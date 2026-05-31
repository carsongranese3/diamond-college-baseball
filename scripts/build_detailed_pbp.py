"""Turn a game's flat play_by_play.json into a broken-down play-by-play.

The saved play_by_play.json is a flat list of play texts (one batting team's
at-bats) with a running away-home score. This script enriches each play into a
structured row: inning, current pitcher, batter, outcome, and the base state
(runners on 1B/2B/3B) before and after the play — written to
play_by_play_detailed.json in the same game folder.

Source quirks handled:
  * Sub-events within a play are joined by "3a" (and "3b" inside an out phrase).
  * Names in the PBP are last-name only; full names come from player_stats.json.
  * Innings aren't marked, so we delimit half-innings by counting to 3 outs.

Run (game dir is relative to the project root):
    .venv/bin/python scripts/build_detailed_pbp.py "2026/Texas/2026-02-13_vs_uc-davis"
"""

import json
import os
import re
import sys

# This file now lives in scripts/; resolve relative game-dir args against the
# project root, not the scripts/ folder.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── name lookups ─────────────────────────────────────────────────────────────
def _last(full):
    """Last-name key for matching PBP text (which uses last names only)."""
    return re.sub(r"[^a-z]", "", (full or "").split(",")[0].split()[-1].lower()) \
        if full and full.split() else ""


def _name_map(rows):
    out = {}
    for r in rows or []:
        nm = r.get("Name")
        if nm and nm not in ("Texas", "UC Davis"):
            out.setdefault(_last(nm), nm)
    return out


# ── play classification ──────────────────────────────────────────────────────
_OUTCOMES = [
    (r"grounded into double play", "Grounded into double play", None),
    (r"struck out swinging", "Strikeout (swinging)", None),
    (r"struck out looking", "Strikeout (looking)", None),
    (r"struck out", "Strikeout", None),
    (r"hit by pitch", "Hit by pitch", "1B"),
    (r"walked", "Walk", "1B"),
    (r"intentionally walked", "Intentional walk", "1B"),
    (r"doubled", "Double", "2B"),
    (r"tripled", "Triple", "3B"),
    (r"homered|home run", "Home run", "HR"),
    (r"singled", "Single", "1B"),
    (r"reached on a fielder's choice|fielder's choice", "Fielder's choice", "1B"),
    (r"reached on an? error|reached on", "Reached on error", "1B"),
    (r"grounded out", "Groundout", None),
    (r"flied out|fl/o", "Flyout", None),
    (r"fouled out", "Foul out", None),
    (r"lined out", "Lineout", None),
    (r"popped out|pop", "Pop out", None),
    (r"infield fly", "Infield fly", None),
]


def _classify(text):
    low = text.lower()
    for pat, label, base in _OUTCOMES:
        if re.search(pat, low):
            return label, base
    return None, None


def _split_subs(text):
    """A play -> [primary, sub-event, ...] using the '3a' separator; '3b' (used
    inside an out phrase like 'out at third 3b unassisted') is flattened."""
    parts = re.split(r"\s*3a\s*", text)
    return [re.sub(r"\s*3b\s*", " ", p).strip() for p in parts if p.strip()]


def _batter(primary):
    """The batter (first name token) and the remaining outcome phrase."""
    m = re.match(r"([A-Z][A-Za-z'\-\.]+(?:\s[A-Z][a-z]?)?)\s+(.*)", primary)
    return (m.group(1).strip(), m.group(2)) if m else (primary, "")


def _find_runner(bases, last_key):
    for b in ("3B", "2B", "1B"):
        if bases[b] and _last(bases[b]) == last_key:
            return b
    return None


