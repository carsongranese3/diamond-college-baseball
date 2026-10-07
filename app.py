"""Diamond/SEC — Flask backend backed by live ncaa.com data (henrygd NCAA API).

Endpoints:
  GET /api/bootstrap      SEC teams + per-team schedules (from scoreboard crawl)
  GET /api/team/<seo>     team season batting/pitching + player roster
  GET /api/game/<id>      single-game box score + line score
"""

import datetime
import os
import sys
import threading
import time

from flask import Flask, abort, jsonify, request, send_from_directory

import boxutil
import bracket
import clock
import local_data
import ncaa
import phase
import season
from gamedetail import build_game
from stats import compute_team_stats


def _team_name(seo):
    # Resolve across every conference (an ACC team isn't in the SEC build).
    data = _season_for_league("ncaa")
    return next((t["name"] for t in data["teams"] if t["id"] == seo), seo)

app = Flask(__name__, static_folder="static", static_url_path="/static")

_mem = {}
_mem_lock = threading.Lock()
# Date-keyed entries multiply with every as-of date viewed, so the memo is bounded:
# past _MEM_SWEEP entries each write drops expired ones, and past _MEM_MAX the
# oldest are evicted too.
_MEM_SWEEP = 400
_MEM_MAX = 1500


def _memo(key, ttl, producer):
    now = time.time()
    with _mem_lock:
        hit = _mem.get(key)
        if hit and now - hit[0] < hit[2]:
            return hit[1]
    value = producer()
    with _mem_lock:
        _mem[key] = (now, value, ttl)
        if len(_mem) > _MEM_SWEEP:
            for k in [k for k, v in _mem.items() if now - v[0] >= v[2]]:
                del _mem[k]
            if len(_mem) > _MEM_MAX:
                for k in sorted(_mem, key=lambda k: _mem[k][0])[:len(_mem) - _MEM_MAX]:
                    del _mem[k]
    return value


def _dkey():
    """The effective date as a memo-key part: the request's as-of date, else the real
    date capped at the season end. Every date-sensitive memo key includes it."""
    return clock.effective_iso()


def _league_json(prefix, ttl, fn, by_date=False):
    """A ?league=-scoped, memoized JSON endpoint. by_date keys the cache on the
    effective date too (for week-relative data + the as-of date)."""
    league = request.args.get("league", "sec")
    key = f"{prefix}:{_dkey()}:{league}" if by_date else f"{prefix}:{league}"
    return jsonify(_memo(key, ttl, lambda: fn(league)))


# ── Conferences / leagues ────────────────────────────────────────────────────
# "League" in the API is either a conference (its scoreboard seo: sec/acc/…) or
# "ncaa" meaning every conference that has a Data/2026/<Conf>/ data folder.

def _available_confs():
    """[(label, seo)] for each conference folder under the Data/2026/ data root, e.g.
    [("ACC", "acc"), ("SEC", "sec")]."""
    root = local_data.DATA_ROOT
    out = []
    if os.path.isdir(root):
        for d in sorted(os.listdir(root)):
            full = os.path.join(root, d)
            if os.path.isdir(full) and not local_data._is_team_dir(full):
                out.append((d, d.lower().replace(" ", "-")))
    return out


def _confs_for_league(league):
    """The (label, seo) conferences a league spans: all of them for 'ncaa', else
    the single one whose seo or label matches."""
    confs = _available_confs()
    lg = (league or "sec").lower()
    if lg in ("ncaa", "all", ""):
        return confs
    return [c for c in confs if c[1] == lg or c[0].lower() == lg]


def _season_for_league(league):
    """{teams (each tagged with its 'conference'), schedules, updated} merged across
    the league's conferences. Lightweight (scoreboard-built); memoized per league."""
    def build():
        teams, schedules = [], {}
        for label, seo in _confs_for_league(league):
            d = _memo(f"season:conf:{seo}:{_dkey()}", season.SEASON_AGGREGATE_TTL,
                      lambda seo=seo: season.build_season(conf=seo))
            teams += [{**t, "conference": label} for t in d["teams"]]
            schedules.update(d["schedules"])
        return {"teams": teams, "schedules": schedules,
                "updated": datetime.datetime.now().isoformat(timespec="minutes")}
    return _memo(f"season:{league}:{_dkey()}", season.SEASON_AGGREGATE_TTL, build)


def _conf_full(label, seo, asof):
    """(teams-with-records, full-schedules) for one conference — played games from
    saved box scores, plus upcoming (scoreboard) and bracket-scheduled games, with
    each team tagged by conference. The per-conference half of /api/bootstrap.
    `asof` is the honored as-of date (ISO) or None; results after it are nulled."""
    dkey = _dkey()
    data = _memo(f"season:conf:{seo}:{dkey}", season.SEASON_AGGREGATE_TTL,
                 lambda seo=seo: season.build_season(conf=seo))
    schedules = _memo(f"local_schedules:{seo}", season.SEASON_AGGREGATE_TTL,
                      lambda seo=seo, data=data: local_data.schedules(data["teams"]))
    upcoming = _memo(f"upcoming:{seo}:{dkey}", 1800,
                     lambda seo=seo: season.upcoming_schedules(conf=seo))
    conf_seos = {t["id"] for t in data["teams"]}
    bracket_up = _memo(f"bracket_up:{seo}:{dkey}", 1800,
                       lambda conf_seos=conf_seos: season.bracket_upcoming(conf_seos))
    full = {}
    for tseo, played in schedules.items():
        played_dates = {g["iso"] for g in played if g.get("iso")}
        games = list(played) + [g for g in upcoming.get(tseo, [])
                                if g.get("iso") not in played_dates]
        have_dates = {g.get("iso") for g in games}
        games += [g for g in bracket_up.get(tseo, []) if g.get("iso") not in have_dates]
        if asof:
            games = [dict(g, result=None, score=None) if (g.get("iso") or "") > asof else g
                     for g in games]
        games.sort(key=lambda g: g.get("iso") or "")
        full[tseo] = games
    records = local_data.regular_season_records(full)
    teams = [{**t, "conference": label, **records.get(t["id"], {})}
             for t in data["teams"]]
    return teams, full


