# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A college-baseball web app ("Diamond/SEC"): a Flask backend serving a single-page React frontend. The backend assembles team schedules, standings, box scores, stats, and postseason brackets from two upstream sources, and the frontend renders them. Originally SEC-only, now multi-conference (`Data/2026/<Conference>/<Team>/`, currently SEC + ACC).

## Running

```bash
.venv/bin/python app.py     # dev server at http://localhost:5050 (debug, threaded)
```

Production entrypoint is gunicorn against `app:app` (see `requirements.txt`).

There is **no build step** for the frontend: `static/index.html` loads React + Babel from a CDN and transpiles the `.jsx` files in the browser at runtime. Editing a `.jsx` file and reloading the page is the full dev loop. New view files must be added as `<script type="text/babel">` tags in `index.html`.

### Two virtualenvs

- **`.venv`** — runs the web app. Deps: `requirements.txt` (Flask, gunicorn).
- **`.venv-dev`** — runs the data-pull scripts. Deps: `requirements-dev.txt`, which adds Camoufox (stealth browser), BeautifulSoup/lxml, and the `collegebaseball` school-id table. After installing, run `python -m camoufox fetch` once.

There are no automated tests, linters, or a Makefile in this repo.

## Two data sources (this is the core architecture)

The app blends two upstreams with very different cost/quality:

1. **henrygd NCAA API** (`ncaa.py`) — a cached client for `ncaa-api.henrygd.me` (a JSON mirror of ncaa.com). Cheap and live, but **incomplete**: no per-team schedule or baseball standings page, and it misses early non-conference box scores. Responses are cached to `cache/` (past/finished data forever, recent data on a short TTL). Rate-limited to 5 req/s.

2. **stats.ncaa.org** (`ncaa_stats.py`) — the official portal, behind Akamai bot protection that 403s plain HTTP clients. Accessed via **Camoufox** (a stealth Firefox) running on a single dedicated browser thread fed by a queue, with every page cached to `cache_ncaa_stats/`. Slow but authoritative: real per-game box scores AND play-by-play for *every* game, including the early non-conference games ncaa.com lacks.

**The pattern throughout:** prefer the richer locally-saved stats.ncaa.org data when a game/team has been pulled, fall back to the live API otherwise. `local_data.py` reads the saved `Data/2026/` folders and returns game-detail / team-stats in the *same shapes* as `gamedetail.py` / `stats.py` so callers and the frontend need no special-casing (it returns `None` when nothing is saved → caller falls back to the API).

The caches (`cache/`, `cache_ncaa_stats/`) and the `Data/2026/` data tree are large and excluded from VS Code indexing in `.vscode/settings.json`. Only `cache_ncaa_stats/` is gitignored; `cache/` and the `Data/2026/` tree are git-tracked.

## The `Data/2026/` data tree

Generated, on-disk season data, **nested by conference**:

```
Data/2026/<Conference>/<Team>/
  schedule.json          full season: every game (played + upcoming) — see pull_schedule.py
  schedule/<date>_<vs|at>_<opp>[_id]/
    boxscore.json        line score (innings + R/H/E) for both teams
    player_stats.json    per-team batting/pitching/fielding lines
  stats/batting.json     season counting-stat totals, one row per player
  stats/pitching.json    (rate stats like AVG/ERA/OPS are NOT stored — computed by readers)
  records.json           cumulative overall + conference record snapshot per week
  roster.txt             one player per line, by jersey #
```

