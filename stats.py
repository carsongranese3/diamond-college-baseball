"""Aggregate a team's real season batting/pitching by summing every box score.

Each box score's `hittingSeason` block is that game's line (not cumulative), so
season totals are the sum across all of a team's games. Pitching has no season
block and is summed from per-game `pitcherStats`.
"""

import ncaa
from boxutil import (find_team_entry, fmt2, fmt3, ip_to_outs, outs_to_ip,
                      player_name, to_int)


def _pkey(p):
    return (p.get("number"), (p.get("lastName") or "").strip(),
            (p.get("firstName") or "").strip())


def compute_team_stats(seo, schedule):
    bat = {}
    pit = {}
    field = {"po": 0, "a": 0, "e": 0, "dp": 0}
    games_used = 0

    for entry in schedule:
        if not entry.get("result") or not entry.get("id"):
            continue
        try:
            box = ncaa.boxscore(entry["id"])
        except ncaa.NotFound:
            continue
        team_id, _ = find_team_entry(box, seo)
        if team_id is None:
            continue
        tb = next((b for b in box.get("teamBoxscore", [])
                   if str(b.get("teamId")) == team_id), None)
        if not tb:
            continue
        games_used += 1

        for p in tb.get("playerStats", []):
            key = _pkey(p)
            hs = p.get("hittingSeason") or {}
            bs = p.get("batterStats") or {}
            if hs or bs:
                src = hs or bs
                ab = to_int(src.get("atBats"))
                played = ab > 0 or to_int(src.get("walks")) > 0
                if played:
                    b = bat.setdefault(key, {
                        "name": player_name(p),
                        "pos": (p.get("position") or "").upper(),
                        "num": p.get("number"),
                        "g": 0, "ab": 0, "r": 0, "h": 0, "2b": 0, "3b": 0,
                        "hr": 0, "rbi": 0, "bb": 0, "k": 0,
                    })
                    b["g"] += 1
                    b["ab"] += ab
                    b["r"] += to_int(src.get("runsScored"))
                    b["h"] += to_int(src.get("hits"))
                    b["2b"] += to_int(src.get("doubles"))
                    b["3b"] += to_int(src.get("triples"))
                    b["hr"] += to_int(src.get("homeRuns"))
                    b["rbi"] += to_int(src.get("runsBattedIn"))
                    b["bb"] += to_int(src.get("walks"))
                    b["k"] += to_int(src.get("strikeouts"))

            fs = p.get("fieldStats") or {}
            field["po"] += to_int(fs.get("putouts"))
            field["a"] += to_int(fs.get("assists"))
            field["e"] += to_int(fs.get("errors"))
            field["dp"] += to_int(fs.get("involvedInDoublePlays"))

            psr = p.get("pitcherStats")
            if psr:
                a = pit.setdefault(key, {
                    "name": player_name(p), "pos": (p.get("position") or "P").upper(),
                    "num": p.get("number"), "g": 0, "gs": 0, "outs": 0,
                    "h": 0, "r": 0, "er": 0, "bb": 0, "k": 0,
                    "w": 0, "l": 0, "sv": 0,
                })
                a["g"] += 1
                if p.get("starter"):
                    a["gs"] += 1
                a["outs"] += ip_to_outs(psr.get("inningsPitched"))
                a["h"] += to_int(psr.get("hitsAllowed"))
                a["r"] += to_int(psr.get("runsAllowed"))
                a["er"] += to_int(psr.get("earnedRunsAllowed"))
                a["bb"] += to_int(psr.get("walksAllowed"))
                a["k"] += to_int(psr.get("strikeouts"))
                a["w"] += to_int(psr.get("win"))
                a["l"] += to_int(psr.get("loss"))
                a["sv"] += to_int(psr.get("save"))

    batters = []
    for b in bat.values():
        ab, h, bb = b["ab"], b["h"], b["bb"]
        tb_ = h + b["2b"] + 2 * b["3b"] + 3 * b["hr"]
        avg = h / ab if ab else 0.0
        obp = (h + bb) / (ab + bb) if (ab + bb) else 0.0
        slg = tb_ / ab if ab else 0.0
        batters.append({
            "name": b["name"], "pos": b["pos"], "num": b["num"],
            "g": b["g"], "ab": ab, "r": b["r"], "h": h, "hr": b["hr"],
            "rbi": b["rbi"], "bb": bb, "k": b["k"], "sb": "—",
            "avg": fmt3(avg), "obp": fmt3(obp), "slg": fmt3(slg),
            "ops": fmt3(obp + slg),
            "_tb": tb_,
        })
    batters.sort(key=lambda x: x["ab"], reverse=True)

    pitchers = []
    for p in pit.values():
        outs = p["outs"]
        ipnum = outs / 3 if outs else 0.0
        era = (p["er"] * 9 / ipnum) if ipnum else 0.0
        whip = ((p["bb"] + p["h"]) / ipnum) if ipnum else 0.0
        pitchers.append({
            "name": p["name"], "pos": p["pos"], "num": p["num"],
            "g": p["g"], "gs": p["gs"], "w": p["w"], "l": p["l"], "sv": p["sv"],
            "ip": outs_to_ip(outs), "h": p["h"], "r": p["r"], "er": p["er"],
            "bb": p["bb"], "k": p["k"], "era": fmt2(era), "whip": fmt2(whip),
            "_outs": outs,
        })
    pitchers.sort(key=lambda x: x["_outs"], reverse=True)

    tab = sum(b["ab"] for b in batters)
    th = sum(b["h"] for b in batters)
    tbb = sum(b["bb"] for b in batters)
    ttb = sum(b["_tb"] for b in batters)
    thr = sum(b["hr"] for b in batters)
    trbi = sum(b["rbi"] for b in batters)
    truns = sum(b["r"] for b in batters)
    b_avg = th / tab if tab else 0.0
    b_obp = (th + tbb) / (tab + tbb) if (tab + tbb) else 0.0
    b_slg = ttb / tab if tab else 0.0

    p_outs = sum(p["_outs"] for p in pitchers)
    p_ipnum = p_outs / 3 if p_outs else 0.0
    p_er = sum(p["er"] for p in pitchers)
    p_h = sum(p["h"] for p in pitchers)
    p_bb = sum(p["bb"] for p in pitchers)
    p_k_raw = sum(p["k"] for p in pitchers)
    p_sv = sum(p["sv"] for p in pitchers)
    # The NCAA API never populates pitcher strikeouts (always 0); show "—".
    k_available = p_k_raw > 0
    if not k_available:
        for p in pitchers:
            p["k"] = "—"

    qualified = [b for b in batters if b["ab"] >= max(20, tab // 80)]
    avg_l = max(qualified, key=lambda r: float(r["avg"] or 0), default=None)
    hr_l = max(batters, key=lambda r: r["hr"], default=None)
    qp = [p for p in pitchers if p["_outs"] >= 60]
    # ERA leader: lowest ERA among pitchers with enough innings (60 outs = 20 IP).
    era_l = min(qp, key=lambda r: float(r["era"] or 99), default=None)
    # Strikeout leader: most K (only when strikeout data is available).
    k_l = (max(pitchers, key=lambda r: r["k"], default=None)
           if k_available else None)

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
                        "line": f"{era_l['era']} ERA / {era_l['k']} K / {era_l['ip']} IP",
                        "note": "ERA"})
    if k_l and k_l["k"] > 0:
        leaders.append({"name": k_l["name"], "pos": k_l["pos"],
                        "line": f"{k_l['k']} K / {k_l['era']} ERA / {k_l['ip']} IP",
                        "note": "Strikeouts"})

    for b in batters:
        b.pop("_tb", None)
    for p in pitchers:
        p.pop("_outs", None)

    po, a, e = field["po"], field["a"], field["e"]
    fp = (po + a) / (po + a + e) if (po + a + e) else 0.0

    return {
        "_games": games_used,
        "batting": {
            "avg": fmt3(b_avg), "obp": fmt3(b_obp), "slg": fmt3(b_slg),
            "hr": thr, "rbi": trbi, "sb": "—", "runs": truns, "h": th,
        },
        "pitching": {
            "era": fmt2((p_er * 9 / p_ipnum) if p_ipnum else 0.0),
            "whip": fmt2(((p_bb + p_h) / p_ipnum) if p_ipnum else 0.0),
            "k": p_k_raw if k_available else "—",
            "bb": p_bb, "sv": p_sv, "ip": outs_to_ip(p_outs),
            "hr_a": 0, "oba": "—",
        },
        "fielding": {"pct": fmt3(fp), "e": e, "dp": field["dp"] // 2,
                     "fp": fmt3(fp)},
        "leaders": leaders,
        "roster": {"batters": batters, "pitchers": pitchers},
    }
