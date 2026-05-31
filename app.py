"""Diamond/SEC — Flask backend backed by live ncaa.com data (henrygd NCAA API).

Endpoints:
  GET /api/bootstrap      SEC teams + per-team schedules (from scoreboard crawl)
  GET /api/team/<seo>     team season batting/pitching + player roster
  GET /api/game/<id>      single-game box score + line score
"""

import threading
import time

from flask import Flask, abort, jsonify, request, send_from_directory

import local_data
import ncaa
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


@app.route("/api/bootstrap")
def bootstrap():
    data = _memo("season", season.SEASON_AGGREGATE_TTL, season.build_season)
    # Schedules/scores come solely from the local 2026/ folders; the API still
    # supplies the team list, rankings (rank/RPI/order), and logos.
    schedules = _memo("local_schedules", season.SEASON_AGGREGATE_TTL,
                      lambda: local_data.schedules(data["teams"]))
    return jsonify({
        "teams": data["teams"],
        "schedules": schedules,
        "updated": data["updated"],
    })


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


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    # threaded=True: a slow first-time team crawl (~50 box-score API calls)
    # must not block the rest of the site / the preview health check.
    app.run(debug=True, port=5050, threaded=True)
