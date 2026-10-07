"""Build the data for the front-end Bracket view.

ncaa_bracket():  the full 64-team NCAA D1 championship bracket, normalized from
the henrygd brackets API — every region and round. The tournament runs live, so
later rounds (super regionals, CWS, finals) are mostly TBD until they're played.
Also returns a left/right `tree` pairing each super regional's two feeder
regionals, for the bracket-style overview.

conf_bracket(teams, schedules, records, phase_label, title):  any conference
tournament, reconstructed from its locally-saved tournament games and seeded by
the regular-season conference standings.
"""

import ncaa
from cities import city_for

# sectionId // 100 -> tournament round.
ROUND_TITLES = {1: "Regionals", 2: "Super Regionals",
                3: "World Series", 4: "World Series Finals"}


# ── NCAA: normalize the championship bracket API ─────────────────────────────
def _bteam(t):
    """One side of an NCAA bracket game -> a clean team dict, or None if TBD."""
    name = t.get("nameShort")
    if not name:
        return None
    seo = t.get("seoname") or ""
    return {
        "name": name,
        "seo": seo,
        "seed": t.get("seed"),
        "score": t.get("score"),
        "winner": bool(t.get("isWinner")),
        "home": bool(t.get("isHome")),
        "logo": ncaa.logo_url(seo) if seo else "",
    }


def _bgame(g):
    teams = g.get("teams") or []
    top = next((_bteam(t) for t in teams if t.get("isTop")), None)
    bottom = next((_bteam(t) for t in teams if not t.get("isTop")), None)
    if top is None and bottom is None and teams:   # fall back to list order
        top = _bteam(teams[0])
        bottom = _bteam(teams[1]) if len(teams) > 1 else None
    return {
        "id": g.get("contestId"),
        "date": g.get("startDate"),
        "time": g.get("startTime"),
        "state": g.get("gameState"),          # F final · I in-progress · P pending
        "section": g.get("sectionId"),
        "pos": g.get("bracketPositionId") or 0,
        "ifNecessary": bool(g.get("isIfNecessary")),
        "top": top,
        "bottom": bottom,
    }


def _super_box(games, regionals):
    """The super-regional matchup as a single game-like box: the two regional
    champions with score = games won in the (best-of-3) super. Slots follow the
    feeder regionals' order (top regional's champion on top). Falls back to TBD
    when the regional champ or super games aren't decided yet."""
    wins = {}
    for gm in games:
        for s in (gm.get("top"), gm.get("bottom")):
            if s and s.get("seo") and s.get("winner"):
                wins[s["seo"]] = wins.get(s["seo"], 0) + 1

    def slot(reg):
        champ = reg.get("winner")
        if not champ:
            return None
        t = next((x for x in reg["teams"] if x["seo"] == champ), None)
        w = wins.get(champ, 0)
        return {"seo": champ, "name": t["name"] if t else champ,
                "seed": t.get("seed") if t else None,
                "logo": t["logo"] if t else ncaa.logo_url(champ),
                "score": w, "winner": w >= 2}

    top, bottom = slot(regionals[0]), slot(regionals[1])
    state = "F" if (top and top["winner"]) or (bottom and bottom["winner"]) else (
        "I" if any(g["state"] == "I" for g in games) else "P")
    return {"top": top, "bottom": bottom, "state": state}


def _super_host(games, sbox):
    """(seo, name) of the Super Regional HOST — the higher national seed of the
    two teams that actually advanced, which is the home team of the super's games.
    A Super hosted by the #1 national seed shifts if that seed is upset in its
    regional (e.g. UCLA out, West Virginia hosts). Priority:
      1) the home team of game 1 (definitive once the matchup is set), then
      2) the higher-seeded of the two advancing teams (for not-yet-played supers)."""
    playable = [g for g in games if g.get("top") or g.get("bottom")]
    if playable:
        g1 = min(playable, key=lambda g: g.get("pos") or 0)
        for s in (g1.get("top"), g1.get("bottom")):
            if s and s.get("home") and s.get("seo"):
                return s["seo"], s.get("name")
    cands = [s for s in (sbox.get("top"), sbox.get("bottom")) if s and s.get("seo")]
    if cands:
        cands.sort(key=lambda s: (s.get("seed") is None, s.get("seed") or 999))
        return cands[0]["seo"], cands[0].get("name")
    return None, None


