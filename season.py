"""Discover SEC teams and build their schedules from the scoreboard crawl.

ncaa.com has no per-team schedule or baseball-standings page, so we crawl the
date-based scoreboard across the season and pivot it per team. RPI (filtered to
Conf == SEC) supplies the canonical 16-team list, overall records, and RPI rank;
the D1Baseball Top 25 supplies poll rank.
"""

import datetime
import re

import clock
import ncaa
import phase
from colors import for_seo

SEASON_START = datetime.date(2026, 2, 13)
SEASON_END = datetime.date(2026, 6, 30)
SEASON_AGGREGATE_TTL = 21600  # 6h


def _norm(name):
    name = name.lower()
    name = name.replace("&", " and ")
    name = re.sub(r"\bst\.?\b", "state", name)
    name = re.sub(r"\buniv\.?\b", "", name)
    name = re.sub(r"[^a-z0-9]+", "", name)
    return name


def _today():
    # clock.today() is the real date, or the dev-clock override when one is set.
    # Stay within the modeled 2026 season if it's later.
    return min(clock.today(), datetime.date(2026, 6, 30))


def _daterange(start, end):
    d = start
    one = datetime.timedelta(days=1)
    while d <= end:
        yield d
        d += one


def _fmt_date(mmddyyyy):
    """'05/16/2026' -> 'May 16'."""
    try:
        dt = datetime.datetime.strptime(mmddyyyy, "%m/%d/%Y")
        return dt.strftime("%b ") + str(dt.day)
    except (ValueError, TypeError):
        return mmddyyyy or ""


def _fmt_iso(mmddyyyy):
    """'05/16/2026' -> '2026-05-16' (for sortable filenames)."""
    try:
        return datetime.datetime.strptime(mmddyyyy, "%m/%d/%Y").strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return ""


def _in_conf(side, conf):
    return any(c.get("conferenceSeo") == conf for c in side.get("conferences") or [])


def _is_sec(side):
    return _in_conf(side, "sec")


def _rank_lookup():
    """Normalized team name -> Top 25 rank (int)."""
    out = {}
    try:
        data = ncaa.top25().get("data", [])
    except (ncaa.NotFound, ncaa.APIError):
        return out
    for row in data:
        team = row.get("TEAM") or row.get("School") or ""
        try:
            out[_norm(team)] = int(row.get("RANK") or row.get("Rank"))
        except (TypeError, ValueError):
            continue
    return out


def _rpi_lookup():
    """Normalized name -> {rpi, record, conf} for SEC schools."""
    out = {}
    try:
        data = ncaa.rpi().get("data", [])
    except (ncaa.NotFound, ncaa.APIError):
        return out
    for row in data:
        school = row.get("School") or ""
        try:
            rpi_rank = int(row.get("Rank"))
        except (TypeError, ValueError):
            rpi_rank = None
        out[_norm(school)] = {
            "rpi": rpi_rank,
            "record": row.get("Record") or "",
            "conf": (row.get("Conf") or "").strip(),
            "school": school,
        }
    return out


def _split_record(rec):
    m = re.match(r"\s*(\d+)\s*-\s*(\d+)", rec or "")
    if not m:
        return 0, 0
    return int(m.group(1)), int(m.group(2))


