"""Fetch NCAA stats from stats.ncaa.org using a stealth browser (Camoufox).

stats.ncaa.org sits behind Akamai bot protection that 403s plain HTTP clients
(requests / httr / urllib) by TLS+fingerprint. Camoufox is a stealth Firefox
build that presents a genuine browser fingerprint, so navigations look like real
traffic and get through (from a non-datacenter IP).

Design:
  * One dedicated browser thread (Playwright's sync API isn't thread-safe), fed
    by a queue, so many Flask requests can share a single long-lived browser.
  * Every page is cached to ./cache_ncaa_stats so we only pay the (slow) browser
    cost once per URL, and so we stay polite to the site.
  * Requests are naturally serialized through the single worker, with a small
    delay between navigations — basic rate-limiting / good-citizen behavior.

Public API:
    get_school_id("Texas")                 -> 703
    get_season_team_id(703, 2026)          -> 614793
    get_team_stats(703, 2026, "batting")   -> {"headers": [...], "rows": [...]}
    fetch_html(url)                        -> raw HTML (lower level)
    shutdown()                             -> stop the browser thread
"""

import atexit
import hashlib
import json
import os
import queue
import random
import re
import threading
import time

from bs4 import BeautifulSoup

NCAA_BASE = "https://stats.ncaa.org"
SPORT_CODE = "MBA"  # men's baseball
CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache_ncaa_stats")

SETTLE_MS_FIRST = 5000  # FIRST navigation: let the Akamai challenge fully clear
SETTLE_MS = 1200        # later navigations reuse the cleared session, so shorter
CHALLENGE_RETRIES = 3   # reloads to clear the Akamai JS challenge if it lingers
CHALLENGE_WAIT_MS = 2500  # extra wait before each challenge-clearing reload
MIN_REAL_PAGE = 2000    # a real stats.ncaa.org page is tens of KB; shorter = challenge
POLITE_DELAY = 4.0      # seconds between navigations (rate-limit; kept conservative
                        # to avoid tripping Akamai's bot protection — ~0.25 req/s)
POLITE_JITTER = 2.5     # extra random 0..JITTER s per navigation, so the request
                        # cadence isn't a fixed metronome (a real giveaway of a bot)
NAV_TIMEOUT = 60000     # ms
VERBOSE = False         # when True, print each page fetch live (pullers set this)

# ── Browser worker thread ────────────────────────────────────────────────────
_url_queue = queue.Queue()
_result_map = {}
_result_lock = threading.Lock()
_req_counter = [0]
_worker = None
_worker_lock = threading.Lock()
_ready = threading.Event()
_worker_err = [None]


