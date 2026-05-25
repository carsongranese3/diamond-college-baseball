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


def _clean_opp(name):
    """Strip the cruft stats.ncaa.org adds to neutral-site/tournament opponents,
    e.g. '#8 Mississippi St. @Hoover, AL (2026 SEC Baseball Championship)'
    -> 'Mississippi St.' (so it matches an SEC team and gets the right logo)."""
    s = re.sub(r"\s*@.*$", "", name or "")     # drop "@Venue, ST (Event)" onward
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s)      # drop a trailing "(...)" if no @
    s = re.sub(r"^#\d+\s+", "", s)              # drop a leading rank like "#8 "
    return s.strip()


def _phase(raw_opponent):
    """Classify a game by the venue/event cruft stats.ncaa.org appends to the
    opponent for neutral-site postseason games. Returns 'regular' or a postseason
    label, so the schedule can group regular season vs SEC tournament vs NCAA play.
    """
    s = (raw_opponent or "").lower()
    if "world series" in s:
        return "College World Series"
    if "super regional" in s:
        return "NCAA Super Regional"
    if "regional" in s:
        return "NCAA Regional"
    if "hoover" in s or ("sec" in s and ("championship" in s or "tournament" in s)):
        return "SEC Tournament"
    if "ncaa" in s:
        return "NCAA Tournament"
    return "regular"


def _iso(mmddyyyy):
    # re.match (not strptime) so a doubleheader suffix like "02/14/2026(1)" parses.
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", mmddyyyy or "")
    return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else (mmddyyyy or "")


def _fmt_date(mmddyyyy):
    """'05/16/2026' (or '05/16/2026(1)') -> 'May 16'."""
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", mmddyyyy or "")
    if not m:
        return mmddyyyy or ""
    try:
        dt = datetime.date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
        return dt.strftime("%b ") + str(dt.day)
    except ValueError:
        return mmddyyyy or ""


def _find_dir(seo, name, root=None):
    """Locate <root>/<Label>/ for a team by matching its seo or display name.
    Defaults to the current-season root (DATA_ROOT)."""
    root = root or DATA_ROOT
    if not os.path.isdir(root):
        return None
    targets = {_norm(seo), _norm(name)}
    targets.discard("")
    for d in os.listdir(root):
        full = os.path.join(root, d)
        if os.path.isdir(full) and _norm(d) in targets:
            return full
    return None


def _year_roots():
    """[(year:int, path)] for each sibling 4-digit-year data folder, newest first.
    Lets player histories span seasons as 2025/, 2024/, … are added later."""
    base = os.path.dirname(DATA_ROOT)
    roots = []
    for d in os.listdir(base):
        full = os.path.join(base, d)
        if re.fullmatch(r"\d{4}", d) and os.path.isdir(full):
            roots.append((int(d), full))
    return sorted(roots, reverse=True)


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


def _host_side(data, team_name):
    """Which side ('home'/'away') in this game's line score / player_stats belongs
    to team_name. box['home'] is unreliable for neutral-site (tournament) games,
    so match by name — the team, then the cleaned opponent — before falling back."""
    box = data.get("box", {})
    ls = box.get("line_score") or {}
    hn = _norm((ls.get("home") or {}).get("name"))
    an = _norm((ls.get("away") or {}).get("name"))
    tn = _norm(team_name)
    oppn = _norm(_clean_opp(box.get("opponent", "")))
    if tn and tn == hn:
        return "home"
    if tn and tn == an:
        return "away"
    if oppn and oppn == hn:
        return "away"
    if oppn and oppn == an:
        return "home"
    return "home" if box.get("home") else "away"


# ── Team season stats (aggregated from the saved per-game files) ─────────────
def team_stats(seo, name):
    team_dir = _find_dir(seo, name)
    if not team_dir:
        return None

    bat, pit, field = {}, {}, {"po": 0, "a": 0, "e": 0}
    games_used = 0

    for _dir, data in _iter_games(team_dir):
        host_side = _host_side(data, name)
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


