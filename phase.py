"""Where in the season are we? — regular season vs the postseason rounds.

The box-score event text only distinguishes regular / SEC Tournament / NCAA
Tournament (it never names the NCAA round), and the live bracket can't be matched
back to our saved games (different id systems). So the NCAA round is resolved from
a small per-season date config below — the postseason rounds are fixed,
sequential weekends, the same way season.py already hard-codes SEASON_START.

Two entry points:
  * game_phase(opponent, iso) -> the round label for one game (used per-game, e.g.
    under a team's recent results). 'regular' for a regular-season game.
  * current_phase(today)      -> {phase, label} for the whole site right now.
"""

import datetime

# Per-season phase windows — contiguous and chronological, so every date maps to
# exactly one phase and the gaps between rounds fall forward into the next round
# (e.g. the days between Regionals and Super Regionals read as "Super Regionals").
# Edit these once per season.
_WINDOWS = [
    ("regular",         datetime.date(2026, 2, 13), datetime.date(2026, 5, 18)),
    ("sec_tournament",  datetime.date(2026, 5, 19), datetime.date(2026, 5, 25)),
    ("regionals",       datetime.date(2026, 5, 26), datetime.date(2026, 6,  2)),
    ("super_regionals", datetime.date(2026, 6,  3), datetime.date(2026, 6,  9)),
    ("cws",             datetime.date(2026, 6, 10), datetime.date(2026, 6, 24)),
]
_SEASON_END = datetime.date(2026, 6, 30)

# Site-wide masthead labels (homepage "what's happening now").
_SITE_LABEL = {
    "regular": "Regular Season",
    "sec_tournament": "SEC Tournament",
    "regionals": "NCAA Regionals",
    "super_regionals": "Super Regionals",
    "cws": "College World Series",
    "offseason": "Offseason",
}

# Per-game round labels (shown under a single game). NCAA games that fall outside
# every postseason window degrade to the generic label.
_GAME_LABEL = {
    "sec_tournament": "SEC Tournament",
    "regionals": "NCAA Regional",
    "super_regionals": "NCAA Super Regional",
    "cws": "College World Series",
}


def _parse_iso(iso):
    try:
        return datetime.date.fromisoformat(iso)
    except (TypeError, ValueError):
        return None


def _phase_for_date(d):
    """Phase key for a date: the earliest window not yet ended."""
    if d is None:
        return "regular"
    for key, _start, end in _WINDOWS:
        if d <= end:
            return key
    return "offseason"


def game_phase(opponent, iso=None):
    """Round label for one game, from the event text stats.ncaa.org appends to the
    opponent plus the game's date. Returns 'regular' for a regular-season game (so
    callers can still test `phase != 'regular'`), else the postseason round."""
    s = (opponent or "").lower()
    if "sec" in s and ("championship" in s or "tournament" in s):
        return _GAME_LABEL["sec_tournament"]
    if "ncaa" in s or "world series" in s or "regional" in s:
        return _GAME_LABEL.get(_phase_for_date(_parse_iso(iso)), "NCAA Tournament")
    return "regular"


def current_phase(today=None):
    """{'phase': key, 'label': display} for the site right now. `today` defaults
    to the real date, capped to the modeled season."""
    d = today or min(datetime.date.today(), _SEASON_END)
    key = _phase_for_date(d)
    return {"phase": key, "label": _SITE_LABEL.get(key, "Regular Season")}
