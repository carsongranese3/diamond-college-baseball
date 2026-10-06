"""Write a team's FULL season schedule (every game — played and upcoming) to
<SEASON>/<TEAM>/schedule.json.

The complete set of PLAYED games comes from the saved box-score folders (the same
authoritative stats.ncaa.org data the live site reads) — ncaa.com's scoreboard
alone is incomplete (it misses early non-conference games). UPCOMING games are
added from the ncaa.com scoreboard for dates after today. Every game carries:

    id, date, iso, opp{id,name,mark,logo,rank,conf}, home, score, result, time, played

Played games have their final score and W/L; upcoming games have score=null and
result=null (with the scheduled start time). `played` is a convenience flag.
This replaces the old plain-text schedule.txt (and build_schedule.py).

Uses the light Flask-only deps (no stealth browser), so it runs under the deploy
.venv just fine.

Run:
    .venv/bin/python scripts/pull_schedule.py            # every SEC team (CONFIG)
    .venv/bin/python scripts/pull_schedule.py Texas      # one team (folder label)
    .venv/bin/python scripts/pull_schedule.py all
"""

import datetime
import json
import os
import sys

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

import ncaa
import season
import local_data as ld

# ─── CONFIG ──────────────────────────────────────────────────────────────────
SEASON = 2026
TEAM = "all"                              # folder label under <SEASON>/, or "all"
SEASON_END = datetime.date(2026, 6, 30)   # last scoreboard date to scan for upcoming
# ─────────────────────────────────────────────────────────────────────────────


def _game(id, date, iso, opp, home, score, result, time, played):
    return {"id": id, "date": date, "iso": iso, "opp": opp, "home": home,
            "score": score, "result": result, "time": time, "played": played}


def _played_schedule(teams):
    """{seo: [game,...]} of every PLAYED game from the saved box-score folders,
    normalized to the schedule.json game shape (played=True)."""
    out = {}
    for seo, games in ld.schedules(teams).items():
        out[seo] = [_game(g.get("id"), g.get("date"), g.get("iso"), g.get("opp"),
                          g.get("home"), g.get("score"), g.get("result"),
                          g.get("time"), True)
                    for g in games]
    return out


def _upcoming_schedule(end, conf="sec"):
    """{seo: [game,...]} of UPCOMING games (strictly after today, not final) from
    the ncaa.com scoreboard, normalized to the schedule.json game shape
    (played=False, score/result=null). The 'after today' filter avoids picking up
    already-played games that ncaa.com still lists as 'pre'."""
    rank_by = season._rank_lookup()
    today_iso = season._today().isoformat()
    out, seen = {}, set()
    one = datetime.timedelta(days=1)
    d = season._today()
    while d <= end:
        try:
            board = ncaa.scoreboard(d.year, d.month, d.day)
        except (ncaa.NotFound, ncaa.APIError):
            d += one
            continue
        for wrap in board.get("games", []):
            g = wrap.get("game") or {}
            home, away = g.get("home"), g.get("away")
            if not home or not away or g.get("gameState") == "final":
                continue
            iso = season._fmt_iso(g.get("startDate", ""))
            if not iso or iso <= today_iso:          # only genuinely future games
                continue
            if not (season._in_conf(home, conf) or season._in_conf(away, conf)):
                continue
            gid = g.get("gameID")
            for side, other in ((home, away), (away, home)):
                if not season._in_conf(side, conf):
                    continue
                seo = side["names"]["seo"]
                if (seo, gid) in seen:
                    continue
                seen.add((seo, gid))
                oseo = other["names"]["seo"]
                out.setdefault(seo, []).append(_game(
                    gid, season._fmt_date(g.get("startDate", "")), iso,
                    {
                        "id": oseo,
                        "name": other["names"].get("short") or oseo,
                        "mark": (other["names"].get("char6") or oseo[:4]).upper(),
                        "logo": ncaa.logo_url(oseo),
                        "rank": rank_by.get(season._norm(other["names"].get("short") or "")),
                        "conf": season._in_conf(other, conf),
                    },
                    side is home, None, None, g.get("startTime"), False))
        d += one
    return out


