"""Collect a team's upcoming (unplayed) games from the ncaa.com scoreboard.

The site's saved schedules only contain played games — box scores are pulled
after a game finishes, so future games never appear there. This crawls the
ncaa.com scoreboard (via ncaa.py, the light Flask-only deps — no stealth browser)
from "today" through the end of the season and writes the team's
scheduled-but-unplayed games to <SEASON>/<TEAM>/future.json, in the same shape as
a schedule entry (score/result null, with the start time).

Run:
    .venv/bin/python scripts/pull_future_games.py                 # uses CONFIG below
    .venv/bin/python scripts/pull_future_games.py Texas
    .venv/bin/python scripts/pull_future_games.py "Texas A&M"
"""

import datetime
import json
import os
import sys

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

import ncaa
import season

# ─── CONFIG ──────────────────────────────────────────────────────────────────
SEASON = 2026
TEAM = "Texas"                           # folder label under <SEASON>/
SEASON_END = datetime.date(2026, 6, 30)  # last scoreboard date to scan
# ─────────────────────────────────────────────────────────────────────────────


def future_games(team_label, end=SEASON_END):
    """Upcoming (gameState != 'final') games for team_label, today → end."""
    key = season._norm(team_label)
    rank_by = season._rank_lookup()
    out, seen = [], set()
    d = season._today()                  # past dates are all final; scan today → end
    one = datetime.timedelta(days=1)
    while d <= end:
        try:
            board = ncaa.scoreboard(d.year, d.month, d.day)
        except (ncaa.NotFound, ncaa.APIError):
            d += one
            continue
        for wrap in board.get("games", []):
            g = wrap.get("game") or {}
            home, away = g.get("home") or {}, g.get("away") or {}
            if not home or not away:
                continue
            for side, other in ((home, away), (away, home)):
                names = side.get("names") or {}
                if key not in (season._norm(names.get("seo")),
                               season._norm(names.get("short"))):
                    continue
                if g.get("gameState") == "final":   # already played → not a future game
                    continue
                gid = g.get("gameID")
                if gid in seen:
                    continue
                seen.add(gid)
                onames = other.get("names") or {}
                oseo = onames.get("seo") or ""
                out.append({
                    "id": gid,
                    "date": season._fmt_date(g.get("startDate", "")),
                    "iso": season._fmt_iso(g.get("startDate", "")),
                    "opp": {
                        "id": oseo,
                        "name": onames.get("short") or oseo,
                        "mark": (onames.get("char6") or oseo[:4]).upper(),
                        "logo": ncaa.logo_url(oseo),
                        "rank": rank_by.get(season._norm(onames.get("short") or "")),
                        "conf": season._is_sec(other),
                    },
                    "home": side is home,
                    "score": None,
                    "result": None,
                    "time": g.get("startTime"),
                    "state": g.get("gameState"),
                })
        d += one
    out.sort(key=lambda e: e["iso"] or "")
    return out


if __name__ == "__main__":
    team = sys.argv[1] if len(sys.argv) > 1 else TEAM
    games = future_games(team)

    out_dir = os.path.join(_PROJECT_ROOT, str(SEASON), team)
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, "future.json")
    payload = {
        "team": team,
        "season": SEASON,
        "generated": datetime.datetime.now().isoformat(timespec="minutes"),
        "games": games,
    }
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)

    print(f"wrote {dest} — {len(games)} upcoming game(s)")
    for g in games:
        loc = "vs" if g["home"] else "at"
        print(f"  {g['iso']}  {loc} {g['opp']['name']:<18} {g['time'] or '':<10} ({g['state']})")