# ── Per-team schedules (built entirely from the saved games) ─────────────────
def schedules(teams):
    """{seo: [games]} built from the local 2026/ folders, in the same shape
    season.build_season produces — so the Scores view and team schedule lists
    render unchanged. `teams` (the API-built list) supplies opponent seo/rank/logo
    for conference opponents; rankings and logos still come from the API.
    """
    # Normalized seo/name -> team, so a game's opponent can be matched to an
    # SEC team (for its real logo slug, rank, and the "SEC Conference" label).
    lookup = {}
    for t in teams:
        for key in (_norm(t["id"]), _norm(t["name"])):
            if key:
                lookup[key] = t

    out = {}
    for t in teams:
        seo, name = t["id"], t["name"]
        out[seo] = []
        team_dir = _find_dir(seo, name)
        if not team_dir:
            continue
        games = []
        for _dir, data in _iter_games(team_dir):
            box = data["box"]
            ls = box.get("line_score") or {}
            opp_name = _clean_opp(box.get("opponent", ""))
            opp_t = lookup.get(_norm(opp_name))
            opp_id = opp_t["id"] if opp_t else _slug(opp_name)
            host = _host_side(data, name)
            other = "away" if host == "home" else "home"
            us = to_int((ls.get(host) or {}).get("r"), None)
            them = to_int((ls.get(other) or {}).get("r"), None)
            res = (box.get("result") or "").strip()[:1].upper()
            games.append({
                "id": box.get("contest_id"),
                "date": _fmt_date(box.get("date")),
                "iso": _iso(box.get("date")),
                "opp": {
                    "id": opp_id,
                    "name": opp_t["name"] if opp_t else opp_name,
                    "mark": (opp_t["mark"] if opp_t else
                             (("".join(w[0] for w in opp_name.split()) or opp_name)[:4]).upper()),
                    "logo": ncaa.logo_url(opp_id),
                    "rank": opp_t["rank"] if opp_t else None,
                    "conf": opp_t is not None,
                },
                "home": host == "home",
                "score": ({"us": us, "them": them}
                          if us is not None and them is not None else None),
                "result": res if res in ("W", "L") else None,
                "time": None,
                "phase": _phase(box.get("opponent", "")),
            })
        games.sort(key=lambda g: g["iso"])
        out[seo] = games
    return out


# ── Per-player career (per-season totals + game-by-game log) ─────────────────
def _bat_game_line(row):
    ab, h = to_int(row.get("AB")), to_int(row.get("H"))
    return {"ab": ab, "r": to_int(row.get("R")), "h": h, "rbi": to_int(row.get("RBI")),
            "bb": to_int(row.get("BB")), "k": to_int(row.get("K")),
            "2b": to_int(row.get("2B")), "3b": to_int(row.get("3B")),
            "hr": to_int(row.get("HR")), "sb": to_int(row.get("SB")),
            "avg": fmt3(h / ab) if ab else ""}


def _pit_game_line(row):
    outs, er = ip_to_outs(row.get("IP")), to_int(row.get("ER"))
    return {"ip": str(row.get("IP", "")), "h": to_int(row.get("H")),
            "r": to_int(row.get("R")), "er": er, "bb": to_int(row.get("BB")),
            "k": to_int(row.get("SO")),
            "era": fmt2(er * 9 / (outs / 3)) if outs else ""}