# Every conference tournament (SEC/ACC/Big Ten/Big 12/…) shares one rank + phase key.
_CONF_TOURNEYS = ("SEC Tournament", "ACC Tournament", "Big Ten Tournament",
                  "Big 12 Tournament", "Conference Tournament")
_ROUND_RANK = {"regular": 0, "NCAA Regional": 2,
               "NCAA Super Regional": 3, "College World Series": 4,
               **{r: 1 for r in _CONF_TOURNEYS}}
_ROUND_PHASE = {"regular": "regular",
                "NCAA Regional": "regionals", "NCAA Super Regional": "super_regionals",
                "College World Series": "cws",
                **{r: "sec_tournament" for r in _CONF_TOURNEYS}}


def _cws_finals_started():
    """True once the effective date has reached the CWS Finals' first scheduled game
    (the finals start date comes from the bracket, so it's data-driven — not a fixed
    calendar guess — yet still respects the as-of date via clock.today()). Until
    then the site stays on the CWS bracket screen, so the two stages stay distinct."""
    try:
        center = _bracket_ncaa().get("center") or {}
    except Exception:
        return False
    start = (center.get("finals") or {}).get("startDate")
    return bool(start and clock.today().isoformat() >= start)


def _live_phase(full):
    """Site phase that advances to the next round the day AFTER the current round's
    games end (rather than on a fixed calendar boundary): the round of today's
    games if any, else the round of the soonest upcoming game. Falls back to the
    date-based phase when nothing is scheduled (offseason). CWS-vs-Finals is
    disambiguated by the date window since both carry the same game-level round.

    The regular -> conference-tournament jump is data-driven: the site stays in the
    Regular Season until the LAST regular-season game on any team's schedule has
    been played (i.e. every team has finished), then moves on — so a late/makeup
    regular game keeps the site in-season even past the nominal calendar window."""
    datebased = phase.current_phase()
    today = clock.today().isoformat()
    rounds_today, next_iso, next_round, last_regular = set(), None, None, ""
    for games in full.values():
        for g in games:
            iso, rd = g.get("iso"), g.get("phase") or "regular"
            if not iso:
                continue
            if rd == "regular" and iso > last_regular:
                last_regular = iso
            if iso == today:
                rounds_today.add(rd)
            elif iso > today and (next_iso is None or iso < next_iso):
                next_iso, next_round = iso, rd
    # Hold the Regular Season until every team's final regular game has been played
    # (today is on or before the last regular-season date); only then advance.
    if last_regular and today <= last_regular:
        return {"phase": "regular", "label": phase._SITE_LABEL["regular"]}
    if rounds_today:
        rd = max(rounds_today, key=lambda r: _ROUND_RANK.get(r, -1))
    elif next_round:
        rd = next_round
    else:
        return datebased
    key = _ROUND_PHASE.get(rd, "regular")
    # CWS and its Finals share the same game-level round, so disambiguate: switch to
    # the Finals once the bracket says the matchup is set (data-driven, the day the
    # finals begin), falling back to the calendar window if the bracket isn't ready.
    if key == "cws" and (_cws_finals_started() or datebased["phase"] == "cws_finals"):
        key = "cws_finals"
    return {"phase": key, "label": phase._SITE_LABEL.get(key, datebased["label"])}


def _bracket_ncaa():
    """The NCAA bracket for this request's date (games after the as-of date are
    unplayed — no spoilers), memoized 30 min per effective date."""
    asof = clock.asof_iso()
    return _memo(f"bracket_ncaa:{_dkey()}", 1800, lambda: bracket.ncaa_bracket(asof=asof))


def _super_regionals():
    """The Super Regional matchups (each: two teams + their official national
    seeds) from the NCAA bracket — for the homepage 'The Field' and team pages.
    Empty list if the bracket isn't available."""
    try:
        tree = _bracket_ncaa().get("tree") or {}
    except Exception:
        return []
    out = []
    for side in ("left", "right"):
        for sup in tree.get(side, []):
            s = sup.get("super") or {}
            if s.get("top") or s.get("bottom"):
                # Host = higher seed of the two advancing teams (bracket.py computes
                # this, accounting for upsets); names the Super by its city.
                out.append({"id": sup.get("id"), "top": s.get("top"),
                            "bottom": s.get("bottom"), "city": sup.get("host_city")})
    return out


def _regional_cities():
    """{team_seo: host_city} for every team in every NCAA regional, so any team's
    regional can be named by its host city ("Austin Regional") from the homepage."""
    try:
        return _bracket_ncaa().get("regional_cities") or {}
    except Exception:
        return {}


def _team_stats(seo, name, sched):
    """Season stats for one team as of this request's date (memoized per date, shared
    by the team page + both leaderboards). Prefers the locally-saved stats.ncaa.org
    data; falls back to the ncaa.com API. Only games on/before the as-of date count."""
    asof = clock.asof_iso()
    return _memo(f"team:{seo}:{_dkey()}", 21600,
                 lambda: local_data.team_stats(seo, name, asof)
                 or (compute_team_stats(seo, sched, asof) if sched is not None else None))


