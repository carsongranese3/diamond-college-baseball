"""Fill in missing game data for a team by pulling it from stats.ncaa.org.

For each team it looks at, this FIRST refreshes 2026/<Team>/schedule.json from the
live ncaa.com API (so the played-game count always reflects reality, including
games played today), THEN compares that count to how many game folders are
actually saved under 2026/<Team>/schedule/. When they differ, it boots the
stealth browser (ncaa_stats), works out which games have no saved folder, and
pulls them — looking first at games AFTER the last saved game, then backward
through the earlier games to fill any gaps.

Only games stats.ncaa.org actually has a box score for are pulled (unplayed and
TBA games have no contest page, so they're never attempted). Each missing game is
saved exactly like pull_game_stats.py does:

    2026/<Team>/schedule/<date>_<vs|at>_<opponent>/
        boxscore.json  player_stats.json  play_by_play.json

The run STOPS on the first game that fails to pull (e.g. an Akamai IP block), so
a ban isn't made worse. Re-run once unblocked — already-saved games are skipped.

Pick the conference + team with the CONFIG block below, or pass them on the command
line, then run:
    .venv/bin/python scripts/update.py                # CONFIG defaults
    .venv/bin/python scripts/update.py SEC            # a whole conference
    .venv/bin/python scripts/update.py SEC Texas      # one team in a conference
    .venv/bin/python scripts/update.py ACC --bulk     # rotate the browser every 50 games
    .venv/bin/python scripts/update.py ACC --bulk=30  # …every 30 games
"""

import collections
import functools
import json
import os
import random
import re
import sys
import time

# ─── CONFIG ──────────────────────────────────────────────────────────────────
CONFERENCE = "ACC"   # which conference folder under 2026/ to update
TEAM = "Wake Forest"         # a team folder label (e.g. "Arkansas"), or "all" for the whole
                     # conference
BULK_EVERY = 0       # bulk mode: rotate (restart) the stealth browser every N games
                     # pulled (0 = off) for a fresh fingerprint/session — stealthier
                     # over a long run. CLI overrides: update.py [CONF] [TEAM] [--bulk[=N]]
# ─────────────────────────────────────────────────────────────────────────────

BULK_COOLDOWN = (20, 45)   # randomized seconds to pause when rotating the browser

# How many of the most recent daily scoreboards to re-fetch fresh when refreshing
# schedules (bypassing the indefinite scoreboard cache). Wide enough to span the
# whole postseason so a board cached empty days ago still gets corrected.
REFRESH_DAYS = 30

SEASON = 2026

# This file lives in scripts/; add the project root (for season/local_data) and
# the scripts dir (to reuse pull_schedule) to the import path.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# The scraping stack (bs4, camoufox, collegebaseball, …) lives in .venv-dev, not
# the Flask-only deploy .venv. If we were launched with a different interpreter
# (e.g. the deploy .venv), re-exec under .venv-dev so the import always works.
_DEV_DIR = os.path.join(_PROJECT_ROOT, ".venv-dev")
_DEV_PY = os.path.join(_DEV_DIR, "bin", "python")
if os.path.exists(_DEV_PY) and not sys.executable.startswith(_DEV_DIR):
    os.execv(_DEV_PY, [_DEV_PY, *sys.argv])

import local_data as ld  # team-folder lookup (handles the conference layer)

print = functools.partial(print, flush=True)  # live progress in the terminal

