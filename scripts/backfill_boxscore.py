"""Backfill `info` (and any missing `decisions`) into already-saved boxscore.json.

Both fields are parsed from the contest's box-score page, which the original pull
already cached in cache_ncaa_stats/ — so this reads only the local cache and makes
NO network requests / never boots the stealth browser. Games whose box-score page
isn't cached are skipped (re-pull them normally to pick the fields up).

    info       {date, time, venue, location, attendance}
    decisions  {win, loss, save}  (added only if the file lacks it)

Run:
    .venv/bin/python scripts/backfill_boxscore.py            # every saved game
    .venv/bin/python scripts/backfill_boxscore.py Texas      # one team folder
"""

import glob
import json
import os
import sys

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

# bs4 lives in .venv-dev (not the deploy .venv) — re-exec there if needed.
_DEV_PY = os.path.join(_PROJECT_ROOT, ".venv-dev", "bin", "python")
if os.path.exists(_DEV_PY) and not sys.executable.startswith(os.path.dirname(_DEV_PY)):
    os.execv(_DEV_PY, [_DEV_PY, *sys.argv])

import ncaa_stats as ns

NCAA_BASE = ns.NCAA_BASE


def _cached(cid):
    """True if the contest's box-score page is already in the local cache."""
    url = f"{NCAA_BASE}/contests/{cid}/box_score"
    return os.path.exists(ns._cache_path(url))


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    pattern = (f"2026/{arg}/schedule/*/boxscore.json" if arg
               else "2026/*/schedule/*/boxscore.json")
    paths = sorted(glob.glob(os.path.join(_PROJECT_ROOT, pattern)))
    updated = skipped_nocache = unchanged = errors = 0

    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                box = json.load(fh)
        except (OSError, ValueError):
            errors += 1
            continue
        cid = box.get("contest_id")
        if not cid:
            continue
        if not _cached(cid):
            skipped_nocache += 1
            continue
        changed = False
        try:
            if not box.get("info"):
                box["info"] = ns.contest_info(cid)
                changed = True
            if not box.get("decisions"):
                box["decisions"] = ns.contest_decisions(cid)
                changed = True
        except Exception as e:  # a corrupt cached page — leave the file as-is
            print(f"  ERR {path}: {type(e).__name__}: {e}", flush=True)
            errors += 1
            continue
        if changed:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(box, fh, indent=2)
            updated += 1
        else:
            unchanged += 1

    print(f"\nbackfill done: {updated} updated, {unchanged} already complete, "
          f"{skipped_nocache} skipped (page not cached), {errors} errors "
          f"— {len(paths)} files scanned.")


if __name__ == "__main__":
    main()