def _game_iso(g):
    """'06/20/2026' (a bracket game's startDate) -> '2026-06-20', or ''."""
    try:
        mo, da, yr = (g.get("startDate") or "").split("/")
        return f"{yr}-{mo}-{da}"
    except ValueError:
        return ""


def _hide_after(raw, asof):
    """Bracket games with every result after `asof` (ISO date) scrubbed — treated as
    unplayed (pending, no scores/winner), so a past-date view has no spoilers. Teams
    that only got into a later game BECAUSE of a result are blanked too: any game in
    the super regional / CWS / finals sections, and regional games past each
    section's first two (whose participants are set by earlier results)."""
    first_two = {}
    for g in raw:
        first_two.setdefault(g.get("sectionId"), []).append(g.get("bracketPositionId") or 0)
    first_two = {sid: set(sorted(p)[:2]) for sid, p in first_two.items()}
    out = []
    for g in raw:
        iso = _game_iso(g)
        if not iso or iso <= asof:
            out.append(g)
            continue
        sid = g.get("sectionId")
        later = (sid is not None and sid // 100 >= 2) or \
                (g.get("bracketPositionId") or 0) not in first_two.get(sid, ())
        teams = [] if later else [
            {**t, "score": None, "isWinner": False} for t in (g.get("teams") or [])]
        out.append({**g, "gameState": "P", "teams": teams})
    return out


def ncaa_bracket(year=2026, asof=None):
    """`asof` (ISO date): treat games after it as unplayed (see _hide_after)."""
    data = ncaa.bracket(year)
    ch = (data.get("championships") or [{}])[0]
    raw = ch.get("games") or []
    if asof:
        raw = _hide_after(raw, asof)

    sections = {}
    for g in raw:
        sid = g.get("sectionId")
        if sid is not None:
            sections.setdefault(sid, []).append(_bgame(g))

    # victor links: which section each game's winner advances into. Lets us learn
    # the bracket wiring (regional -> super -> world-series half) from the data.
    bpos_sec = {g["bracketPositionId"]: g["sectionId"] for g in raw}
    advances = {}
    for g in raw:
        v, sid = g.get("victorBracketPositionId"), g["sectionId"]
        tgt = bpos_sec.get(v)
        if tgt and tgt != sid:
            advances[sid] = tgt

    groups = {}
    for sid, games in sections.items():
        games.sort(key=lambda x: x["pos"])
        seen = {}
        for gm in games:
            for s in (gm["top"], gm["bottom"]):
                if s and s["seo"] and s["seo"] not in seen:
                    seen[s["seo"]] = {"name": s["name"], "seo": s["seo"],
                                      "seed": s["seed"], "logo": s["logo"]}
        # Regional seeds 1–4 by bracket slot: Game 1 is #1 (top, the host) vs #4
        # (bottom); Game 2 is #3 (top) vs #2 (bottom) — the #2 seed is the bottom
        # team. Verified against the live bracket's top/bottom ordering.
        if sid // 100 == 1 and len(games) >= 2:
            for s, rseed in [(games[0]["top"], 1), (games[0]["bottom"], 4),
                             (games[1]["top"], 3), (games[1]["bottom"], 2)]:
                if s and s["seo"] in seen:
                    seen[s["seo"]]["rseed"] = rseed
        teams = sorted(seen.values(),
                       key=lambda t: (t.get("rseed") or t["seed"] or 99, t["name"]))
        # A regional champion is the last team standing (others 2-loss eliminated).
        winner = None
        if sid // 100 == 1:
            losses = {}
            for gm in games:
                if gm["state"] != "F":
                    continue
                for s in (gm["top"], gm["bottom"]):
                    if s and s["seo"] and not s["winner"]:
                        losses[s["seo"]] = losses.get(s["seo"], 0) + 1
            alive = [t for t in teams if losses.get(t["seo"], 0) < 2]
            winner = alive[0]["seo"] if len(alive) == 1 else None
        host = next((t for t in teams if t["seed"] is not None),
                    teams[0] if teams else None)
        # Regionals/Supers are named for the host's CITY (Austin, not Texas).
        city = city_for(host["seo"], host["name"]) if host else "Region %s" % sid
        groups[sid] = {
            "id": sid, "teams": teams, "games": games, "winner": winner,
            "label": host["name"] if host else "Region %s" % sid,
            "city": city,
            "seed": host["seed"] if host else None,
        }

    # rounds (kept for the regional grid + the regional double-elim modal)
    rounds = {}
    for sid, grp in groups.items():
        rounds.setdefault(sid // 100, []).append(grp)
    out = []
    for r in sorted(rounds):
        out.append({"number": r, "title": ROUND_TITLES.get(r, "Round %d" % r),
                    "groups": sorted(rounds[r], key=lambda x: x["id"])})

    # Super-regional tree + CWS halves, placed by the FIXED NCAA bracket structure
    # using each super's national SEED LINE (the top feeder regional's seed). The
    # feed's advance links can be missing for a super whose game isn't decided yet
    # (the #5 line had none), which used to dump that super onto the wrong side — so
    # we place by seed line, which is always known. Standard order, top→bottom:
    # bracket 1 (left) = 1,8,4,5; bracket 2 (right) = 2,7,3,6.
    LEFT_LINES, RIGHT_LINES = [1, 8, 4, 5], [2, 7, 3, 6]
    supers = {}
    for sid in groups:
        if sid // 100 == 1 and sid in advances:
            supers.setdefault(advances[sid], []).append(sid)

    def _seed_line(sup_sid):
        seeds = [groups[r]["seed"] for r in supers[sup_sid] if groups[r].get("seed")]
        return min(seeds) if seeds else 99

    side_of, order_of = {}, {}
    for sup_sid in supers:
        line = _seed_line(sup_sid)
        if line in LEFT_LINES:
            side_of[sup_sid], order_of[sup_sid] = "left", LEFT_LINES.index(line)
        elif line in RIGHT_LINES:
            side_of[sup_sid], order_of[sup_sid] = "right", RIGHT_LINES.index(line)
        else:                       # off-structure bracket: keep it stable, don't crash
            side_of[sup_sid], order_of[sup_sid] = "right", 99

    # WS section id per half — the half holding seed line #1 is the left bracket.
    ws_targets = sorted({advances[s] for s in supers if s in advances})
    line1 = next((s for s in supers if _seed_line(s) == 1), None)
    left_ws = (advances.get(line1) if line1 and advances.get(line1)
               else (ws_targets[0] if ws_targets else None))
    right_ws = next((w for w in ws_targets if w != left_ws), None)

    tree = {"left": [], "right": []}
    super_champ_by_side = {"left": [], "right": []}
    for sup_sid in sorted(supers, key=lambda s: (side_of[s] == "right", order_of[s], s)):
        regs = sorted(supers[sup_sid], key=lambda r: groups[r]["seed"] or 99)
        reg_groups = [groups[r] for r in regs]
        side = side_of[sup_sid]
        sbox = _super_box(sections.get(sup_sid, []), reg_groups)
        # Named for the HOST's city — the higher seed of the two advancing teams,
        # which may not be either feeder regional's host if a top seed was upset.
        host_seo, host_name = _super_host(sections.get(sup_sid, []), sbox)
        host_city = (city_for(host_seo, host_name) if host_seo
                     else (reg_groups[0]["city"] if reg_groups else None))
        # Flag the host so the UI can place the home team beneath the visitor.
        for s in (sbox.get("top"), sbox.get("bottom")):
            if s and s.get("seo"):
                s["home"] = (s["seo"] == host_seo)
        tree[side].append({"id": sup_sid, "regionals": reg_groups, "super": sbox,
                           "games": sections.get(sup_sid, []), "host_city": host_city})
        champ = next((s for s in (sbox["top"], sbox["bottom"])
                      if s and s.get("winner")), None)
        super_champ_by_side[side].append(champ)

    # College World Series: the two WS halves (301/302) sit between the supers
    # and the finals. Each is a 4-team double-elim pod of the four super winners
    # on that side; its champion (last team standing) plays the best-of-3 finals
    # (the WS sections' advance target) against the other half's champion.
    finals_sid = next((advances[w] for w in ws_targets if w in advances), None)

    def _half_champion(ws_sid):
        losses, seos, info = {}, set(), {}
        for gm in sections.get(ws_sid, []):
            for s in (gm["top"], gm["bottom"]):
                if s and s["seo"]:
                    seos.add(s["seo"])
                    info[s["seo"]] = s
                    if gm["state"] == "F" and not s["winner"]:
                        losses[s["seo"]] = losses.get(s["seo"], 0) + 1
        alive = [s for s in seos if losses.get(s, 0) < 2]
        champ = alive[0] if (seos and len(alive) == 1) else None
        if not champ:
            return None
        wins = 0
        for gm in (sections.get(finals_sid, []) if finals_sid else []):
            for s in (gm["top"], gm["bottom"]):
                if s and s["seo"] == champ and s["winner"]:
                    wins += 1
        t = info[champ]
        return {"seo": champ, "name": t["name"], "seed": t.get("seed"),
                "logo": t["logo"], "score": wins, "winner": wins >= 2}

    def _cws_half(ws_sid, side):
        # The 4 team slots are the super winners feeding this half (None = TBD).
        teams = [{"seo": c["seo"], "name": c["name"], "seed": c.get("seed"),
                  "logo": c["logo"]} for c in super_champ_by_side[side] if c]
        win = _half_champion(ws_sid)
        return {"id": ws_sid, "label": "World Series", "seed": None,
                "teams": teams, "games": sections.get(ws_sid, []),
                "winner": win["seo"] if win else None}

    top = _half_champion(left_ws) if left_ws else None
    bottom = _half_champion(right_ws) if right_ws else None
    fstate = "F" if (top and top["winner"]) or (bottom and bottom["winner"]) else "P"

    # First (scheduled) date of the best-of-3 finals, as ISO — the day the CWS Finals
    # begin. The site uses this to switch from the CWS screen to the Finals screen on
    # the right calendar day (respecting the as-of date), not just whenever the
    # live bracket happens to have the matchup. None until the finals are scheduled.
    def _iso(d):                                   # "06/20/2026" -> "2026-06-20"
        try:
            mo, da, yr = (d or "").split("/")
            return f"{yr}-{mo}-{da}"
        except ValueError:
            return None
    finals_isos = sorted(i for i in (_iso(g.get("date"))
                                     for g in (sections.get(finals_sid, []) if finals_sid else []))
                         if i)
    finals_start = finals_isos[0] if finals_isos else None

    center = {
        "halves": {
            "left": _cws_half(left_ws, "left") if left_ws else None,
            "right": _cws_half(right_ws, "right") if right_ws else None,
        },
        "finals": {"top": top, "bottom": bottom, "state": fstate, "startDate": finals_start,
                   # Per-game series list (same _bgame shape as a super's games) so the
                   # frontend can open the best-of-3 finals like a super regional.
                   "games": sections.get(finals_sid, []) if finals_sid else []},
    }

    # team seo -> its regional's host city, for every team in every regional, so
    # the site can name a team's regional by host city from any perspective.
    regional_cities = {}
    for sid, grp in groups.items():
        if sid // 100 != 1:
            continue
        for t in grp["teams"]:
            if t.get("seo"):
                regional_cities[t["seo"]] = grp["city"]

    return {"title": ch.get("title", "NCAA Tournament"),
            "rounds": out, "tree": tree, "center": center,
            "regional_cities": regional_cities}


# ── Conference tournaments: reconstruct any conference's bracket from local games
def _conf_pct(rec):
    w, l = rec.get("confW", 0), rec.get("confL", 0)
    return w / (w + l) if (w + l) else 0.0


def conf_tourney_phase(schedules):
    """The conference-tournament phase string present in these schedules (e.g.
    "ACC Tournament" / "SEC Tournament"), or None if no tournament is scheduled.
    Conference-tournament labels all end in "Tournament"; NCAA rounds don't
    ("NCAA Regional"/"NCAA Super Regional"), so this cleanly selects the conf
    tourney without naming any specific conference."""
    for games in schedules.values():
        for g in games:
            p = g.get("phase") or ""
            if p.endswith("Tournament") and p != "NCAA Tournament":
                return p
    return None


def conf_bracket(teams, schedules, records, phase_label, title=None):
    """Reconstruct a conference tournament bracket from the locally-saved games
    whose phase == phase_label (e.g. "SEC Tournament"), seeded by regular-season
    conference standings. Conference-agnostic — pass the phase string and an
    optional display title (defaults to "2026 <phase_label>")."""
    by_seo = {t["id"]: t for t in teams}

    # Seed the 16 teams by regular-season conference record (1 = best).
    seeded = sorted(teams, key=lambda t: (-_conf_pct(records.get(t["id"], {})),
                                          -records.get(t["id"], {}).get("confW", 0),
                                          t["name"]))
    seed_of = {t["id"]: i + 1 for i, t in enumerate(seeded)}

    def side(seo, score, fallback_name=None):
        t = by_seo.get(seo)
        return {
            "seo": seo,
            "name": t["name"] if t else (fallback_name or seo),
            "seed": seed_of.get(seo),
            "mark": t["mark"] if t else None,
            "score": score,
            "logo": (t["logo"] if t else ncaa.logo_url(seo)),
        }

    # Dedup the tournament games (each appears once per conference team).
    seen = {}
    for seo, games in schedules.items():
        for g in games:
            if g.get("phase") != phase_label:
                continue
            gid = g.get("id")
            if gid in seen:
                continue
            sc = g.get("score") or {}
            a = side(seo, sc.get("us"))
            b = side(g["opp"]["id"], sc.get("them"), g["opp"].get("name"))
            res = g.get("result")
            winner = a["seo"] if res == "W" else (b["seo"] if res == "L" else None)
            seen[gid] = {"id": gid, "iso": g.get("iso"), "date": g.get("date"),
                         "top": a, "bottom": b, "winner": winner}

    # Each side either advanced from a feeder game, or — if this is the team's
    # first game past round 1 — entered on a bye. A bye becomes a single-team cell
    # placed ONE round earlier (double bye in round 2, not round 1).
    ordered = sorted(seen.values(), key=lambda g: (g["iso"] or "", str(g["id"])))
    won_round, won_game, appeared = {}, {}, set()
    games, bye_cells = {}, {}
    for gm in ordered:
        a, b = gm["top"]["seo"], gm["bottom"]["seo"]
        gm["_round"] = 1 + max(won_round.get(a, 0), won_round.get(b, 0))
        # In the #1 overall seed's ENTERING game (it arrives on a bye, so it
        # hasn't appeared yet), put it on the BOTTOM so its bye drops beneath the
        # game it feeds into — mirroring the bottom half of the bracket. Scoped to
        # just this game (not Georgia's later games), so nothing else reorders.
        if gm["top"].get("seed") == 1 and gm["_round"] > 1 and a not in appeared:
            gm["top"], gm["bottom"] = gm["bottom"], gm["top"]
            a, b = b, a
        gm["type"] = "game"
        gm["children"] = {}
        for key, seo in (("top", a), ("bottom", b)):
            feeder = won_game.get(seo)
            if feeder:
                gm["children"][key] = feeder
            elif seo not in appeared and gm["_round"] > 1:
                bid = "bye-%s-%s" % (gm["id"], key)
                bye_cells[bid] = {"id": bid, "type": "bye", "team": gm[key],
                                  "_round": gm["_round"] - 1}
                gm["children"][key] = bid
        games[gm["id"]] = gm
        appeared.add(a)
        appeared.add(b)
        if gm["winner"]:
            won_round[gm["winner"]] = gm["_round"]
            won_game[gm["winner"]] = gm["id"]

    # Tree layout: each leaf (round-1 game or bye cell) gets a slot; each parent
    # sits at the average of its children — the standard non-crossing bracket.
    ypos, counter = {}, [0]

    def _assign(nid):
        if nid in ypos:
            return ypos[nid]
        node = games.get(nid)
        kids = list(node["children"].values()) if node else []
        if not kids:
            ypos[nid] = counter[0]
            counter[0] += 1
        else:
            ypos[nid] = sum(_assign(c) for c in kids) / len(kids)
        return ypos[nid]

    for gm in sorted(ordered, key=lambda x: (-x["_round"], str(x["id"]))):
        _assign(gm["id"])
    span = max(counter[0] - 1, 1)

    cells_by_round = {}
    for cell in list(ordered) + list(bye_cells.values()):
        cell["y"] = ypos.get(cell["id"], 0) / span
        cells_by_round.setdefault(cell["_round"], []).append(cell)
    maxr = max(cells_by_round) if cells_by_round else 0
    rounds = []
    for r in sorted(cells_by_round):
        cells = sorted(cells_by_round[r], key=lambda c: c["y"])
        rtitle = ("Championship" if r == maxr else
                  "Semifinals" if r == maxr - 1 else "Round %d" % r)
        rounds.append({"number": r, "title": rtitle, "cells": cells})

    seeds = [{"seed": seed_of[t["id"]], "name": t["name"], "seo": t["id"],
              "mark": t["mark"], "logo": t["logo"]} for t in seeded]
    return {"title": title or ("2026 " + phase_label), "seeds": seeds, "rounds": rounds}