# A conference's team labels double as their 2026/<Conf>/<Team> folder names and the
# school names passed to ncaa_stats — so each name must match an `ncaa_name` in the
# collegebaseball lookup table (all of the below are verified to resolve). Only
# baseball-sponsoring members are listed (e.g. ACC omits Syracuse & SMU, Big Ten
# omits Wisconsin, Big 12 omits Colorado & Iowa St. — none field baseball). A
# conference NOT listed here has its teams discovered from its 2026/<Conf>/ folders.
CONFERENCE_TEAMS = {
    "SEC": [
        "Alabama", "Arkansas", "Auburn", "Florida", "Georgia", "Kentucky", "LSU",
        "Mississippi St.", "Missouri", "Oklahoma", "Ole Miss", "South Carolina",
        "Tennessee", "Texas", "Texas A&M", "Vanderbilt",
    ],
    "ACC": [
        "Boston College", "California", "Clemson", "Duke", "Florida St.",
        "Georgia Tech", "Louisville", "Miami (FL)", "NC State", "North Carolina",
        "Notre Dame", "Pittsburgh", "Stanford", "Virginia", "Virginia Tech",
        "Wake Forest",
    ],
    "Big Ten": [
        "Illinois", "Indiana", "Iowa", "Maryland", "Michigan", "Michigan St.",
        "Minnesota", "Nebraska", "Northwestern", "Ohio St.", "Oregon", "Penn St.",
        "Purdue", "Rutgers", "Southern California", "UCLA", "Washington",
    ],
    "Big 12": [
        "Arizona", "Arizona St.", "Baylor", "BYU", "Cincinnati", "Houston",
        "Kansas", "Kansas St.", "Oklahoma St.", "TCU", "Texas Tech", "UCF",
        "Utah", "West Virginia",
    ],
}

# Set by main() to the conference being processed; used only to place a brand-new
# team's folder under the right conference.
_ACTIVE_CONFERENCE = CONFERENCE


def _season_root():
    return os.path.join(_PROJECT_ROOT, str(SEASON))


def _resolve_conference(name):
    """Match a conference name (case-insensitively) to its actual 2026/ folder name,
    preferring an existing folder, then a known-mapping key, else the name as given."""
    season_root = _season_root()
    if os.path.isdir(season_root):
        for d in sorted(os.listdir(season_root)):
            if d.lower() == name.lower() and os.path.isdir(os.path.join(season_root, d)):
                return d
    for key in CONFERENCE_TEAMS:
        if key.lower() == name.lower():
            return key
    return name


def _conf_root(conference):
    return os.path.join(_season_root(), conference)


def _conf_seo(conference):
    """The scoreboard conferenceSeo for a conference label — lowercased and
    hyphenated, which matches ncaa.com's seos for the Power 4
    (SEC->sec, ACC->acc, Big Ten->big-ten, Big 12->big-12)."""
    return conference.lower().replace(" ", "-")


def conference_teams(conference):
    """Team labels for a conference: its explicit roster if known, otherwise the
    team folders present under 2026/<conference>/."""
    if conference in CONFERENCE_TEAMS:
        return list(CONFERENCE_TEAMS[conference])
    return [label for label, _ in ld.team_dirs(_conf_root(conference))]

_FILES = ("boxscore.json", "player_stats.json", "play_by_play.json")
_browser_announced = False


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "opp"


def _team_root(label):
    # Resolve the team's existing folder, which sits under a conference
    # (2026/<Conf>/<label>/). A brand-new team is placed under the conference being
    # processed (2026/<_ACTIVE_CONFERENCE>/<label>/).
    found = ld._find_dir(label, label, _season_root())
    return found or os.path.join(_conf_root(_ACTIVE_CONFERENCE), label)


def _schedule_dir(label):
    return os.path.join(_team_root(label), "schedule")


def _played_count(label):
    """How many games in 2026/<label>/schedule.json have been played (result set),
    or None if the file is missing/unreadable. Box scores only exist for played
    games, so this is the count we compare against the saved folders."""
    path = os.path.join(_team_root(label), "schedule.json")
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return sum(1 for g in data.get("games", []) if g.get("played"))


def _is_saved(game_dir):
    """True if all 3 JSON files exist and are non-empty (same rule as the puller)."""
    return all(os.path.exists(os.path.join(game_dir, f)) for f in _FILES) and \
        all(os.path.getsize(os.path.join(game_dir, f)) > 0 for f in _FILES)


def _saved_dirnames(sched_dir):
    if not os.path.isdir(sched_dir):
        return []
    return [d for d in os.listdir(sched_dir)
            if _is_saved(os.path.join(sched_dir, d))]