def _qualifiers(stats):
    """(min AB, min IP) for leaderboard qualification: 50 AB / 20 IP over a full
    season, scaled down early (2 AB and 1 IP per team game) so an early as-of date
    still has leaders."""
    gp = (stats or {}).get("_games") or 0
    return min(50, 2 * gp), min(20, gp)


def _ip_float(ip):
    try:
        return float(ip)
    except (TypeError, ValueError):
        return 0.0


def _conference_leaders(league="sec"):
    """Top-3 leaders in AVG / HR / ERA for a league, found by walking every team's
    roster: pool the qualified players across all teams, then take the best three
    (so one team can place multiple players, and a later team pushes weaker ones
    out of the top three)."""
    data = _season_for_league(league)
    avg_pool, rbi_pool, hr_pool, ops_pool = [], [], [], []
    era_pool, k_pool, wins_pool, whip_pool, fip_pool = [], [], [], [], []
    for t in data["teams"]:
        seo, name = t["id"], t["name"]
        sched = data["schedules"].get(seo)
        try:
            stats = _team_stats(seo, name, sched)
        except Exception:
            stats = None
        min_ab, min_ip = _qualifiers(stats)
        roster = (stats or {}).get("roster") or {}
        for b in roster.get("batters", []):
            try:
                ab = int(b.get("ab") or 0)
            except (TypeError, ValueError):
                ab = 0
            if ab >= min_ab and b.get("avg"):
                avg_pool.append((_ip_float(b["avg"]), t, b, b["avg"]))
            # OPS — computable advanced stat (replaces wRC+ from the mockup).
            if ab >= min_ab and b.get("ops"):
                ops_pool.append((_ip_float(b["ops"]), t, b, b["ops"]))
            try:
                hr = int(b.get("hr") or 0)
            except (TypeError, ValueError):
                hr = 0
            if hr > 0:
                hr_pool.append((hr, t, b, str(hr)))
            try:
                rbi = int(b.get("rbi") or 0)
            except (TypeError, ValueError):
                rbi = 0
            if rbi > 0:
                rbi_pool.append((rbi, t, b, str(rbi)))
        for p in roster.get("pitchers", []):
            qual = _ip_float(p.get("ip")) >= min_ip
            if qual and p.get("era"):
                era_pool.append((_ip_float(p["era"]), t, p, p["era"]))
            # WHIP + FIP — computable advanced pitching stats (lower is better).
            if qual and p.get("whip"):
                whip_pool.append((_ip_float(p["whip"]), t, p, p["whip"]))
            if qual and p.get("fip"):
                fip_pool.append((_ip_float(p["fip"]), t, p, p["fip"]))
            try:
                k = int(p.get("k") or 0)
            except (TypeError, ValueError):
                k = 0
            if k > 0:
                k_pool.append((k, t, p, str(k)))
            try:
                w = int(p.get("w") or 0)
            except (TypeError, ValueError):
                w = 0
            if w > 0:
                wins_pool.append((w, t, p, str(w)))

    def fmt(e):
        _v, t, p, val = e
        return {"player": p.get("name"), "team": t["id"], "abbr": t.get("mark"),
                "pos": p.get("pos"), "value": val}

    def top(pool, reverse):
        return [fmt(e) for e in sorted(pool, key=lambda x: x[0], reverse=reverse)[:3]]

    return {
        # batters
        "avg": {"label": "Batting Avg", "unit": "AVG", "list": top(avg_pool, True)},
        "rbi": {"label": "RBI", "unit": "RBI", "list": top(rbi_pool, True)},
        "hr": {"label": "Home Runs", "unit": "HR", "list": top(hr_pool, True)},
        "ops": {"label": "OPS", "unit": "ADV", "list": top(ops_pool, True)},
        # pitchers
        "era": {"label": "Earned Run Avg", "unit": "ERA", "list": top(era_pool, False)},
        "k": {"label": "Strikeouts", "unit": "K", "list": top(k_pool, True)},
        "whip": {"label": "WHIP", "unit": "", "list": top(whip_pool, False)},
        "fip": {"label": "FIP", "unit": "ADV", "list": top(fip_pool, False)},
        "wins": {"label": "Wins", "unit": "W", "list": top(wins_pool, True)},
    }


@app.route("/api/conference-leaders")
def conference_leaders():
    return _league_json("conference_leaders", season.SEASON_AGGREGATE_TTL, _conference_leaders,
                        by_date=True)


def _stat_leaders(league="sec"):
    """Pooled, league-wide player-stats leaderboard for the Stats page. Walks every
    team's roster (sharing the team:{seo} cache with _conference_leaders) and flattens
    the qualified batters and pitchers into two flat lists of player cards. The
    frontend does all the sorting / column / leader-hero logic, so rate stats stay as
    their pre-formatted display strings and only the identity + raw stat fields ship."""
    data = _season_for_league(league)
    batters, pitchers = [], []
    for t in data["teams"]:
        seo, name = t["id"], t["name"]
        sched = data["schedules"].get(seo)
        try:
            stats = _team_stats(seo, name, sched)
        except Exception:
            stats = None
        min_ab, min_ip = _qualifiers(stats)
        roster = (stats or {}).get("roster") or {}
        ident = {"team": t["name"], "seo": t["id"], "abbr": t.get("mark"),
                 "color": t.get("color"), "logo": t.get("logo"),
                 "conference": t.get("conference")}
        # Ship each qualified player's FULL counting line (everything local_data
        # exposes) + team identity, so the frontend can show / compute any stat —
        # basic counting, the stored rates, or the advanced metrics it derives.
        for b in roster.get("batters", []):
            try:
                ab = int(b.get("ab") or 0)
            except (TypeError, ValueError):
                ab = 0
            if ab >= min_ab:                   # qualified batters only
                batters.append({**b, **ident, "type": "B"})
        for p in roster.get("pitchers", []):
            if _ip_float(p.get("ip")) >= min_ip:   # qualified pitchers only
                pitchers.append({**p, **ident, "type": "P"})
    return {"batters": batters, "pitchers": pitchers,
            "teams": len(data["teams"]), "updated": data["updated"]}


