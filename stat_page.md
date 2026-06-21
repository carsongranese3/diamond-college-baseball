# Plan: Add a "Stats" page (Stat Leaders)

## Context

The app has Home / Standings / Scores / Postseason / Compare but no league-wide player-stats view. A prototype (`~/Downloads/College baseball stats page/Stats Page.dc.html`) defines a **Stat Leaders** page: a team-colored leader hero, a click-to-add/remove **column chip selector** (batting in gold, pitching in blue), and a **sortable leaderboard table**. We port that into the app, wired to real data and the existing theme/league system.

**Decisions:**
- Theme-aware (light + dark via `.bbx` tokens); the leader hero **follows the currently-sorted stat** (sort by HR → HR leader in the hero).
- **Batter / Pitcher mode (mutually exclusive):** the Display Stats section has a **Batter | Pitcher segmented toggle** — exactly one is active, never both. The table shows only players of the active type, so there is no pooling and no `—` placeholders. Switching mode swaps the available stat chips (gold batting set vs blue pitching set) and resets `selected`/`sortKey` to that type's defaults. Default mode: **Batter**.

All stats the prototype needs already exist in the per-team `roster` data — no new scraping/pipeline work.

## Backend — `app.py`

**New `_stat_leaders(league="sec")`** — mirrors the existing `_conference_leaders` walk (reuse its pattern + `team:{seo}` cache key):
- For each `t` in `_season_for_league(league)["teams"]`, get `stats = _memo(f"team:{seo}", 21600, lambda: local_data.team_stats(seo, name) or compute_team_stats(seo, sched))` and read `stats["roster"]` (`batters`, `pitchers`).
- Flatten into two lists of player cards: identity from the team object (`abbr = t["mark"]`, `color = t["color"]`, `logo = t["logo"]`, `team = t["name"]`, `seo`, `num` (jersey #, from the roster row), `pos`, `type` `"B"`/`"P"`) plus stats:
  - **Batting:** `avg, obp, slg, ops` (strings like `".327"`), `hr, rbi, sb, h` (ints).
  - **Pitching:** `era, whip` (strings), `w, so(=k), sv` (ints), `ip` (string like `"109.1"`).
- **Qualified filter:** batters `ab >= 50`; pitchers `ip >= ~20` (parse IP string; tunable).
- Return `{"batters": [...], "pitchers": [...], "teams": len(teams), "updated": data["updated"]}`.

**New route:**
```python
@app.route("/api/stat-leaders")
def stat_leaders():
    return _league_json("stat_leaders", season.SEASON_AGGREGATE_TTL, _stat_leaders)
```
Reuses `_league_json` / `_memo`, `local_data.team_stats`, `compute_team_stats`, `_season_for_league`. Frontend does all sort/column/leader logic client-side; rate stats stay as pre-formatted display strings.

## Frontend

- **`static/bootstrap.js`** — `window.fetchStatLeaders = _memoFetch("__slCache", "/api/stat-leaders", "stat-leaders");`
- **`static/stats.jsx` (new)** — `Stats({ league, onTeamClick })`. Fetch via `fetchStatLeaders(league)` in `useEffect([league])`. State `{mode, selected, sortKey, sortDir}` where `mode` is `"B"` or `"P"`; `MASTER`/`toggleStat`/`setSort` ported from the prototype. `useMemo` picks the active list (`data.batters` when `mode==="B"`, else `data.pitchers`), builds sorted rows (parse rate strings → floats, nulls last), header defs, dynamic `gridCols`, and chips. **Leader hero = `sorted[0]`** with stat boxes adapting to mode (AVG/HR/RBI/OPS vs ERA/W/SO/WHIP) and a team-color gradient. Wrap in `.bbx` + new `.stx-*` classes.
  - **Batter/Pitcher toggle:** a segmented control at the top of the Display Stats section sets `mode` (mutually exclusive). Changing `mode` swaps the chip set and resets `selected`/`sortKey` to that mode's defaults (e.g. Batter → AVG, Pitcher → ERA). No mixed-type rows, so no `—` placeholders.
  - **Max 10 selected stats:** `toggleStat` caps `selected` at **10** stat columns — adding an 11th is a no-op (the chip doesn't toggle on). Already-selected chips still deselect freely. Once at the cap, the not-yet-selected chips render disabled/dimmed. (The fixed Rank/Player/Number/Team/Pos columns don't count toward the 10.)
  - **Row cap:** the table shows the **top 25** players for the current sort (rank 1–25) — `sorted.slice(0, 25)`. Ranks render `01`–`25`. (The leader hero still reads `sorted[0]`.)
  - **Table columns (changed from prototype):** fixed left columns are **Rank → Player Name → Number (jersey #) → Team → Pos**, then the selected stat columns. **Team cell uses the real logo, not the prototype's color square** — render via the shared `Monogram` component (`components.jsx`: `team.logo` with colored-initials fallback), passing `{ id: seo, logo, name, color }`. `gridCols` leads with widths for rank/player/number/team/pos (e.g. `['44px','minmax(170px,1.4fr)','44px','60px','50px']`) before the dynamic stat columns.
  - **Layout order (changed from prototype):** (1) "STAT LEADERS" title/eyebrow, (2) **Display Stats section** — moved up to sit ABOVE the leader hero, containing the **Batter | Pitcher toggle** then the stat chip selector, (3) leader hero, (4) table.
- **`static/styles.css`** — `.stx-*` block (hero, chips, dynamic-column grid table) on `--bbx-*` tokens (`--bbx-gold` batting, `--bbx-blue` pitching, fonts `--bbx-cond`/`--bbx-sans`/`--bbx-mono`); light variant free from the existing `.bbx` light tokens.
- **`static/app.jsx`** — `pathForView`/`viewForPath` for `/stats`; `goStats`; `section` mapping; render `<Stats league={league} onTeamClick={goTeam} />`; Topbar `onStats` prop + "Stats" nav link after "Scores".
- **`static/index.html`** — `<script type="text/babel" src="/static/stats.jsx"></script>` before `app.jsx`.

## Data notes / limitations
- Player class (Jr/So/Sr) is not in our data → omit (hero meta shows `pos · team`).
- Stats arrive pre-formatted; the frontend parses to numbers only for sorting.
- **Position = most-played** (not first-seen). `build_roster.py` / `build_stats.py` tally each game's `P` code and store the most frequent via `local_data.most_played_position`, which normalizes compound codes (`2B/3B`→`2B`) and ignores pinch roles (`PH`/`PR`/`OUT`/`DP`) unless that's all a player did. Pitchers resolve to `P`. Already applied to all regenerated `roster.txt` + `stats/*.json`.
- NCAA league walks all tracked teams (~32), sharing the `team:{seo}` cache — cheap after first load.

## Verification
1. `.venv/bin/python app.py` → `http://localhost:5050`, click **Stats**.
2. `curl 'http://localhost:5050/api/stat-leaders?league=sec'` → `{batters, pitchers, teams, updated}` populated.
3. Toggle NCAA/SEC/ACC (re-scope), flip Batter/Pitcher (table + chips swap, only one active), click chips (columns), click headers (sort + hero updates).
4. Toggle theme → adapts light/dark.
5. No regressions; `git diff --stat` shows only intended files.

## Files touched
`app.py`, `static/stats.jsx` (new), `static/bootstrap.js`, `static/app.jsx`, `static/index.html`, `static/styles.css`, `stat_page.md`.
