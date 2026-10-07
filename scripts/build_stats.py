"""Build per-team season stat files under <SEASON>/<TEAM>/stats/.

Aggregates every saved per-game box score (player_stats.json + boxscore.json) into
three files of season totals, one row per player:

    <SEASON>/<TEAM>/stats/batting.json
    <SEASON>/<TEAM>/stats/pitching.json
    <SEASON>/<TEAM>/stats/fielding.json

Only BASIC counting stats are stored — the raw building blocks. Rate/derived
stats (AVG, OBP, SLG, OPS, ISO, ERA, WHIP, K/9, FIP, fielding %, …) are NOT stored
here; they are computed from these counts by whoever reads the files.

  batting:  g, pa, ab, r, h, 1b, 2b, 3b, hr, rbi, bb, ibb, so, hbp, sf, sh, sb, cs, tb
  pitching: g, gs, w, l, s, outs, ip, h, r, er, bb, ibb, so, bf, hr_a, 2b_a, 3b_a, hb, bk, wp
  fielding: one row per fielder whose `pos` is a LIST with a separate entry per
            position played. Every entry carries the universal fielding stats
            (g, po, a, tc, e, dp, tp); OUTFIELD entries add ofa (outfield assists =
            assists at an OF spot); CATCHER entries add the catcher-only stats
            (pb, sba, csb, ci) — a LF has no SBA, so those keys are omitted off the
            plate. DH/pinch appearances are excluded; each game's line is attributed
            to that game's primary fielding position (a compound code -> its first
            real spot, since the box score can't split a game's chances across
            positions). Only stats recorded in the box-score fielding line are kept
            (no GS / innings / fielding-vs-throwing error split / pickoffs).

Pitcher wins / losses / saves come from each game's `decisions` block (added by the
scraper) attributed to this team's side.

Run:
    .venv/bin/python scripts/build_stats.py            # every team under <SEASON>/
    .venv/bin/python scripts/build_stats.py Texas      # one team
"""

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import local_data as ld
from stat_agg import aggregate

SEASON = 2026


def build_for_team(label):
    team_dir = ld._find_dir(label, label)  # resolves flat or <Conference>/<Team>
    if not team_dir:
        return None

    bat_rows, pit_rows, fld_rows = aggregate(team_dir, label)

    stats_dir = os.path.join(team_dir, "stats")
    os.makedirs(stats_dir, exist_ok=True)
    stamp = datetime.date.today().isoformat()
    for fname, players in (("batting.json", bat_rows), ("pitching.json", pit_rows),
                           ("fielding.json", fld_rows)):
        with open(os.path.join(stats_dir, fname), "w", encoding="utf-8") as fh:
            json.dump({"team": label, "season": SEASON, "generated": stamp,
                       "players": players}, fh, indent=2)
    return len(bat_rows), len(pit_rows), len(fld_rows)


def main():
    targets = sys.argv[1:] or [label for label, _ in ld.team_dirs()]
    for label in targets:
        res = build_for_team(label)
        if res is None:
            print(f"  SKIP {label} (no folder)", flush=True)
        else:
            b, p, f = res
            print(f"  {label}: {b} batters, {p} pitchers, {f} fielders -> {SEASON}/{label}/stats/", flush=True)


if __name__ == "__main__":
    main()
