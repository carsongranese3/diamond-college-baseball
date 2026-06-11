"""Build per-team weekly record files under <SEASON>/<TEAM>/records.json.

Walks each team's schedule.json against a shared SEC week calendar (Mon-Sun weeks
that start the first week of conference play) and snapshots the team's CUMULATIVE
record as of the end of each week — both overall (all regular-season games) and
conference (regular-season games vs SEC opponents). Postseason games (SEC
Tournament, NCAA) are excluded; they fall outside the regular-season date window.

These power the SEC rankings-over-time graph on the Standings page: ranking all
teams by their conference record at each week gives each team's weekly SEC
position. The week calendar is global (built from every team) so all teams share
the same week numbers even when only one team is rebuilt.

Reads schedule.json directly (which already carries iso / result / opp.conf), so
no web crawl is needed.

Run:
    .venv/bin/python scripts/build_records.py            # every team under <SEASON>/
    .venv/bin/python scripts/build_records.py Texas      # one team
"""

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import local_data as ld
import phase

SEASON = 2026


def _played_regular(games):
    """Regular-season games with a W/L result, sorted by date. Each item is a
    (date, result, is_conf) tuple."""
    out = []
    for g in games:
        d = phase._parse_iso(g.get("iso"))
        if d is None or phase._phase_for_date(d) != "regular":
            continue
        if g.get("result") not in ("W", "L"):
            continue
        out.append((d, g["result"], bool((g.get("opp") or {}).get("conf"))))
    out.sort(key=lambda x: x[0])
    return out


def _team_games(team_dir):
    path = os.path.join(team_dir, "schedule.json")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh).get("games") or []


def build_week_calendar(all_games):
    """Contiguous Mondays from the first conference-game week to the last, across
    every team — so a bye week still gets a column and all teams line up. Returns
    [date(Monday), ...]."""
    mondays = set()
    for games in all_games.values():
        for d, _res, is_conf in _played_regular(games):
            if is_conf:
                mondays.add(d - datetime.timedelta(days=d.weekday()))
    if not mondays:
        return []
    start, end = min(mondays), max(mondays)
    weeks, m = [], start
    while m <= end:
        weeks.append(m)
        m += datetime.timedelta(days=7)
    return weeks


def team_weeks(games, calendar):
    """Cumulative overall + conference record snapshot at the end of each week."""
    reg = _played_regular(games)
    rows = []
    for n, monday in enumerate(calendar, 1):
        end = monday + datetime.timedelta(days=6)
        ow = ol = cw = cl = 0
        for d, res, is_conf in reg:
            if d > end:
                break
            if res == "W":
                ow += 1
                cw += 1 if is_conf else 0
            else:
                ol += 1
                cl += 1 if is_conf else 0
        rows.append({"n": n, "start": monday.isoformat(), "end": end.isoformat(),
                     "ovrW": ow, "ovrL": ol, "confW": cw, "confL": cl})
    return rows


def calendar_for_all():
    """The shared week calendar built from EVERY team under DATA_ROOT — the same
    basis main() uses, so records written incrementally (e.g. by update.py) line up
    with a full `build_records.py` run."""
    all_games = {}
    for label, team_dir in ld.team_dirs():
        g = _team_games(team_dir)
        if g is not None:
            all_games[label] = g
    return build_week_calendar(all_games)


def write_for_team(team_dir, label, calendar, stamp=None):
    """Write team_dir/records.json from its schedule.json against `calendar`.
    Returns the number of week rows, or None if the team has no schedule.json."""
    games = _team_games(team_dir)
    if games is None:
        return None
    rows = team_weeks(games, calendar)
    stamp = stamp or datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")
    with open(os.path.join(team_dir, "records.json"), "w", encoding="utf-8") as fh:
        json.dump({"team": label, "season": SEASON, "generated": stamp,
                   "weeks": rows}, fh, indent=2)
        fh.write("\n")
    return len(rows)


def main():
    # team_dirs() descends the <year>/<Conference>/<Team>/ layout (and still
    # handles a flat one), so enumeration doesn't assume teams sit at the root.
    pairs = ld.team_dirs()                       # [(label, dir)]
    dir_by = dict(pairs)
    targets = sys.argv[1:] or [label for label, _ in pairs]
    # The calendar is built from EVERY team (even when rebuilding one) so weeks
    # stay aligned across the whole conference.
    all_games = {}
    for label, team_dir in pairs:
        g = _team_games(team_dir)
        if g is not None:
            all_games[label] = g
    calendar = build_week_calendar(all_games)
    if not calendar:
        print("No conference games found — nothing to build.")
        return
    stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")
    for label in targets:
        games = all_games.get(label)
        team_dir = dir_by.get(label)
        if games is None or team_dir is None:
            print(f"  {label}: no schedule.json, skipped", flush=True)
            continue
        rows = team_weeks(games, calendar)
        path = os.path.join(team_dir, "records.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"team": label, "season": SEASON, "generated": stamp,
                       "weeks": rows}, fh, indent=2)
            fh.write("\n")
        last = rows[-1] if rows else {}
        print(f"  {label}: {len(rows)} weeks -> {os.path.relpath(path)} "
              f"(final conf {last.get('confW')}-{last.get('confL')})", flush=True)


if __name__ == "__main__":
    main()
