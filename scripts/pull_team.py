"""Automatically pull one team's entire season of box scores via the NCAA API.

Edit the CONFIG block below and run:

    .venv/bin/python scripts/pull_team.py

It discovers the team's full schedule from the NCAA scoreboard API, then for
every played game creates a folder containing three files:

    <YEAR>/<TEAM_LABEL>/<date>_<vs|at>_<opponent>/
        boxscore.json       raw NCAA box score (both teams, every player)
        player_stats.json   cleaned per-player batting/pitching + line score
        play_by_play.json   raw NCAA play-by-play (omitted if unavailable)

Responses already pulled are served from ./cache so re-runs are fast. Set
FRESH = True to force a re-fetch from the API (used near live games when
stats are still changing).
"""

import json
import os
import sys
import time

# This file now lives in scripts/; add the project root to sys.path so the
# library modules (ncaa, season, gamedetail) at the project root resolve.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

import ncaa
import season
from gamedetail import build_game

# ─── CONFIG ──────────────────────────────────────────────────────────────────
YEAR = 2026
TEAM_SEO = "texas"      # ncaa.com team slug (e.g. "georgia", "lsu", "texas-am")
TEAM_LABEL = "Texas"    # folder name under <YEAR>/
FRESH = False           # True = re-pull every box score from the API
# ─────────────────────────────────────────────────────────────────────────────


def pull(team_seo=TEAM_SEO, team_label=TEAM_LABEL, year=YEAR, fresh=FRESH):
    out_dir = os.path.join(_PROJECT_ROOT, str(year), team_label)
    os.makedirs(out_dir, exist_ok=True)

    print(f"Discovering {team_label}'s {year} schedule via the NCAA API…")
    data = season.build_season(fresh=fresh)
    schedule = data["schedules"].get(team_seo)
    if not schedule:
        print(f"  '{team_seo}' not found. Available teams:")
        print("  " + ", ".join(sorted(data["schedules"])))
        return

    total = len(schedule)
    playable = [g for g in schedule if g.get("result") and g.get("id")]
    print(f"  {total} games found, {len(playable)} played with a box score.\n")

    def _write(path, obj):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=2)

    written = 0
    no_box = []
    no_pbp = []
    used = set()
    started = time.time()

    for game in schedule:
        gid = game.get("id")
        if not game.get("result") or not gid:
            continue  # unplayed game — no box score exists yet
        try:
            box = ncaa.boxscore(gid, fresh=fresh)
        except (ncaa.NotFound, ncaa.APIError):
            no_box.append(game.get("date") or gid)
            continue

        iso = game.get("iso") or str(gid)
        vs = "vs" if game.get("home") else "at"
        name = f"{iso}_{vs}_{game['opp']['id']}"
        if name in used:                       # doubleheader, same date/opp
            name = f"{name}_{gid}"
        used.add(name)

        game_dir = os.path.join(out_dir, "schedule", name)
        os.makedirs(game_dir, exist_ok=True)

        # 1. raw box score
        _write(os.path.join(game_dir, "boxscore.json"), box)

        # 2. cleaned player stats + line score (what the app already derives)
        try:
            _write(os.path.join(game_dir, "player_stats.json"),
                   build_game(gid))
        except (ncaa.NotFound, ncaa.APIError):
            pass

        # 3. raw play-by-play (not available for every game)
        try:
            _write(os.path.join(game_dir, "play_by_play.json"),
                   ncaa.playbyplay(gid, fresh=fresh))
        except (ncaa.NotFound, ncaa.APIError):
            no_pbp.append(name)

        written += 1
        print(f"  [{written:>2}/{len(playable)}] {name}/")

    elapsed = time.time() - started
    print(f"\nDone in {elapsed:.1f}s — wrote {written} game folders to {out_dir}")
    if no_box:
        print(f"  {len(no_box)} played game(s) had no box score in the API: "
              f"{', '.join(map(str, no_box))}")
    if no_pbp:
        print(f"  {len(no_pbp)} game(s) had no play-by-play available.")


if __name__ == "__main__":
    # Optional overrides: python pull_team.py <seo> <Label>
    seo = sys.argv[1] if len(sys.argv) > 1 else TEAM_SEO
    label = sys.argv[2] if len(sys.argv) > 2 else TEAM_LABEL
    pull(seo, label)
