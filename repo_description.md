# Repository Guide

A college-baseball web app ("Diamond") — a Flask backend serving a single-page React frontend that shows standings, scores, box scores, team/player pages, and the live postseason (conference tournaments → regionals → super regionals → College World Series → Finals). It started SEC-only and is now multi-conference (currently SEC + ACC, with the full NCAA tournament field filled in from the live bracket).

## Big-picture architecture

The app blends **two upstream data sources** with very different cost and quality:

1. **henrygd NCAA API** (`ncaa-api.henrygd.me`) — a JSON mirror of ncaa.com. Cheap and live, but incomplete (no per-team schedules or baseball standings, misses early non-conference box scores). Used for the team list, rankings, the live bracket, logos, and scoreboards.
2. **stats.ncaa.org** — the official portal, behind Akamai bot protection. Reached only via a stealth browser (Camoufox). Slow but authoritative: real per-game box scores and play-by-play for every game.

The pattern throughout: **prefer the richer locally-saved stats.ncaa.org data when a game/team has been pulled, fall back to the live API otherwise.** Saved data lives on disk under `Data/2026/` (gitignored). The frontend transpiles JSX in the browser (no build step).

---

## Root — backend Python

| File | Lines | What it does |
|---|---|---|
| **`app.py`** | ~865 | The Flask app. In-process memoizer (`_memo`), all `/api/*` endpoints (bootstrap, team, game, player, standings, leaders, brackets, players-to-watch, dev clock/update), the data-driven site-phase logic (`_live_phase`, `_cws_finals_started`), the NCAA-Top-25 logo resolver, and the SPA catch-all that serves `index.html`. |
| **`ncaa.py`** | ~193 | Cached client for the henrygd NCAA API. `get()` caches every response to `cache/` (immutable data forever, recent data with a short TTL); typed helpers for `scoreboard`, `rpi`, `top25`, `bracket`, `boxscore`, `logo_url`, etc. Rate-limited and retrying. |
| **`ncaa_stats.py`** | ~602 | Fetches stats.ncaa.org through a **Camoufox stealth browser** (defeats the Akamai 403). One long-lived browser thread fed by a queue; every page cached to `cache_ncaa_stats/`. Exposes a team's schedule, per-contest box score, decisions, play-by-play. Used only by the `scripts/` pipeline (dev env). |
| **`season.py`** | ~453 | Discovers each conference's teams and builds schedules by crawling the date-based scoreboard and pivoting per team (ncaa.com has no per-team schedule). RPI supplies the canonical team list + records + RPI rank. Also builds the NCAA-tournament fill (`postseason_schedules`) and the phase windows' upcoming games. |
| **`local_data.py`** | ~807 | Reads the locally-saved stats.ncaa.org data from the `Data/2026/` folders. Largest module: conference-aware folder lookup (`_find_dir`, `team_dirs`), per-game detail, season stat aggregation, weekly records — all produced in the *same shapes* as `gamedetail.py`/`stats.py` so the app needs no special-casing. Returns `None` when nothing is saved → caller falls back to the API. |
| **`bracket.py`** | ~445 | Builds the front-end bracket data. `ncaa_bracket()` normalizes the henrygd 64-team championship bracket (regions, rounds, super-regional tree, CWS halves + finals). `conf_bracket()` reconstructs any conference tournament from its locally-saved games. |
| **`phase.py`** | ~120 | "Where in the season are we?" Resolves regular / conference tournament / regionals / supers / CWS / CWS Finals from per-season **date windows** (the box-score text never names the NCAA round). `game_phase()` per game, `current_phase()` site-wide, `round_by_date()` for upcoming games. |
| **`stats.py`** | ~207 | Aggregates a team's real season batting/pitching by summing every box score (each box score's block is per-game, not cumulative). |
| **`gamedetail.py`** | ~170 | Builds the game-detail payload (line score + batter/pitcher tables) from a real box score + game metadata. |
| **`boxutil.py`** | ~118 | Shared box-score helpers: innings-pitched math, name/number formatting, rate-stat formatting. |
| **`colors.py`** | ~91 | Curated team colors (band/ink) for Power-4 programs, keyed by ncaa.com seo slug. Seeds the band/accents on views built from the scoreboard crawl (which carries no colors). |
| **`cities.py`** | ~48 | Host cities for NCAA regional/super-regional sites, keyed by seo (regionals are named for the host *city*, not the school). |
| **`clock.py`** | ~42 | The dev "time machine": a `TEST` flag + date make the whole site behave as of any day. Everything date-aware goes through `clock.today()`. Process-global single-user tool, toggled via `/api/dev/clock`. |

### Requirements
- **`requirements.txt`** — web-app deps only (Flask, gunicorn). The `.venv` that runs the server.
- **`requirements-dev.txt`** — adds the scraping stack (Camoufox, BeautifulSoup/lxml, the `collegebaseball` school-id table). The `.venv-dev` that runs `scripts/`.

---

## `scripts/` — the data pipeline (run with `.venv-dev`)

Generates the `Data/2026/` data tree from stats.ncaa.org.