@app.route("/api/stat-leaders")
def stat_leaders():
    return _league_json("stat_leaders", season.SEASON_AGGREGATE_TTL, _stat_leaders,
                        by_date=True)


def _rankings_history(league="sec"):
    """Each team's standings position week by week within its league, from the
    precomputed weekly records (scripts/build_records.py). For every week, teams are
    ranked by conference win pct (tiebreak conf wins, then name) — the same ordering
    the Standings table uses — and assigned 1..N. Returns
    {weeks: [{n, start, end}], teams: {seo: [{n, rank, confW, confL, ovrW, ovrL}]}}."""
    data = _season_for_league(league)
    teams = data["teams"]
    weekly = local_data.weekly_records(teams, clock.asof_iso())
    name_by = {t["id"]: t["name"] for t in teams}
    by_team = {seo: {w["n"]: w for w in rows} for seo, rows in weekly.items()}
    week_ns = sorted({w["n"] for rows in weekly.values() for w in rows})
    series = {seo: [] for seo in weekly}
    weeks_meta = []
    for n in week_ns:
        present = [(seo, by_team[seo][n]) for seo in weekly if n in by_team[seo]]
        present.sort(key=lambda it: (
            -(it[1]["confW"] / max(it[1]["confW"] + it[1]["confL"], 1)),
            -it[1]["confW"], name_by.get(it[0], it[0])))
        for rank, (seo, w) in enumerate(present, 1):
            series[seo].append({"n": n, "rank": rank,
                                "confW": w["confW"], "confL": w["confL"],
                                "ovrW": w["ovrW"], "ovrL": w["ovrL"]})
        first = present[0][1] if present else {}
        weeks_meta.append({"n": n, "start": first.get("start"), "end": first.get("end")})
    return {"weeks": weeks_meta, "teams": series}


@app.route("/api/rankings/history")
def rankings_history():
    return _league_json("rankings_history", season.SEASON_AGGREGATE_TTL, _rankings_history,
                        by_date=True)


def _slug(name):
    """A best-effort ncaa.com logo slug from a team name (Georgia Tech -> georgia-tech)."""
    s = "".join(c if c.isalnum() else "-" for c in (name or "").lower())
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")


def _logo_norm(s):
    """Match key for a school name vs a logo file: lowercased, the word 'state' folded
    to 'st' (logos use the -st slug), non-alphanumerics dropped. So 'Oregon State' and
    the file 'oregon-st.svg' both reduce to 'oregonst'."""
    return "".join(c for c in (s or "").lower().replace("state", "st") if c.isalnum())


_logo_index_cache = None


def _logo_seo_index():
    """{normalized name -> logo seo} built from the bundled static/logos/ files, so a
    poll/RPI display name resolves to the right logo even when its slug differs."""
    global _logo_index_cache
    if _logo_index_cache is None:
        idx = {}
        try:
            for f in os.listdir(ncaa._LOGO_DIR):
                if f.endswith(".svg"):
                    idx.setdefault(_logo_norm(f[:-4]), f[:-4])
        except OSError:
            pass
        _logo_index_cache = idx
    return _logo_index_cache


# Poll/RPI display names whose normalized form still doesn't match a logo file —
# abbreviations and misspellings the index can't catch. Keyed by _logo_norm(name).
_NAME_LOGO_ALIASES = {
    "fsu": "florida-st",
    "jaxst": "jacksonville-st",   # "Jax State"
    "lousiana": "louisiana",      # the poll's misspelling of "Louisiana"
}


def _resolve_logo_seo(name):
    """ncaa.com logo slug for a poll/RPI display name — maps name quirks to the bundled
    logos (e.g. 'Oregon State' -> oregon-st, 'FSU' -> florida-st) so the NCAA standings
    show real logos instead of the initials fallback. Falls back to a plain slug."""
    key = _logo_norm(name)
    return _NAME_LOGO_ALIASES.get(key) or _logo_seo_index().get(key) or _slug(name)


def _top25():
    """The official D1 Top 25 poll as [{rank, name, record, prev, seo, logo,
    conference, known}]. Teams we have data for get their real seo/logo/conference
    (and are clickable); others get a slugged logo + name only. Powers the NCAA
    standings view."""
    try:
        rows = ncaa.top25().get("data", [])
    except (ncaa.NotFound, ncaa.APIError):
        return []
    by_norm = {season._norm(t["name"]): t
               for t in _season_for_league("ncaa")["teams"]}
    out = []
    for r in rows:
        name = r.get("TEAM") or r.get("School") or ""
        try:
            rank = int(r.get("RANK") or r.get("Rank"))
        except (TypeError, ValueError):
            continue
        t = by_norm.get(season._norm(name))
        seo = t["id"] if t else _resolve_logo_seo(name)
        out.append({
            "rank": rank,
            "name": t["name"] if t else name,
            "record": r.get("OVERALL RECORD") or r.get("Record") or "",
            "prev": str(r.get("PREVIOUS RANK") or "").strip(),
            "seo": seo,
            "logo": t["logo"] if t else (ncaa.logo_url(seo) if seo else ""),
            "conference": t.get("conference") if t else None,
            "known": t is not None,
        })
    out.sort(key=lambda x: x["rank"])
    return out[:25]


