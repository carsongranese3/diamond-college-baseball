"""Read locally-saved stats.ncaa.org data from the 2026/<Team>/ folders.

The website normally pulls from ncaa.com (via ncaa.py). This module lets it
prefer the richer locally-saved data (real play-by-play, pitcher strikeouts,
stolen bases) when a team/game has been pulled with pull_team_stats.py, and
return None when it hasn't — so the caller can fall back to the API.

Game detail and team stats are produced in the same shapes as gamedetail.py
and stats.py so the rest of the app/frontend needs no special-casing.
"""

import datetime
import json
import os
import re

import ncaa
from boxutil import fmt2, fmt3, ip_to_outs, outs_to_ip, to_int
from colors import for_seo

DATA_ROOT = os.path.join(os.path.dirname(__file__), "2026")


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-") or "opp"


def _iso(mmddyyyy):
    try:
        return datetime.datetime.strptime(mmddyyyy, "%m/%d/%Y").strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return mmddyyyy or ""


def _find_dir(seo, name):
    """Locate 2026/<Label>/ for a team by matching its seo or display name."""
    if not os.path.isdir(DATA_ROOT):
        return None
    targets = {_norm(seo), _norm(name)}
    targets.discard("")
    for d in os.listdir(DATA_ROOT):
        full = os.path.join(DATA_ROOT, d)
        if os.path.isdir(full) and _norm(d) in targets:
            return full
    return None


def _load(game_dir):
    out = {}
    for key, fname in (("box", "boxscore.json"), ("players", "player_stats.json"),
                       ("plays", "play_by_play.json")):
        path = os.path.join(game_dir, fname)
        if not os.path.exists(path):
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                out[key] = json.load(fh)
        except (json.JSONDecodeError, OSError):
            return None
    return out


def _iter_games(team_dir):
    for d in sorted(os.listdir(team_dir)):
        full = os.path.join(team_dir, d)
        if os.path.isdir(full):
            data = _load(full)
            if data:
                yield full, data


