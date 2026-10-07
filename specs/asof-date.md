# Spec: view the site as of a date (`?asof=`), remove dev tools

Decisions: see the last entry in `docs/decisions.md` (authoritative). Summary + code map below.

## Behavior
- URL `?asof=YYYY-MM-DD` makes the whole site behave as of that day: games after it are
  unplayed, standings/records/phase/This-Week/rankings history rewind, and **all stats**
  (team, player, leaders, splits, situational, compare, players-to-watch, POTW) count only
  games on/before that date.
- **No `asof` = today** (the real date, clamped to the season end 2026-06-30 as today).
- Valid range `[2026-02-13, min(real today, 2026-06-30)]`; otherwise ignored → today.
- No spoilers: bracket/postseason data treat games after as-of as unplayed; `/api/game/...`
  for a game dated after as-of → 404.
- Leader qualification: batting `AB >= min(50, 2 × team games played)`, pitching
  `IP >= min(20, 1 × team games played)` (team games played as of the date).

## Contract between backend and frontend
- Every `/api/*` endpoint accepts `?asof=`.
- `/api/bootstrap` → `clock`:
  ```json
  {"today": "2026-05-01", "asof": "2026-05-01", "live": false,
   "min": "2026-02-13", "max": "2026-06-30",
   "phases": [{"key": "regular", "label": "Regular Season", "start": "2026-02-13", "end": "2026-05-18"}, ...]}
  ```
  `today` = effective date (as-of, or real today clamped to season); `asof` = the honored
  as-of string or `null`; `live` = `asof is null`; `phases` from `phase._WINDOWS` with
  `phase._SITE_LABEL` labels, in chronological order.
- `/api/dev/clock` and `/api/dev/update` are removed.

## Removal
- Backend: `clock.TEST/_DATE/configure/is_test/state` time machine, `/api/dev/clock`,
  `/api/dev/update`, `UPDATE_CONFERENCES`, `_update*`, `_run_update` (app.py ~60-103, 850-877),
  unused imports (`subprocess`; check `sys`).
- Frontend: `UpdateButton`, `DevClock` and their mounts in `static/app.jsx`; `.devclock*`,
  `.devupd*` in `static/styles.css`.

## Backend map (from explore pass; line numbers approximate)
- `clock.today()` → read `request.args["asof"]` when `flask.has_request_context()`, validate +
  clamp; else real date. Prewarm thread (app.py ~996) and scripts call it outside a request.
- `season._today()` (season.py:31) = `min(clock.today(), 6/30)`; drives `build_season`
  scoreboard crawl (314, 344), `upcoming_schedules` (126), `bracket_upcoming` (190).
- `phase.current_phase` (118), `app._cws_finals_started` (201), `_live_phase` (216),
  `_prev_week_window` (546), `_players_to_watch` (772, `gp` at ~774-786 must count only
  iso <= asof).
- Memo keys that must include the effective date: `season:conf:{seo}` (139,152),
  `season:{league}` (145), `team:{seo}` (296, 387, 893 — shared by 3 endpoints),
  `splits:{seo}` (901), `player:{seo}:{name}` (926), `_league_json` endpoints
  `conference_leaders` (372), `stat_leaders` (416), `rankings_history` (449) → `by_date=True`.
  `bootstrap_payload:{asof}:{test}` (748) → drop `test`. `_memo` has no eviction → add
  expired-entry sweep / size cap.
- `_conf_full` (148-176) nulls post-date results only `if test:` (168-170, 741-742) → make
  unconditional "iso > asof".
- Stats: `local_data.team_stats` (364) reads PRECOMPUTED `stats/*.json`; `team_splits` (1267)
  uses precomputed roster/OPS baseline + per-game PBP via `_iter_games` (330, filter on folder
  name `d[:10]`); `local_data.player` (1038) per-game via `_iter_games` (cross-year via
  `_year_roots()`: skip years > asof year, filter only the as-of year);
  `week_player_lines` (977) already takes a range; `weekly_records` (955) reads `records.json`
  (drop/recompute weeks past as-of); `stats.compute_team_stats` (stats.py:26) skip
  `entry["iso"] > asof`. Aggregation for stats/*.json lives in
  `scripts/build_stats.py:269-436` `build_for_team` — extract a pure
  `aggregate(team_dir, label, asof=None)` into a non-script module (build_stats imports
  local_data → avoid circular import), keep `build_for_team` writing via it; use the fast
  precomputed read when as-of >= team's last saved game.
- Spoilers: `bracket_ncaa` (960, also 197/699), `super_regionals`/`regional_cities` (848-849),
  `postseason_fill` (735), `bracket_conf` (963-975, raw `local_data.schedules`).
- Game guard: `/api/game/<id>` (~938-949) — 404 if `iso > asof` before memo.

## Frontend map
- `static/bootstrap.js`: all fetches (roster 14, player 27, `_memoFetch` 50 for leaders /
  rankings-history / POTW / players-to-watch / stat-leaders, top25 62, team 81, splits 94,
  game 117, bootstrap 127) + `static/bracket.jsx` 8, 19. Add `window.ASOF` from the URL and a
  helper that appends `asof=` to every API URL (handles existing `?`).
- `window.SEASON_CLOCK` readers use `.today`: home.jsx:91, home_regular.jsx:32,60,
  stage_page.jsx:63. `SEASON_UPDATED` (real now) is wrongly used as a "today" fallback in
  home_regular.jsx/stage_page.jsx → use `SEASON_CLOCK.today`. scores.jsx:103 default date
  uses `new Date()` → use `SEASON_CLOCK.today`.
- Routing in `static/app.jsx`: `pathForView` (26-77) / `buildQuery` (18-24), push/replace
  effect (161-169), popstate (170-175). Preserve `?asof=` across navigation by merging it into
  the query in `pathForView`/the effect (some views already emit queries).
- UI: date chip in the Topbar (453-491): calendar input (min/max from `clock`), prev/next day
  arrows, phase shortcuts (jump to a phase's start/end from `clock.phases`), "Viewing <date>"
  banner + "Back to today" when `!clock.live`. Changing date = full navigation to the current
  path with/without `?asof=`. If the URL has an `asof` that bootstrap reports as `null`,
  strip it with `history.replaceState`.

## Acceptance
- No `asof`: site identical to today's live behavior (minus dev widgets).
- `?asof=2026-04-15`: games after 4/15 unplayed everywhere; team/player/leaders/splits
  numbers differ from full season and match a hand sum of games ≤ 4/15; bracket shows no
  post-4/15 results; `/api/game` for a later game 404s.
- In-app navigation keeps `?asof=`; "Back to today" drops it.
- Invalid/future `asof` → today, param stripped.