@app.route("/api/rankings/top25")
def rankings_top25():
    return jsonify(_memo("top25", season.SEASON_AGGREGATE_TTL, _top25))


def _prev_week_window():
    """The previous COMPLETED Tue–Mon week as (start, end) dates. Weeks run Tue–Mon
    (a Monday game belongs to the weekend it follows), so this is the week before the
    one containing today."""
    today = clock.today()
    this_tue = today - datetime.timedelta(days=(today.weekday() - 1) % 7)
    return this_tue - datetime.timedelta(days=7), this_tue - datetime.timedelta(days=1)


# Composite ranking shared by Player of the Week and Players to Watch — the SAME
# formula as the homepage "Players of the Season": batters combine OPS + HR + RBI
# (each normalized to the pool max), pitchers combine ERA + WHIP + SO (min-max
# normalized, ERA & WHIP inverted since lower is better). Higher score = better.
#
# The normalization COEFFICIENTS are computed from the NATIONAL pool (every league's
# qualified players), so a player is always measured against everyone — not just his
# own conference. `_*_coeffs` build the yardstick from a reference pool; `_score_*`
# then score any subset of players against it. Volume-guarded entries are passed in so
# tiny-sample lines don't skew the coefficients. Entries are [(seo, name, counts), ...];
# scores come back as [(score, seo, name, counts), ...].
def _bat_triple(c):
    ab = c["ab"]
    denom = ab + c["bb"] + c["hbp"]
    obp = (c["h"] + c["bb"] + c["hbp"]) / denom if denom else 0.0
    slg = c["tb"] / ab if ab else 0.0
    return (obp + slg, c["hr"], c["rbi"])            # (ops, hr, rbi)


def _pit_triple(c):
    outs = c["outs"]
    era = c["er"] * 27 / outs if outs else 0.0
    whip = (c["h"] + c["bb"]) * 3 / outs if outs else 0.0
    return (era, whip, c["k"])                       # (era, whip, so)


def _bat_coeffs(entries):
    """Per-stat maxima (OPS, HR, RBI) for the batter composite, from a reference pool."""
    triples = [_bat_triple(c) for _s, _n, c in entries]
    return (max([t[0] for t in triples] + [1e-9]),
            max([t[1] for t in triples] + [1e-9]),
            max([t[2] for t in triples] + [1e-9]))


def _pit_coeffs(entries):
    """Per-stat (min, span) for the pitcher composite (ERA, WHIP, SO), from a pool."""
    triples = [_pit_triple(c) for _s, _n, c in entries]

    def _rng(i):
        xs = [t[i] for t in triples] or [0.0]
        mn = min(xs)
        return mn, max(max(xs) - mn, 1e-9)
    return (_rng(0), _rng(1), _rng(2))


def _score_bats(entries, coeffs):
    mo, mh, mr = coeffs
    out = []
    for seo, name, c in entries:
        o, h, r = _bat_triple(c)
        out.append((o / mo + h / mh + r / mr, seo, name, c))
    return out


def _score_pits(entries, coeffs):
    (e_min, e_span), (w_min, w_span), (s_min, s_span) = coeffs
    out = []
    for seo, name, c in entries:
        e, w, s = _pit_triple(c)
        out.append(((1 - (e - e_min) / e_span) + (1 - (w - w_min) / w_span) + (s - s_min) / s_span,
                    seo, name, c))
    return out


def _batter_week_card(seo, pname, c, team_by):
    """A batter display card from that week's counting totals."""
    t, ab = team_by.get(seo, {}), c["ab"]
    denom = ab + c["bb"] + c["hbp"]
    avg = c["h"] / ab if ab else 0.0
    obp = (c["h"] + c["bb"] + c["hbp"]) / denom if denom else 0.0
    slg = c["tb"] / ab if ab else 0.0
    return {
        "player": pname, "team": seo, "abbr": t.get("mark"), "teamName": t.get("name"),
        "pos": c.get("pos") or "",
        "basic": [{"label": "AVG", "value": boxutil.fmt3(avg)},
                  {"label": "HR", "value": str(c["hr"])},
                  {"label": "RBI", "value": str(c["rbi"])},
                  {"label": "BB", "value": str(c["bb"])}],
        "adv": [{"label": "OPS", "value": boxutil.fmt3(obp + slg)},
                {"label": "ISO", "value": boxutil.fmt3(slg - avg)},
                {"label": "OBP", "value": boxutil.fmt3(obp)},
                {"label": "GPA", "value": boxutil.fmt3((1.8 * obp + slg) / 4)}],
    }


