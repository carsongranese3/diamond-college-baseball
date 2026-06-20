# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A college-baseball web app ("Diamond/SEC"): a Flask backend serving a single-page React frontend. The backend assembles team schedules, standings, box scores, stats, and postseason brackets from two upstream sources, and the frontend renders them. Originally SEC-only, now multi-conference (`2026/<Conference>/<Team>/`, currently SEC + ACC).

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

**The pattern throughout:** prefer the richer locally-saved stats.ncaa.org data when a game/team has been pulled, fall back to the live API otherwise. `local_data.py` reads the saved `2026/` folders and returns game-detail / team-stats in the *same shapes* as `gamedetail.py` / `stats.py` so callers and the frontend need no special-casing (it returns `None` when nothing is saved → caller falls back to the API).

Both caches (`cache/`, `cache_ncaa_stats/`) and the `2026/` data tree are gitignored and large; they're excluded from VS Code indexing in `.vscode/settings.json`.

## The `2026/` data tree

Generated, on-disk season data, **nested by conference**:

```
2026/<Conference>/<Team>/
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

`app.py` is the Flask app: an in-process memoizer (`_memo`), the `/api/*` endpoints, and a catch-all that serves the SPA. Key concept — **"league"**: a request's `?league=` is either a single conference seo (`sec`, `acc`) or `ncaa`, meaning *all* conferences that have a `2026/<Conf>/` folder. `/api/bootstrap` merges every conference into one team list (each team tagged with its `conference`); other endpoints scope by `?league=`.

Supporting modules:
- `season.py` — discovers conference teams and builds schedules by crawling the date-based scoreboard and pivoting per team (RPI gives the canonical team list + records + RPI rank; poll gives ranking).
- `phase.py` — resolves where in the season we are (regular / conf tournament / regionals / supers / CWS) from a per-season date config; `game_phase()` per game, `current_phase()` site-wide. The postseason rounds are date-driven because the box-score text never names the NCAA round.
- `bracket.py` — NCAA 64-team bracket (from the henrygd brackets API) and the conference tournament bracket (reconstructed from saved postseason games + standings seeding).
- `stats.py` / `boxutil.py` — sum per-game box scores into season totals; box-score / innings-pitched / name math.
- `gamedetail.py` — build the line-score + batter/pitcher tables for one game.
- `colors.py` / `cities.py` — curated team colors (keyed by ncaa.com seo) and tournament host cities (regionals are named for the host *city*, not school).
- `clock.py` — dev "time machine". `TEST` flag + a date makes the whole site behave as of that day (games after it read as not-yet-played). Everything date-aware must go through `clock.today()`. It's a process-global single-user dev tool, toggled via `/api/dev/clock`.

## Frontend (`static/`)

`bootstrap.js` runs before React: it fetches `/api/bootstrap` and populates `window` globals the views read synchronously — `TEAMS`, `TEAM_BY_ID`, `SCHEDULES`, `LEAGUES`, `leagueTeams(league)`, `SEASON_PHASE`, `SUPER_REGIONALS`, `SEASON_CLOCK`, `CURRENT_LEAGUE`, etc. It also exposes lazy, memoized fetchers (`fetchTeam`, `fetchGame`, `fetchRoster`, `fetchPlayer`, `fetchConferenceLeaders`, …) since per-team stats and per-game box scores are expensive crawls fetched on demand.

`app.jsx` is the SPA shell: top-bar league selector (NCAA/conference), view router, and theme (persisted in `localStorage`, applied pre-paint in `index.html` to avoid a flash). The other `.jsx` files are views (`standings`, `team`, `game`, `scores`, `player`, `compare`, `bracket`, `home`, `teamhome`, `home_regular`, `stage_page`). `components.jsx` holds shared pieces. All styling is in `styles.css`.
