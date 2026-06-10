"""Diamond/SEC — Flask backend backed by live ncaa.com data (henrygd NCAA API).

Endpoints:
  GET /api/bootstrap      SEC teams + per-team schedules (from scoreboard crawl)
  GET /api/team/<seo>     team season batting/pitching + player roster
  GET /api/game/<id>      single-game box score + line score
"""

import datetime
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
    data = _memo("season", season.SEASON_AGGREGATE_TTL, season.build_season)
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


_ROUND_RANK = {"regular": 0, "SEC Tournament": 1, "NCAA Regional": 2,
               "NCAA Super Regional": 3, "College World Series": 4}
_ROUND_PHASE = {"regular": "regular", "SEC Tournament": "sec_tournament",
                "NCAA Regional": "regionals", "NCAA Super Regional": "super_regionals",
                "College World Series": "cws"}


def _live_phase(full):
    """Site phase that advances to the next round the day AFTER the current round's
    games end (rather than on a fixed calendar boundary): the round of today's
    games if any, else the round of the soonest upcoming game. Falls back to the
    date-based phase when nothing is scheduled (offseason). CWS-vs-Finals is
    disambiguated by the date window since both carry the same game-level round."""
    datebased = phase.current_phase()
    today = clock.today().isoformat()
    rounds_today, next_iso, next_round = set(), None, None
    for games in full.values():
        for g in games:
            iso, rd = g.get("iso"), g.get("phase") or "regular"
            if not iso:
                continue
            if iso == today:
                rounds_today.add(rd)
            elif iso > today and (next_iso is None or iso < next_iso):
                next_iso, next_round = iso, rd
    if rounds_today:
        rd = max(rounds_today, key=lambda r: _ROUND_RANK.get(r, -1))
    elif next_round:
        rd = next_round
    else:
        return datebased
    key = _ROUND_PHASE.get(rd, "regular")
    if key == "cws" and datebased["phase"] == "cws_finals":
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


def _conference_leaders():
    """Top-3 conference leaders in AVG / HR / ERA, found by walking every team's
    roster: pool the qualified players across all teams, then take the best three
    (so one team can place multiple players, and a later team pushes weaker ones
    out of the top three)."""
    data = _memo("season", season.SEASON_AGGREGATE_TTL, season.build_season)
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
    return jsonify(_memo("conference_leaders", season.SEASON_AGGREGATE_TTL,
                         _conference_leaders))


def _rankings_history():
    """Each team's SEC standings position week by week, from the precomputed
    weekly records (scripts/build_records.py). For every week, teams are ranked by
    conference win pct (tiebreak conf wins, then name) — the same ordering the
    Standings table uses — and assigned 1..N. Returns
    {weeks: [{n, start, end}], teams: {seo: [{n, rank, confW, confL, ovrW, ovrL}]}}."""
    data = _memo("season", season.SEASON_AGGREGATE_TTL, season.build_season)
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
    return jsonify(_memo("rankings_history", season.SEASON_AGGREGATE_TTL,
                         _rankings_history))


def _player_of_week():
    """Best batter + best pitcher over the PREVIOUS Mon-Sun week, by a simple weekly
    formula. Batter score = on-base (incl. HBP) + slugging; pitcher score (game-score
    style) = outs - 2*runs - hits - walks. Each winner carries their team and a
    SEASON stat line (basic + computable advanced) for display. Returns
    {window, batter|None, pitcher|None}."""
    data = _memo("season", season.SEASON_AGGREGATE_TTL, season.build_season)
    teams = data["teams"]
    team_by = {t["id"]: t for t in teams}
    today = clock.today()
    this_mon = today - datetime.timedelta(days=today.weekday())
    start = this_mon - datetime.timedelta(days=7)
    end = this_mon - datetime.timedelta(days=1)
    lines = local_data.week_player_lines(teams, start.isoformat(), end.isoformat())

    best_bat = best_pit = None  # (score, seo, name, weekly_counts)
    for seo, d in lines.items():
        for pname, c in d["batting"].items():
            ab, pa = c["ab"], c["ab"] + c["bb"] + c["hbp"]
            if pa < 6:                       # volume guard: ≥6 plate appearances
                continue
            score = (c["h"] + c["bb"] + c["hbp"]) / pa + (c["tb"] / ab if ab else 0)
            if best_bat is None or score > best_bat[0]:
                best_bat = (score, seo, pname, c)
        for pname, c in d["pitching"].items():
            if c["outs"] < 9:                # ≥3 IP
                continue
            score = c["outs"] - 2 * c["r"] - c["h"] - c["bb"]
            if best_pit is None or score > best_pit[0]:
                best_pit = (score, seo, pname, c)

    # Display the PREVIOUS WEEK's line — the stats that earned the honor — computed
    # straight from that week's counting totals (not season stats).
    batter = pitcher = None
    if best_bat:
        _s, seo, pname, c = best_bat
        t, ab = team_by.get(seo, {}), c["ab"]
        denom = ab + c["bb"] + c["hbp"]
        avg = c["h"] / ab if ab else 0.0
        obp = (c["h"] + c["bb"] + c["hbp"]) / denom if denom else 0.0
        slg = c["tb"] / ab if ab else 0.0
        batter = {
            "player": pname, "team": seo, "abbr": t.get("mark"), "teamName": t.get("name"),
            "pos": c.get("pos") or "",
            "basic": [{"label": "AVG", "value": boxutil.fmt3(avg)},
                      {"label": "HR", "value": str(c["hr"])},
                      {"label": "RBI", "value": str(c["rbi"])}],
            "adv": [{"label": "OPS", "value": boxutil.fmt3(obp + slg)},
                    {"label": "ISO", "value": boxutil.fmt3(slg - avg)},
                    {"label": "OBP", "value": boxutil.fmt3(obp)}],
        }
    if best_pit:
        _s, seo, pname, c = best_pit
        t, outs = team_by.get(seo, {}), c["outs"]
        era = c["er"] * 27 / outs if outs else 0.0
        whip = (c["h"] + c["bb"]) * 3 / outs if outs else 0.0
        pitcher = {
            "player": pname, "team": seo, "abbr": t.get("mark"), "teamName": t.get("name"),
            "pos": "P",
            "basic": [{"label": "ERA", "value": boxutil.fmt2(era)},
                      {"label": "K", "value": str(c["k"])},
                      {"label": "IP", "value": boxutil.outs_to_ip(outs)}],
            "adv": [{"label": "FIP", "value": boxutil.fip(c["hr"], c["bb"], c["hbp"], c["k"], outs)},
                    {"label": "WHIP", "value": boxutil.fmt2(whip)},
                    {"label": "K/9", "value": boxutil.per9(c["k"], outs)}],
        }
    return {"window": {"start": start.isoformat(), "end": end.isoformat()},
            "batter": batter, "pitcher": pitcher}


