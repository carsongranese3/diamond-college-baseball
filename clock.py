"""Effective "today" for the app, with a per-request "as-of" date.

A request's `?asof=YYYY-MM-DD` makes the whole site behave as of that day: games
after it read as not-yet-played, so the phase / standings / This-Week / stats all
reflect that day. No `asof` (or an invalid / out-of-range one) means today, the real
date. Each request resolves its own date, so concurrent viewers never disagree.

Everything date-aware goes through clock.today(). Outside a request (the startup
pre-warm thread, scripts) there is no `asof`, so it's simply the real date.
"""

import datetime

try:
    from flask import has_request_context, request
except ImportError:          # the data scripts (.venv-dev) run without Flask
    def has_request_context():
        return False
    request = None

SEASON_START = datetime.date(2026, 2, 13)
SEASON_END = datetime.date(2026, 6, 30)


def asof():
    """The honored as-of date for this request, or None. Honored only when it parses
    as YYYY-MM-DD and falls in [SEASON_START, min(real today, SEASON_END)]; anything
    else (malformed, before the season, in the future) is ignored -> None."""
    if not has_request_context():
        return None
    raw = request.args.get("asof")
    if not raw:
        return None
    try:
        d = datetime.date.fromisoformat(raw)
    except ValueError:
        return None
    if raw != d.isoformat():              # reject loose forms like 20260415
        return None
    if SEASON_START <= d <= min(datetime.date.today(), SEASON_END):
        return d
    return None


def asof_iso():
    """asof() as an ISO string, or None."""
    d = asof()
    return d.isoformat() if d else None


def today():
    """The effective current date — the request's as-of date, else the real date."""
    return asof() or datetime.date.today()


def effective_iso():
    """today() clamped to the modeled season, as an ISO string — the date-key for
    memoized data (as-of date, or the real date capped at the season end)."""
    return min(today(), SEASON_END).isoformat()
