"""Diamond/SEC — Flask backend backed by live ncaa.com data (henrygd NCAA API).

Endpoints:
  GET /api/bootstrap      SEC teams + per-team schedules (from scoreboard crawl)
  GET /api/team/<seo>     team season batting/pitching + player roster
  GET /api/game/<id>      single-game box score + line score
"""

import datetime
import os
import subprocess
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


def _memo(key, ttl, producer):
    now = time.time()
    with _mem_lock:
        hit = _mem.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = producer()
    with _mem_lock:
        _mem[key] = (now, value)
    return value


def _league_json(prefix, ttl, fn, by_date=False):
    """A ?league=-scoped, memoized JSON endpoint. by_date keys the cache on the
    effective date too (for week-relative data + the dev time machine)."""
    league = request.args.get("league", "sec")
    key = f"{prefix}:{clock.today().isoformat()}:{league}" if by_date else f"{prefix}:{league}"
    return jsonify(_memo(key, ttl, lambda: fn(league)))


# ── Dev "Update" — run scripts/update.py to pull fresh data ───────────────────
# A single-user dev tool (like the time machine): the bottom-left Update button
# kicks this off, polls it, then reloads. update.py boots the stealth browser and
# can run for minutes, so it runs in a background thread; the frontend polls
# /api/dev/update for {running} and reloads when it flips false.

# Which conferences the Update button pulls. None = every conference that already
# has a data folder under 2026/ (currently SEC + ACC). To also pull conferences
# update.py knows but that aren't onboarded yet, list them explicitly -- e.g.
#   UPDATE_CONFERENCES = ["SEC", "ACC", "Big Ten", "Big 12"]
# (labels must match update.py's CONFERENCE_TEAMS keys / 2026/ folder names).
UPDATE_CONFERENCES = None

_update_lock = threading.Lock()
_update = {"running": False, "ok": None, "log": ""}


def _update_conferences():
    """The conference folder-labels one Update run pulls (one update.py pass each)."""
    if UPDATE_CONFERENCES:
        return list(UPDATE_CONFERENCES)
    return [label for label, _seo in _available_confs()]


def _run_update(conf_labels):
    """Run scripts/update.py once per conference (team='all'), capture its output,
    then drop the memo cache so the next bootstrap reflects the freshly pulled data.
    Launched with the current interpreter — update.py re-execs itself into .venv-dev
    (where the scraping stack lives) when needed."""
    script = os.path.join(os.path.dirname(__file__), "scripts", "update.py")
    chunks, ok = [], True
    for label in conf_labels:
        try:
            proc = subprocess.run([sys.executable, script, label, "all"],
                                  capture_output=True, text=True, timeout=3600)
            chunks.append(proc.stdout + proc.stderr)
            ok = ok and proc.returncode == 0
        except Exception as e:                       # timeout, missing interpreter, …
            chunks.append(f"{label}: {type(e).__name__}: {e}")
            ok = False
    with _mem_lock:
        _mem.clear()
    with _update_lock:
        _update.update(running=False, ok=ok, log="\n".join(chunks))


# ── Conferences / leagues ────────────────────────────────────────────────────
# "League" in the API is either a conference (its scoreboard seo: sec/acc/…) or
# "ncaa" meaning every conference that has a 2026/<Conf>/ data folder.