`local_data.py` is conference-aware via `DATA_ROOT` + helpers `_find_dir` / `team_dirs` / `_is_team_dir` (a directory is a conference folder if it isn't itself a team folder). When adding readers, go through these helpers rather than hardcoding paths — folder names contain spaces.

### Building the data (scripts/, run with the dev venv)

- `pull_game_stats.py` — save a team's full season, one folder per game, from stats.ncaa.org (boots Camoufox).
- `pull_schedule.py` — write `schedule.json`: played games from the saved box-score folders, upcoming from the live scoreboard.
- `update.py` — the incremental driver: refresh `schedule.json`, diff played-count vs saved folders, pull only the missing games.
- `build_stats.py` / `build_roster.py` / `build_records.py` — aggregate the saved per-game files into `stats/`, `roster.txt`, `records.json`.
- `backfill_boxscore.py` — add `info`/`decisions` to saved boxscores from cache only (no network).

## Backend layout (`app.py` + modules)

`app.py` is the Flask app: an in-process memoizer (`_memo`), the `/api/*` endpoints, and a catch-all that serves the SPA. Key concept — **"league"**: a request's `?league=` is either a single conference seo (`sec`, `acc`) or `ncaa`, meaning *all* conferences that have a `Data/2026/<Conf>/` folder. `/api/bootstrap` merges every conference into one team list (each team tagged with its `conference`); other endpoints scope by `?league=`.

Supporting modules:
- `season.py` — discovers conference teams and builds schedules by crawling the date-based scoreboard and pivoting per team (RPI gives the canonical team list + records + RPI rank; poll gives ranking).
- `phase.py` — resolves where in the season we are (regular / conf tournament / regionals / supers / CWS) from a per-season date config; `game_phase()` per game, `current_phase()` site-wide. The postseason rounds are date-driven because the box-score text never names the NCAA round.
- `bracket.py` — NCAA 64-team bracket (from the henrygd brackets API) and the conference tournament bracket (reconstructed from saved postseason games + standings seeding).
- `stats.py` / `boxutil.py` — sum per-game box scores into season totals; box-score / innings-pitched / name math.
- `gamedetail.py` — build the line-score + batter/pitcher tables for one game.
- `colors.py` / `cities.py` — curated team colors (keyed by ncaa.com seo) and tournament host cities (regionals are named for the host *city*, not school).
- `clock.py` — the effective "today". A request's `?asof=YYYY-MM-DD` (valid within `[2026-02-13, min(real today, 2026-06-30)]`, else ignored) makes the whole site — schedules, standings, phase, brackets, and all stats — behave as of that day; no `asof` means today. It's per-request (read from the Flask request; real date outside one), so everything date-aware must go through `clock.today()` and every date-sensitive `_memo` key must include the effective date. The frontend forwards `asof` on every API call via `window.apiUrl` and preserves it across navigation. When `asof` precedes a team's last saved game, stats are aggregated per game via `stat_agg.py` instead of read from the precomputed `stats/*.json`.

## Frontend (`static/`)

`bootstrap.js` runs before React: it fetches `/api/bootstrap` and populates `window` globals the views read synchronously — `TEAMS`, `TEAM_BY_ID`, `SCHEDULES`, `LEAGUES`, `leagueTeams(league)`, `SEASON_PHASE`, `SUPER_REGIONALS`, `SEASON_CLOCK`, `CURRENT_LEAGUE`, etc. It also exposes lazy, memoized fetchers (`fetchTeam`, `fetchGame`, `fetchRoster`, `fetchPlayer`, `fetchConferenceLeaders`, …) since per-team stats and per-game box scores are expensive crawls fetched on demand.

`app.jsx` is the SPA shell: top-bar league selector (NCAA/conference), view router, and theme (persisted in `localStorage`, applied pre-paint in `index.html` to avoid a flash). The other `.jsx` files are views (`standings`, `team`, `game`, `scores`, `player`, `compare`, `bracket`, `home`, `teamhome`, `home_regular`, `stage_page`). `components.jsx` holds shared pieces. All styling is in `styles.css`.

## Where things live
- Specs: `specs/`
- API / endpoint docs: `docs/api.md` (the live surface is the `/api/*` routes in `app.py`)
- Normalized data shapes: `docs/data-shapes.md` (the on-disk `Data/2026/` shapes are described above)
- Decisions log: `docs/decisions.md`
- Design reference, if a prototype was provided: `design/` (pulled files) + `docs/design.md` (mapping)

> There is no automated test suite, linter, or build step in this repo (see "Running" above). The
> QA agent verifies by running `.venv/bin/python app.py` and exercising the affected `/api/*`
> endpoints and views in the browser, not by running a test command.

---

## Orchestration (instructions for the main session)

You are the orchestrator. You do not write feature code yourself; you plan, delegate to
the specialist subagents, and integrate their output. The available specialists are:
`requirements-agent`, `explore-agent`, `data-agent`, `backend-agent`, `frontend-agent`,
`qa-agent`, `devops-agent`.

### First, pick the mode

Before delegating anything, decide which mode the task is:
- **Mode A — new feature / greenfield**: building something that doesn't exist yet, in a new or
  empty-ish repo. Use the full build pipeline below.
- **Mode B — editing an existing project**: changing, extending, or fixing code that already
  exists (add a field, fix a bug, refactor, wire in a new endpoint). Understand before you edit.

When unsure, look: if the relevant code already exists in the repo, it's Mode B. Most day-to-day
work is Mode B. Don't run the full greenfield pipeline on a one-file bugfix.

### Mode A — new feature / greenfield

1. Delegate to `requirements-agent` to produce a spec at `specs/<feature>.md` with acceptance
   criteria and edge cases. If the user wants the plan sourced from Azure DevOps, tell the
   agent so explicitly in the prompt — it has read-only access to work items but only consults
   them when asked.
2. Once the spec exists, delegate to `data-agent` (writes `docs/data-shapes.md`) and
   `backend-agent` (reads the shape, writes `docs/api.md`). If the app has no external data,
   skip `data-agent` and let `backend-agent` start from the spec.
3. Delegate `frontend-agent` only after `docs/api.md` exists — it depends on those exact field
   names, so this step is genuinely serial, not parallel.
4. After any piece lands, delegate `qa-agent` to verify it against the spec and do a security
   pass. Treat its go / no-go as a gate.
5. Bring in `devops-agent` only after QA gives a go and its security concerns are resolved —
   for the pipeline, environment config, and monitoring.

### Run independent agents in parallel

The data → backend → frontend chain is serial *across* the chain because each reads the previous
one's doc — don't break that. But *within* a step, run independent agents concurrently:

- **To run agents in parallel, issue their Task calls in a single message.** Multiple Task calls in
  one message run concurrently; one call per message runs them serially. When two or more agents are
  independent, do not wait for one to finish before starting the next — launch them together.
- **Parallel-eligible cases** (launch together in one message):
  - two or more independent backend endpoints or modules,
  - `data-agent` + `backend-agent` on the parts that don't depend on each other (backend scaffolds
    the server/schema while data builds the fetch layer; integrate after),
  - in Mode B, independent edits across layers for one change (e.g. a backend change and an
    unrelated frontend change),
  - independent verification or exploration tasks.