# ── Team season stats (aggregated from the saved per-game files) ─────────────
def team_stats(seo, name):
    team_dir = _find_dir(seo, name)
    if not team_dir:
        return None

    bat, pit, field = {}, {}, {"po": 0, "a": 0, "e": 0}
    games_used = 0

    for _dir, data in _iter_games(team_dir):
        host_side = "home" if data["box"].get("home") else "away"
        side = data["players"].get(host_side) or {}
        if not (side.get("batting") or side.get("pitching")):
            continue
        games_used += 1

        for row in side.get("batting", []):
            key = (row.get("#"), row.get("Name"))
            ab = to_int(row.get("AB"))
            if ab == 0 and to_int(row.get("BB")) == 0:
                continue
            b = bat.setdefault(key, {
                "name": row.get("Name", ""), "pos": row.get("P", ""),
                "num": row.get("#", ""), "g": 0, "ab": 0, "r": 0, "h": 0,
                "2b": 0, "3b": 0, "hr": 0, "rbi": 0, "bb": 0, "k": 0,
                "hbp": 0, "sf": 0, "sb": 0,
            })
            b["g"] += 1
            b["ab"] += ab
            b["r"] += to_int(row.get("R"))
            b["h"] += to_int(row.get("H"))
            b["2b"] += to_int(row.get("2B"))
            b["3b"] += to_int(row.get("3B"))
            b["hr"] += to_int(row.get("HR"))
            b["rbi"] += to_int(row.get("RBI"))
            b["bb"] += to_int(row.get("BB"))
            b["k"] += to_int(row.get("K"))
            b["hbp"] += to_int(row.get("HBP"))
            b["sf"] += to_int(row.get("SF"))
            b["sb"] += to_int(row.get("SB"))

        for row in side.get("pitching", []):
            outs = ip_to_outs(row.get("IP"))
            if outs == 0:
                continue
            key = (row.get("#"), row.get("Name"))
            p = pit.setdefault(key, {
                "name": row.get("Name", ""), "pos": row.get("P", "P"),
                "num": row.get("#", ""), "g": 0, "outs": 0, "h": 0, "r": 0,
                "er": 0, "bb": 0, "k": 0,
            })
            p["g"] += 1
            p["outs"] += outs
            p["h"] += to_int(row.get("H"))
            p["r"] += to_int(row.get("R"))
            p["er"] += to_int(row.get("ER"))
            p["bb"] += to_int(row.get("BB"))
            p["k"] += to_int(row.get("SO"))

        for row in side.get("fielding", []):
            field["po"] += to_int(row.get("PO"))
            field["a"] += to_int(row.get("A"))
            field["e"] += to_int(row.get("E"))

    if games_used == 0:
        return None

    batters = []
    for b in bat.values():
        ab, h, bb, hbp, sf = b["ab"], b["h"], b["bb"], b["hbp"], b["sf"]
        tb = h + b["2b"] + 2 * b["3b"] + 3 * b["hr"]
        avg = h / ab if ab else 0.0
        obp = (h + bb + hbp) / (ab + bb + hbp + sf) if (ab + bb + hbp + sf) else 0.0
        slg = tb / ab if ab else 0.0
        batters.append({
            "name": b["name"], "pos": b["pos"], "num": b["num"], "g": b["g"],
            "ab": ab, "r": b["r"], "h": h, "hr": b["hr"], "rbi": b["rbi"],
            "bb": bb, "k": b["k"], "sb": b["sb"], "avg": fmt3(avg),
            "obp": fmt3(obp), "slg": fmt3(slg), "ops": fmt3(obp + slg), "_tb": tb,
        })
    batters.sort(key=lambda x: x["ab"], reverse=True)

    pitchers = []
    for p in pit.values():
        ipnum = p["outs"] / 3 if p["outs"] else 0.0
        era = (p["er"] * 9 / ipnum) if ipnum else 0.0
        whip = ((p["bb"] + p["h"]) / ipnum) if ipnum else 0.0
        pitchers.append({
            "name": p["name"], "pos": p["pos"], "num": p["num"], "g": p["g"],
            "gs": "", "w": "", "l": "", "sv": "", "ip": outs_to_ip(p["outs"]),
            "h": p["h"], "r": p["r"], "er": p["er"], "bb": p["bb"], "k": p["k"],
            "era": fmt2(era), "whip": fmt2(whip), "_outs": p["outs"],
        })
    pitchers.sort(key=lambda x: x["_outs"], reverse=True)

    tab = sum(b["ab"] for b in batters)
    th = sum(b["h"] for b in batters)
    tbb = sum(b["bb"] for b in batters)
    thbp = sum(b["hbp"] if "hbp" in b else 0 for b in batters)
    ttb = sum(b["_tb"] for b in batters)
    p_outs = sum(p["_outs"] for p in pitchers)
    p_ipnum = p_outs / 3 if p_outs else 0.0
    p_er = sum(p["er"] for p in pitchers)
    p_h = sum(p["h"] for p in pitchers)
    p_bb = sum(p["bb"] for p in pitchers)
    p_k = sum(p["k"] for p in pitchers)

    avg_l = max((b for b in batters if b["ab"] >= max(20, tab // 80)),
                key=lambda r: float(r["avg"] or 0), default=None)
    hr_l = max(batters, key=lambda r: r["hr"], default=None)
    era_l = min((p for p in pitchers if p["_outs"] >= 60),
                key=lambda r: float(r["era"] or 99), default=None)
    leaders = []
    if avg_l:
        leaders.append({"name": avg_l["name"], "pos": avg_l["pos"],
                        "line": f"{avg_l['avg']} / {avg_l['hr']} HR / {avg_l['rbi']} RBI",
                        "note": "Batting avg"})
    if hr_l:
        leaders.append({"name": hr_l["name"], "pos": hr_l["pos"],
                        "line": f"{hr_l['avg']} / {hr_l['hr']} HR / {hr_l['rbi']} RBI",
                        "note": "Home runs"})
    if era_l:
        leaders.append({"name": era_l["name"], "pos": era_l["pos"],
                        "line": f"{era_l['era']} ERA / {era_l['k']} K", "note": "Ace"})

    for b in batters:
        b.pop("_tb", None)
        b.pop("hbp", None)
    for p in pitchers:
        p.pop("_outs", None)

    po, a, e = field["po"], field["a"], field["e"]
    fp = (po + a) / (po + a + e) if (po + a + e) else 0.0
    b_avg = th / tab if tab else 0.0
    b_obp = (th + tbb + thbp) / (tab + tbb + thbp) if (tab + tbb + thbp) else 0.0
    b_slg = ttb / tab if tab else 0.0

    return {
        "_games": games_used, "_source": "local",
        "batting": {"avg": fmt3(b_avg), "obp": fmt3(b_obp), "slg": fmt3(b_slg),
                    "hr": sum(b["hr"] for b in batters),
                    "rbi": sum(b["rbi"] for b in batters), "sb": sum(b["sb"] for b in batters),
                    "runs": sum(b["r"] for b in batters), "h": th},
        "pitching": {"era": fmt2((p_er * 9 / p_ipnum) if p_ipnum else 0.0),
                     "whip": fmt2(((p_bb + p_h) / p_ipnum) if p_ipnum else 0.0),
                     "k": p_k, "bb": p_bb, "sv": "—", "ip": outs_to_ip(p_outs),
                     "hr_a": 0, "oba": "—"},
        "fielding": {"pct": fmt3(fp), "e": e, "dp": "—", "fp": fmt3(fp)},
        "leaders": leaders,
        "roster": {"batters": batters, "pitchers": pitchers},
    }


# ── Single game detail (line score + box + play-by-play) ─────────────────────
def _side(name, seo, ls):
    col = for_seo(seo)
    return {
        "name": name, "seo": seo,
        "mark": (("".join(w[0] for w in name.split()) or name)[:4]).upper(),
        "logo": ncaa.logo_url(seo) if seo else "",
        "color": col["color"], "ink": col["ink"],
        "innings": ls.get("innings", []),
        "r": to_int(ls.get("r")), "h": to_int(ls.get("h")), "e": to_int(ls.get("e")),
    }


def _box_rows_bat(rows):
    out = []
    for row in rows or []:
        ab = to_int(row.get("AB"))
        out.append({
            "name": row.get("Name", ""), "pos": row.get("P", ""),
            "ab": ab, "r": to_int(row.get("R")), "h": to_int(row.get("H")),
            "rbi": to_int(row.get("RBI")), "bb": to_int(row.get("BB")),
            "k": to_int(row.get("K")),
            "avg": fmt3(to_int(row.get("H")) / ab) if ab else "",
        })
    return out


def _box_rows_pit(rows):
    out = []
    for row in rows or []:
        outs = ip_to_outs(row.get("IP"))
        er = to_int(row.get("ER"))
        out.append({
            "name": row.get("Name", ""), "ip": str(row.get("IP", "")),
            "h": to_int(row.get("H")), "r": to_int(row.get("R")), "er": er,
            "bb": to_int(row.get("BB")), "k": to_int(row.get("SO")),
            "era": fmt2(er * 9 / (outs / 3)) if outs else "—", "dec": "—",
        })
    return out


def game(seo, name, iso, host_runs=None, opp_seo=None):
    """Game detail from the local folder matching (team, date[, host runs]).

    opp_seo is the opponent's ncaa.com slug (from the schedule) — used for the
    opponent logo, since the stats.ncaa.org opponent NAME often slugs to a
    different value (e.g. "Lamar University" vs "lamar") and would 404.
    """
    team_dir = _find_dir(seo, name)
    if not team_dir:
        return None
    want_runs = to_int(host_runs, None) if host_runs not in (None, "") else None

    for _dir, data in _iter_games(team_dir):
        box = data["box"]
        if _iso(box.get("date")) != iso:
            continue
        host_side = "home" if box.get("home") else "away"
        ls = box.get("line_score") or {}
        if want_runs is not None and to_int((ls.get(host_side) or {}).get("r")) != want_runs:
            continue  # doubleheader: disambiguate by the host team's run total

        opp_name = box.get("opponent", "")
        opp = opp_seo or _slug(opp_name)  # prefer the ncaa.com slug for the logo
        if host_side == "home":
            home_seo, away_seo = seo, opp
        else:
            home_seo, away_seo = opp, seo

        away_ls = ls.get("away") or {}
        home_ls = ls.get("home") or {}
        away = _side(away_ls.get("name", opp_name), away_seo, away_ls)
        home = _side(home_ls.get("name", name), home_seo, home_ls)
        players = data["players"]
        return {
            "venue": "", "attendance": None, "weather": None, "duration": "Final",
            "homeTeam": home_seo, "awayTeam": away_seo,
            "winner": "home" if home["r"] > away["r"] else (
                "away" if away["r"] > home["r"] else None),
            "line": {"away": away, "home": home},
            "batters": {"away": _box_rows_bat((players.get("away") or {}).get("batting")),
                        "home": _box_rows_bat((players.get("home") or {}).get("batting"))},
            "pitchers": {"away": _box_rows_pit((players.get("away") or {}).get("pitching")),
                         "home": _box_rows_pit((players.get("home") or {}).get("pitching"))},
            "plays": data["plays"] or [],
            "notes": [],
            "_source": "local",
        }
    return None
