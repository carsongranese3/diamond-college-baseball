"""Save a team's full season, one folder per game, from stats.ncaa.org.

Saves the data from the official NCAA stats portal (via the Camoufox stealth
browser in ncaa_stats.py) rather than ncaa.com. The big win: stats.ncaa.org has
real per-game box scores AND play-by-play for every game, including the early
non-conference games ncaa.com lacked.

Layout:

    <SEASON>/<TEAM_LABEL>/<date>_<vs|at>_<opponent>/
        boxscore.json               line score (innings + R/H/E) for both teams
        player_stats.json           per-team batting / pitching / fielding lines
        play_by_play.json           ordered plays with running score
        play_by_play_detailed.json  each play broken down (inning, batter, pitcher,
                                    outcome, base state, runs, pitch count) — derived
                                    locally from the three files above, no extra fetch

Run:
    .venv/bin/python scripts/pull_game_stats.py            # uses CONFIG below
    .venv/bin/python scripts/pull_game_stats.py Georgia Georgia
    .venv/bin/python scripts/pull_game_stats.py Texas Texas 3   # 3rd arg = limit (testing)
    .venv/bin/python scripts/pull_game_stats.py Texas Texas 0 2026-05-19 2026-05-24
        # args 4 & 5 = start/end date (ISO, inclusive); 0 = no game-count limit.
        # Or just set START_DATE / END_DATE in CONFIG and run with no args.
    .venv/bin/python scripts/pull_game_stats.py all          # every SEC team, whole season
    .venv/bin/python scripts/pull_game_stats.py all 2026-05-19 2026-05-24   # SEC, date window

First run is slow: each game = 3 stealth-browser page loads, rate-limited.
Pages are cached in cache_ncaa_stats/, so re-runs are fast. A full all-SEC pull is
~16 teams × ~55 games × 3 loads — budget a couple of hours for the first run.
"""

import functools
import json
import os
import re
import sys
import time

# This file now lives in scripts/; add the project root to sys.path so the
# library modules (ncaa_stats, etc.) at the project root resolve, and remember
# the project root for the game-folder output paths below.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

# The scraping stack (bs4, camoufox, collegebaseball, …) lives in .venv-dev, not
# the Flask-only deploy .venv. If we were launched with a different interpreter
# (e.g. the deploy .venv), re-exec under .venv-dev so the imports always work.
_DEV_DIR = os.path.join(_PROJECT_ROOT, ".venv-dev")
_DEV_PY = os.path.join(_DEV_DIR, "bin", "python")
if os.path.exists(_DEV_PY) and not sys.executable.startswith(_DEV_DIR):
    os.execv(_DEV_PY, [_DEV_PY, *sys.argv])

# All output is flushed immediately so progress shows up live in the terminal.
print = functools.partial(print, flush=True)

print("Loading libraries and booting the stealth browser… "
      "(first output can take 30–60s, this is normal — not frozen)")

import ncaa_stats as ns

ns.VERBOSE = True  # print each page fetch live so progress is always visible

# ─── CONFIG ──────────────────────────────────────────────────────────────────
SEASON = 2026
ALL_SEC = False           # True = pull ALL 16 SEC teams (ignores TEAM_SCHOOL/LABEL)
TEAM_SCHOOL = "Vanderbilt"     # single team: school name (matched vs the NCAA table)
TEAM_LABEL = "Vanderbilt"      # single team: folder name under <SEASON>/
START_DATE = ""           # ISO "YYYY-MM-DD"; "" = no lower bound (season start)
END_DATE = ""             # ISO "YYYY-MM-DD"; "" = no upper bound (season end)
LIMIT = 0                 # 0 = whole season; >0 = first N games (for testing)
FORCE = True             # True = re-pull games even if already saved in <SEASON>/
# ─────────────────────────────────────────────────────────────────────────────

