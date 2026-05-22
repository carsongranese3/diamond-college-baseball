"""Build the game-detail payload (line score + batter/pitcher tables) from the
real box score and game metadata."""

import ncaa
from boxutil import player_name, to_int
from colors import for_seo


def _side_meta(box, is_home):
    for t in box.get("teams", []):
        if bool(t.get("isHome")) == is_home:
            return t
    return {}


def _linescore(meta, is_home):
    """Return (innings, totals) for a side.

    ncaa.com's linescores array holds the numbered innings AND the R/H/E total
    columns (period 'R'/'H'/'E'). Only the numbered periods are innings; the
    rest are totals — never sum them into the run total.
    """
    key = "home" if is_home else "visit"
    innings, totals = [], {}
    for ls in meta.get("linescores", []):
        period = str(ls.get("period", "")).strip()
        raw = ls.get(key)
        val = to_int(raw) if str(raw).strip().lstrip("-").isdigit() else 0
        if period.isdigit():
            innings.append(val)
        elif period in ("R", "H", "E"):
            totals[period] = val
    return innings, totals


def _batters(tb):
    rows = []
    for p in tb.get("playerStats", []):
        bs = p.get("batterStats")
        if not bs:
            continue
        hs = p.get("hittingSeason") or {}
        rows.append({
            "name": player_name(p),
            "pos": (p.get("position") or "").upper(),
            "ab": to_int(bs.get("atBats")),
            "r": to_int(bs.get("runsScored")),
            "h": to_int(bs.get("hits")),
            "rbi": to_int(bs.get("runsBattedIn")),
            "bb": to_int(bs.get("walks")),
            "k": to_int(bs.get("strikeouts")),
            "avg": _avg(hs.get("battingAverage")),
        })
    return rows


def _avg(v):
    """'0.374' -> '.374'."""
    try:
        f = float(v)
        s = f"{f:.3f}"
        return s[1:] if s.startswith("0") else s
    except (TypeError, ValueError):
        return str(v or "")


def _pitchers(tb):
    rows = []
    for p in tb.get("playerStats", []):
        ps = p.get("pitcherStats")
        if not ps:
            continue
        dec = "—"
        if to_int(ps.get("win")):
            dec = "W"
        elif to_int(ps.get("loss")):
            dec = "L"
        elif to_int(ps.get("save")):
            dec = "SV"
        rows.append({
            "name": player_name(p),
            "ip": ps.get("inningsPitched") or "0.0",
            "h": to_int(ps.get("hitsAllowed")),
            "r": to_int(ps.get("runsAllowed")),
            "er": to_int(ps.get("earnedRunsAllowed")),
            "bb": to_int(ps.get("walksAllowed")),
            "k": to_int(ps.get("strikeouts")),
            "era": str(ps.get("earnedRunAverage") or ""),
            "dec": dec,
        })
    return rows


def _team_id(box, is_home):
    m = _side_meta(box, is_home)
    return str(m.get("teamId"))


def build_game(game_id):
    box = ncaa.boxscore(game_id)
    try:
        meta = ncaa.game_meta(game_id).get("contests", [{}])[0]
    except (ncaa.NotFound, ncaa.APIError, IndexError, KeyError):
        meta = {}

    def side(is_home):
        m = _side_meta(box, is_home)
        seo = m.get("seoname", "")
        col = for_seo(seo)
        color = m.get("color") or col["color"]
        innings, totals = _linescore(meta, is_home)
        runs = totals.get("R", sum(innings))  # R column, not the summed row
        return {
            "name": m.get("nameShort") or seo,
            "mark": (m.get("name6Char") or seo[:4]).upper(),
            "seo": seo,
            "logo": ncaa.logo_url(seo) if seo else "",
            "color": color,
            "ink": col["ink"],
            "innings": innings,
            "r": runs,
            "_totals": totals,
            "_id": str(m.get("teamId")),
        }

    away, home = side(False), side(True)

    def tb_for(team_id):
        return next((b for b in box.get("teamBoxscore", [])
                     if str(b.get("teamId")) == team_id), {}) or {}

    home_tb = tb_for(home["_id"])
    away_tb = tb_for(away["_id"])

    def team_hits(tb):
        return sum(to_int((p.get("batterStats") or {}).get("hits"))
                   for p in tb.get("playerStats", []))

    def team_err(tb):
        return sum(to_int((p.get("fieldStats") or {}).get("errors"))
                   for p in tb.get("playerStats", []))

    # Prefer the authoritative H/E from the line-score totals; fall back to
    # summing the box score if those columns are missing.
    home["h"] = home["_totals"].get("H", team_hits(home_tb))
    home["e"] = home["_totals"].get("E", team_err(home_tb))
    away["h"] = away["_totals"].get("H", team_hits(away_tb))
    away["e"] = away["_totals"].get("E", team_err(away_tb))
    for s in (home, away):
        s.pop("_id", None)
        s.pop("_totals", None)

    winner_id = str(meta.get("winner") or "")
    final = (meta.get("gameState") == "F") or bool(meta.get("finalMessage"))

    return {
        "venue": "",
        "attendance": None,
        "weather": None,
        "duration": meta.get("finalMessage") or ("Final" if final else ""),
        "homeTeam": home["seo"],
        "awayTeam": away["seo"],
        "winner": "home" if winner_id and winner_id == _team_id(box, True) else (
            "away" if winner_id else None),
        "line": {"away": away, "home": home},
        "batters": {"home": _batters(home_tb), "away": _batters(away_tb)},
        "pitchers": {"home": _pitchers(home_tb), "away": _pitchers(away_tb)},
        "plays": [],   # ncaa.com path has no play-by-play; local games fill this
        "notes": [],
    }
