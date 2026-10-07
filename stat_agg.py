"""Side-effect-free per-game aggregation of a team's saved box scores into season
totals — one row per player for batting / pitching / fielding.

Shared by scripts/build_stats.py (which writes the results to <Team>/stats/*.json)
and local_data (which calls it with an `asof` cutoff to rewind a team's stats to a
past date, since the precomputed stats files only hold full-season totals). See
build_stats.py's docstring for the stored fields.
"""

import collections
import json
import os
import re

import local_data as ld
from boxutil import ip_to_outs, outs_to_ip, to_int

# ── Batted-ball types (GB/FB/LD/PU) from the detailed play-by-play ────────────
# Only games with a play_by_play_detailed.json (currently the SEC pulls) contribute;
# absent files just leave the counts at 0, so they fill in as more PBP is pulled.
_NAME_SUFFIX = {"jr", "sr", "ii", "iii", "iv", "v"}


def _last_key(full):
    """Box-score full name ('Carson Tinney', 'Anthony Pack Jr.') -> (last, first-init)."""
    toks = re.sub(r"[.,]", " ", full or "").split()
    if not toks:
        return None, ""
    fi = toks[0][0].lower()
    while len(toks) > 1 and toks[-1].lower() in _NAME_SUFFIX:
        toks.pop()
    return toks[-1].lower(), fi


def _pbp_last(name):
    """PBP batter ('Tinney', 'Pack Jr.', 'Galloway, R.') -> (last, first-init)."""
    name = (name or "").strip()
    if "," in name:                         # "Galloway, R."
        last, rest = name.split(",", 1)
        toks = last.split()
        return (toks[-1].lower() if toks else ""), (rest.strip()[:1].lower() if rest.strip() else "")
    toks = name.split()
    while len(toks) > 1 and toks[-1].lower().rstrip(".") in _NAME_SUFFIX:
        toks.pop()
    return (toks[-1].lower() if toks else ""), ""


def _batted_ball_type(play):
    """Classify one play's batted-ball type from its description/outcome, or None.
    Reliable for outs (grounded/lined/popped/flied) and home runs (fly balls). Hits
    described only by field/direction carry no stated trajectory, so they stay None
    (not every ball in play is classifiable from text PBP)."""
    desc = (play.get("description") or "").lower()
    oc = play.get("outcome") or ""
    if "grounded" in desc: return "gb"
    if "lined" in desc:    return "ld"
    if "popped" in desc:   return "pu"
    if "flied" in desc:    return "fb"
    if oc in ("Groundout", "Grounded into double play"): return "gb"
    if oc == "Lineout":   return "ld"
    if oc in ("Pop out", "Infield fly"): return "pu"
    if oc == "Flyout":    return "fb"
    if oc == "Home run":  return "fb"        # home runs are fly balls
    if oc == "Foul out":
        return "fb" if re.search(r"\b(lf|cf|rf)\b", desc) else "pu"
    # Grounder hits: the PBP names where the ball went, and these phrasings are
    # ground balls by convention (balls through the infield + infield hits). Hits
    # "to <outfield>" carry no trajectory (fly vs line drive), so they stay None.
    if oc in ("Single", "Double", "Triple"):
        if ("through the" in desc and "side" in desc) or "up the middle" in desc:
            return "gb"
        if re.search(r"\bto (ss|2b|3b|1b|shortstop|second base|third base|first base|pitcher)\b", desc):
            return "gb"
    return None


def _pa_event_type(play):
    """Plate-appearance outcome stats kept separately from batted-ball type:
    swinging/looking strikeouts, reached-on-error, fielder's choice, and catcher's
    interference (the batter is awarded the base — distinct from a 'batter's
    interference' out). Returns ks/kl/roe/fc/ci, or None."""
    oc = play.get("outcome") or ""
    desc = (play.get("description") or "").lower()
    if oc == "Strikeout (swinging)": return "ks"
    if oc == "Strikeout (looking)":  return "kl"
    if oc == "Catcher interference": return "ci"   # now its own outcome in the PBP
    if oc == "Reached on error":     return "roe"
    if oc == "Fielder's choice":     return "fc"
    if "catcher's interference" in desc:
        return "ci"
    # A runner picked off and out — a standalone play whose `batter` field is the
    # picked-off runner. Exclude "failed pickoff attempt" (the runner stayed safe).
    if oc == "—" and "picked off" in desc and "failed pickoff" not in desc:
        return "po"
    return None