# The 16 SEC baseball schools (names verified against the collegebaseball lookup
# table). Used by pull_all_sec(); each name doubles as its <SEASON>/ folder label.
SEC_TEAMS = [
    "Alabama", "Arkansas", "Auburn", "Florida", "Georgia", "Kentucky", "LSU",
    "Mississippi St.", "Missouri", "Oklahoma", "Ole Miss", "South Carolina",
    "Tennessee", "Texas", "Texas A&M", "Vanderbilt",
]

INTER_TEAM_DELAY = 5   # seconds to pause between teams in pull_all_sec (politeness)

_FILES = ("boxscore.json", "player_stats.json", "play_by_play.json")


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "opp"


def _already_saved(game_dir):
    """True if all 3 JSON files exist and are non-empty."""
    return all(os.path.getsize(os.path.join(game_dir, f)) > 0
               for f in _FILES if os.path.exists(os.path.join(game_dir, f))) \
        and all(os.path.exists(os.path.join(game_dir, f)) for f in _FILES)


# ─── Detailed play-by-play ───────────────────────────────────────────────────
# Every pulled game also gets a play_by_play_detailed.json: the flat play list
# broken into inning, pitcher, batter, outcome, base state before/after, runs
# scored and the pitch count/sequence — derived locally from the three files just
# saved (no extra fetches). Pitch letters: B = ball, K = called strike,
# S = swinging strike, F = foul.

_DETAILED = "play_by_play_detailed.json"

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


def _last(full):
    """Last-name key for matching PBP text (which uses last names only)."""
    return re.sub(r"[^a-z]", "", (full or "").split(",")[0].split()[-1].lower()) \
        if full and full.split() else ""


def _name_map(rows, team_name=None):
    """{last-name -> full name} from box-score rows, skipping the team-totals row
    (whose Name is the team's own name)."""
    out = {}
    for r in rows or []:
        nm = r.get("Name")
        if nm and nm != team_name:
            out.setdefault(_last(nm), nm)
    return out


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


def _pitches(text):
    """The count + pitch sequence the at-bat reached, e.g. '(2-2 BKSBS)' ->
    {'count': '2-2', 'sequence': 'BKSBS'}. None when the play has no pitch data."""
    m = re.search(r"\((\d+)-(\d+)(?:\s+([A-Z]+))?\)", text)
    if not m:
        return None
    return {"count": f"{m.group(1)}-{m.group(2)}", "sequence": m.group(3) or ""}


def _find_runner(bases, last_key):
    for b in ("3B", "2B", "1B"):
        if bases[b] and _last(bases[b]) == last_key:
            return b
    return None


