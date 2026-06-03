"""Fill in missing game data for a team by pulling it from stats.ncaa.org.

For each team it looks at, this FIRST refreshes 2026/<Team>/schedule.txt from the
live ncaa.com API (so the recorded game count always reflects reality, including
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

Pick the team with the CONFIG block below, then run:
    .venv/bin/python scripts/update.py
"""

import collections
import functools
import json
import os
import re
import sys

# ─── CONFIG ──────────────────────────────────────────────────────────────────
TEAM = "all"   # a team folder label (e.g. "Arkansas"), or "all" for every team
# ─────────────────────────────────────────────────────────────────────────────

SEASON = 2026

# This file lives in scripts/; add the project root (for season/local_data) and
# the scripts dir (to reuse build_schedule) to the import path.
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

print = functools.partial(print, flush=True)  # live progress in the terminal

# The 16 SEC schools; each name doubles as its 2026/ folder label and the school
# name passed to ncaa_stats (same convention as pull_game_stats.py).
SEC_TEAMS = [
    "Alabama", "Arkansas", "Auburn", "Florida", "Georgia", "Kentucky", "LSU",
    "Mississippi St.", "Missouri", "Oklahoma", "Ole Miss", "South Carolina",
    "Tennessee", "Texas", "Texas A&M", "Vanderbilt",
]

_FILES = ("boxscore.json", "player_stats.json", "play_by_play.json")
_browser_announced = False


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "opp"


def _team_root(label):
    return os.path.join(_PROJECT_ROOT, str(SEASON), label)


def _schedule_dir(label):
    return os.path.join(_team_root(label), "schedule")


def _recorded_count(label):
    """The number on the first line of 2026/<label>/schedule.txt, or None."""
    path = os.path.join(_team_root(label), "schedule.txt")
    try:
        with open(path, encoding="utf-8") as fh:
            return int(fh.readline().strip())
    except (OSError, ValueError):
        return None


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


def pull_missing(label):
    """Pull every game stats.ncaa.org has that isn't saved yet. Returns False to
    stop the whole run (a game failed), True to keep going to the next team."""
    ns = _load_ns()
    school_id = ns.get_school_id(label)
    if school_id is None:
        print(f"     no stats.ncaa.org id for {label!r} — skipping")
        return True

    games = ns.team_schedule(school_id, SEASON)          # played games only
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
    return True


def refresh_schedules(labels):
    """Regenerate 2026/<Team>/schedule.txt from the live ncaa.com API for each
    targeted team, so the recorded game count reflects reality (incl. games
    played today) BEFORE we compare it to the saved folders. One API season
    build covers every team; we match each folder label to its API team by name.
    Returns the set of labels that were refreshed."""
    import build_schedule
    import season

    print("Refreshing schedule.txt from the ncaa.com API…")
    data = season.build_season(fresh=True)
    by_name = {t["name"]: t for t in data["teams"]}
    refreshed = set()
    for label in labels:
        team = by_name.get(label)
        if not team:
            print(f"  SKIP {label} (not in the API team list)")
            continue
        res = build_schedule.build_for_team(team, data["schedules"].get(team["id"], []))
        if res:
            _, n = res
            print(f"  {label}: schedule.txt -> {n} games")
            refreshed.add(label)
    print()
    return refreshed


def process(label):
    """Compare recorded vs saved counts for one team; pull if they differ."""
    recorded = _recorded_count(label)
    if recorded is None:
        print(f"  SKIP {label} (no schedule.txt — run build_schedule.py first)")
        return True

    saved = len(_saved_dirnames(_schedule_dir(label)))
    if recorded == saved:
        print(f"  {label}: in sync ({saved} games saved)")
        return True

    print(f"  {label}: schedule lists {recorded}, {saved} saved — checking stats.ncaa.org…")
    return pull_missing(label)


def main():
    if TEAM.lower() == "all":
        targets = SEC_TEAMS
    else:
        targets = [t for t in SEC_TEAMS if t.lower() == TEAM.lower()]
        if not targets:
            print(f"  '{TEAM}' is not an SEC team. Set TEAM to one of:\n  "
                  + ", ".join(SEC_TEAMS))
            return

    # 1) Refresh every targeted team's schedule.txt from the live API, then
    # 2) run the count check (now against fresh numbers) and pull what's missing.
    refresh_schedules(targets)

    for t in targets:
        if not process(t):
            break  # stop on first failure

    if "ncaa_stats" in sys.modules:        # shut the browser down if we started it
        try:
            sys.modules["ncaa_stats"].shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    main()