def _base_dirname(g):
    """Date + home/away + opponent — the same for both games of a doubleheader."""
    return f"{g['iso']}_{'vs' if g['home'] else 'at'}_{_slug(g['opponent'])}"


def _dirnames(games):
    """contest_id -> folder name. Same-day, same-opponent doubleheaders share a
    base name, so the contest_id is appended to keep their folders distinct;
    single games keep the plain base name."""
    counts = collections.Counter(_base_dirname(g) for g in games)
    out = {}
    for g in games:
        base = _base_dirname(g)
        out[g["contest_id"]] = f"{base}_{g['contest_id']}" if counts[base] > 1 else base
    return out


def _folder_contest_id(game_dir):
    """The contest_id recorded in a saved folder's boxscore.json, or None."""
    try:
        with open(os.path.join(game_dir, "boxscore.json"), encoding="utf-8") as fh:
            return str(json.load(fh).get("contest_id") or "") or None
    except (OSError, ValueError):
        return None


def _migrate_doubleheaders(sched_dir, games):
    """Rename any old-style plain doubleheader folder (saved before this fix, when
    both games shared one name) to the new contest_id-suffixed name, so the half
    already on disk is kept rather than re-pulled or double-counted. Returns the
    number of folders renamed."""
    counts = collections.Counter(_base_dirname(g) for g in games)
    renamed = 0
    for base, n in counts.items():
        if n < 2:
            continue
        old = os.path.join(sched_dir, base)
        cid = _folder_contest_id(old) if os.path.isdir(old) else None
        if cid is None:
            continue
        new = os.path.join(sched_dir, f"{base}_{cid}")
        if not os.path.exists(new):
            os.rename(old, new)
            renamed += 1
    return renamed


def _load_ns():
    """Import ncaa_stats lazily so in-sync teams never boot the browser."""
    global _browser_announced
    if not _browser_announced:
        print("Booting the stealth browser… (first load can take 30–60s)")
        _browser_announced = True
    import ncaa_stats as ns
    ns.VERBOSE = True
    return ns


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2)


# ── Bulk mode: periodically rotate the stealth browser ───────────────────────
_BULK_EVERY = 0      # games between browser rotations (0 = off); set in main()
_games_pulled = 0    # running count of games pulled this run, across all teams


def _bump_pulled():
    """Count a freshly pulled game; in bulk mode, rotate the browser every
    _BULK_EVERY games so one long pull looks like several short, distinct sessions."""
    global _games_pulled
    _games_pulled += 1
    if _BULK_EVERY and _games_pulled % _BULK_EVERY == 0:
        _rotate_browser()


def _rotate_browser():
    """Close + reboot the stealth browser for a fresh fingerprint/session, with a
    randomized human-like pause before resuming."""
    import ncaa_stats as ns
    cooldown = random.uniform(*BULK_COOLDOWN)
    print(f"     ↻ bulk mode: {_games_pulled} games pulled — rotating the stealth "
          f"browser (fresh fingerprint), pausing {cooldown:.0f}s before the next…",
          flush=True)
    ns.restart()
    time.sleep(cooldown)