def build_detailed(game_dir):
    """Read the three saved JSONs in game_dir and write play_by_play_detailed.json.
    Returns the parsed payload. Innings are inferred by counting to 3 outs; the
    current pitcher is tracked via in-text pitching changes."""
    pbp = json.load(open(os.path.join(game_dir, "play_by_play.json")))
    players = json.load(open(os.path.join(game_dir, "player_stats.json")))
    box = json.load(open(os.path.join(game_dir, "boxscore.json")))

    # Which side is batting in this PBP? Match play-leading names to each roster.
    lead = [_batter(_split_subs(p["text"])[0])[0] for p in pbp]
    lead_keys = {_last(n) for n in lead}
    bat_map = {s: _name_map((players.get(s) or {}).get("batting"),
                            (players.get(s) or {}).get("team"))
               for s in ("away", "home")}
    bat_side = max(("away", "home"), key=lambda s: len(lead_keys & set(bat_map[s])))
    pit_side = "home" if bat_side == "away" else "away"
    batters = bat_map[bat_side]
    pitchers = _name_map((players.get(pit_side) or {}).get("pitching"),
                         (players.get(pit_side) or {}).get("team"))

    pit_team = (players.get(pit_side) or {}).get("team")
    pit_rows = [r for r in (players.get(pit_side) or {}).get("pitching", [])
                if r.get("Name") != pit_team]
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
        pitch_data = _pitches(primary)

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
            sub_events = subs
        else:
            bname_short, _rest = _batter(primary)
            batter_name = batters.get(_last(bname_short), bname_short)
            sub_events = subs[1:]

        # Apply existing-runner sub-events FIRST (they vacate bases before the
        # batter takes one), lead runners (closer to home) before trailing ones.
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
            "count": pitch_data["count"] if pitch_data else None,
            "pitches": pitch_data["sequence"] if pitch_data else None,
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
    with open(os.path.join(game_dir, _DETAILED), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    return out


def _ensure_detailed(game_dir, rebuild):
    """Write play_by_play_detailed.json for a saved game. rebuild=True always
    rebuilds; otherwise it's only built when missing. Never raises — a parse
    failure just logs and leaves the game's other files untouched."""
    dest = os.path.join(game_dir, _DETAILED)
    if not rebuild and os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    try:
        build_detailed(game_dir)
    except Exception as e:
        print(f"     (detailed PBP skipped: {type(e).__name__}: {e})")


def pull(school=TEAM_SCHOOL, label=TEAM_LABEL, season=SEASON, limit=LIMIT,
         force=FORCE, start_date=START_DATE, end_date=END_DATE, shutdown=True):
    out_root = os.path.join(_PROJECT_ROOT, str(season), label)
    os.makedirs(out_root, exist_ok=True)

    print(f"Looking up {school} and its {season} schedule on stats.ncaa.org…")
    school_id = ns.get_school_id(school)
    games = ns.team_schedule(school_id, season)
    # Date-range filter (inclusive). iso is "YYYY-MM-DD", so string compare = date compare.
    if start_date:
        games = [g for g in games if g["iso"] >= start_date]
    if end_date:
        games = [g for g in games if g["iso"] <= end_date]
    if limit:
        games = games[:limit]
    window = (f" between {start_date or 'season start'} and {end_date or 'season end'}"
              if (start_date or end_date) else "")
    print(f"  {len(games)} games to pull{window}.\n")

    def _write(path, obj):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=2)

    written, skipped, errors = 0, 0, []
    started = time.time()
    for i, g in enumerate(games, 1):
        cid = g["contest_id"]
        vs = "vs" if g["home"] else "at"
        name = f"{g['iso']}_{vs}_{_slug(g['opponent'])}"
        game_dir = os.path.join(out_root, "schedule", name)
        # #2: skip games already fully saved (no fetch, no parse) unless forced.
        if not force and _already_saved(game_dir):
            skipped += 1
            print(f"  [{i:>2}/{len(games)}] {name}/  (already saved, skip)")
            _ensure_detailed(game_dir, rebuild=False)   # backfill detailed PBP if missing
            continue
        os.makedirs(game_dir, exist_ok=True)
        try:
            _write(os.path.join(game_dir, "boxscore.json"), {
                "contest_id": cid, "date": g["date"], "opponent": g["opponent"],
                "home": g["home"], "result": g["result"],
                "line_score": ns.contest_line_score(cid),
                "decisions": ns.contest_decisions(cid),
                "info": ns.contest_info(cid),
            })
            _write(os.path.join(game_dir, "player_stats.json"),
                   ns.contest_player_stats(cid))
            _write(os.path.join(game_dir, "play_by_play.json"),
                   ns.contest_play_by_play(cid))
            _ensure_detailed(game_dir, rebuild=True)   # derive detailed PBP from the 3 files
            written += 1
            print(f"  [{i:>2}/{len(games)}] {name}/")
        except ns.BlockedError as e:
            errors.append((name, "BLOCKED"))
            print(f"  [{i:>2}/{len(games)}] {name}/  BLOCKED: {e}")
            print("     ⛔ Akamai blocked this IP — stopping now so the ban isn't "
                  "made worse.\n     Switch IP or wait, then re-run (saved games skip).")
            break
        except Exception as e:  # keep going on a bad game
            errors.append((name, f"{type(e).__name__}: {e}"))
            print(f"  [{i:>2}/{len(games)}] {name}/  ERROR: {type(e).__name__}: {e}")

    if shutdown:
        ns.shutdown()  # skipped when looping many teams (keep one browser alive)
    print(f"\nDone in {time.time() - started:.0f}s — wrote {written} game folders "
          f"({skipped} already saved, skipped) to {out_root}")
    if errors:
        print(f"  {len(errors)} game(s) had problems:")
        for nm, msg in errors:
            print(f"    {nm}: {msg}")
    return {"written": written, "skipped": skipped, "errors": errors}