def _pitcher_week_card(seo, pname, c, team_by):
    """A pitcher display card from that week's counting totals."""
    t, outs = team_by.get(seo, {}), c["outs"]
    era = c["er"] * 27 / outs if outs else 0.0
    whip = (c["h"] + c["bb"]) * 3 / outs if outs else 0.0
    return {
        "player": pname, "team": seo, "abbr": t.get("mark"), "teamName": t.get("name"),
        "pos": "P",
        "basic": [{"label": "ERA", "value": boxutil.fmt2(era)},
                  {"label": "K", "value": str(c["k"])},
                  {"label": "BB", "value": str(c["bb"])},
                  {"label": "IP", "value": boxutil.outs_to_ip(outs)}],
        "adv": [{"label": "FIP", "value": boxutil.fip(c["hr"], c["bb"], c["hbp"], c["k"], outs)},
                {"label": "WHIP", "value": boxutil.fmt2(whip)},
                {"label": "K/9", "value": boxutil.per9(c["k"], outs)},
                {"label": "BB/9", "value": boxutil.per9(c["bb"], outs)}],
    }


def _player_of_week(league="sec"):
    """Best batter + best pitcher over the PREVIOUS Tue-Mon week in a league, by the
    weekly formulas above. Each winner carries their team and that week's stat line.
    Returns {window, batter|None, pitcher|None}."""
    start, end = _prev_week_window()
    # National pool (every conference) sets the composite coefficients so the winner is
    # measured against all players, not just his league; the selection is the league's
    # own best line, scored against that national yardstick.
    nat = _season_for_league("ncaa")
    nat_by = {t["id"]: t for t in nat["teams"]}
    lines = local_data.week_player_lines(nat["teams"], start.isoformat(), end.isoformat())

    bat_all, pit_all = [], []          # qualified (seo, name, weekly_counts) nationwide
    for seo, d in lines.items():
        for pname, c in d["batting"].items():
            if c["ab"] + c["bb"] + c["hbp"] >= 6:        # ≥6 plate appearances
                bat_all.append((seo, pname, c))
        for pname, c in d["pitching"].items():
            if c["outs"] >= 9:                           # ≥3 IP
                pit_all.append((seo, pname, c))
    bat_co, pit_co = _bat_coeffs(bat_all), _pit_coeffs(pit_all)

    lg_ids = {t["id"] for t in _season_for_league(league)["teams"]}
    scored_bat = _score_bats([e for e in bat_all if e[0] in lg_ids], bat_co)
    scored_pit = _score_pits([e for e in pit_all if e[0] in lg_ids], pit_co)
    best_bat = max(scored_bat, key=lambda x: x[0]) if scored_bat else None
    best_pit = max(scored_pit, key=lambda x: x[0]) if scored_pit else None

    batter = _batter_week_card(*best_bat[1:], nat_by) if best_bat else None
    pitcher = _pitcher_week_card(*best_pit[1:], nat_by) if best_pit else None
    return {"window": {"start": start.isoformat(), "end": end.isoformat()},
            "batter": batter, "pitcher": pitcher}


def _round_field(phase_key, schedules):
    """seos of the teams in the CURRENT postseason round's field — everyone who
    entered the round (so a team eliminated mid-round still counts, but one knocked
    out an earlier round does not). A team is "in" the round if it has a game inside
    the round's date window; the CWS Finals field is the two bracket finalists.
    Returns None to mean "no filter" — the regular season (every team is in)."""
    if phase_key in ("regular", "offseason"):
        return None
    if phase_key == "cws_finals":
        try:
            finals = (_bracket_ncaa().get("center") or {}).get("finals") or {}
        except Exception:
            return None
        seos = {(finals.get("top") or {}).get("seo"),
                (finals.get("bottom") or {}).get("seo")} - {None}
        return seos or None
    win = next((w for w in phase._WINDOWS if w[0] == phase_key), None)
    if not win:
        return None
    lo, hi = win[1].isoformat(), win[2].isoformat()
    field = {seo for seo, gs in schedules.items()
             if any(lo <= (g.get("iso") or "") <= hi for g in gs)}
    return field or None


def _bootstrap_payload():
    """(all_teams, full, post_teams): the merged team list, full per-team schedules
    (with per-game phase), and non-conference postseason stubs. Shared by /api/bootstrap
    and the site-phase computation so the homepage and every phase-dependent endpoint
    are built from the exact same data. Memoized per effective date."""
    asof = clock.asof_iso()          # None when live: nothing to hide

    def build():
        all_teams, full = [], {}
        for label, seo in _available_confs():
            teams, conf_full = _conf_full(label, seo, asof)
            all_teams += teams
            full.update(conf_full)
        # Fill the full NCAA-tournament field from the bracket (non-SEC/ACC matchups);
        # box-score games for tracked teams win (dedupe by date + opponent). The
        # opponent seo is normalized (alphanumerics only) because box scores and the
        # bracket sometimes spell it differently (e.g. "st-john-s-ny" vs "st-johns-ny"),
        # which an exact match would miss — letting the same game show up twice.
        nrm = lambda s: "".join(c for c in (s or "").lower() if c.isalnum())
        post = _memo("postseason_fill", 1800, season.postseason_schedules)
        known = {t["id"] for t in all_teams}
        for seo, games in post["games"].items():
            existing = full.get(seo, [])
            have = {(g.get("iso"), nrm((g.get("opp") or {}).get("id"))) for g in existing}
            add = [g for g in games if (g.get("iso"), nrm((g.get("opp") or {}).get("id"))) not in have]
            if asof:
                add = [dict(g, result=None, score=None) if (g.get("iso") or "") > asof else g for g in add]
            if add:
                full[seo] = sorted(existing + add, key=lambda g: g.get("iso") or "")
        post_teams = [stub for seo, stub in post["teams"].items() if seo not in known]
        return all_teams, full, post_teams

    return _memo(f"bootstrap_payload:{_dkey()}", 1800, build)


