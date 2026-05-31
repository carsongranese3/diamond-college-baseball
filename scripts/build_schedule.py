"""Write a season schedule file for every team from the ncaa.com API.

Calls season.build_season() (the same henrygd ncaa.com source the live site
uses) and writes 2026/<Team>/schedule.txt for each SEC team — a plain-text list
of every game on the team's schedule, one per line:

    date | home/away opponent | score | result
    2026-02-13 | vs Washington St. | 7-3 | W

Played games show their final score and W/L; unplayed games show "—". The file
sits at the team root, next to roster.txt and the schedule/ folder; it does not
touch check_games.py's games.txt (which comes from stats.ncaa.org instead).

Run:
    .venv/bin/python scripts/build_schedule.py            # every SEC team
    .venv/bin/python scripts/build_schedule.py Texas      # one team (folder label)
"""

import os
import sys

# This file lives in scripts/; add the project root so the library modules
# (season, local_data, ...) at the project root import.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

import local_data as ld
import season


def _line(g):
    """One schedule row: 'date | vs/at opponent | score | result'."""
    iso = g.get("iso") or ""
    vs = "vs" if g.get("home") else "at"
    opp = (g.get("opp") or {}).get("name") or "?"
    sc = g.get("score")
    score = f"{sc['us']}-{sc['them']}" if sc else "—"
    result = g.get("result") or "—"
    return f"{iso} | {vs} {opp} | {score} | {result}"


def build_for_team(team, schedule):
    """Write 2026/<Team>/schedule.txt for one team; return (path, n) or None."""
    seo, name = team["id"], team["name"]
    team_dir = ld._find_dir(seo, name)
    if not team_dir:
        return None

    games = sorted(schedule, key=lambda g: g.get("iso") or "")

    out_path = os.path.join(team_dir, "schedule.txt")
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(f"{len(games)}\n")
        for g in games:
            fh.write(_line(g) + "\n")
    return out_path, len(games)


def main():
    print("Fetching SEC schedules from the ncaa.com API…", flush=True)
    data = season.build_season()
    teams = {t["name"]: t for t in data["teams"]}
    schedules = data["schedules"]

    targets = sys.argv[1:]
    if targets:
        selected = [teams[t] for t in targets if t in teams]
        missing = [t for t in targets if t not in teams]
        for t in missing:
            print(f"  SKIP {t} (not in the API team list)")
    else:
        selected = list(teams.values())

    for t in selected:
        res = build_for_team(t, schedules.get(t["id"], []))
        if res is None:
            print(f"  SKIP {t['name']} (no 2026/ folder)")
        else:
            path, n = res
            print(f"  wrote {path}  ({n} games)")


if __name__ == "__main__":
    main()