def upcoming_schedules(end=SEASON_END, conf="sec"):
    """{seo: [game, ...]} of each `conf` team's UPCOMING games (scheduled, not yet
    final) from the ncaa.com scoreboard, for dates after today through `end`.

    Same per-game shape as build_season's schedules — score/result are null and the
    scheduled start time is kept. The round (phase) is resolved from the date, since
    the scoreboard carries no event text for unplayed games. Merged into the saved
    (played-only) schedules so the schedule/Scores/This-Week views can show what's
    next.
    """
    rank_by = _rank_lookup()
    today_iso = _today().isoformat()
    out, seen = {}, set()
    one = datetime.timedelta(days=1)
    d = _today()
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
            iso = _fmt_iso(g.get("startDate", ""))
            if not iso or iso <= today_iso:           # only genuinely future games
                continue
            if not (_in_conf(home, conf) or _in_conf(away, conf)):
                continue
            gid = g.get("gameID")
            for side, other in ((home, away), (away, home)):
                if not _in_conf(side, conf):
                    continue
                seo = side["names"]["seo"]
                if (seo, gid) in seen:
                    continue
                seen.add((seo, gid))
                oseo = other["names"]["seo"]
                out.setdefault(seo, []).append({
                    "id": gid,
                    "date": _fmt_date(g.get("startDate", "")),
                    "iso": iso,
                    "opp": {
                        "id": oseo,
                        "name": other["names"]["short"] or oseo,
                        "mark": (other["names"].get("char6") or oseo[:4]).upper(),
                        "logo": ncaa.logo_url(oseo),
                        "rank": rank_by.get(_norm(other["names"]["short"] or "")),
                        "conf": _in_conf(other, conf),
                    },
                    "home": side is home,
                    "score": None,
                    "result": None,
                    "time": g.get("startTime"),
                    "phase": phase.round_by_date(iso),
                })
        d += one
    for seo in out:
        out[seo].sort(key=lambda e: e["iso"])
    return out


def bracket_upcoming(sec_seos):
    """{seo: [game, ...]} of FUTURE postseason games the BRACKET has scheduled but
    the scoreboard doesn't carry yet (e.g. College World Series matchups), per SEC
    team. Both teams must be known. Same per-game shape as upcoming_schedules
    (score/result null, scheduled time + phase kept, played=False)."""
    try:
        data = ncaa.bracket(SEASON_END.year)
    except (ncaa.NotFound, ncaa.APIError):
        return {}
    ch = (data.get("championships") or [{}])[0]
    rank_by = _rank_lookup()
    today_iso = _today().isoformat()
    out, seen = {}, set()
    for g in ch.get("games") or []:
        if g.get("gameState") == "F":           # finals come from box scores
            continue
        sides = [t for t in (g.get("teams") or []) if t.get("seoname")]
        if len(sides) < 2:                       # opponent not determined yet
            continue
        iso = _fmt_iso(g.get("startDate", ""))
        if not iso or iso <= today_iso:          # only genuinely future games
            continue
        gid = g.get("contestId")
        for t, other in ((sides[0], sides[1]), (sides[1], sides[0])):
            seo = t["seoname"]
            if seo not in sec_seos or (seo, gid) in seen:
                continue
            seen.add((seo, gid))
            oseo = other["seoname"]
            oname = other.get("nameShort") or oseo
            out.setdefault(seo, []).append({
                "id": gid,
                "date": _fmt_date(g.get("startDate", "")),
                "iso": iso,
                "opp": {
                    "id": oseo, "name": oname,
                    "mark": (("".join(w[0] for w in oname.split()) or oname)[:4]).upper(),
                    "logo": ncaa.logo_url(oseo),
                    "rank": rank_by.get(_norm(oname)),
                    "conf": oseo in sec_seos,
                },
                "home": bool(t.get("isHome")),
                "score": None, "result": None,
                "time": g.get("startTime"),
                "phase": phase.round_by_date(iso),
                "played": False,
            })
    for seo in out:
        out[seo].sort(key=lambda e: e["iso"])
    return out