def _site_phase():
    """The one site-wide live phase, as /api/bootstrap reports it — so phase-dependent
    endpoints (e.g. Players to Watch) never drift from the homepage at round boundaries,
    where the data-driven phase advances a day before the calendar window does."""
    return _live_phase(_bootstrap_payload()[1])


def _players_to_watch(league="sec", n=4):
    """Top-N batters + top-N pitchers OVER THE FULL SEASON (to date) by the same
    formula as Player of the Week, at most ONE per team within each list (so the four
    batter cards are four different teams; a team may appear once among batters and
    once among pitchers). Volume qualifiers scale with each team's games played so a
    small-sample line (e.g. a 4-for-6 bench bat) doesn't surface.

    Postseason: limited to teams in the current round's field. The CWS Finals is the
    exception to the one-per-team rule — with only two teams left it shows each one's
    top TWO batters and TWO pitchers, so the panel stays full. {batters, pitchers}."""
    # In the postseason, only feature players whose team is in the current round
    # (its field at the start) — eliminated teams drop off as the rounds advance. Use
    # the SAME site phase the homepage shows, so the two never disagree at a boundary.
    ph = _site_phase()["phase"]
    today = clock.today().isoformat()

    def _qualify(lines, scheds):
        """Volume-guarded (seo, name, counts) — thresholds scale with games played."""
        bat, pit = [], []
        for seo, d in lines.items():
            gp = sum(1 for g in (scheds.get(seo) or [])
                     if g.get("result") and (g.get("iso") or "") <= today)
            bat_min, pit_min = max(6, 2 * gp), max(9, gp)
            for pname, c in d["batting"].items():
                if c["ab"] + c["bb"] + c["hbp"] >= bat_min:
                    bat.append((seo, pname, c))
            for pname, c in d["pitching"].items():
                if c["outs"] >= pit_min:
                    pit.append((seo, pname, c))
        return bat, pit

    # National pool (every conference) sets the composite coefficients, so players are
    # ranked against the whole country rather than only their own league.
    nat = _season_for_league("ncaa")
    nat_by = {t["id"]: t for t in nat["teams"]}
    nat_bat, nat_pit = _qualify(
        local_data.week_player_lines(nat["teams"], "2026-01-01", today),
        nat.get("schedules") or {})
    bat_co, pit_co = _bat_coeffs(nat_bat), _pit_coeffs(nat_pit)

    # Selection scope: the league (whole NCAA for the CWS Finals, a national event
    # between two often cross-conference finalists) narrowed to the postseason field.
    pool = "ncaa" if ph == "cws_finals" else league
    data = _season_for_league(pool)
    field = _round_field(ph, data.get("schedules") or {})
    per_team = 2 if ph == "cws_finals" else 1    # finals: 2 per remaining team, else 1
    sel_ids = {t["id"] for t in data["teams"]}
    keep = lambda seo: seo in sel_ids and (field is None or seo in field)
    scored_bat = _score_bats([e for e in nat_bat if keep(e[0])], bat_co)
    scored_pit = _score_pits([e for e in nat_pit if keep(e[0])], pit_co)

    # Keep the top `per_team` from each team, then the best `n` overall.
    def _top(scored):
        by_team = {}
        for e in sorted(scored, key=lambda x: x[0], reverse=True):
            by_team.setdefault(e[1], []).append(e)
        chosen = [e for lst in by_team.values() for e in lst[:per_team]]
        chosen.sort(key=lambda x: x[0], reverse=True)
        return chosen[:n]

    bats = _top(scored_bat)
    pits = _top(scored_pit)
    return {
        "batters": [_batter_week_card(seo, p, c, nat_by) for _s, seo, p, c in bats],
        "pitchers": [_pitcher_week_card(seo, p, c, nat_by) for _s, seo, p, c in pits],
    }


@app.route("/api/player-of-week")
def player_of_week():
    # by_date so the as-of date picks the right prior week.
    return _league_json("potw", 1800, _player_of_week, by_date=True)


@app.route("/api/players-to-watch")
def players_to_watch():
    return _league_json("ptw", 1800, _players_to_watch, by_date=True)


def _clock_state():
    """The `clock` block of /api/bootstrap: the effective date, the honored as-of date
    (null when live), the valid as-of range, and the season phase windows."""
    asof = clock.asof_iso()
    return {
        "today": _dkey(),
        "asof": asof,
        "live": asof is None,
        "min": clock.SEASON_START.isoformat(),
        "max": min(datetime.date.today(), clock.SEASON_END).isoformat(),
        "phases": [{"key": key, "label": phase._SITE_LABEL[key],
                    "start": start.isoformat(), "end": end.isoformat()}
                   for key, start, end in phase._WINDOWS],
    }


@app.route("/api/bootstrap")
def bootstrap():
    # The team list (tagged by conference), full per-team schedules, and the NCAA
    # postseason field are all assembled by _bootstrap_payload (shared with the
    # site-phase computation so the homepage and phase-dependent endpoints agree).
    all_teams, full, post_teams = _bootstrap_payload()
    return jsonify({
        "teams": all_teams,
        "postseason_teams": post_teams,
        "schedules": full,
        "updated": datetime.datetime.now().isoformat(timespec="minutes"),
        "phase": _live_phase(full),
        "super_regionals": _memo(f"super_regionals:{_dkey()}", 1800, _super_regionals),
        "regional_cities": _memo(f"regional_cities:{_dkey()}", 1800, _regional_cities),
        "clock": _clock_state(),
    })


