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
    .venv/bin/python pull_team_stats.py Texas Texas 0 2026-05-19 2026-05-24
        # args 4 & 5 = start/end date (ISO, inclusive); 0 = no game-count limit.
        # Or just set START_DATE / END_DATE in CONFIG and run with no args.
    .venv/bin/python pull_team_stats.py all          # every SEC team, whole season
    .venv/bin/python pull_team_stats.py all 2026-05-19 2026-05-24   # SEC, date window

First run is slow: each game = 3 stealth-browser page loads, rate-limited.
Pages are cached in cache_ncaa_stats/, so re-runs are fast. A full all-SEC pull is
~16 teams × ~55 games × 3 loads — budget a couple of hours for the first run.
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
ALL_SEC = False           # True = pull ALL 16 SEC teams (ignores TEAM_SCHOOL/LABEL)
TEAM_SCHOOL = "Vanderbilt"     # single team: school name (matched vs the NCAA table)
TEAM_LABEL = "Vanderbilt"      # single team: folder name under <SEASON>/
START_DATE = ""           # ISO "YYYY-MM-DD"; "" = no lower bound (season start)
END_DATE = ""             # ISO "YYYY-MM-DD"; "" = no upper bound (season end)
LIMIT = 0                 # 0 = whole season; >0 = first N games (for testing)
FORCE = False             # True = re-pull games even if already saved in <SEASON>/
# ─────────────────────────────────────────────────────────────────────────────

# The 16 SEC baseball schools (names verified against the collegebaseball lookup
# table). Used by pull_all_sec(); each name doubles as its <SEASON>/ folder label.
SEC_TEAMS = [
    "Alabama", "Arkansas", "Auburn", "Florida", "Georgia", "Kentucky", "LSU",
    "Mississippi St.", "Missouri", "Oklahoma", "Ole Miss", "South Carolina",
    "Tennessee", "Texas", "Texas A&M", "Vanderbilt",
]

_FILES = ("boxscore.json", "player_stats.json", "play_by_play.json")


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "opp"


def _already_saved(game_dir):
    """True if all 3 JSON files exist and are non-empty."""
    return all(os.path.getsize(os.path.join(game_dir, f)) > 0
               for f in _FILES if os.path.exists(os.path.join(game_dir, f))) \
        and all(os.path.exists(os.path.join(game_dir, f)) for f in _FILES)


def pull(school=TEAM_SCHOOL, label=TEAM_LABEL, season=SEASON, limit=LIMIT,
         force=FORCE, start_date=START_DATE, end_date=END_DATE, shutdown=True):
    out_root = os.path.join(os.path.dirname(__file__), str(season), label)
    os.makedirs(out_root, exist_ok=True)

    print(f"Looking up {school} and its {season} schedule on stats.ncaa.org…")
    school_id = ns.get_school_id(school)
    games = ns.team_schedule(school_id, season)
    # Date-range filter (inclusive). iso is "YYYY-MM-DD", so string compare = date compare.
    if start_date:
        games = [g for g in games if g["iso"] >= start_date]
    if end_date:
        games = [g for g in games if g["iso"] <= end_date]
    if limit:
        games = games[:limit]
    window = (f" between {start_date or 'season start'} and {end_date or 'season end'}"
              if (start_date or end_date) else "")
    print(f"  {len(games)} games to pull{window}.\n")

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

    if shutdown:
        ns.shutdown()  # skipped when looping many teams (keep one browser alive)
    print(f"\nDone in {time.time() - started:.0f}s — wrote {written} game folders "
          f"({skipped} already saved, skipped) to {out_root}")
    if errors:
        print(f"  {len(errors)} game(s) had problems:")
        for nm, msg in errors:
            print(f"    {nm}: {msg}")
    return {"written": written, "skipped": skipped, "errors": errors}


def pull_all_sec(season=SEASON, start_date=START_DATE, end_date=END_DATE,
                 force=FORCE, limit=LIMIT):
    """Pull every SEC team for a season, reusing one browser across all teams.

    Each team is independent: if one fails to start (bad name lookup, schedule
    fetch error) we log it and move on rather than aborting the whole run.
    """
    started = time.time()
    window = (f" between {start_date or 'season start'} and {end_date or 'season end'}"
              if (start_date or end_date) else "")
    print(f"Pulling all {len(SEC_TEAMS)} SEC teams for {season}{window}…\n")

    totals = {"written": 0, "skipped": 0, "game_errors": 0}
    team_failures = []
    for n, team in enumerate(SEC_TEAMS, 1):
        print(f"\n──────── [{n}/{len(SEC_TEAMS)}] {team} ────────")
        try:
            res = pull(team, team, season, limit, force, start_date, end_date,
                       shutdown=False)
            totals["written"] += res["written"]
            totals["skipped"] += res["skipped"]
            totals["game_errors"] += len(res["errors"])
        except Exception as e:  # whole-team failure (lookup/schedule) — keep going
            team_failures.append((team, f"{type(e).__name__}: {e}"))
            print(f"  !! {team} failed: {type(e).__name__}: {e}")

    ns.shutdown()  # one shutdown for the whole run
    print(f"\n════════ ALL SEC DONE in {time.time() - started:.0f}s ════════")
    print(f"  {totals['written']} games written, {totals['skipped']} already saved, "
          f"{totals['game_errors']} game-level error(s) across {len(SEC_TEAMS)} teams.")
    if team_failures:
        print(f"  {len(team_failures)} team(s) failed entirely:")
        for t, m in team_failures:
            print(f"    {t}: {m}")


if __name__ == "__main__":
    # All-SEC mode: either `... all`/`... sec` on the CLI, or ALL_SEC=True in CONFIG
    # with no team arg. Optional date window follows the `all` keyword on the CLI.
    cli_all = len(sys.argv) > 1 and sys.argv[1].lower() in ("all", "sec")
    config_all = len(sys.argv) == 1 and ALL_SEC
    if cli_all or config_all:
        start = sys.argv[2] if len(sys.argv) > 2 else START_DATE
        end = sys.argv[3] if len(sys.argv) > 3 else END_DATE
        pull_all_sec(SEASON, start_date=start, end_date=end)
    else:
        school = sys.argv[1] if len(sys.argv) > 1 else TEAM_SCHOOL
        label = sys.argv[2] if len(sys.argv) > 2 else TEAM_LABEL
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else LIMIT
        start = sys.argv[4] if len(sys.argv) > 4 else START_DATE
        end = sys.argv[5] if len(sys.argv) > 5 else END_DATE
        pull(school, label, SEASON, limit, start_date=start, end_date=end)
