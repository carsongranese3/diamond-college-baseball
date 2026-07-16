# Decisions

## Game play-by-play now sourced from the detailed PBP (2026-06-28)

The game view's play-by-play is rendered from each game's
`play_by_play_detailed.json` (grouped by half-inning) instead of the flat
`play_by_play.json`. Chosen layout: **inning-grouped feed** with collapsible
half-inning headers + running score, surfacing outcome label, count/pitches,
base+outs state, and running score/RBI per play.

- **Contract:** `local_data.game()` emits a new `pbp` array (see
  `docs/data-shapes.md`) alongside the existing flat `plays`.
- **Fallback:** the flat `plays` list is retained; the detailed file is loaded
  optionally so a missing one never drops a game, and the live-API path (no
  detailed data) falls back to the flat list. Coverage today is 100% (all 1,934
  saved games have the detailed file), but the fallback stays for the API path
  and future robustness.
- **Why not a pure source swap:** the detailed `description` ≈ the simple
  `text`, so re-sourcing alone would be visually identical and pointless; the
  value is surfacing the structured fields.

## Situational Splits view (2026-06-29)

Imported the claude.ai/design "Situational stats section" prototype and built it
as a real feature: a **Situational** mode on the team Stats tab (beside
Team/Players), `/team/<seo>/stats?mode=situational`.

- **Real data, not the prototype's RNG.** Splits are computed server-side from
  each team's saved `play_by_play_detailed.json` (`runners_before` + `outs_before`
  per PA) — a direct payoff of the detailed-PBP work above. New endpoint
  `GET /api/team/<seo>/splits` returns raw per-(mask,outs) counts per batter; the
  frontend sums the selected cells and computes AVG/OBP/SLG/OPS using the
  prototype's exact math (see `docs/data-shapes.md`, `docs/design.md`).
- **Aesthetic.** Per the user, keep the prototype's layout/interaction (diamond
  base toggles, outs/ANY, team-OPS + delta, per-batter table) but reskin into the
  app's existing `styles.css` tokens/fonts. The diamond/leader accent uses the
  team's color (`colors.py`), which generalizes the prototype's Texas-orange.
- **Coverage caveat.** Endpoint reports `gamesWithPbp`/`gamesTotal`; teams/games
  without detailed PBP are skipped, and a zero-coverage team shows an empty state.
- **OBP** intentionally follows the prototype: `(H+BB)/(AB+BB)` (HBP/SF ignored),
  for visual parity; revisit if full OBP is wanted later.

## Fielding stats (`stats/fielding.json`) (2026-06-29)

`scripts/build_stats.py` now also writes `stats/fielding.json`, mirroring
batting/pitching. Only counting stats are stored; fielding % is derived by
readers. `local_data.team_stats` reads it — real team `fielding.{pct,e,dp}`
(replacing the old placeholders, already shown by `team.jsx`/`compare.jsx`) plus
a per-player `roster.fielders` list (summary totals + `fpct`, and a `positions`
breakdown each with its own `fpct`).

**Per-position split:** each fielder row's `pos` is a **list** with one entry per
position played, because fielding stats mean different things by position (a 1B's
putouts vs a SS's assists). Each game's fielding line is attributed to that game's
primary position; the box score gives one position code + combined chances per
player per game, so chances can't be split *within* a game (a compound code like
`SS/2B` lands on its first real position).

**Position-gated fields (recorded box-score stats only):**
- universal: `g, po, a, e, tc, dp, tp`
- outfield (LF/CF/RF/OF): `+ ofa` (outfield assists = assists at an OF spot)
- catcher (C): `+ pb, sba, csb, ci`

Intentionally **not** stored: GS, innings played, fielding-vs-throwing error
split, and pickoffs — none are in the per-game box-score fielding line. GS/innings
would require scraping the stats.ncaa.org season fielding page (a separate
source); the error split and per-fielder pickoffs aren't cleanly recoverable even
from the play-by-play. Frontend (`team.jsx`) splits these into Basic (recorded
counts) vs Advanced (calculated: FPCT, RF/G, TC/G, CS%).