@app.route("/api/team/<seo>")
def team(seo):
    # Look across every conference so ACC/Big-Ten/… team pages resolve, not just SEC.
    data = _season_for_league("ncaa")
    sched = data["schedules"].get(seo)
    if sched is None:
        abort(404)

    # Prefer locally-saved stats.ncaa.org data; fall back to the ncaa.com API.
    return jsonify(_team_stats(seo, _team_name(seo), sched))


@app.route("/api/team/<seo>/splits")
def team_splits(seo):
    data = _season_for_league("ncaa")
    if not any(t["id"] == seo for t in data["teams"]):
        abort(404)
    asof = clock.asof_iso()
    result = _memo(f"splits:{seo}:{_dkey()}", 21600,
                   lambda: local_data.team_splits(seo, _team_name(seo), asof))
    if result is None:
        abort(404)
    return jsonify(result)


@app.route("/api/roster/<seo>")
def roster(seo):
    """Team roster, read from Data/2026/<Team>/roster.txt (built by build_roster.py)."""
    data = local_data.read_roster(seo, _team_name(seo))
    if data is None:
        abort(404)
    return jsonify(data)


@app.route("/api/player/<seo>")
def player(seo):
    # Per-season totals + game log for one player, built solely from Data/2026/ (and
    # future-season) folders. The team name is resolved server-side from the seo.
    player_name = request.args.get("player", "")
    asof = clock.asof_iso()

    def producer():
        return local_data.player(seo, _team_name(seo), player_name, asof)

    result = _memo(f"player:{seo}:{player_name}:{_dkey()}", 21600, producer)
    if result is None:
        abort(404)
    return jsonify(result)


@app.route("/api/game/<game_id>")
def game(game_id):
    seo = request.args.get("team")
    iso = request.args.get("iso")
    runs = request.args.get("runs")
    opp = request.args.get("opp")
    key = f"game:{game_id}:{seo}:{iso}:{opp}"
    asof = clock.asof_iso()
    if asof and iso and iso > asof:
        abort(404)                     # no spoilers: the game hasn't happened yet

    def producer():
        # Prefer the locally-saved game (real play-by-play); else the API.
        if seo and iso:
            local = local_data.game(seo, _team_name(seo), iso, runs, opp)
            if local is not None:
                return local
        return build_game(game_id)

    try:
        return jsonify(_memo(key, 86400, producer))
    except ncaa.NotFound:
        abort(404)
    except ncaa.APIError:
        abort(503)


@app.route("/api/bracket/ncaa")
def bracket_ncaa():
    # Full 64-team NCAA bracket, straight from the API (covers every team, not
    # just the SEC ones). Cached 30 min since the tournament is live.
    return jsonify(_bracket_ncaa())


@app.route("/api/bracket/conf/<league>")
def bracket_conf(league):
    """Any conference's tournament bracket, reconstructed from its local games.
    `league` is the conference label or seo (e.g. "SEC" / "acc"). Empty rounds
    when that conference hasn't scheduled its tournament yet."""
    data = _season_for_league(league)
    schedules = _memo(f"local_schedules:{league.lower()}", season.SEASON_AGGREGATE_TTL,
                      lambda: local_data.schedules(data["teams"]))
    asof = clock.asof_iso()
    if asof:                           # no spoilers: drop games after the as-of date
        schedules = {seo: [g for g in games if (g.get("iso") or "") <= asof]
                     for seo, games in schedules.items()}
    phase_label = bracket.conf_tourney_phase(schedules)
    if not phase_label:
        return jsonify({"title": "", "seeds": [], "rounds": []})
    records = local_data.regular_season_records(schedules)
    return jsonify(bracket.conf_bracket(data["teams"], schedules, records, phase_label))


@app.route("/")
@app.route("/<path:_clientpath>")
def index(_clientpath=""):
    # Single-page app: every non-API, non-static path serves index.html so the
    # client-side router can render the right view (e.g. /scores, /postseason,
    # /team/texas) on a direct load or refresh. /api/* and /static/* are matched
    # by their own routes first, so they never reach here.
    return send_from_directory(app.static_folder, "index.html")


# ── Startup pre-warm ─────────────────────────────────────────────────────────
# `_mem` is per-process and empty on boot, so without this the first visitor
# after a deploy — or after the 6h season TTL lapses — pays for the whole
# bootstrap build. Warm it on a daemon thread at import time so the app is ready
# before anyone asks. Under gunicorn each worker imports this module and warms
# its OWN memo, which is what we want since workers don't share `_mem`.
# Set DISABLE_PREWARM=1 to turn it off.

def _prewarm():
    try:
        t0 = time.time()
        _bootstrap_payload()
        _site_phase()
        print(f"[prewarm] bootstrap ready in {time.time() - t0:.1f}s", file=sys.stderr)
    except Exception as e:          # a warm failure must never stop the app serving
        print(f"[prewarm] skipped: {type(e).__name__}: {e}", file=sys.stderr)


def _start_prewarm():
    if os.environ.get("DISABLE_PREWARM") == "1":
        return
    # `python app.py` runs behind the Werkzeug reloader, which imports this module
    # in BOTH the supervisor and the child; only the child (WERKZEUG_RUN_MAIN=true)
    # actually serves, so warming in the supervisor would just duplicate the work.
    # Under gunicorn there's no reloader, the variable is absent, and every worker
    # warms itself.
    if __name__ == "__main__" and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return
    threading.Thread(target=_prewarm, name="prewarm", daemon=True).start()


_start_prewarm()


if __name__ == "__main__":
    # threaded=True: a slow first-time team crawl (~50 box-score API calls)
    # must not block the rest of the site / the preview health check.
    app.run(debug=True, port=5050, threaded=True)
