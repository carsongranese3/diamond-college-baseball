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
    return jsonify({
        "teams": data["teams"],
        "schedules": data["schedules"],
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