def pull_missing(label):
    """Pull every game stats.ncaa.org has that isn't saved yet. Returns False to
    stop the whole run (a game failed), True to keep going to the next team."""
    ns = _load_ns()
    school_id = ns.get_school_id(label)
    if school_id is None:
        print(f"     no stats.ncaa.org id for {label!r} — skipping")
        return True

    try:
        games = ns.team_schedule(school_id, SEASON)      # played games only
    except Exception as e:                                # Akamai block, network, …
        print(f"     couldn't read {label}'s schedule from stats.ncaa.org "
              f"({type(e).__name__}: {e})")
        print("     ⛔ Stopping the run (re-run once the block/issue clears).")
        return False
    sched_dir = _schedule_dir(label)
    os.makedirs(sched_dir, exist_ok=True)

    migrated = _migrate_doubleheaders(sched_dir, games)
    if migrated:
        print(f"     migrated {migrated} doubleheader folder(s) to the new naming")

    dirnames = _dirnames(games)                           # contest_id -> folder name
    missing = [g for g in games
               if not _is_saved(os.path.join(sched_dir, dirnames[g["contest_id"]]))]
    if not missing:
        print(f"     stats.ncaa.org has {len(games)} played games — all already saved")
        return True

    # Order: games AFTER the last saved game (oldest→newest), then backward
    # through the earlier games (newest→oldest) to fill any gaps.
    last_iso = max((d[:10] for d in _saved_dirnames(sched_dir)), default="")
    missing_cids = {g["contest_id"] for g in missing}
    by_date = sorted(games, key=lambda g: g["iso"])
    after = [g for g in by_date
             if g["iso"] > last_iso and g["contest_id"] in missing_cids]
    earlier = [g for g in reversed(by_date)
               if g["iso"] <= last_iso and g["contest_id"] in missing_cids]
    order = after + earlier

    print(f"     {len(order)} missing game(s) to pull")
    for i, g in enumerate(order, 1):
        name = dirnames[g["contest_id"]]
        game_dir = os.path.join(sched_dir, name)
        os.makedirs(game_dir, exist_ok=True)
        cid = g["contest_id"]
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
            print(f"       [{i}/{len(order)}] {name}/")
        except Exception as e:
            print(f"       [{i}/{len(order)}] {name}/  FAILED: {type(e).__name__}: {e}")
            print("     ⛔ Stopping the whole run on the first failure (as configured).")
            print("        Re-run once the issue clears — saved games are skipped.")
            return False
        # Count the game only after a clean save (outside the try, so a browser
        # rotation can't be mistaken for a pull failure).
        _bump_pulled()
    return True


def refresh_schedules(labels, conf_seo, conf_dir):
    """Regenerate <conf_dir>/<Team>/schedule.json from the live ncaa.com API for each
    targeted team, so the played-game count reflects reality (incl. games played
    today) BEFORE we compare it to the saved folders. Team folders are created under
    conf_dir as needed, so a conference can be onboarded from scratch. One season
    crawl covers every team. Returns the set of labels that were refreshed."""
    import pull_schedule

    # write_team_schedules only writes into folders that already exist, so make sure
    # each target has one (a fresh conference's teams have no folder yet).
    for label in labels:
        os.makedirs(os.path.join(conf_dir, label), exist_ok=True)

    print("Refreshing schedule.json from the ncaa.com API…")
    # fresh=True forces a re-pull of the last REFRESH_DAYS daily scoreboards (which
    # are otherwise cached indefinitely), so games that finished — or boards cached
    # empty before that day's games were posted — register as finals here. That's
    # what makes the played-vs-saved check below notice new games to pull. The window
    # is wide enough to cover the whole postseason, where a team can go several days
    # between games and an older board may still be stale.
    results = pull_schedule.write_team_schedules(labels, conf=conf_seo,
                                                 fresh=True, fresh_days=REFRESH_DAYS)
    refreshed = set()
    for label, n, played in results:
        print(f"  {label}: schedule.json -> {n} games ({played} played)")
        refreshed.add(label)
    for label in labels:
        if label not in refreshed:
            print(f"  SKIP {label} (not on the {conf_seo} scoreboard)")
    print()
    return refreshed


def process(label):
    """Compare played-game count vs saved box-score folders; pull if they differ."""
    played = _played_count(label)
    if played is None:
        print(f"  SKIP {label} (no schedule.json — run pull_schedule.py first)")
        return True

    saved = len(_saved_dirnames(_schedule_dir(label)))
    if played == saved:
        print(f"  {label}: in sync ({saved} games saved)")
        return True

    print(f"  {label}: schedule lists {played} played, {saved} saved — checking stats.ncaa.org…")
    return pull_missing(label)