def _available_confs():
    """[(label, seo)] for each conference folder under the 2026/ data root, e.g.
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
            d = _memo(f"season:conf:{seo}", season.SEASON_AGGREGATE_TTL,
                      lambda seo=seo: season.build_season(conf=seo))
            teams += [{**t, "conference": label} for t in d["teams"]]
            schedules.update(d["schedules"])
        return {"teams": teams, "schedules": schedules,
                "updated": datetime.datetime.now().isoformat(timespec="minutes")}
    return _memo(f"season:{league}", season.SEASON_AGGREGATE_TTL, build)


def _conf_full(label, seo, asof, test):
    """(teams-with-records, full-schedules) for one conference — played games from
    saved box scores, plus upcoming (scoreboard) and bracket-scheduled games, with
    each team tagged by conference. The per-conference half of /api/bootstrap."""
    data = _memo(f"season:conf:{seo}", season.SEASON_AGGREGATE_TTL,
                 lambda seo=seo: season.build_season(conf=seo))
    schedules = _memo(f"local_schedules:{seo}", season.SEASON_AGGREGATE_TTL,
                      lambda seo=seo, data=data: local_data.schedules(data["teams"]))
    upcoming = _memo(f"upcoming:{seo}:{asof}", 1800,
                     lambda seo=seo: season.upcoming_schedules(conf=seo))
    conf_seos = {t["id"] for t in data["teams"]}
    bracket_up = _memo(f"bracket_up:{seo}:{asof}", 1800,
                       lambda conf_seos=conf_seos: season.bracket_upcoming(conf_seos))
    full = {}
    for tseo, played in schedules.items():
        played_dates = {g["iso"] for g in played if g.get("iso")}
        games = list(played) + [g for g in upcoming.get(tseo, [])
                                if g.get("iso") not in played_dates]
        have_dates = {g.get("iso") for g in games}
        games += [g for g in bracket_up.get(tseo, []) if g.get("iso") not in have_dates]
        if test:
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
    calendar guess — yet still respects the dev time machine via clock.today()). Until
    then the site stays on the CWS bracket screen, so the two stages stay distinct."""
    try:
        center = _memo("bracket_ncaa", 1800, bracket.ncaa_bracket).get("center") or {}
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


def _super_regionals():
    """The Super Regional matchups (each: two teams + their official national
    seeds) from the NCAA bracket — for the homepage 'The Field' and team pages.
    Empty list if the bracket isn't available."""
    try:
        tree = bracket.ncaa_bracket().get("tree") or {}
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
        return bracket.ncaa_bracket().get("regional_cities") or {}
    except Exception:
        return {}


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
            stats = _memo(f"team:{seo}", 21600,
                          lambda seo=seo, name=name, sched=sched:
                          local_data.team_stats(seo, name)
                          or (compute_team_stats(seo, sched) if sched else None))
        except Exception:
            stats = None
        roster = (stats or {}).get("roster") or {}
        for b in roster.get("batters", []):
            try:
                ab = int(b.get("ab") or 0)
            except (TypeError, ValueError):
                ab = 0
            if ab >= 50 and b.get("avg"):
                avg_pool.append((_ip_float(b["avg"]), t, b, b["avg"]))
            # OPS — computable advanced stat (replaces wRC+ from the mockup).
            if ab >= 50 and b.get("ops"):
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
            qual = _ip_float(p.get("ip")) >= 20
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
    return _league_json("conference_leaders", season.SEASON_AGGREGATE_TTL, _conference_leaders)


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
            stats = _memo(f"team:{seo}", 21600,
                          lambda seo=seo, name=name, sched=sched:
                          local_data.team_stats(seo, name)
                          or (compute_team_stats(seo, sched) if sched else None))
        except Exception:
            stats = None
        roster = (stats or {}).get("roster") or {}
        ident = {"team": t["name"], "seo": t["id"], "abbr": t.get("mark"),
                 "color": t.get("color"), "logo": t.get("logo")}
        # Ship each qualified player's FULL counting line (everything local_data
        # exposes) + team identity, so the frontend can show / compute any stat —
        # basic counting, the stored rates, or the advanced metrics it derives.
        for b in roster.get("batters", []):
            try:
                ab = int(b.get("ab") or 0)
            except (TypeError, ValueError):
                ab = 0
            if ab >= 50:                       # qualified batters only
                batters.append({**b, **ident, "type": "B"})
        for p in roster.get("pitchers", []):
            if _ip_float(p.get("ip")) >= 20:    # qualified pitchers only
                pitchers.append({**p, **ident, "type": "P"})
    return {"batters": batters, "pitchers": pitchers,
            "teams": len(data["teams"]), "updated": data["updated"]}


@app.route("/api/stat-leaders")
def stat_leaders():
    return _league_json("stat_leaders", season.SEASON_AGGREGATE_TTL, _stat_leaders)


def _rankings_history(league="sec"):
    """Each team's standings position week by week within its league, from the
    precomputed weekly records (scripts/build_records.py). For every week, teams are
    ranked by conference win pct (tiebreak conf wins, then name) — the same ordering
    the Standings table uses — and assigned 1..N. Returns
    {weeks: [{n, start, end}], teams: {seo: [{n, rank, confW, confL, ovrW, ovrL}]}}."""
    data = _season_for_league(league)
    teams = data["teams"]
    weekly = local_data.weekly_records(teams)
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
    return _league_json("rankings_history", season.SEASON_AGGREGATE_TTL, _rankings_history)


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


