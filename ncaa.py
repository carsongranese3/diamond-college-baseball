"""Cached client for the henrygd NCAA API (https://ncaa-api.henrygd.me).

The public API is rate-limited to 5 req/s per IP, so every response is cached
to ./cache as JSON. Past-dated scoreboards and finished box scores never change,
so they are cached indefinitely; recent/standings data uses a short TTL.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

BASE = "https://ncaa-api.henrygd.me"
CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache")

_lock = threading.Lock()
_last_request = [0.0]
_MIN_INTERVAL = 0.25  # ~4 req/s, safely under the 5 req/s limit


class NotFound(Exception):
    """Endpoint genuinely has no data (404/400, or unparseable page)."""


class APIError(Exception):
    """Transient upstream failure (5xx / 429 / network) after retries."""


_RETRY_CODES = {429, 500, 502, 503, 504}
_MAX_RETRIES = 4


def _cache_path(key):
    safe = key.strip("/").replace("/", "__") or "root"
    return os.path.join(CACHE_DIR, safe + ".json")


def _read_cache(path, ttl):
    if not os.path.exists(path):
        return None
    if ttl is not None and (time.time() - os.path.getmtime(path)) > ttl:
        return None
    # iCloud-offloaded files are treated as a cache miss (reading them would
    # stall on a slow iCloud download); the caller refetches from the API.
    try:
        if os.stat(path).st_flags & 0x40000000:  # SF_DATALESS
            return None
    except (OSError, AttributeError):
        pass
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(path, value):
    os.makedirs(CACHE_DIR, exist_ok=True)
    # Unique temp name per writer so concurrent threads (the multi-threaded dev
    # server fires /api/bootstrap more than once at load) don't race on the same
    # .tmp file. os.replace is atomic; last writer wins on identical content.
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(value, fh)
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _throttle():
    with _lock:
        wait = _MIN_INTERVAL - (time.time() - _last_request[0])
        if wait > 0:
            time.sleep(wait)
        _last_request[0] = time.time()


def get(path, ttl=None, negative_ttl=21600):
    """GET an API path (e.g. '/rankings/baseball/d1'), JSON-decoded and cached.

    ttl=None caches forever (immutable data). Missing/404 endpoints are cached
    as a sentinel for negative_ttl seconds so we don't re-hammer dead games.
    """
    path = "/" + path.strip("/")
    cpath = _cache_path(path)

    cached = _read_cache(cpath, ttl)
    if cached is not None:
        if isinstance(cached, dict) and cached.get("__miss__"):
            raise NotFound(path)
        return cached

    req = urllib.request.Request(
        BASE + path,
        headers={"User-Agent": "diamond-sec/1.0", "Accept": "application/json"},
    )
    raw = None
    last_exc = None
    for attempt in range(_MAX_RETRIES):
        _throttle()
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read().decode("utf-8")
            break
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 400):
                _write_cache(_cache_path(path), {"__miss__": True})
                raise NotFound(path) from exc
            if exc.code in _RETRY_CODES:
                last_exc = exc
            else:
                raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_exc = exc
        # transient: back off (0.5s, 1s, 2s, …) and retry
        time.sleep(0.5 * (2 ** attempt))
    if raw is None:
        raise APIError(f"{path}: gave up after {_MAX_RETRIES} tries "
                       f"({last_exc})") from last_exc

    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        # The API returns plain text like "Could not parse data" for pages
        # ncaa.com doesn't publish (e.g. baseball standings).
        raise NotFound(f"{path}: {raw[:80]!r}") from exc

    _write_cache(cpath, value)
    return value


# ── Typed helpers ────────────────────────────────────────────────────────────

SPORT = "baseball"
DIV = "d1"


def top25(ttl=10800):
    return get(f"/rankings/{SPORT}/{DIV}", ttl=ttl)


def rpi(ttl=10800):
    return get(f"/rankings/{SPORT}/{DIV}/rpi", ttl=ttl)


def schools_index(ttl=2592000):
    return get("/schools-index", ttl=ttl)


def scoreboard(year, month, day, fresh=False):
    """One day of games. Past days are immutable; today gets a 30-min TTL."""
    ttl = 1800 if fresh else None
    return get(
        f"/scoreboard/{SPORT}/{DIV}/{year:04d}/{month:02d}/{day:02d}/all-conf",
        ttl=ttl,
    )


def bracket(year, ttl=1800):
    """The full NCAA D1 championship bracket for a season (every region, all
    rounds). The tournament is live while it runs, so cache for 30 minutes."""
    return get(f"/brackets/{SPORT}/{DIV}/{year:04d}", ttl=ttl)


def game_meta(game_id, fresh=False):
    return get(f"/game/{game_id}", ttl=1800 if fresh else None)


def boxscore(game_id, fresh=False):
    return get(f"/game/{game_id}/boxscore", ttl=1800 if fresh else None)


def playbyplay(game_id, fresh=False):
    return get(f"/game/{game_id}/play-by-play", ttl=1800 if fresh else None)


_LOGO_DIR = os.path.join(os.path.dirname(__file__), "static", "logos")


def logo_url(seo, dark=False):
    # Prefer a logo bundled in static/logos/ (downloaded once, slug-corrected for
    # schools whose stats.ncaa.org slug differs from ncaa.com's logo filename,
    # e.g. the-citadel -> citadel). Fall back to the live API otherwise.
    if seo and os.path.exists(os.path.join(_LOGO_DIR, f"{seo}.svg")):
        return f"/static/logos/{seo}.svg"
    url = f"{BASE}/logo/{seo}.svg"
    return url + "?dark=true" if dark else url