@app.route("/api/player-of-week")
def player_of_week():
    # Keyed by the effective date so the time machine picks the right prior week.
    return jsonify(_memo("potw:" + clock.today().isoformat(), 1800, _player_of_week))


@app.route("/api/bootstrap")
def bootstrap():
    data = _memo("season", season.SEASON_AGGREGATE_TTL, season.build_season)
    # Schedules/scores come solely from the local 2026/ folders; the API still
    # supplies the team list, rankings (rank/RPI/order), and logos.
    schedules = _memo("local_schedules", season.SEASON_AGGREGATE_TTL,
                      lambda: local_data.schedules(data["teams"]))
    asof = season._today().isoformat()
    test = clock.is_test()
    # Keyed by the effective date so test dates don't pollute the live cache.
    upcoming = _memo("upcoming:" + asof, 1800, season.upcoming_schedules)
    # Bracket-scheduled postseason games (e.g. CWS) the scoreboard doesn't carry yet.
    sec_seos = {t["id"] for t in data["teams"]}
    bracket_up = _memo("bracket_up:" + asof, 1800,
                       lambda: season.bracket_upcoming(sec_seos))
    full = {}
    for seo, played in schedules.items():
        # The scoreboard sometimes lists a played game as 'pre' (ncaa.com lag), so
        # only add upcoming games on dates we have NO box score for — no duplicates.
        played_dates = {g["iso"] for g in played if g.get("iso")}
        games = list(played) + [g for g in upcoming.get(seo, [])
                                if g.get("iso") not in played_dates]
        # Add bracket-scheduled games on any date not already present.
        have_dates = {g.get("iso") for g in games}
        games += [g for g in bracket_up.get(seo, []) if g.get("iso") not in have_dates]
        if test:
            # Time machine: games after the test date read as not-yet-played, so the
            # whole site reflects that day. With test off this loop is skipped.
            games = [dict(g, result=None, score=None) if (g.get("iso") or "") > asof else g
                     for g in games]
        games.sort(key=lambda g: g.get("iso") or "")
        full[seo] = games
    # Standings/records skip result=None games, so in test mode this reflects only
    # games up to the test date.
    records = local_data.regular_season_records(full)
    teams = [{**t, **records.get(t["id"], {})} for t in data["teams"]]
    return jsonify({
        "teams": teams,
        "schedules": full,
        "updated": data["updated"],
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


@app.route("/api/team/<seo>")
def team(seo):
    data = _memo("season", season.SEASON_AGGREGATE_TTL, season.build_season)
    sched = data["schedules"].get(seo)
    if sched is None:
        abort(404)

    def producer():
        # Prefer locally-saved stats.ncaa.org data; fall back to the ncaa.com API.
        local = local_data.team_stats(seo, _team_name(seo))
        return local if local is not None else compute_team_stats(seo, sched)

    return jsonify(_memo(f"team:{seo}", 21600, producer))


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


@app.route("/api/bracket/sec")
def bracket_sec():
    data = _memo("season", season.SEASON_AGGREGATE_TTL, season.build_season)
    schedules = _memo("local_schedules", season.SEASON_AGGREGATE_TTL,
                      lambda: local_data.schedules(data["teams"]))
    records = local_data.regular_season_records(schedules)
    return jsonify(bracket.sec_bracket(data["teams"], schedules, records))


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