def _add_batted_balls(game_dir, players, side, bat):
    """Tally GB/FB/LD/PU and the PA-outcome stats (K swinging/looking, ROE, FC, CI)
    into the batting accumulators from this game's detailed PBP.
    Attributes plays to the right team by figuring out which half-inning OUR team bats
    in (the box-score home/away labels don't track Top/Bottom at neutral sites), using
    batters whose last name is unique to us — so an opponent sharing a last name can't
    be miscounted."""
    dp = os.path.join(game_dir, "play_by_play_detailed.json")
    if not os.path.exists(dp):
        return
    try:
        pbp = json.load(open(dp, encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    plays = pbp.get("plays") or []

    def last_names(rows):
        out = {}
        for r in rows or []:
            nm = (r.get("Name") or "").strip()
            lk, fi = _last_key(nm)
            if lk:
                out.setdefault(lk, []).append((nm, fi))
        return out

    by_last = last_names((players.get(side) or {}).get("batting"))
    opp_side = "away" if side == "home" else "home"
    opp_last = set(last_names((players.get(opp_side) or {}).get("batting")).keys())

    # Which half (top/bottom) is ours? Vote with batters unique to our side.
    votes = collections.Counter()
    for pl in plays:
        lk = _pbp_last(pl.get("batter") or "")[0]
        if lk in by_last and lk not in opp_last:
            half = (pl.get("inning") or "").split()[0].lower()
            if half:
                votes[half] += 1
    our_half = votes.most_common(1)[0][0] if votes else None

    for pl in plays:
        if our_half and (pl.get("inning") or "").split()[0].lower() != our_half:
            continue
        lk, fi = _pbp_last(pl.get("batter") or "")
        cands = by_last.get(lk)
        if not cands:
            continue
        full = cands[0][0] if len(cands) == 1 else next((nm for nm, f in cands if f == fi), None)
        if not full:
            continue
        acc = bat.get(_norm(full))
        if acc is None:
            continue
        bt = _batted_ball_type(pl)
        if bt:
            acc[bt] += 1
        et = _pa_event_type(pl)
        if et:
            acc[et] += 1


# Outcomes where the batter put the ball in play. The count sequence stops before
# that final pitch, so we add it back as one strike (a ball in play is a strike).
_CONTACT_OUTCOMES = {
    "Single", "Double", "Triple", "Home run", "Groundout", "Flyout", "Lineout",
    "Pop out", "Foul out", "Grounded into double play", "Fielder's choice",
    "Reached on error", "Infield fly",
}


def _add_pbp_pitching(game_dir, players, side, pit):
    """Tally pitcher stats from the detailed PBP, matched to OUR pitchers via each
    play's `pitcher` field: GB/FB/LD/PU allowed + GIDP induced (best-effort, same
    classifier as the batters), and pitches/strikes/balls from the play's count
    sequence (B = ball, everything else = strike) plus one strike for a ball put in
    play (which isn't in the sequence). The box score has no pitch count."""
    dp = os.path.join(game_dir, "play_by_play_detailed.json")
    if not os.path.exists(dp):
        return
    try:
        pbp = json.load(open(dp, encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    for pl in pbp.get("plays") or []:
        pn = pl.get("pitcher")
        acc = pit.get(_norm(pn)) if pn else None
        if acc is None:                 # not one of our pitchers (or unresolved)
            continue
        bt = _batted_ball_type(pl)
        if bt:
            acc[bt] += 1
        oc = pl.get("outcome") or ""
        if oc == "Grounded into double play":
            acc["gidp"] += 1
        elif oc == "Strikeout (swinging)":
            acc["ks"] += 1
        elif oc == "Strikeout (looking)":
            acc["kl"] += 1
        seq = pl.get("pitches") or ""
        if seq:
            balls = seq.count("B")
            acc["balls"] += balls
            acc["strikes"] += len(seq) - balls
            acc["pt"] += len(seq)
        if oc in _CONTACT_OUTCOMES:      # the ball-in-play pitch (a strike) isn't in seq
            acc["strikes"] += 1
            acc["pt"] += 1


# raw player_stats key -> our stored key, for the straight counting stats.
_BAT_COUNTS = {
    "R": "r", "AB": "ab", "H": "h", "2B": "2b", "3B": "3b", "HR": "hr",
    "RBI": "rbi", "BB": "bb", "IBB": "ibb", "K": "so", "HBP": "hbp",
    "SF": "sf", "SH": "sh", "SB": "sb", "CS": "cs", "TB": "tb",
}
_PIT_COUNTS = {
    "H": "h", "R": "r", "ER": "er", "BB": "bb", "IBB": "ibb", "SO": "so",
    "BF": "bf", "HR-A": "hr_a", "2B-A": "2b_a", "3B-A": "3b_a",
    "HB": "hb", "Bk": "bk", "WP": "wp",
    "InhRun": "ir", "InhRunScore": "irs",   # inherited runners (and how many scored)
}
_DEC_KEY = {"win": "w", "loss": "l", "save": "s"}
# raw fielding key -> our stored key. PO/A/E/TC are the core line; CI/PB/SBA/CSB
# are catcher-specific; IDP is double plays the fielder took part in (a per-player
# count, NOT a team DP total — see build_for_team); TP is triple plays.
_FIELD_COUNTS = {
    "PO": "po", "A": "a", "TC": "tc", "E": "e", "IDP": "dp", "TP": "tp",
    "CI": "ci", "PB": "pb", "SBA": "sba", "CSB": "csb",
}
# Outfield positions — "outfield assists" (OFA) is simply assists made at an OF spot.
_OUTFIELD = {"LF", "CF", "RF", "OF"}


def _blank(keys):
    return {k: 0 for k in keys}


def _norm(s):
    return ld._norm(s)


def aggregate(team_dir, label, asof=None):
    """(bat_rows, pit_rows, fld_rows) of season totals for one team folder. With `asof`
    (an ISO date) only games dated on/before it are counted. Reads nothing but the
    per-game files and writes nothing."""
    # name -> accumulator. Keep display name / number / position from the rows.
    # fld is nested: name -> {position -> counts}, so each fielding position a
    # player manned gets its own stat line.
    bat, pit, fld, meta = {}, {}, {}, {}
    # name -> {position: games} so a player's stored pos is the one played most.
    # Tracked separately per table so a two-way player's batting position doesn't
    # leak into their pitching row (they share `meta`).
    bat_pos, pit_pos = {}, {}

    # Read boxscore.json + player_stats.json per game DIRECTLY (not via
    # _iter_games, which also needs play_by_play.json and would skip a game whose
    # PBP is missing / iCloud-offloaded — undercounting season totals).
    sched_dir = os.path.join(team_dir, "schedule")
    for d in sorted(os.listdir(sched_dir) if os.path.isdir(sched_dir) else []):
        if asof and d[:10] > asof:
            continue  # after the as-of date
        game_dir = os.path.join(sched_dir, d)
        bp = os.path.join(game_dir, "boxscore.json")
        pp = os.path.join(game_dir, "player_stats.json")
        if not (os.path.isdir(game_dir) and os.path.exists(bp) and os.path.exists(pp)):
            continue
        try:
            box = json.load(open(bp, encoding="utf-8"))
            players = json.load(open(pp, encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        data = {"box": box, "players": players}
        side = ld._host_side(data, label)
        rows = players.get(side) or {}
        decisions = box.get("decisions") or {}

        for row in rows.get("batting") or []:
            name = (row.get("Name") or "").strip()
            if not name or ld._is_totals_row(row, label):
                continue
            ab, bb = to_int(row.get("AB")), to_int(row.get("BB"))
            hbp, sf, sh = to_int(row.get("HBP")), to_int(row.get("SF")), to_int(row.get("SH"))
            if ab + bb + hbp + sf + sh == 0:
                continue  # didn't actually come to the plate
            acc = bat.setdefault(_norm(name), _blank(_BAT_COUNTS.values())
                                 | {"g": 0, "pa": 0, "gb": 0, "fb": 0, "ld": 0, "pu": 0,
                                    "ks": 0, "kl": 0, "roe": 0, "fc": 0, "ci": 0, "po": 0})
            meta.setdefault(_norm(name), {"name": name, "num": row.get("#", ""), "pos": row.get("P", "")})
            pv = (row.get("P") or "").strip().upper()
            if pv:
                pc = bat_pos.setdefault(_norm(name), {})
                pc[pv] = pc.get(pv, 0) + 1
            acc["g"] += 1
            acc["pa"] += ab + bb + hbp + sf + sh
            for src, dst in _BAT_COUNTS.items():
                acc[dst] += to_int(row.get(src))

        # GB/FB/LD/PU from the detailed play-by-play (present for SEC games).
        _add_batted_balls(game_dir, players, side, bat)

        # Box scores list pitchers in order of appearance, so the first one is
        # the starter (gs). Filter the totals row out first so index 0 is real.
        pitch_rows = [r for r in (rows.get("pitching") or [])
                      if (r.get("Name") or "").strip() and not ld._is_totals_row(r, label)]
        for i, row in enumerate(pitch_rows):
            name = row.get("Name").strip()
            outs = ip_to_outs(row.get("IP"))
            if outs == 0 and to_int(row.get("BF")) == 0:
                continue
            acc = pit.setdefault(_norm(name), _blank(_PIT_COUNTS.values())
                                 | {"g": 0, "gs": 0, "outs": 0, "w": 0, "l": 0, "s": 0,
                                    "gb": 0, "fb": 0, "ld": 0, "pu": 0, "gidp": 0,
                                    "ks": 0, "kl": 0,
                                    "pt": 0, "strikes": 0, "balls": 0})
            meta.setdefault(_norm(name), {"name": name, "num": row.get("#", ""), "pos": row.get("P", "P")})
            pc = pit_pos.setdefault(_norm(name), {})
            pv = (row.get("P") or "").strip().upper() or "P"
            pc[pv] = pc.get(pv, 0) + 1
            acc["g"] += 1
            if i == 0:
                acc["gs"] += 1  # first pitcher listed = the game's starter
            acc["outs"] += outs
            for src, dst in _PIT_COUNTS.items():
                acc[dst] += to_int(row.get(src))

        # W / L / S for this game go to the matching pitcher on THIS team's side.
        for key, dec in decisions.items():
            letter = _DEC_KEY.get(key)
            if not letter or not dec or dec.get("side") != side:
                continue
            target = pit.get(_norm(dec.get("name")))
            if target is not None:
                target[letter] += 1

        # GB/FB/LD/PU allowed, GIDP induced, and estimated pitches from the PBP.
        _add_pbp_pitching(game_dir, players, side, pit)

        # Fielding: one row per defensive appearance. Skip the team-totals row and
        # DH-only rows (a DH took no defensive position), so g/pos count real
        # fielding games. PO/A/E/TC etc. accumulate straight from the box score.
        for row in rows.get("fielding") or []:
            name = (row.get("Name") or "").strip()
            if not name or ld._is_totals_row(row, label):
                continue
            pos0 = ld.primary_position(row.get("P"))
            if pos0 in ("", "DH") or pos0 in ld._PSEUDO_POS:
                continue  # DH / pinch roles aren't defensive appearances
            meta.setdefault(_norm(name), {"name": name, "num": row.get("#", ""), "pos": row.get("P", "")})
            # Attribute this game's fielding line to its primary position.
            posmap = fld.setdefault(_norm(name), {})
            acc = posmap.setdefault(pos0, _blank(_FIELD_COUNTS.values()) | {"g": 0})
            acc["g"] += 1
            for src, dst in _FIELD_COUNTS.items():
                acc[dst] += to_int(row.get(src))

    def rows_out(acc, num_sort, pos_counts=None):
        out = []
        for nkey, a in acc.items():
            m = meta.get(nkey, {})
            pos = m.get("pos", "")
            if pos_counts is not None and pos_counts.get(nkey):
                pos = ld.most_played_position(pos_counts[nkey])
            row = {"num": m.get("num", ""), "name": m.get("name", ""), "pos": pos}
            row.update(a)
            out.append(row)
        out.sort(key=lambda r: (-r.get(num_sort, 0), r["name"]))
        return out

    bat_rows = rows_out(bat, "pa", bat_pos)
    for r in bat_rows:  # singles aren't a box-score column; derive from the hits
        r["1b"] = r["h"] - r["2b"] - r["3b"] - r["hr"]
    pit_rows = rows_out(pit, "outs", pit_pos)
    for r in pit_rows:
        r["ip"] = outs_to_ip(r["outs"])  # convenience; `outs` is the canonical count
        # ks/kl are reconstructed per pitch from the PBP, whose pitcher-of-record is
        # rebuilt from box-score BF. At a mid-PA pitching change NCAA charges the
        # strikeout to the pitcher who left with two strikes, which BF windows can't
        # capture, so the split can drift a strikeout or two past the authoritative
        # box SO. Clamp it: when ks+kl exceeds SO, scale both down to sum to SO,
        # preserving the swinging/looking ratio (matches batting, where K+ꓘ ≤ SO).
        ks, kl, so = r.get("ks", 0), r.get("kl", 0), r.get("so", 0)
        if ks + kl > so:
            r["ks"] = round(ks * so / (ks + kl)) if (ks + kl) else 0
            r["kl"] = so - r["ks"]
    # Fielding: one row per player whose `pos` is a list of per-position stat lines.
    fld_rows = []
    for nkey, posmap in fld.items():
        m = meta.get(nkey, {})
        entries = []
        for pos, a in posmap.items():
            ent = {"pos": pos, "g": a["g"], "po": a["po"], "a": a["a"],
                   "tc": a["tc"], "e": a["e"], "dp": a["dp"], "tp": a["tp"]}
            if pos == "C":  # catcher-only stats; meaningless at any other position
                ent.update(pb=a["pb"], sba=a["sba"], csb=a["csb"], ci=a["ci"])
            elif pos in _OUTFIELD:  # outfield assists (a subset of A)
                ent["ofa"] = a["a"]
            entries.append(ent)
        entries.sort(key=lambda r: (-r["g"], -r["tc"]))  # primary position first
        fld_rows.append({"num": m.get("num", ""), "name": m.get("name", ""), "pos": entries})
    fld_rows.sort(key=lambda r: -sum(e["tc"] for e in r["pos"]))  # most active gloves first
    return bat_rows, pit_rows, fld_rows
