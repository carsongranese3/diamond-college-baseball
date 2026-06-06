"""Effective "today" for the app, with a dev time-machine (test mode).

`TEST` is the master switch:
  * TEST = False  -> everything behaves normally (the real date; no time travel).
  * TEST = True   -> the whole site behaves as though it were the test date: games
    after it read as not-yet-played, so the phase / standings / This-Week reflect
    that day.

Everything date-aware goes through clock.today(). Toggle it via /api/dev/clock.
It's a process-global, so it's a single-user dev tool, not per-request.
"""

import datetime

TEST = False     # the "test" variable — master switch for the time machine
_DATE = None     # the test date (datetime.date) used while TEST is on


def configure(test, date_iso):
    """Set the test flag and date (date_iso = 'YYYY-MM-DD'; falsy/invalid -> None)."""
    global TEST, _DATE
    TEST = bool(test)
    try:
        _DATE = datetime.date.fromisoformat(date_iso) if date_iso else None
    except (TypeError, ValueError):
        _DATE = None


def is_test():
    """True only when test mode is on AND a valid test date is set."""
    return TEST and _DATE is not None


def today():
    """The effective current date — the test date in test mode, else the real date."""
    return _DATE if is_test() else datetime.date.today()


def state():
    """Current clock state for the API / dev widget."""
    return {"test": TEST, "date": _DATE.isoformat() if _DATE else None,
            "today": today().isoformat()}