- **Keep serial only where there's a real dependency:** spec before any build, `docs/api.md` before
  `frontend-agent`, the build before `qa-agent`. Don't parallelize across a doc hand-off.

Think "serial backbone, parallel where independent" — not everything at once, and not everything
one-at-a-time.

### Mode B — editing an existing project

The trap here is editing before understanding. Fresh-context agents that skip discovery
reinvent helpers, miss conventions, and break things they couldn't see. So:

1. **Understand first.** Delegate `explore-agent` to map the slice of the codebase the change
   touches: the files involved, how the layers connect, the patterns and naming already in use,
   and anything that would break. It is read-only — it reports a map; you integrate its findings
   and pass them to the builders. It does not edit.
2. **Scope the change.** Decide the smallest set of files/layers that actually has to change.
   If the change is genuinely cross-cutting and underspecified, delegate `requirements-agent`
   to document *current behavior + the specific delta* (not a from-scratch spec) and, if asked,
   to pull scope from Azure DevOps. For a clear, small change, skip the spec and go straight to
   the edit.
3. **Edit the affected layers together.** Delegate `backend-agent` / `frontend-agent` /
   `data-agent` to change only what step 2 scoped — pass them the explorer's map and tell them
   to match existing patterns, not introduce new ones. These often run in parallel here, since
   an edit usually doesn't recreate the greenfield data→backend→frontend dependency.
4. **Verify against current behavior.** Delegate `qa-agent` to confirm the change works, the
   surrounding behavior still passes (no regressions), and to do a security pass on the diff.
5. Bring in `devops-agent` only if the change affects build, config, or deploy — many edits
   don't, so don't invoke it by reflex.

In both modes the rules below apply.

When delegating, remember each subagent starts with a fresh context and can only see what
you put in the prompt. Always pass:
- the spec file path (`specs/<feature>.md`),
- the relevant doc paths (`docs/data-shapes.md`, `docs/api.md`),
- in Mode B, the explorer's map of the affected code,
- any decisions already made.

You own `docs/decisions.md`. Whenever you resolve an open question or make a cross-cutting
call (library choice, data source, schema tradeoff), append it there before delegating the
next step, so future sessions and fresh-context agents stay consistent.

Surface for the user to confirm (do not let an agent do these unprompted): deploying to
production, deleting data, changing access or security settings, creating accounts, or
entering any credentials.