def main():
    global _ACTIVE_CONFERENCE, _BULK_EVERY
    raw = sys.argv[1:]
    pos = [a for a in raw if not a.startswith("-")]
    flags = [a for a in raw if a.startswith("-")]
    conf_name = pos[0] if len(pos) >= 1 else CONFERENCE
    team = pos[1] if len(pos) >= 2 else TEAM
    _BULK_EVERY = BULK_EVERY
    for f in flags:
        if f == "--bulk":
            _BULK_EVERY = 50
        elif f.startswith("--bulk="):
            try:
                _BULK_EVERY = max(0, int(f.split("=", 1)[1]))
            except ValueError:
                print(f"  (ignoring bad --bulk value {f!r})")
    conference = _resolve_conference(conf_name)
    _ACTIVE_CONFERENCE = conference

    teams = conference_teams(conference)
    if not teams:
        print(f"  No teams found for conference {conference!r} "
              f"(looked in {os.path.relpath(_conf_root(conference))}/).")
        # Common mix-up: a TEAM name was put in the CONFERENCE slot.
        owner = next(((c, t) for c, ts in CONFERENCE_TEAMS.items()
                      for t in ts if t.lower() == conference.lower()), None)
        if owner:
            c, t = owner
            print(f"  '{t}' is a TEAM in {c}, not a conference — set CONFERENCE = {c!r} "
                  f"and TEAM = {t!r} (or run: update.py {c!r} {t!r}).")
        else:
            print("  CONFERENCE must be one of: " + ", ".join(CONFERENCE_TEAMS)
                  + " (others are read from their 2026/<Conf>/ folders).")
        return

    if team.lower() == "all":
        targets = teams
    else:
        targets = [t for t in teams if t.lower() == team.lower()]
        if not targets:
            print(f"  '{team}' is not in {conference}. Teams:\n  " + ", ".join(teams))
            return

    conf_seo = _conf_seo(conference)
    conf_dir = _conf_root(conference)
    print(f"Updating {conference} ({conf_seo}) — "
          f"{'all teams' if team.lower() == 'all' else targets[0]}")
    if _BULK_EVERY:
        print(f"bulk mode: rotating the stealth browser every {_BULK_EVERY} games")
    print()

    # 1) Refresh every targeted team's schedule.json from the live API, then
    # 2) run the count check (now against fresh numbers) and pull what's missing.
    refresh_schedules(targets, conf_seo, conf_dir)

    # Per team we rebuild stats/, records.json and roster.txt after its pull. The
    # records week calendar is shared across every team, so build it once now (each
    # target's schedule.json was just refreshed above).
    import build_stats
    import build_records
    import build_roster
    records_calendar = build_records.calendar_for_all()

    for t in targets:
        ok = process(t)
        # Always refresh the derived files for a team we ran, so they reflect
        # whatever's now saved (newly pulled games, backfilled decisions, etc.).
        res = build_stats.build_for_team(t)
        if res is not None:
            b, p = res
            print(f"     stats/ rebuilt: {b} batters, {p} pitchers")
        # records.json (from schedule.json) + roster.txt (from saved box scores).
        team_dir = ld._find_dir(t, t)
        if team_dir and records_calendar:
            nweeks = build_records.write_for_team(team_dir, t, records_calendar)
            if nweeks is not None:
                print(f"     records.json: {nweeks} weeks")
        rpath, rplayers = build_roster.build_for_team(t)
        if rpath:
            print(f"     roster.txt: {rplayers} players")
        if not ok:
            break  # stop on first failure

    # The refresh above ran BEFORE the pull, so re-write schedule.json now that the
    # games are saved — this run's newly pulled games are then reflected as played.
    # (The scoreboard fetches are cached from the first pass, so this is cheap.)
    print("Updating schedule.json with the games pulled this run…")
    refresh_schedules(targets, conf_seo, conf_dir)

    if "ncaa_stats" in sys.modules:        # shut the browser down if we started it
        try:
            sys.modules["ncaa_stats"].shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    main()
