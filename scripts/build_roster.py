"""Generate a roster.txt for each team folder, listing every player by jersey #.

Reads the per-game player_stats.json files inside each 2026/<Team>/ folder and
writes a roster.txt with one player per line (sorted by jersey number). Players
who appear in both the batting and pitching lines get a "Two-way" tag.

The web app's Roster tab reads these files via /api/roster/<seo>.

Run:
    .venv/bin/python scripts/build_roster.py              # all teams under 2026/
    .venv/bin/python scripts/build_roster.py Texas        # just one team
"""

import datetime
import json
import os
import sys

# This file now lives in scripts/; add the project root to sys.path so the
# library modules (local_data, ncaa_stats, ...) at the project root import.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import local_data as ld


def build_for_team(team_label):
    team_dir = os.path.join(ld.DATA_ROOT, team_label)
    if not os.path.isdir(team_dir):
        return None, 0

    # name -> {num, pos, g_bat, g_pit}
    # We only need boxscore.json (for the home/away split) + player_stats.json,
    # not play_by_play.json — so don't go through _iter_games (which requires all
    # three and would skip games whose PBP file is iCloud-offloaded).
    by_name = {}
    sched_dir = os.path.join(team_dir, "schedule")
    game_names = sorted(os.listdir(sched_dir)) if os.path.isdir(sched_dir) else []
    for d in game_names:
        game_dir = os.path.join(sched_dir, d)
        if not os.path.isdir(game_dir):
            continue
        bp = os.path.join(game_dir, "boxscore.json")
        pp = os.path.join(game_dir, "player_stats.json")
        if not (os.path.exists(bp) and os.path.exists(pp)):
            continue
        # Read the files normally — reading an iCloud-offloaded file triggers a
        # download on the spot. That's fine for this on-demand script (unlike the
        # web server, where a stall would white-screen the page). If the read
        # genuinely fails (offline, etc.), we just skip the game.
        try:
            box = json.load(open(bp, encoding="utf-8"))
            ps = json.load(open(pp, encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        data = {"box": box, "players": ps}
        side = (ps or {}).get(ld._host_side(data, team_label)) or {}
        for kind, default_pos in (("batting", ""), ("pitching", "P")):
            for r in side.get(kind, []):
                name = (r.get("Name") or "").strip()
                if not name or name == team_label:
                    continue  # the "totals" row repeats the team name; skip it
                e = by_name.setdefault(
                    name, {"num": "", "pos": "", "g_bat": 0, "g_pit": 0})
                e["g_bat" if kind == "batting" else "g_pit"] += 1
                if not e["num"]:
                    e["num"] = r.get("#", "")
                if not e["pos"]:
                    e["pos"] = r.get("P", default_pos)

    rows = []
    for name, e in by_name.items():
        if e["g_bat"] and e["g_pit"]:
            role = "Two-way"
        elif e["g_bat"]:
            role = "Batter"
        else:
            role = "Pitcher"
        rows.append((e["num"], name, e["pos"], role, max(e["g_bat"], e["g_pit"])))

    # Sort by jersey number (numeric); missing/non-numeric numbers go to the end.
    def _key(r):
        try:
            n = int(r[0])
        except (ValueError, TypeError):
            n = 9999
        return (n, r[1])
    rows.sort(key=_key)

    out_path = os.path.join(team_dir, "roster.txt")
    today = datetime.date.today().isoformat()
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(f"# {team_label} — 2026 roster\n")
        fh.write(f"# Generated {today} by build_roster.py from saved game data.\n")
        fh.write("# Format: number|name|position|role|games\n")
        for num, name, pos, role, g in rows:
            fh.write(f"{num}|{name}|{pos}|{role}|{g}\n")
    return out_path, len(rows)


def main():
    targets = sys.argv[1:] or sorted(
        d for d in os.listdir(ld.DATA_ROOT)
        if os.path.isdir(os.path.join(ld.DATA_ROOT, d))
    )
    for t in targets:
        path, n = build_for_team(t)
        if path is None:
            print(f"  SKIP {t} (no folder)")
        else:
            print(f"  wrote {path}  ({n} players)")


if __name__ == "__main__":
    main()
