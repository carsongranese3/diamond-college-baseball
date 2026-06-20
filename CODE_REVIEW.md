# Code Review

Review of the current uncommitted working-tree changes (`git diff` against `main`).

**Scope of the change:** fill the NCAA-tournament field beyond the locally-tracked SEC/ACC teams by pulling the rest of the 64-team bracket from the live API, add a "What's at stake today" board for **Super Regionals** (mirroring the existing Regionals board), and surface **LIVE** status on in-progress games in the tickers.

Files: `app.py`, `season.py`, `static/bootstrap.js`, `static/home_regular.jsx`, `static/stage_page.jsx`, `static/styles.css`.

## Summary

Solid, well-commented change that follows the codebase's existing conventions closely — the new `season.postseason_schedules()` returns games in `build_season`'s shape, the test-mode neutralization reuses the exact `_conf_full` pattern, and the frontend refactor (`stgRoundMatchups`) cleanly generalizes the old SEC-only `stgStakes` loop so Regionals and Super Regionals share it. Postseason teams are kept out of `TEAMS` (so standings/scores stay conference-scoped) while still resolving in `TEAM_BY_ID` — a clean separation.

The findings below are mostly edge cases; none are blockers.

## Findings

### 1. Backend dedupe is exact, frontend dedupe is normalized — duplicates can leak into `SCHEDULES` (medium)

`app.py:557` merges bracket games into a tracked team's schedule, deduping against existing box-score games by an **exact** key:

```python
have = {(g.get("iso"), (g.get("opp") or {}).get("id")) for g in existing}
add  = [g for g in games if (g.get("iso"), (g.get("opp") or {}).get("id")) not in have]
```

But the frontend `stgRoundMatchups` (`static/stage_page.jsx`) deliberately added a `norm()` because *"local box scores and the bracket sometimes spell the same team differently (e.g. `st-john-s-ny` vs `st-johns-ny`)"*. When that spelling mismatch happens, the backend `have` check **misses**, so both the box-score game and the bracket game land in `SCHEDULES[seo]`.

`stgRoundMatchups` hides the dupe on the stakes board (it normalizes the matchup key), but other consumers of `SCHEDULES` — the Scores view and the team-schedule view — don't, so they'd render the same game twice.

**Suggestion:** apply the same `norm()` to the opponent seo when building `have`/`add` in the backend merge, so the dedupe key matches the frontend's. That fixes it at the source for every consumer.

### 2. Regional/Super host city can render blank in NCAA view (low–medium)

`stgRoundMatchups` chooses the "host" side `seo` by JS object key-iteration order over `SCHEDULES`, which is arbitrary between the two teams in a matchup. Downstream:

- `stgStakes`: `city: (window.REGIONAL_CITY_BY_TEAM || {})[seo]`
- `stgSupers`: `city: cityByTeam[seo]`

Both maps are keyed by the **host** team. If iteration picks the visiting side, `seo` is the visitor and the city lookup returns `""`. The old code iterated `hpSecTeams()`, which biased toward the tracked (often hosting) side; the new league-wide loop loses that bias, so in NCAA view a regional's city may sometimes be blank.

**Suggestion:** prefer the home side as the host perspective, e.g. pick `hostId = game.home ? seo : oppId`, or fall back to the opponent's city entry when `seo`'s is empty.

### 3. Backend merge key collapses same-day, same-opponent doubleheaders (low)

The `(iso, opp.id)` key in finding #1 also means a team that plays the same opponent twice on one day maps to a single slot — a second distinct game would be dropped from `add`. Regional/super doubleheaders are virtually always against *different* opponents, so the real-world risk is low, but the frontend already handles this case explicitly (*"a team can play twice in a day"*), so the backend is slightly less precise than the frontend it feeds.

### 4. Tie scores mark both teams a winner (very low)

In `postseason_schedules`, the result fallback when `isWinner` is absent is `result = "W" if us >= them else "L"`, applied from both perspectives — equal scores would label both sides `W`. College baseball games don't end tied, so this is harmless, but `>` would be marginally more correct than `>=`.

## Note (not a code issue): CLAUDE.md location

`CLAUDE.md` was moved to `docs/CLAUDE.md` as requested. Be aware Claude Code auto-loads `CLAUDE.md` from the **repository root** (and parent/sub-directories it walks into), not from `docs/`. Future Claude Code sessions won't pick up `docs/CLAUDE.md` automatically. If you want it auto-loaded, keep a copy or symlink at the repo root, or add a one-line root `CLAUDE.md` pointing at `docs/CLAUDE.md`.

## Things done well

- `season.postseason_schedules()` matches `build_season`'s game shape exactly, so the merge in `bootstrap()` and all frontend consumers need no special-casing.
- Test-mode handling (`app.py:558`) reuses the established `_conf_full` neutralization pattern verbatim — consistent and correct.
- The new bracket fill is memoized (`_memo("postseason_fill", 1800, …)`), matching the surrounding TTL convention.
- `stgRoundMatchups` is a clean extraction that removes duplication between the Regionals and the new Super Regionals boards, and the league scoping (NCAA = full field, conference = filtered) is handled in one place.
- LIVE-status logic is defensively gated (`g.live === undefined && g.st === "TBD"`) so it only kicks in for schedule-sourced rows without an explicit live flag.