def _browser_loop():
    """Runs in its own thread: owns the Camoufox browser for its whole life."""
    from camoufox.sync_api import Camoufox
    try:
        with Camoufox(headless=True) as browser:
            page = browser.new_page()
            _ready.set()
            cleared = False  # has the Akamai challenge been passed yet this session?
            while True:
                req_id, url = _url_queue.get()
                if url is None:  # shutdown sentinel
                    break
                try:
                    page.goto(url, wait_until="domcontentloaded",
                              timeout=NAV_TIMEOUT)
                    # First successful page needs the long settle to clear the
                    # Akamai challenge; after that the session is cleared and
                    # subsequent pages render fast, so a short settle is enough.
                    page.wait_for_timeout(SETTLE_MS if cleared else SETTLE_MS_FIRST)
                    html = page.content()
                    # Akamai sometimes serves a tiny JS challenge page first; it sets
                    # a clearance cookie, then a reload returns the real page. Reload
                    # a few times before giving up — far more reliable than "re-run".
                    tries = 0
                    while (len(html) < MIN_REAL_PAGE and not _looks_blocked(html)
                           and tries < CHALLENGE_RETRIES):
                        tries += 1
                        page.wait_for_timeout(CHALLENGE_WAIT_MS)
                        page.reload(wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
                        page.wait_for_timeout(SETTLE_MS_FIRST)
                        html = page.content()
                    result = ("ok", html)
                    cleared = True
                except Exception as exc:  # navigation failure
                    result = ("err", f"{type(exc).__name__}: {exc}")
                with _result_lock:
                    q = _result_map.get(req_id)
                if q is not None:
                    q.put(result)
                # Jittered delay so the inter-request cadence looks human, not like
                # a fixed-interval bot.
                time.sleep(POLITE_DELAY + random.uniform(0, POLITE_JITTER))
    except Exception as exc:  # browser failed to launch
        _worker_err[0] = f"{type(exc).__name__}: {exc}"
        _ready.set()


def _ensure_worker():
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            if VERBOSE:
                print("    (booting stealth browser — first time takes ~15-25s…)",
                      flush=True)
            _ready.clear()
            _worker_err[0] = None
            _worker = threading.Thread(target=_browser_loop, daemon=True)
            _worker.start()
    # Wait generously for the browser to boot. A slow cold start used to slip past
    # this and surface later as a cryptic queue timeout; now we wait longer and, if
    # it's truly stuck, raise a clear message instead.
    if not _ready.wait(timeout=240):
        if _worker_err[0]:
            raise RuntimeError("Camoufox failed to start: " + _worker_err[0])
        raise RuntimeError(
            "Camoufox didn't finish booting in 240s — usually resource contention "
            "(stop the webpage / close heavy apps) or a slow cold start. Just re-run.")
    if _worker_err[0]:
        raise RuntimeError("Camoufox failed to start: " + _worker_err[0])


def shutdown():
    if _worker and _worker.is_alive():
        _url_queue.put((-1, None))


def restart():
    """Close the current browser, wait for it to fully exit, and drop it so the NEXT
    fetch_html() boots a brand-new Camoufox instance.

    Why this aids stealth: each Camoufox launch (no persistent user_data_dir here)
    gets a freshly randomized fingerprint AND an empty cookie jar, so the new
    session re-clears Akamai from scratch and looks like a different device. Rotating
    mid-pull turns one suspiciously long, unbroken session into several short,
    unrelated-looking ones — which is what defeats session-length / fingerprint /
    cookie-age heuristics. It does NOT change the source IP, so it won't by itself
    beat a pure IP-rate block (POLITE_DELAY handles request rate)."""
    global _worker
    with _worker_lock:
        w = _worker
    if w and w.is_alive():
        _url_queue.put((-1, None))   # sentinel: worker exits its `with Camoufox`
        w.join(timeout=60)           # wait for the browser process to actually close
    with _worker_lock:
        _worker = None
        _ready.clear()
    # Drain anything left on the queue so the fresh worker starts clean.
    try:
        while True:
            _url_queue.get_nowait()
    except queue.Empty:
        pass


atexit.register(shutdown)


# ── HTML caching + fetch ─────────────────────────────────────────────────────
def _cache_path(url):
    h = hashlib.sha1(url.encode()).hexdigest()[:16]
    return os.path.join(CACHE_DIR, h + ".html")


class BlockedError(Exception):
    """stats.ncaa.org returned an Access Denied / bot-block page."""


def _looks_blocked(html):
    head = html[:600].lower()
    return "access denied" in head or "you don't have permission" in head


def fetch_html(url, use_cache=True):
    cpath = _cache_path(url)
    if use_cache and os.path.exists(cpath):
        with open(cpath, "r", encoding="utf-8") as fh:
            return fh.read()

    if VERBOSE:
        print(f"    ↓ {url.replace(NCAA_BASE, '')}", flush=True)
    _ensure_worker()
    with _result_lock:
        _req_counter[0] += 1
        req_id = _req_counter[0]
        reply = queue.Queue()
        _result_map[req_id] = reply
    _url_queue.put((req_id, url))
    # Generous: covers the nav plus a few Akamai challenge-clearing reloads.
    status, payload = reply.get(timeout=NAV_TIMEOUT / 1000 + 90)
    with _result_lock:
        _result_map.pop(req_id, None)

    if status == "err":
        raise RuntimeError(f"fetch failed for {url}: {payload}")
    if _looks_blocked(payload):
        raise BlockedError(f"Akamai still blocked {url}")
    # Don't cache a challenge/empty/truncated page — real stats.ncaa.org pages
    # are tens of KB. Caching a short one poisons future runs.
    if len(payload) < 2000:
        raise RuntimeError(
            f"suspiciously short response ({len(payload)} chars) for {url} — "
            "not caching (likely a challenge page; just re-run)")

    os.makedirs(CACHE_DIR, exist_ok=True)
    # Unique temp name per writer (write-then-rename) so an interrupted run can't
    # leave a truncated cache file and concurrent writers don't race on one .tmp.
    tmp = f"{cpath}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
        os.replace(tmp, cpath)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return payload


# ── Lookups ──────────────────────────────────────────────────────────────────
def get_school_id(name):
    """School name -> permanent NCAA school_id (offline table from collegebaseball)."""
    from collegebaseball import lookup
    res = lookup.lookup_school(name)
    if isinstance(res, tuple):
        return int(res[0])
    raise ValueError(f"school not found: {name!r} ({res})")


_school_cache = {}


def get_season_team_id(school_id, season):
    """Map a permanent school_id + season year -> that season's team id.

    stats.ncaa.org uses a different team id per season; the team-history page
    lists them all.
    """
    if school_id not in _school_cache:
        url = f"{NCAA_BASE}/teams/history/{SPORT_CODE}/{school_id}"
        soup = BeautifulSoup(fetch_html(url), "lxml")
        seasons = {}
        for a in soup.find_all("a", href=True):
            m = re.search(r"/teams/(\d+)", a["href"])
            if not m:
                continue
            row_text = (a.find_parent("tr").get_text(" ") if a.find_parent("tr")
                        else a.get_text(" "))
            ym = re.search(r"\b(19|20)\d{2}\b", row_text)
            if ym:
                seasons[int(ym.group(0))] = int(m.group(1))
        _school_cache[school_id] = seasons
    seasons = _school_cache[school_id]
    # stats.ncaa.org labels a spring season by the academic-year START: the
    # spring-2026 season is listed as "2025". So if an exact match isn't found,
    # fall back to (season - 1), which is how the rest of this app's "2026"
    # maps onto the NCAA listing.
    if season in seasons:
        return seasons[season]
    if (season - 1) in seasons:
        return seasons[season - 1]
    raise ValueError(f"season {season} not found for school {school_id}; "
                     f"have {sorted(seasons)}")


# ── Stat grid parsing ────────────────────────────────────────────────────────
def _parse_stat_grid(html):
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", id="stat_grid") or soup.find("table")
    if table is None:
        return {"headers": [], "rows": []}

    headers = [th.get_text(strip=True)
               for th in table.find("thead").find_all("th")] if table.find("thead") else []

    rows = []
    body = table.find("tbody") or table
    for tr in body.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue
        values = []
        for td in cells:
            # data-order holds the raw, unformatted numeric value when present
            values.append(td.attrs["data-order"] if "data-order" in td.attrs
                          else td.get_text(strip=True))
        if any(v for v in values):
            rows.append(dict(zip(headers, values)) if headers else values)
    return {"headers": headers, "rows": rows}


def get_team_stats(school_id, season, variant="batting"):
    """Season-to-date team stats for a school/season.

    variant: 'batting' (default), 'pitching', or 'fielding'.
    Returns {"headers": [...], "rows": [{header: value, ...}], "url": ...}.
    """
    season_team_id = get_season_team_id(school_id, season)
    base_url = f"{NCAA_BASE}/teams/{season_team_id}/season_to_date_stats"
    html = fetch_html(base_url)
    url = base_url

    if variant.lower() != "batting":
        # Follow the nav link for pitching/fielding (its year_stat_category_id
        # changes, so discover it rather than hardcode).
        soup = BeautifulSoup(html, "lxml")
        for a in soup.find_all("a", href=True):
            if (variant.capitalize() in a.get_text()
                    and "year_stat_category_id" in a["href"]):
                href = a["href"]
                url = href if href.startswith("http") else NCAA_BASE + href
                html = fetch_html(url)
                break

    parsed = _parse_stat_grid(html)
    parsed["url"] = url
    parsed["season_team_id"] = season_team_id
    return parsed


# ── Per-game (contest) data ──────────────────────────────────────────────────
_CONTEST_RE = re.compile(r"/contests/(\d+)/box_score")


def _iso(mmddyyyy):
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", mmddyyyy or "")
    return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else (mmddyyyy or "")


def _table_rows(table):
    """(headers, [row-values]) for a table, using data-order when present."""
    trs = table.find_all("tr")
    if not trs:
        return [], []
    headers = [c.get_text(strip=True) for c in trs[0].find_all(["th", "td"])]
    rows = []
    for tr in trs[1:]:
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue
        rows.append([c.attrs["data-order"] if "data-order" in c.attrs
                     else c.get_text(" ", strip=True) for c in cells])
    return headers, rows


def team_schedule(school_id, season):
    """List of games for a team/season: contest_id, date, opponent, home, result."""
    stid = get_season_team_id(school_id, season)
    # The schedule is a living index — games appear as they're played — so always
    # re-fetch it instead of serving the permanent cache; otherwise newly played
    # games (e.g. conference-tournament games) are never discovered.
    soup = BeautifulSoup(fetch_html(f"{NCAA_BASE}/teams/{stid}", use_cache=False), "lxml")
    games, seen = [], set()
    for a in soup.find_all("a", href=True):
        m = _CONTEST_RE.search(a["href"])
        if not m or m.group(1) in seen:
            continue
        cid = m.group(1)
        tr = a.find_parent("tr")
        cells = ([c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
                 if tr else [])
        date = next((c for c in cells if re.match(r"\d{2}/\d{2}/\d{4}", c)), "")
        result = a.get_text(strip=True)
        opp = ""
        for c in cells:
            if c in (date, result) or re.fullmatch(r"[\d,]+", c) or not c:
                continue
            opp = c
            break
        home = True
        low = opp.lower()
        if low.startswith("at "):
            home, opp = False, opp[3:].strip()
        elif opp.startswith("@"):
            home, opp = False, opp[1:].strip()
        elif low.startswith("vs"):
            opp = re.sub(r"^vs\.?\s*", "", opp, flags=re.I)
        seen.add(cid)
        games.append({"contest_id": cid, "date": date, "iso": _iso(date),
                      "opponent": opp, "home": home, "result": result})
    return games


def contest_line_score(cid):
    soup = BeautifulSoup(fetch_html(f"{NCAA_BASE}/contests/{cid}/box_score"), "lxml")
    target = None
    for t in soup.find_all("table"):
        trs = t.find_all("tr")
        if not trs:
            continue
        hdr = [c.get_text(strip=True) for c in trs[0].find_all(["th", "td"])]
        if hdr[-3:] == ["R", "H", "E"]:
            target = t
            break
    if target is None:
        return {"away": None, "home": None}
    hdr, rows = _table_rows(target)
    sides = []
    for r in rows[:2]:
        if not r:
            continue
        sides.append({"name": r[0], "innings": r[1:-3],
                      "r": r[-3], "h": r[-2], "e": r[-1]})
    return {"away": sides[0] if sides else None,
            "home": sides[1] if len(sides) > 1 else None}


_DECISION_LABELS = {"Winning Pitcher": "win", "Losing Pitcher": "loss", "Save": "save"}


def contest_decisions(cid):
    """Pitcher decisions for a contest from the box-score page's Game Leaders:
    winning pitcher, losing pitcher, and save. Returns
    {"win": d, "loss": d, "save": d} where each is None when absent (a game with
    no save omits that row) and otherwise
    {name, record, line, side, player_id}. `record` is W-L for win/loss and the
    season save count for a save; `side` is "away"/"home"; `line` is the IP/H/R/K/BB
    summary. Reuses the cached box-score page, so it costs no extra fetch."""
    soup = BeautifulSoup(fetch_html(f"{NCAA_BASE}/contests/{cid}/box_score"), "lxml")
    out = {"win": None, "loss": None, "save": None}
    for tr in soup.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        if len(cells) < 2:
            continue
        key = _DECISION_LABELS.get(cells[0].get_text(strip=True))
        if not key or out[key]:
            continue
        # The pitcher sits in the away (cell[1]) or home (cell[2]) column; the
        # other side's cell is blank.
        for side, idx in (("away", 1), ("home", 2)):
            if idx >= len(cells):
                continue
            text = cells[idx].get_text(" ", strip=True)
            if not text:
                continue
            link = cells[idx].find("a")
            name = link.get_text(strip=True) if link else text.split("(")[0].strip()
            pid = None
            if link and link.get("href"):
                m = re.search(r"/players/(\d+)", link["href"])
                pid = m.group(1) if m else None
            rec = re.search(r"\(([^)]*)\)", text)
            out[key] = {
                "name": name,
                "record": rec.group(1) if rec else None,
                "line": text[rec.end():].strip(" ,") if rec else "",
                "side": side,
                "player_id": pid,
            }
            break
    return out


def contest_info(cid):
    """Game info from the box-score page header (the grey lines under the line
    score): date, start time, venue, location, and attendance. Returns
    {date, time, venue, location, attendance}; any field is None when the page
    doesn't carry it. Reuses the cached box-score page, so it costs no extra fetch."""
    soup = BeautifulSoup(fetch_html(f"{NCAA_BASE}/contests/{cid}/box_score"), "lxml")
    info = {"date": None, "time": None, "venue": None,
            "location": None, "attendance": None}
    for td in soup.find_all("td", class_="grey_text"):
        text = td.get_text(" ", strip=True)
        if not text:
            continue
        m = re.match(r"(\d{2}/\d{2}/\d{4})(?:\s+(.+))?$", text)
        if m:
            info["date"] = m.group(1)
            info["time"] = (m.group(2) or "").strip() or None
            continue
        m = re.match(r"Attendance:\s*([\d,]+)", text)
        if m:
            info["attendance"] = m.group(1)
            continue
        # Venue line: "Venue Name (City, ST)". Require the "City, ST" shape so
        # team-record grey lines (e.g. "Auburn Tigers 16-2, Conf 2-0") don't match.
        if info["venue"] is None:
            m = re.match(r"(.+?)\s*\(([^,)]+,\s*[A-Za-z.]{2,})\)\s*$", text)
            if m:
                info["venue"], info["location"] = m.group(1).strip(), m.group(2).strip()
    return info


def _classify(headers):
    h = set(headers)
    if "AB" in h and "RBI" in h:
        return "batting"
    if "IP" in h and "ER" in h:
        return "pitching"
    if "PO" in h and "E" in h and "A" in h:
        return "fielding"
    return None


def contest_player_stats(cid):
    """Per-team batting/pitching/fielding player tables for a contest.

    Returns {"away": {...}, "home": {...}} where each side is
    {"team": name, "batting": [..], "pitching": [..], "fielding": [..]}.
    Away/home order matches the line score.
    """
    soup = BeautifulSoup(
        fetch_html(f"{NCAA_BASE}/contests/{cid}/individual_stats"), "lxml")
    comps, order = {}, []
    for t in soup.find_all("table", id=re.compile(r"competitor_\d+_year_stat_category_\d+")):
        comp = re.match(r"competitor_(\d+)_", t["id"]).group(1)
        headers, rows = _table_rows(t)
        kind = _classify(headers)
        if not kind:
            continue
        if comp not in comps:
            comps[comp] = {}
            order.append(comp)
        comps[comp][kind] = [dict(zip(headers, r)) for r in rows]

    line = contest_line_score(cid)
    names = [line["away"]["name"] if line["away"] else "",
             line["home"]["name"] if line["home"] else ""]
    out = {}
    for slot, comp in zip(("away", "home"), order):
        data = comps.get(comp, {})
        data["team"] = names[0 if slot == "away" else 1]
        out[slot] = data
    return out


def contest_play_by_play(cid):
    """Ordered [{side, team, text, score}] for a contest — BOTH teams' at-bats.

    Each inning is laid out in three columns: [away | score | home]. A row's play
    sits in whichever side column is batting. The old version read only the away
    column (cells[0]), so it silently dropped the home team's half of every game.
    """
    soup = BeautifulSoup(
        fetch_html(f"{NCAA_BASE}/contests/{cid}/play_by_play"), "lxml")
    verbs = ("walked", "singled", "grounded", "struck out", "flied", "doubled",
             "tripled", "homered", "reached", "popped", "lined", "fouled",
             "hit by pitch", "to ", "advanced", "scored", "stole")

    def _is_play(text):
        return bool(text) and any(w in text for w in verbs)

    away_name = home_name = ""
    plays = []
    for t in soup.find_all("table"):
        if not any(w in t.get_text(" ", strip=True) for w in verbs):
            continue
        for tr in t.find_all("tr"):
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
            if len(cells) < 2:
                continue
            # Header row "<Away> | Score | <Home>": capture team names, then skip.
            if len(cells) >= 3 and cells[1].strip().lower() == "score":
                away_name, home_name = cells[0], cells[2]
                continue
            score = cells[1]
            away_text = cells[0]
            home_text = cells[2] if len(cells) >= 3 else ""
            if _is_play(away_text):
                plays.append({"side": "away", "team": away_name,
                              "text": away_text, "score": score})
            if _is_play(home_text):
                plays.append({"side": "home", "team": home_name,
                              "text": home_text, "score": score})
    return plays


if __name__ == "__main__":
    import sys
    school = sys.argv[1] if len(sys.argv) > 1 else "Texas"
    season = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    variant = sys.argv[3] if len(sys.argv) > 3 else "batting"
    sid = get_school_id(school)
    print(f"{school} school_id={sid}")
    data = get_team_stats(sid, season, variant)
    print(f"{variant} stats — {len(data['rows'])} rows from {data['url']}")
    print("headers:", data["headers"])
    for row in data["rows"][:8]:
        print(row)
    shutdown()