- **DH/pinch rows excluded** (`pos` reduces to DH/PH/PR/…): not defensive
  appearances, so `g` and `pos` reflect real fielding games. Pitchers are
  included (they field).
- **Team DP ≠ Σ per-player DP.** One double play credits several fielders, so
  summing IDP overcounts ~2–3×. Team `dp` instead uses **staff GIDP induced**
  (`Σ pitcher gidp`) — a clean, if GB-only, team double-play count. Per-player
  `dp` (IDP) is still stored as-is in `fielding.json`.
- The incremental driver (`scripts/update.py`) calls `build_for_team`, so
  fielding regenerates automatically on future pulls.

## Player of the Week card (2026-07-14)
- **BB display**: batter card now shows walks (`BB`) in the `basic` stat row.
  The scoring formula (`_batter_week_score`) was NOT changed — walks were
  already counted via the on-base term `(H+BB+HBP)/PA`. This is display-only.
- **GPA added**: batter `adv` row shows Gross Production Average,
  `GPA = (1.8·OBP + SLG) / 4`, formatted with `boxutil.fmt3`. Batter-only
  (GPA is a hitting stat); pitcher card unchanged.
- **Card layout**: removed the `bbx-potw__cutout` placeholder box, reflowed
  content left, moved the team logo to the RIGHT of the player name at size 40
  (was size 18 above the name). `.bbx-statgrid` switched to
  `repeat(auto-fit, minmax(70px,1fr))` to fit the now-4-item basic/adv grids.

### Pitcher card + logo follow-up (2026-07-14)
- Pitcher card `basic` now ERA, K, **BB**, IP (BB inserted between K and IP);
  `adv` now ends with **BB/9** (`boxutil.per9(c["bb"], outs)`). No scoring change.
- Team logo in `.bbx-potw__nameline` bumped 40 → **56** (shared batter+pitcher
  component). `.bbx-potw__name` given `min-width:0; overflow-wrap:break-word`
  and the monogram `flex:0 0 auto` so a long name wraps instead of squeezing
  the larger logo.

### Postseason "Players to Watch" cutout removed (2026-07-14)
- `stage_page.jsx` `StagePlayersToWatch`: removed the `.stg-pcard__photo`
  ("PLAYER CUTOUT") box and its CSS (`.stg-pcard__photo`, `.stg-pcard__logo`).
  Logo moved out of the photo box to the RIGHT of the player name (size 26 → 40)
  via a new `.stg-pcard__nameline` flex row, matching `.bbx-potw__nameline`.
- This clears the LAST player-cutout placeholder in the app. Confirmed via
  `grep -rni cutout static/` → no matches. Cutout spaces existed only on the
  regular-season POTW card and the postseason Players-to-Watch cards; the
  offseason (`home.jsx`) and team (`teamhome.jsx`) homepages never had one.

## Situational stats: base "Any", batting/pitching splits, handedness UI (2026-07-14)
- **Base "Any" button**: bottom-left of the diamond. Since mask `0` already means
  "bases empty", "Any" uses a distinct sentinel (`mask === "any"`) that aggregates
  over ALL base states in `_agg`. Frontend-only (filtering is client-side).
- **BATTING / PITCHING toggle**: new segmented control inside `SituationalView`
  (below the team/player/situational controls), following the `stats.jsx`
  Batters/Pitchers pattern.
- **Pitching splits**: derivable from play-by-play (pitcher named per play).
  Cells keyed `"<mask>-<outs>"` like batting. Shown: BF, H, BB, SO, HR, IP, WHIP,
  opp-AVG. **No ERA** — earned vs unearned runs are not in the play data.
- **FIELDING dropped**: play-by-play has zero fielder attribution
  (no PO/A/E/position), so real fielding splits aren't derivable. Not built.
