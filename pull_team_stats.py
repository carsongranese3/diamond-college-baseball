"""Save a team's full season, one folder per game, from stats.ncaa.org.

Same idea as pull_team.py, but the data comes from the official NCAA stats
portal (via the Camoufox stealth browser in ncaa_stats.py) instead of ncaa.com.
The big win: stats.ncaa.org has real per-game box scores AND play-by-play for
every game, including the early non-conference games ncaa.com lacked.

Layout (mirrors pull_team.py):

    <SEASON>/<TEAM_LABEL>/<date>_<vs|at>_<opponent>/
        boxscore.json       line score (innings + R/H/E) for both teams
        player_stats.json    per-team batting / pitching / fielding player lines
        play_by_play.json    ordered plays with running score

Run:
    .venv/bin/python pull_team_stats.py            # uses CONFIG below
    .venv/bin/python pull_team_stats.py Georgia Georgia
    .venv/bin/python pull_team_stats.py Texas Texas 3   # 3rd arg = limit (testing)

First run is slow: each game = 3 stealth-browser page loads, rate-limited.
Pages are cached in cache_ncaa_stats/, so re-runs are fast.
"""

import functools
import json
import os
import re
import sys
import time

# All output is flushed immediately so progress shows up live in the terminal.
print = functools.partial(print, flush=True)

print("Loading libraries and booting the stealth browser… "
      "(first output can take 30–60s, this is normal — not frozen)")

import ncaa_stats as ns

ns.VERBOSE = True  # print each page fetch live so progress is always visible

# ─── CONFIG ──────────────────────────────────────────────────────────────────
SEASON = 2026
TEAM_SCHOOL = "Georgia"     # school name (matched against the NCAA school table)
TEAM_LABEL = "Georgia"      # folder name under <SEASON>/
LIMIT = 0                 # 0 = whole season; >0 = first N games (for testing)
FORCE = False             # True = re-pull games even if already saved in <SEASON>/
# ─────────────────────────────────────────────────────────────────────────────

_FILES = ("boxscore.json", "player_stats.json", "play_by_play.json")


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "opp"


def _already_saved(game_dir):
    """True if all 3 JSON files exist and are non-empty."""
    return all(os.path.getsize(os.path.join(game_dir, f)) > 0
               for f in _FILES if os.path.exists(os.path.join(game_dir, f))) \
        and all(os.path.exists(os.path.join(game_dir, f)) for f in _FILES)


def pull(school=TEAM_SCHOOL, label=TEAM_LABEL, season=SEASON, limit=LIMIT,
         force=FORCE):
    out_root = os.path.join(os.path.dirname(__file__), str(season), label)
    os.makedirs(out_root, exist_ok=True)

    print(f"Looking up {school} and its {season} schedule on stats.ncaa.org…")
    school_id = ns.get_school_id(school)
    games = ns.team_schedule(school_id, season)
    if limit:
        games = games[:limit]
    print(f"  {len(games)} games to pull.\n")

    def _write(path, obj):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=2)

    written, skipped, errors = 0, 0, []
    started = time.time()
    for i, g in enumerate(games, 1):
        cid = g["contest_id"]
        vs = "vs" if g["home"] else "at"
        name = f"{g['iso']}_{vs}_{_slug(g['opponent'])}"
        game_dir = os.path.join(out_root, name)
        # #2: skip games already fully saved (no fetch, no parse) unless forced.
        if not force and _already_saved(game_dir):
            skipped += 1
            print(f"  [{i:>2}/{len(games)}] {name}/  (already saved, skip)")
            continue
        os.makedirs(game_dir, exist_ok=True)
        try:
            _write(os.path.join(game_dir, "boxscore.json"), {
                "contest_id": cid, "date": g["date"], "opponent": g["opponent"],
                "home": g["home"], "result": g["result"],
                "line_score": ns.contest_line_score(cid),
            })
            _write(os.path.join(game_dir, "player_stats.json"),
                   ns.contest_player_stats(cid))
            _write(os.path.join(game_dir, "play_by_play.json"),
                   ns.contest_play_by_play(cid))
            written += 1
            print(f"  [{i:>2}/{len(games)}] {name}/")
        except ns.BlockedError as e:
            errors.append((name, "BLOCKED"))
            print(f"  [{i:>2}/{len(games)}] {name}/  BLOCKED: {e}")
        except Exception as e:  # keep going on a bad game
            errors.append((name, f"{type(e).__name__}: {e}"))
            print(f"  [{i:>2}/{len(games)}] {name}/  ERROR: {type(e).__name__}: {e}")

    ns.shutdown()
    print(f"\nDone in {time.time() - started:.0f}s — wrote {written} game folders "
          f"({skipped} already saved, skipped) to {out_root}")
    if errors:
        print(f"  {len(errors)} game(s) had problems:")
        for nm, msg in errors:
            print(f"    {nm}: {msg}")


if __name__ == "__main__":
    school = sys.argv[1] if len(sys.argv) > 1 else TEAM_SCHOOL
    label = sys.argv[2] if len(sys.argv) > 2 else TEAM_LABEL
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else LIMIT
    pull(school, label, SEASON, limit)