def build_season(fresh=False, conf="sec"):
    """Returns {teams: [...], schedules: {seo: [games]}, updated: iso}.

    Cached in ./cache/season.json via the underlying scoreboard cache; this
    function itself recomputes from cached daily scoreboards (cheap).
    """
    today = _today()
    rank_by = _rank_lookup()
    rpi_by = _rpi_lookup()

    # seo -> team accumulator
    teams = {}
    # seo -> list of raw schedule entries
    sched = {}

    def ensure_team(side):
        seo = side["names"]["seo"]
        if seo not in teams:
            col = for_seo(seo)
            teams[seo] = {
                "id": seo,
                "name": side["names"]["short"] or side["names"]["seo"],
                "mark": (side["names"].get("char6") or seo[:4]).upper(),
                "logo": ncaa.logo_url(seo),
                "color": col["color"],
                "ink": col["ink"],
                "city": "",
                "rank": None,
                "rpi": None,
                "confW": 0, "confL": 0,
                "ovrW": 0, "ovrL": 0,
                "streak": "—",
            }
            sched[seo] = []
        return teams[seo]

    for d in _daterange(SEASON_START, today):
        is_recent = (today - d).days <= 2
        try:
            board = ncaa.scoreboard(d.year, d.month, d.day, fresh=is_recent and fresh)
        except (ncaa.NotFound, ncaa.APIError):
            continue
        for wrap in board.get("games", []):
            g = wrap.get("game") or {}
            home, away = g.get("home"), g.get("away")
            if not home or not away:
                continue
            home_sec, away_sec = _in_conf(home, conf), _in_conf(away, conf)
            if not (home_sec or away_sec):
                continue

            gid = g.get("gameID")
            state = g.get("gameState")
            final = state == "final"
            date_str = g.get("startDate", "")

            for side, other, side_is_sec in (
                (home, away, home_sec),
                (away, home, away_sec),
            ):
                if not side_is_sec:
                    continue
                ensure_team(side)
                ensure_team(other) if _in_conf(other, conf) else None
                seo = side["names"]["seo"]

                def _int(s):
                    try:
                        return int(s)
                    except (TypeError, ValueError):
                        return None

                us, them = _int(side.get("score")), _int(other.get("score"))
                result = None
                if final and us is not None and them is not None:
                    result = "W" if side.get("winner") or us > them else "L"

                sched[seo].append({
                    "id": gid,
                    "date": _fmt_date(date_str),
                    "iso": _fmt_iso(date_str),
                    "_sortkey": date_str,
                    "opp": {
                        "id": other["names"]["seo"],
                        "name": other["names"]["short"] or other["names"]["seo"],
                        "mark": (other["names"].get("char6") or other["names"]["seo"][:4]).upper(),
                        "logo": ncaa.logo_url(other["names"]["seo"]),
                        "rank": rank_by.get(_norm(other["names"]["short"] or "")),
                        "conf": _in_conf(other, conf),
                    },
                    "home": side is home,
                    "score": {"us": us, "them": them} if us is not None and them is not None else None,
                    "result": result,
                    "time": g.get("startTime") if not final else None,
                })

    # Sort each schedule chronologically and compute records/streak.
    def _key(e):
        try:
            return datetime.datetime.strptime(e["_sortkey"], "%m/%d/%Y")
        except (ValueError, TypeError):
            return datetime.datetime.max

    for seo, games in sched.items():
        games.sort(key=_key)
        t = teams[seo]
        nm = _norm(t["name"])
        t["rank"] = rank_by.get(nm)
        rinfo = rpi_by.get(nm)
        if rinfo:
            t["rpi"] = rinfo["rpi"]
            t["ovrW"], t["ovrL"] = _split_record(rinfo["record"])
        cw = cl = 0
        seq = []
        for e in games:
            if e["result"] and e["opp"]["conf"]:
                if e["result"] == "W":
                    cw += 1
                else:
                    cl += 1
            if e["result"]:
                seq.append(e["result"])
            e.pop("_sortkey", None)
        t["confW"], t["confL"] = cw, cl
        if not rinfo:
            t["ovrW"] = sum(1 for r in seq if r == "W")
            t["ovrL"] = sum(1 for r in seq if r == "L")
        if seq:
            last = seq[-1]
            n = 0
            for r in reversed(seq):
                if r == last:
                    n += 1
                else:
                    break
            t["streak"] = f"{last}{n}"

    team_list = sorted(
        teams.values(),
        key=lambda x: (x["rpi"] is None, x["rpi"] if x["rpi"] is not None else 999),
    )
    return {
        "teams": team_list,
        "schedules": sched,
        "updated": datetime.datetime.now().isoformat(timespec="minutes"),
    }