def pull_all_sec(season=SEASON, start_date=START_DATE, end_date=END_DATE,
                 force=FORCE, limit=LIMIT):
    """Pull every SEC team for a season, reusing one browser across all teams.

    Each team is independent: if one fails to start (bad name lookup, schedule
    fetch error) we log it and move on rather than aborting the whole run.
    """
    started = time.time()
    window = (f" between {start_date or 'season start'} and {end_date or 'season end'}"
              if (start_date or end_date) else "")
    print(f"Pulling all {len(SEC_TEAMS)} SEC teams for {season}{window}…\n")

    totals = {"written": 0, "skipped": 0, "game_errors": 0}
    team_failures = []
    blocked = False
    for n, team in enumerate(SEC_TEAMS, 1):
        print(f"\n──────── [{n}/{len(SEC_TEAMS)}] {team} ────────")
        try:
            res = pull(team, team, season, limit, force, start_date, end_date,
                       shutdown=False)
            totals["written"] += res["written"]
            totals["skipped"] += res["skipped"]
            totals["game_errors"] += len(res["errors"])
            # Games coming back BLOCKED means the IP just got flagged mid-run.
            if any("BLOCK" in str(msg).upper() for _nm, msg in res["errors"]):
                blocked = True
        except ns.BlockedError as e:
            blocked = True
            print(f"  !! {team}: BLOCKED — {e}")
        except Exception as e:  # whole-team failure (lookup/schedule) — keep going
            team_failures.append((team, f"{type(e).__name__}: {e}"))
            print(f"  !! {team} failed: {type(e).__name__}: {e}")

        if blocked:
            # Once Akamai blocks the IP, every further request just digs the ban
            # deeper — stop immediately. Already-saved games are skipped on re-run.
            print("\n  ⛔ stats.ncaa.org is blocking this IP (Akamai). Aborting the run.\n"
                  "     Switch to a different IP (phone hotspot / VPN / new router IP)\n"
                  "     or wait, verify with stats.ncaa.org in a browser, then re-run.")
            break
        if n < len(SEC_TEAMS):
            time.sleep(INTER_TEAM_DELAY)  # breather between teams (good citizen)

    ns.shutdown()  # one shutdown for the whole run
    print(f"\n════════ ALL SEC DONE in {time.time() - started:.0f}s ════════")
    print(f"  {totals['written']} games written, {totals['skipped']} already saved, "
          f"{totals['game_errors']} game-level error(s) across {len(SEC_TEAMS)} teams.")
    if team_failures:
        print(f"  {len(team_failures)} team(s) failed entirely:")
        for t, m in team_failures:
            print(f"    {t}: {m}")


if __name__ == "__main__":
    # All-SEC mode: either `... all`/`... sec` on the CLI, or ALL_SEC=True in CONFIG
    # with no team arg. Optional date window follows the `all` keyword on the CLI.
    cli_all = len(sys.argv) > 1 and sys.argv[1].lower() in ("all", "sec")
    config_all = len(sys.argv) == 1 and ALL_SEC
    if cli_all or config_all:
        start = sys.argv[2] if len(sys.argv) > 2 else START_DATE
        end = sys.argv[3] if len(sys.argv) > 3 else END_DATE
        pull_all_sec(SEASON, start_date=start, end_date=end)
    else:
        school = sys.argv[1] if len(sys.argv) > 1 else TEAM_SCHOOL
        label = sys.argv[2] if len(sys.argv) > 2 else TEAM_LABEL
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else LIMIT
        start = sys.argv[4] if len(sys.argv) > 4 else START_DATE
        end = sys.argv[5] if len(sys.argv) > 5 else END_DATE
        pull(school, label, SEASON, limit, start_date=start, end_date=end)