# Player-of-week scoring formulas, shared by Player of the Week and Players to Watch.
# Batter = on-base (incl. HBP) + slugging; pitcher = game-score style. Each returns
# None below the volume guard so unqualified lines are skipped.
def _batter_week_score(c):
    ab, pa = c["ab"], c["ab"] + c["bb"] + c["hbp"]
    if pa < 6:                               # ≥6 plate appearances
        return None
    return (c["h"] + c["bb"] + c["hbp"]) / pa + (c["tb"] / ab if ab else 0)


def _pitcher_week_score(c):
    if c["outs"] < 9:                        # ≥3 IP
        return None
    return c["outs"] - 2 * c["r"] - c["h"] - c["bb"]


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
    data = _season_for_league(league)
    teams = data["teams"]
    team_by = {t["id"]: t for t in teams}
    start, end = _prev_week_window()
    lines = local_data.week_player_lines(teams, start.isoformat(), end.isoformat())

    best_bat = best_pit = None  # (score, seo, name, weekly_counts)
    for seo, d in lines.items():
        for pname, c in d["batting"].items():
            s = _batter_week_score(c)
            if s is not None and (best_bat is None or s > best_bat[0]):
                best_bat = (s, seo, pname, c)
        for pname, c in d["pitching"].items():
            s = _pitcher_week_score(c)
            if s is not None and (best_pit is None or s > best_pit[0]):
                best_pit = (s, seo, pname, c)

    batter = _batter_week_card(*best_bat[1:], team_by) if best_bat else None
    pitcher = _pitcher_week_card(*best_pit[1:], team_by) if best_pit else None
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
            finals = (_memo("bracket_ncaa", 1800, bracket.ncaa_bracket)
                      .get("center") or {}).get("finals") or {}
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
    are built from the exact same data. Memoized per effective date + test flag."""
    asof = season._today().isoformat()
    test = clock.is_test()

    def build():
        all_teams, full = [], {}
        for label, seo in _available_confs():
            teams, conf_full = _conf_full(label, seo, asof, test)
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
            if test:
                add = [dict(g, result=None, score=None) if (g.get("iso") or "") > asof else g for g in add]
            if add:
                full[seo] = sorted(existing + add, key=lambda g: g.get("iso") or "")
        post_teams = [stub for seo, stub in post["teams"].items() if seo not in known]
        return all_teams, full, post_teams

    return _memo(f"bootstrap_payload:{asof}:{test}", 1800, build)


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
    # The CWS Finals is a national event between two (often cross-conference)
    # finalists, so pull from the whole NCAA pool regardless of the selected league —
    # otherwise a conference view (e.g. SEC) would drop the other finalist.
    pool = "ncaa" if ph == "cws_finals" else league
    data = _season_for_league(pool)
    teams = data["teams"]
    schedules = data.get("schedules") or {}
    team_by = {t["id"]: t for t in teams}
    today = clock.today().isoformat()
    lines = local_data.week_player_lines(teams, "2026-01-01", today)   # season to date

    field = _round_field(ph, schedules)
    per_team = 2 if ph == "cws_finals" else 1    # finals: 2 per remaining team, else 1

    bats, pits = [], []          # each team's best (score, seo, name, counts)
    for seo, d in lines.items():
        if field is not None and seo not in field:
            continue
        gp = sum(1 for g in (schedules.get(seo) or []) if g.get("result"))
        bat_min = max(6, 2 * gp)     # ≥2 PA per team game (qualified-ish hitter)
        pit_min = max(9, gp)         # ≥~1 IP per 3 team games
        cb, cp = [], []
        for pname, c in d["batting"].items():
            if c["ab"] + c["bb"] + c["hbp"] < bat_min:
                continue
            s = _batter_week_score(c)
            if s is not None:
                cb.append((s, seo, pname, c))
        for pname, c in d["pitching"].items():
            if c["outs"] < pit_min:
                continue
            s = _pitcher_week_score(c)
            if s is not None:
                cp.append((s, seo, pname, c))
        cb.sort(key=lambda x: x[0], reverse=True)
        cp.sort(key=lambda x: x[0], reverse=True)
        bats.extend(cb[:per_team])   # top `per_team` from this team
        pits.extend(cp[:per_team])
    bats.sort(key=lambda x: x[0], reverse=True)
    pits.sort(key=lambda x: x[0], reverse=True)
    return {
        "batters": [_batter_week_card(seo, p, c, team_by) for _s, seo, p, c in bats[:n]],
        "pitchers": [_pitcher_week_card(seo, p, c, team_by) for _s, seo, p, c in pits[:n]],
    }


@app.route("/api/player-of-week")
def player_of_week():
    # by_date so the time machine picks the right prior week.
    return _league_json("potw", 1800, _player_of_week, by_date=True)


@app.route("/api/players-to-watch")
def players_to_watch():
    return _league_json("ptw", 1800, _players_to_watch, by_date=True)


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
        "super_regionals": _memo("super_regionals", 1800, _super_regionals),
        "regional_cities": _memo("regional_cities", 1800, _regional_cities),
        "clock": clock.state(),
    })


@app.route("/api/dev/clock")
def dev_clock():
    """Test-only time machine. ?test=1&date=2026-05-15 turns it on for that date;
    ?test=0 turns it off. No param just reports the current state."""
    if "test" in request.args:
        clock.configure(request.args.get("test") in ("1", "true", "on"),
                        request.args.get("date"))
    return jsonify(clock.state())


@app.route("/api/dev/update", methods=["GET", "POST"])
def dev_update():
    """Dev-only data refresh. POST starts scripts/update.py in the background for
    every conference in UPDATE_CONFERENCES (all teams); GET reports {running, ok}.
    The button reloads the page once running flips false so the new data shows."""
    if request.method == "POST":
        with _update_lock:
            if not _update["running"]:
                labels = _update_conferences()
                _update.update(running=True, ok=None, log="")
                threading.Thread(target=_run_update, args=(labels,),
                                 daemon=True).start()
    with _update_lock:
        return jsonify({k: _update[k] for k in ("running", "ok")})


@app.route("/api/team/<seo>")
def team(seo):
    # Look across every conference so ACC/Big-Ten/… team pages resolve, not just SEC.
    data = _season_for_league("ncaa")
    sched = data["schedules"].get(seo)
    if sched is None:
        abort(404)

    def producer():
        # Prefer locally-saved stats.ncaa.org data; fall back to the ncaa.com API.
        local = local_data.team_stats(seo, _team_name(seo))
        return local if local is not None else compute_team_stats(seo, sched)

    return jsonify(_memo(f"team:{seo}", 21600, producer))


@app.route("/api/team/<seo>/splits")
def team_splits(seo):
    data = _season_for_league("ncaa")
    if not any(t["id"] == seo for t in data["teams"]):
        abort(404)
    result = _memo(f"splits:{seo}", 21600,
                   lambda: local_data.team_splits(seo, _team_name(seo)))
    if result is None:
        abort(404)
    return jsonify(result)


@app.route("/api/roster/<seo>")
def roster(seo):
    """Team roster, read from 2026/<Team>/roster.txt (built by build_roster.py)."""
    data = local_data.read_roster(seo, _team_name(seo))
    if data is None:
        abort(404)
    return jsonify(data)


@app.route("/api/player/<seo>")
def player(seo):
    # Per-season totals + game log for one player, built solely from 2026/ (and
    # future-season) folders. The team name is resolved server-side from the seo.
    player_name = request.args.get("player", "")

    def producer():
        return local_data.player(seo, _team_name(seo), player_name)

    result = _memo(f"player:{seo}:{player_name}", 21600, producer)
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
    return jsonify(_memo("bracket_ncaa", 1800, bracket.ncaa_bracket))


@app.route("/api/bracket/conf/<league>")
def bracket_conf(league):
    """Any conference's tournament bracket, reconstructed from its local games.
    `league` is the conference label or seo (e.g. "SEC" / "acc"). Empty rounds
    when that conference hasn't scheduled its tournament yet."""
    data = _season_for_league(league)
    schedules = _memo(f"local_schedules:{league.lower()}", season.SEASON_AGGREGATE_TTL,
                      lambda: local_data.schedules(data["teams"]))
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


if __name__ == "__main__":
    # threaded=True: a slow first-time team crawl (~50 box-score API calls)
    # must not block the rest of the site / the preview health check.
    app.run(debug=True, port=5050, threaded=True)