def build(game_dir):
    pbp = json.load(open(os.path.join(game_dir, "play_by_play.json")))
    players = json.load(open(os.path.join(game_dir, "player_stats.json")))
    box = json.load(open(os.path.join(game_dir, "boxscore.json")))

    # Which side is batting in this PBP? Match play-leading names to each roster.
    lead = [_batter(_split_subs(p["text"])[0])[0] for p in pbp]
    lead_keys = {_last(n) for n in lead}
    bat_map = {s: _name_map((players.get(s) or {}).get("batting"))
               for s in ("away", "home")}
    bat_side = max(("away", "home"),
                   key=lambda s: len(lead_keys & set(bat_map[s])))
    pit_side = "home" if bat_side == "away" else "away"
    batters = bat_map[bat_side]
    pitchers = _name_map((players.get(pit_side) or {}).get("pitching"))

    pit_rows = [r for r in (players.get(pit_side) or {}).get("pitching", [])
                if r.get("Name") not in ("Texas", "UC Davis")]
    cur_pitcher = pit_rows[0]["Name"] if pit_rows else ""

    half = "Top" if bat_side == "away" else "Bottom"
    bases = {"1B": None, "2B": None, "3B": None}
    outs = 0
    inning = 1
    plays = []

    def base_snapshot():
        return {b: bases[b] for b in ("1B", "2B", "3B")}

    def parse_score(s):
        m = re.match(r"(\d+)\s*-\s*(\d+)", s or "")
        return {"away": int(m.group(1)), "home": int(m.group(2))} if m else None

    for p in pbp:
        text = p["text"].strip()
        subs = _split_subs(text)
        primary = subs[0]
        low = primary.lower()

        # Pitching change: "Grubbs to p for Riojas."
        m = re.match(r"([A-Z][A-Za-z'\-\.]+).* to p for ", primary)
        if m and " to p for " in primary:
            cur_pitcher = pitchers.get(_last(m.group(1)), m.group(1))
            continue
        # Other substitutions ("X to lf", "X to ss for Y") — skip (not a PA).
        if re.match(r"[A-Z][A-Za-z'\-\.]+(?:\s[A-Z])?\s+to\s+\w+", primary) \
                and not re.search(r"advanced|scored|out at|to (first|second|third|home)", low):
            continue

        outs_before = outs
        runners_before = base_snapshot()
        scored = []
        outcome, place = _classify(primary)

        # Standalone baserunning event (wild pitch / passed ball / steal / balk).
        runner_event = (outcome is None and
                        re.search(r"advanced|stole|scored|caught stealing", low))

        if runner_event:
            batter_name = None
            outcome = ("Wild pitch" if "wild pitch" in low else
                       "Passed ball" if "passed ball" in low else
                       "Stolen base" if "stole" in low else
                       "Caught stealing" if "caught stealing" in low else
                       "Baserunning")
            sub_events = subs            # whole text is runner movement(s)
        else:
            bname_short, _rest = _batter(primary)
            batter_name = batters.get(_last(bname_short), bname_short)
            sub_events = subs[1:]

        # Apply existing-runner sub-events FIRST (they vacate bases before the
        # batter takes a base), and lead runners (closer to home) before trailing
        # ones — otherwise a runner advancing into an occupied base clobbers it.
        def _prio(s):
            sl = s.lower()
            if "scored" in sl or "to home" in sl:
                return 0
            if "third" in sl:
                return 1
            if "second" in sl:
                return 2
            if "first" in sl:
                return 3
            return 4
        for sub in sorted(sub_events, key=_prio):
            sl = sub.lower()
            rm = re.search(r"([A-Z][A-Za-z'\-\.]+)\s+(advanced to (second|third|home)|scored|out)", sub)
            who = _find_runner(bases, _last(rm.group(1))) if rm else None
            if "scored" in sl:
                if who:
                    scored.append(bases[who]); bases[who] = None
                elif batter_name and place == "HR":
                    pass
            elif "out at" in sl or re.search(r"\bout\b", sl):
                if who:
                    bases[who] = None
                outs += 1
            elif "advanced to third" in sl or "to third" in sl:
                if who:
                    nm = bases[who]; bases[who] = None; bases["3B"] = nm
            elif "advanced to second" in sl or "to second" in sl:
                if who:
                    nm = bases[who]; bases[who] = None; bases["2B"] = nm
            elif "advanced to home" in sl:
                if who:
                    scored.append(bases[who]); bases[who] = None

        # Now resolve the batter (after runners have moved off their bases).
        if not runner_event:
            if place in ("1B", "2B", "3B"):
                bases[place] = batter_name
            elif place == "HR":
                scored.append(batter_name)
            elif outcome:  # an out (the 2nd out of a GIDP is a runner sub-event)
                outs += 1

        plays.append({
            "inning": f"{half} {inning}",
            "pitcher": cur_pitcher,
            "batter": batter_name,
            "outcome": outcome or "—",
            "rbi": "RBI" in primary,
            "runs_scored": scored,
            "outs_before": outs_before,
            "outs_after": min(outs, 3),
            "runners_before": runners_before,
            "runners_after": base_snapshot(),
            "score": parse_score(p.get("score")),
            "description": re.sub(r"\s*3[ab]\s*", " ", text).strip(),
        })

        if outs >= 3:                    # half-inning over: reset
            outs = 0
            bases = {"1B": None, "2B": None, "3B": None}
            inning += 1

    out = {
        "contest_id": box.get("contest_id"),
        "date": box.get("date"),
        "batting_team": (players.get(bat_side) or {}).get("team"),
        "pitching_team": (players.get(pit_side) or {}).get("team"),
        "note": ("Broken-down from the saved play_by_play.json, which contains "
                 f"the {(players.get(bat_side) or {}).get('team')} at-bats only. "
                 "Innings inferred by counting outs; pitcher tracked via in-text "
                 "pitching changes."),
        "plays": plays,
    }
    dest = os.path.join(game_dir, "play_by_play_detailed.json")
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    return dest, out


if __name__ == "__main__":
    gd = sys.argv[1] if len(sys.argv) > 1 else "2026/Texas/2026-02-13_vs_uc-davis"
    if not os.path.isabs(gd):
        gd = os.path.join(_PROJECT_ROOT, gd)   # resolve against project root
    dest, data = build(gd)
    print(f"wrote {dest} — {len(data['plays'])} plays")
    print(f"batting: {data['batting_team']}  pitching: {data['pitching_team']}")