- **Lefty/righty handedness selector**: batter handedness (Bats L/R) does NOT
  exist anywhere in the data (play-by-play, roster.txt, stats JSON). Per user,
  the L/R-boxes + plate + "Any" UI is built VISUALLY in the pitching view now,
  but only "Any" returns data; L and R are inert placeholders until a future
  data pull adds handedness. No backend/data work for handedness this iteration.
- **API contract (pitching splits)**: `/api/team/<seo>/splits` response gains a
  `pitchers` list alongside `players`, same top-level shape. Each pitcher cell
  (keyed `"<mask>-<outs>"`) carries: `bf, ab, h, bb, so, hr, outs`. Frontend
  derives IP=outs/3, WHIP=(h+bb)/IP, oppAVG=h/ab. Endpoint stays unparameterized
  (fetch-once, filter client-side); memo key `splits:{seo}` unchanged.

### Situational: base/out heatmap replaces TEAM OPS box (2026-07-14)
- Removed the `.split-team-ops` box (batting-only) from the situational controls row.
- Third column of `.split-controls` (both modes) now holds a mini 8×3 base/out
  heatmap: 8 base states × 3 out counts, one team-aggregate cell each, shaded by
  performance and clickable to jump the selector to that base+out state.
  - Batting metric: OPS (higher = stronger, more intense team color).
  - Pitching metric: opponent AVG (h/ab) — lower = stronger for the defense, so
    the color scale is inverted (opp SLG isn't derivable — pitching cells lack
    2B/3B breakdown, only bf/ab/h/bb/so/hr/outs).
  - Low-sample cells (few PA/BF) are dimmed to avoid misleading extreme colors.
  - Handedness stays hidden behind SHOW_HANDEDNESS=false; heatmap is its own column.
- All derivable from existing splits data; no backend/data change.

### PBP baserunner parser fix — forced advances (2026-07-14)
- **Bug**: `scripts/pull_game_stats.py` runner sub-event loop used a regex that
  required whitespace immediately before the action word ("advanced"/"scored"/
  "out"). NCAA runner names are "Last, F." (e.g. "Willits, J."), so the comma
  blocked the match and it captured the initial ("J.") instead of the surname —
  `_find_runner` then failed and the advance was silently dropped. Effect: walk/
  HBP/error/forced advances never moved runners; runners appeared stuck on 1B.
  2B/3B/loaded states only registered when the BATTER hit an extra-base hit.
- **Fix**: capture the full leading name up to the action keyword
  (`re.match(r"\s*(.+?)\s+(?:advanced\b|scored\b|out\b)", sub)`) and let `_last()`
  extract the surname (it already handles "Last, First"). Minimal change; rest of
  the loop was correct but never firing.
- **Impact**: re-derived `play_by_play_detailed.json` for all 1934 saved games
  (SEC+ACC) via `_ensure_detailed(rebuild=True)` — no re-scrape (advancement text
  was already saved). Oklahoma bases-loaded PA 6 → 75; runner-on-1B 41% → 24%;
  total PA unchanged (2511) = redistribution, not double-count. Fixes ALL
  situational splits/heatmaps (RISP etc.) across every team.
- **Note**: the `2026/` data tree IS git-tracked (only `cache_ncaa_stats/` is
  gitignored), so the rebuild is a ~1934-file diff. Server memoizes `splits:{seo}`
  (6h TTL) — restart to refresh (done this session).
- **Stolen-base advances — FIXED (same session)**: the runner loop had no
  "stole" branch, so steals didn't move runners. Added stole second/third/home
  handling and extended the name regex to `advanced|scored|out|stole|caught|
  picked`. Caught-stealing/pickoffs already contained "out" so the existing out
  branch covers them (no double-count). Re-derived all 1934 games again.
  OU bases-loaded 75 → 87; runners-in-scoring-position up; total PA still 2511.