def player(seo, name, player_name):
    """Per-season batting/pitching totals + a game-by-game log for one player,
    across every saved season. Players are matched by name (jersey #s change
    year to year). Returns None if the player has no saved games.
    """
    pnorm = _norm(player_name)
    if not pnorm:
        return None
    disp = {"name": player_name, "num": "", "pos": ""}
    seasons = []

    for year, root in _year_roots():
        team_dir = _find_dir(seo, name, root)
        if not team_dir:
            continue
        b = {k: 0 for k in ("g", "ab", "r", "h", "2b", "3b", "hr", "rbi",
                            "bb", "k", "hbp", "sf", "sb")}
        p = {k: 0 for k in ("g", "outs", "h", "r", "er", "bb", "k")}
        games = []
        for _dir, data in _iter_games(team_dir):
            side = (data.get("players") or {}).get(_host_side(data, name)) or {}
            brow = next((r for r in side.get("batting", [])
                         if _norm(r.get("Name")) == pnorm), None)
            prow = next((r for r in side.get("pitching", [])
                         if _norm(r.get("Name")) == pnorm), None)
            if not (brow or prow):
                continue
            row0 = brow or prow
            disp["name"] = row0.get("Name") or disp["name"]
            disp["num"] = row0.get("#") or disp["num"]
            disp["pos"] = (brow.get("P") if brow else None) or disp["pos"] \
                or (prow.get("P") if prow else "")
            box = data["box"]
            host = _host_side(data, name)
            games.append({
                "iso": _iso(box.get("date")), "date": _fmt_date(box.get("date")),
                "opp": _clean_opp(box.get("opponent", "")), "home": host == "home",
                "result": (box.get("result") or "").strip()[:1].upper(),
                "bat": _bat_game_line(brow) if brow else None,
                "pit": _pit_game_line(prow) if prow else None,
            })
            if brow and (to_int(brow.get("AB")) or to_int(brow.get("BB"))):
                b["g"] += 1
                for src, dst in (("AB", "ab"), ("R", "r"), ("H", "h"), ("2B", "2b"),
                                 ("3B", "3b"), ("HR", "hr"), ("RBI", "rbi"),
                                 ("BB", "bb"), ("K", "k"), ("HBP", "hbp"),
                                 ("SF", "sf"), ("SB", "sb")):
                    b[dst] += to_int(brow.get(src))
            if prow and ip_to_outs(prow.get("IP")):
                p["g"] += 1
                p["outs"] += ip_to_outs(prow.get("IP"))
                for src, dst in (("H", "h"), ("R", "r"), ("ER", "er"),
                                 ("BB", "bb"), ("SO", "k")):
                    p[dst] += to_int(prow.get(src))

        if not games:
            continue
        games.sort(key=lambda g: g["iso"])

        batting = None
        if b["g"]:
            ab, h, bb, hbp, sf = b["ab"], b["h"], b["bb"], b["hbp"], b["sf"]
            tb = h + b["2b"] + 2 * b["3b"] + 3 * b["hr"]
            obp_d = ab + bb + hbp + sf
            obp = (h + bb + hbp) / obp_d if obp_d else 0.0
            slg = tb / ab if ab else 0.0
            batting = {"g": b["g"], "ab": ab, "r": b["r"], "h": h, "2b": b["2b"],
                       "3b": b["3b"], "hr": b["hr"], "rbi": b["rbi"], "bb": bb,
                       "k": b["k"], "sb": b["sb"], "avg": fmt3(h / ab if ab else 0),
                       "obp": fmt3(obp), "slg": fmt3(slg), "ops": fmt3(obp + slg)}
        pitching = None
        if p["g"]:
            ipnum = p["outs"] / 3 if p["outs"] else 0.0
            pitching = {"g": p["g"], "ip": outs_to_ip(p["outs"]), "h": p["h"],
                        "r": p["r"], "er": p["er"], "bb": p["bb"], "k": p["k"],
                        "era": fmt2(p["er"] * 9 / ipnum) if ipnum else "—",
                        "whip": fmt2((p["bb"] + p["h"]) / ipnum) if ipnum else "—"}

        seasons.append({"year": year, "batting": batting,
                        "pitching": pitching, "games": games})

    if not seasons:
        return None
    return {"name": disp["name"], "num": disp["num"], "pos": disp["pos"],
            "team": name, "teamId": seo, "seasons": seasons}
