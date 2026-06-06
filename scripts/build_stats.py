"""Build per-team season stat files under <SEASON>/<TEAM>/stats/.

Aggregates every saved per-game box score (player_stats.json + boxscore.json) into
two files of season totals, one row per player:

    <SEASON>/<TEAM>/stats/batting.json
    <SEASON>/<TEAM>/stats/pitching.json

Only BASIC counting stats are stored — the raw building blocks. Rate/derived
stats (AVG, OBP, SLG, OPS, ISO, ERA, WHIP, K/9, FIP, …) are NOT stored here; they
are computed from these counts by whoever reads the files.

  batting:  g, pa, ab, r, h, 1b, 2b, 3b, hr, rbi, bb, ibb, so, hbp, sf, sh, sb, cs, tb
  pitching: g, gs, w, l, s, outs, ip, h, r, er, bb, ibb, so, bf, hr_a, 2b_a, 3b_a, hb, bk, wp

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
from boxutil import ip_to_outs, outs_to_ip, to_int

SEASON = 2026

# raw player_stats key -> our stored key, for the straight counting stats.
_BAT_COUNTS = {
    "R": "r", "AB": "ab", "H": "h", "2B": "2b", "3B": "3b", "HR": "hr",
    "RBI": "rbi", "BB": "bb", "IBB": "ibb", "K": "so", "HBP": "hbp",
    "SF": "sf", "SH": "sh", "SB": "sb", "CS": "cs", "TB": "tb",
}
_PIT_COUNTS = {
    "H": "h", "R": "r", "ER": "er", "BB": "bb", "IBB": "ibb", "SO": "so",
    "BF": "bf", "HR-A": "hr_a", "2B-A": "2b_a", "3B-A": "3b_a",
    "HB": "hb", "Bk": "bk", "WP": "wp",
}
_DEC_KEY = {"win": "w", "loss": "l", "save": "s"}


def _blank(keys):
    return {k: 0 for k in keys}


def _norm(s):
    return ld._norm(s)


def build_for_team(label):
    team_dir = os.path.join(ld.DATA_ROOT, label)
    if not os.path.isdir(team_dir):
        return None

    # name -> accumulator. Keep display name / number / position from the rows.
    bat, pit, meta = {}, {}, {}

    # Read boxscore.json + player_stats.json per game DIRECTLY (not via
    # _iter_games, which also needs play_by_play.json and would skip a game whose
    # PBP is missing / iCloud-offloaded — undercounting season totals).
    sched_dir = os.path.join(team_dir, "schedule")
    for d in sorted(os.listdir(sched_dir) if os.path.isdir(sched_dir) else []):
        game_dir = os.path.join(sched_dir, d)
        bp = os.path.join(game_dir, "boxscore.json")
        pp = os.path.join(game_dir, "player_stats.json")
        if not (os.path.isdir(game_dir) and os.path.exists(bp) and os.path.exists(pp)):
            continue
        try:
            box = json.load(open(bp, encoding="utf-8"))
            players = json.load(open(pp, encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        data = {"box": box, "players": players}
        side = ld._host_side(data, label)
        rows = players.get(side) or {}
        decisions = box.get("decisions") or {}

        for row in rows.get("batting") or []:
            name = (row.get("Name") or "").strip()
            if not name or ld._is_totals_row(row, label):
                continue
            ab, bb = to_int(row.get("AB")), to_int(row.get("BB"))
            hbp, sf, sh = to_int(row.get("HBP")), to_int(row.get("SF")), to_int(row.get("SH"))
            if ab + bb + hbp + sf + sh == 0:
                continue  # didn't actually come to the plate
            acc = bat.setdefault(_norm(name), _blank(_BAT_COUNTS.values()) | {"g": 0, "pa": 0})
            meta.setdefault(_norm(name), {"name": name, "num": row.get("#", ""), "pos": row.get("P", "")})
            acc["g"] += 1
            acc["pa"] += ab + bb + hbp + sf + sh
            for src, dst in _BAT_COUNTS.items():
                acc[dst] += to_int(row.get(src))

        # Box scores list pitchers in order of appearance, so the first one is
        # the starter (gs). Filter the totals row out first so index 0 is real.
        pitch_rows = [r for r in (rows.get("pitching") or [])
                      if (r.get("Name") or "").strip() and not ld._is_totals_row(r, label)]
        for i, row in enumerate(pitch_rows):
            name = row.get("Name").strip()
            outs = ip_to_outs(row.get("IP"))
            if outs == 0 and to_int(row.get("BF")) == 0:
                continue
            acc = pit.setdefault(_norm(name), _blank(_PIT_COUNTS.values()) | {"g": 0, "gs": 0, "outs": 0, "w": 0, "l": 0, "s": 0})
            meta.setdefault(_norm(name), {"name": name, "num": row.get("#", ""), "pos": row.get("P", "P")})
            acc["g"] += 1
            if i == 0:
                acc["gs"] += 1  # first pitcher listed = the game's starter
            acc["outs"] += outs
            for src, dst in _PIT_COUNTS.items():
                acc[dst] += to_int(row.get(src))

        # W / L / S for this game go to the matching pitcher on THIS team's side.
        for key, dec in decisions.items():
            letter = _DEC_KEY.get(key)
            if not letter or not dec or dec.get("side") != side:
                continue
            target = pit.get(_norm(dec.get("name")))
            if target is not None:
                target[letter] += 1

    def rows_out(acc, num_sort):
        out = []
        for nkey, a in acc.items():
            m = meta.get(nkey, {})
            row = {"num": m.get("num", ""), "name": m.get("name", ""), "pos": m.get("pos", "")}
            row.update(a)
            out.append(row)
        out.sort(key=lambda r: (-r.get(num_sort, 0), r["name"]))
        return out

    bat_rows = rows_out(bat, "pa")
    for r in bat_rows:  # singles aren't a box-score column; derive from the hits
        r["1b"] = r["h"] - r["2b"] - r["3b"] - r["hr"]
    pit_rows = rows_out(pit, "outs")
    for r in pit_rows:
        r["ip"] = outs_to_ip(r["outs"])  # convenience; `outs` is the canonical count

    stats_dir = os.path.join(team_dir, "stats")
    os.makedirs(stats_dir, exist_ok=True)
    stamp = datetime.date.today().isoformat()
    for fname, players in (("batting.json", bat_rows), ("pitching.json", pit_rows)):
        with open(os.path.join(stats_dir, fname), "w", encoding="utf-8") as fh:
            json.dump({"team": label, "season": SEASON, "generated": stamp,
                       "players": players}, fh, indent=2)
    return len(bat_rows), len(pit_rows)


def main():
    targets = sys.argv[1:] or sorted(
        d for d in os.listdir(ld.DATA_ROOT)
        if os.path.isdir(os.path.join(ld.DATA_ROOT, d))
    )
    for label in targets:
        res = build_for_team(label)
        if res is None:
            print(f"  SKIP {label} (no folder)", flush=True)
        else:
            b, p = res
            print(f"  {label}: {b} batters, {p} pitchers -> {SEASON}/{label}/stats/", flush=True)


if __name__ == "__main__":
    main()