def _recent_finals(scoreboard, played):
    """{seo: [game,...]} of games the scoreboard reports as FINAL that we don't yet
    have a saved box score for (matched by date) — e.g. just-played super-regional
    games. Marked played=True with the scoreboard's score, so schedule.json stays
    complete AND update.py's played-vs-saved count notices there are games to pull."""
    out = {}
    for seo, games in scoreboard.items():
        have_dates = {g.get("iso") for g in played.get(seo, [])}
        for g in games:
            if not g.get("result") or not g.get("iso") or g["iso"] in have_dates:
                continue  # not final, or already covered by a saved box score
            out.setdefault(seo, []).append(_game(
                g.get("id"), g.get("date"), g.get("iso"), g.get("opp"),
                g.get("home"), g.get("score"), g.get("result"), g.get("time"), True))
    return out


def build_full_schedules(end=SEASON_END, conf="sec", fresh=False, fresh_days=2):
    """({seo: [game,...]}, {seo: name}) — every played game (saved box scores, plus
    scoreboard finals not yet pulled) and every upcoming game (scoreboard, plus
    bracket-scheduled postseason games), per team in `conf`.

    fresh=True re-fetches the last `fresh_days` of daily scoreboards (bypassing the
    indefinite cache) so games that finished — or boards that were cached empty —
    since the board was last cached show up as finals. That's what lets update.py
    notice there are new games to pull (a wide window matters in the postseason)."""
    season_data = season.build_season(conf=conf, fresh=fresh, fresh_days=fresh_days)
    teams = season_data["teams"]
    names = {t["id"]: t["name"] for t in teams}
    conf_seos = {t["id"] for t in teams}
    played = _played_schedule(teams)                              # saved box scores
    recent = _recent_finals(season_data.get("schedules") or {}, played)  # just-played, unpulled
    upcoming = _upcoming_schedule(end, conf)                      # scoreboard, not yet played
    bracket_up = season.bracket_upcoming(conf_seos)              # bracket-scheduled (e.g. CWS)
    out = {}
    for seo in set(played) | set(recent) | set(upcoming) | set(bracket_up):
        base = played.get(seo, []) + recent.get(seo, []) + upcoming.get(seo, [])
        # Add bracket games the scoreboard sources didn't already cover (by date+opp).
        have = {(g.get("iso"), (g.get("opp") or {}).get("id")) for g in base}
        extra = [g for g in bracket_up.get(seo, [])
                 if (g.get("iso"), (g.get("opp") or {}).get("id")) not in have]
        games = base + extra
        games.sort(key=lambda e: e["iso"] or "")
        out[seo] = games
    return out, names


def write_schedule(team_dir, label, games):
    """Write team_dir/schedule.json; return (path, n_games)."""
    dest = os.path.join(team_dir, "schedule.json")
    payload = {
        "team": label,
        "season": SEASON,
        "generated": datetime.datetime.now().isoformat(timespec="minutes"),
        "games": games,
    }
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    return dest, len(games)


def write_team_schedules(labels=None, end=SEASON_END, conf="sec", fresh=False, fresh_days=2):
    """Build schedules once and write schedule.json into each team folder.
    labels=None writes every team in `conf` that has a folder; otherwise only those
    whose folder label matches (case/format-insensitive). fresh=True re-pulls the
    last `fresh_days` of scoreboards so just-finished games are picked up. Returns
    [(label, n_games, n_played)]."""
    want = {season._norm(x) for x in labels} if labels is not None else None
    sched, names = build_full_schedules(end, conf=conf, fresh=fresh, fresh_days=fresh_days)
    out = []
    for seo, games in sched.items():
        team_dir = ld._find_dir(seo, names.get(seo, seo))
        if not team_dir:
            continue
        label = os.path.basename(team_dir)
        if want is not None and season._norm(label) not in want:
            continue
        write_schedule(team_dir, label, games)
        played = sum(1 for g in games if g.get("played"))
        out.append((label, len(games), played))
    return sorted(out)


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else TEAM
    labels = None if arg.lower() == "all" else [arg]
    print("Building schedules (saved box scores + ncaa.com upcoming)…", flush=True)
    results = write_team_schedules(labels)
    if not results:
        print(f"No SEC team matched {arg!r} (or it has no Data/2026/ folder).")
        sys.exit(1)
    total = 0
    for label, n, played in results:
        total += n
        print(f"  {label}: {n} games ({played} played, {n - played} upcoming) "
              f"-> Data/2026/{label}/schedule.json")
    print(f"wrote {len(results)} schedule.json file(s), {total} games total.")
