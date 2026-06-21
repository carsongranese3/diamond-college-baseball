"""Build per-team season stat files under <SEASON>/<TEAM>/stats/.

Aggregates every saved per-game box score (player_stats.json + boxscore.json) into
two files of season totals, one row per player:

    <SEASON>/<TEAM>/stats/batting.json
    <SEASON>/<TEAM>/stats/pitching.json

Only BASIC counting stats are stored — the raw building blocks. Rate/derived
stats (AVG, OBP, SLG, OPS, ISO, ERA, WHIP, K/9, FIP, …) are NOT stored here; they
are computed from these counts by whoever reads the files.

  batting:  g, pa, ab, r, h, 1b, 2b, 3b, hr, rbi, bb, ibb, so, hbp, sf, sh, sb, cs, tb
  pitching: g, gs, w, l, s, outs, ip, h, r, er, bb, ibb, so, bf, hr_a, 2b_a, 3b_a, hb, bk, wp

Pitcher wins / losses / saves come from each game's `decisions` block (added by the
scraper) attributed to this team's side.

Run:
    .venv/bin/python scripts/build_stats.py            # every team under <SEASON>/
    .venv/bin/python scripts/build_stats.py Texas      # one team
"""

import collections
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import local_data as ld
from boxutil import ip_to_outs, outs_to_ip, to_int

SEASON = 2026

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
}
_DEC_KEY = {"win": "w", "loss": "l", "save": "s"}


def _blank(keys):
    return {k: 0 for k in keys}


def _norm(s):
    return ld._norm(s)


def build_for_team(label):
    team_dir = ld._find_dir(label, label)  # resolves flat or <Conference>/<Team>
    if not team_dir:
        return None

    # name -> accumulator. Keep display name / number / position from the rows.
    bat, pit, meta = {}, {}, {}
    # name -> {position: games} so a player's stored pos is the one played most.
    # Tracked separately per table so a two-way player's batting position doesn't
    # leak into their pitching row (they share `meta`).
    bat_pos, pit_pos = {}, {}

    # Read boxscore.json + player_stats.json per game DIRECTLY (not via
    # _iter_games, which also needs play_by_play.json and would skip a game whose
    # PBP is missing / iCloud-offloaded — undercounting season totals).
    sched_dir = os.path.join(team_dir, "schedule")
    for d in sorted(os.listdir(sched_dir) if os.path.isdir(sched_dir) else []):
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
            acc = pit.setdefault(_norm(name), _blank(_PIT_COUNTS.values()) | {"g": 0, "gs": 0, "outs": 0, "w": 0, "l": 0, "s": 0})
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

    stats_dir = os.path.join(team_dir, "stats")
    os.makedirs(stats_dir, exist_ok=True)
    stamp = datetime.date.today().isoformat()
    for fname, players in (("batting.json", bat_rows), ("pitching.json", pit_rows)):
        with open(os.path.join(stats_dir, fname), "w", encoding="utf-8") as fh:
            json.dump({"team": label, "season": SEASON, "generated": stamp,
                       "players": players}, fh, indent=2)
    return len(bat_rows), len(pit_rows)


def main():
    targets = sys.argv[1:] or [label for label, _ in ld.team_dirs()]
    for label in targets:
        res = build_for_team(label)
        if res is None:
            print(f"  SKIP {label} (no folder)", flush=True)
        else:
            b, p = res
            print(f"  {label}: {b} batters, {p} pitchers -> {SEASON}/{label}/stats/", flush=True)


if __name__ == "__main__":
    main()
