"""Check each team's full schedule against what's been pulled locally.

For every team, this fetches the complete season schedule from stats.ncaa.org
(via ncaa_stats, the same source pull_game_stats.py uses) and compares it to the
game folders already saved under 2026/<Team>/schedule/. It writes a games.txt
checklist into each team folder marking every game SAVED or MISSING, so you can see at a
glance which games still need pulling.

Game folders are matched the exact way pull_game_stats.py names them:
    <iso>_<vs|at>_<slug(opponent)>      e.g. 2026-02-13_vs_uc-davis
and a game counts as SAVED only when all three JSON files exist and are non-empty
(boxscore.json, player_stats.json, play_by_play.json).

Run:
    .venv/bin/python scripts/check_games.py            # every SEC team
    .venv/bin/python scripts/check_games.py Texas      # one team
    .venv/bin/python scripts/check_games.py Texas LSU  # a few teams

Like pull_game_stats.py, this drives the stealth browser (ncaa_stats), so it needs
the full project environment (camoufox + Python 3.10+). Schedule pages already in
cache_ncaa_stats/ are read from cache, so re-runs are fast.
"""

import datetime
import functools
import os
import re
import sys

# This file lives in scripts/; add the project root so the library modules
# (ncaa_stats, ...) at the project root import, and remember the root for the
# 2026/<Team>/ output paths below.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

print = functools.partial(print, flush=True)  # live progress in the terminal

SEASON = 2026
DATA_ROOT = os.path.join(_PROJECT_ROOT, str(SEASON))

# The 16 SEC baseball schools — each name doubles as its 2026/ folder label,
# exactly as in pull_game_stats.py.
SEC_TEAMS = [
    "Alabama", "Arkansas", "Auburn", "Florida", "Georgia", "Kentucky", "LSU",
    "Mississippi St.", "Missouri", "Oklahoma", "Ole Miss", "South Carolina",
    "Tennessee", "Texas", "Texas A&M", "Vanderbilt",
]

_FILES = ("boxscore.json", "player_stats.json", "play_by_play.json")


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "opp"


def _game_dirname(game):
    """The folder name pull_game_stats.py would save this game under."""
    vs = "vs" if game["home"] else "at"
    return f"{game['iso']}_{vs}_{_slug(game['opponent'])}"


def _is_saved(game_dir):
    """True if all 3 JSON files exist and are non-empty (same rule as the puller)."""
    return all(os.path.exists(os.path.join(game_dir, f)) for f in _FILES) and \
        all(os.path.getsize(os.path.join(game_dir, f)) > 0 for f in _FILES)


def check_team(school, label=None):
    """Write 2026/<label>/games.txt for one team; return (saved, missing)."""
    import ncaa_stats as ns

    label = label or school
    team_dir = os.path.join(DATA_ROOT, label)
    os.makedirs(team_dir, exist_ok=True)

    school_id = ns.get_school_id(school)
    if school_id is None:
        print(f"  SKIP {label} (no school id for {school!r})")
        return None
    games = ns.team_schedule(school_id, SEASON)

    rows, saved = [], 0
    for g in games:
        dirname = _game_dirname(g)
        ok = _is_saved(os.path.join(team_dir, "schedule", dirname))
        saved += 1 if ok else 0
        rows.append((
            "SAVED  " if ok else "MISSING",
            g.get("iso", ""),
            ("vs" if g["home"] else "at") + " " + (g.get("opponent") or ""),
            (g.get("result") or "").strip() or "—",
            str(g.get("contest_id") or ""),
            dirname,
        ))
    rows.sort(key=lambda r: r[1])
    missing = len(rows) - saved

    out_path = os.path.join(team_dir, "games.txt")
    today = datetime.date.today().isoformat()
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(f"# {label} — {SEASON} game checklist\n")
        fh.write(f"# Generated {today} by check_games.py from stats.ncaa.org.\n")
        fh.write(f"# {saved} of {len(rows)} games saved locally; {missing} missing.\n")
        fh.write("# Format: status | date | home/away opponent | result | contest_id | folder\n")
        for r in rows:
            fh.write(" | ".join(r) + "\n")

    flag = "" if missing == 0 else f"  ⚠ {missing} missing"
    print(f"  wrote {out_path}  ({saved}/{len(rows)} saved){flag}")
    return saved, missing


def main():
    targets = sys.argv[1:] or SEC_TEAMS
    total_saved = total_missing = 0
    for t in targets:
        res = check_team(t)
        if res:
            total_saved += res[0]
            total_missing += res[1]
    print(f"\nDone — {total_saved} games saved, {total_missing} missing "
          f"across {len(targets)} team(s).")

    # ncaa_stats keeps a browser thread alive; shut it down so the script exits.
    try:
        import ncaa_stats as ns
        ns.shutdown()
    except Exception:
        pass


if __name__ == "__main__":
    main()