| Script | What it does |
|---|---|
| **`update.py`** | The incremental driver. Refreshes each team's `schedule.json` from the live API, diffs played-count vs saved box-score folders, and pulls only the missing games (boots the stealth browser). Stops on the first Akamai block. Re-execs itself into `.venv-dev`. Backs the homepage **Update** button. |
| **`pull_game_stats.py`** | Saves a team's full season, one folder per game, from stats.ncaa.org (box score + player stats + play-by-play). |
| **`pull_schedule.py`** | Writes a team's full-season `schedule.json`: played games from saved box-score folders + scoreboard "recent finals" + upcoming from the scoreboard + bracket-scheduled postseason. Light deps (no browser). |
| **`build_stats.py`** | Aggregates saved per-game box scores into `Data/2026/<Team>/stats/{batting,pitching}.json` (counting stats only; rates computed by readers). |
| **`build_roster.py`** | Writes `Data/2026/<Team>/roster.txt` from the saved per-game player stats. |
| **`build_records.py`** | Writes `Data/2026/<Team>/records.json` — cumulative overall + conference record snapshot per week (powers the standings-over-time graph). |
| **`backfill_boxscore.py`** | Adds `info`/`decisions` fields to already-saved box scores from the local cache only (no network). |

---

## `static/` — the frontend (browser-transpiled JSX, no build step)

`index.html` loads React + Babel from a CDN and includes each `.jsx` via `<script type="text/babel">`. Editing a file + reloading is the full dev loop.

| File | What it renders |
|---|---|
| **`index.html`** | The shell: fonts, theme pre-paint, React/Babel CDN scripts, and the ordered list of view files. |
| **`bootstrap.js`** | Runs before React: fetches `/api/bootstrap` and populates `window` globals (`TEAMS`, `TEAM_BY_ID`, `SCHEDULES`, `SEASON_PHASE`, `leagueTeams`, `SEASON_CLOCK`, …) plus lazy, memoized fetchers (`fetchTeam`, `fetchGame`, `fetchRoster`, `fetchPlayer`, `fetchBracket`, leaders/players-to-watch). |
| **`app.jsx`** | Root SPA shell: URL routing, top-bar league selector (NCAA/SEC/ACC), theme toggle, the dev **DevClock** + **Update** widgets, and the view router. |
| **`components.jsx`** | Shared UI primitives — `Monogram` (team logo with initials fallback), `RankChip`, eyebrows, etc. |
| **`home.jsx`** | The site homepage adapters/atoms ("Scoreboard" design) — shared helpers (`hpSecTeams`, `HPLogo`, phase labels) the other home variants reuse. |
| **`home_regular.jsx`** | The regular-season homepage ("Broadcast Bold"): series/player of the week, conference leaders, ticker. |
| **`stage_page.jsx`** | The **postseason** homepage — one reusable `StagePage` driven by a per-phase config (conf tournament / regionals / supers / CWS / CWS Finals). Day-filtered games, the "what's at stake today" boards, the CWS field, the best-of-3 Championship Series, players-to-watch. The largest view. |
| **`teamhome.jsx`** | A single team's "Home" tab (season-aware landing below the team hero). |
| **`team.jsx`** | Team detail: continuous schedule + Team/Players stats toggle + postseason status. |
| **`player.jsx`** | Player detail: per-season totals + game-by-game log. |
| **`game.jsx`** | Game detail / box score: line score + batter/pitcher tables (team headers click through to team pages for tracked teams only). |
| **`scores.jsx`** | Daily scoreboard built from per-team schedules, deduped by matchup. |
| **`standings.jsx`** | Standings tables (NCAA Top 25 + conference) and the rankings-over-time graph. |
| **`bracket.jsx`** | The Postseason bracket view — NCAA 64-team bracket + a tab per conference tournament. |
| **`compare.jsx`** | Head-to-head: team vs team / player vs player. |
| **`styles.css`** | All styling (~100 KB), including the `.bbx` broadcast theme tokens. |
| **`logos/`** | ~194 bundled team logo SVGs, named by ncaa.com seo slug (the bulk of `static/`'s size). |

---

## Data & cache folders (all gitignored, regenerated)

| Folder | ~Size | Contents |
|---|---|---|
| **`Data/2026/`** | 130 MB | The season data tree, nested by conference: `Data/2026/<Conf>/<Team>/` with `schedule.json` (full season), `schedule/<date>_<vs\|at>_<opp>/` box-score folders (`boxscore.json`, `player_stats.json`, `play_by_play.json`), `stats/{batting,pitching}.json`, `records.json`, `roster.txt`. |
| **`cache/`** | 27 MB | Cached henrygd NCAA API responses (`ncaa.py`). |
| **`cache_ncaa_stats/`** | 359 MB | Cached stats.ncaa.org pages (`ncaa_stats.py`), so the slow browser cost is paid once per URL. |
| **`.venv/`** | 14 MB | Web-app virtualenv (Flask). |
| **`.venv-dev/`** | 571 MB | Scraping virtualenv (Camoufox + stats stack). |
| **`__pycache__/`** | — | Compiled Python. |

> The repo is ~1.1 GB on disk but only ~6 MB is tracked by git — the four heavyweights above are all gitignored and regenerate.

---

## Config & meta

| Path | What it is |
|---|---|
| **`.github/workflows/deploy.yml`** | CI: deploys to an Azure Web App on push to `main` (and manual dispatch). |
| **`.vscode/settings.json`** | Pins the Python interpreter and excludes the huge generated folders from indexing/search. |
| **`.gitignore`** | Ignores the venvs, caches, `Data/2026/`, `__pycache__`, `.DS_Store`. |
| **`CLAUDE.md`** | Guidance for Claude Code working in this repo (architecture + commands). |
| **`repo_description.md`** | This file. |

---

## Running it

```bash
.venv/bin/python app.py        # dev server at http://localhost:5050
```

No frontend build — reload the page after editing `.jsx`. The `scripts/` pipeline runs under `.venv-dev` (the scrapers re-exec themselves into it). Production runs gunicorn against `app:app` (see `requirements.txt` / the deploy workflow).
