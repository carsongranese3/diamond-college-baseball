# API reference

All endpoints are served by `app.py`. The SPA shell is served by the catch-all at `GET /`.

## The `asof` query parameter (every `/api/*` endpoint)

`?asof=YYYY-MM-DD` makes the response reflect the site as of that date: games after it are
unplayed (results/scores nulled), records / standings / phase / This-Week / rankings history
rewind, and all stats (team, player, leaders, splits, players-to-watch, POTW) count only games
dated on or before it. Resolved per request by `clock.today()` — no server-side state.

- **Honored range:** `[2026-02-13, min(real today, 2026-06-30)]`, strict `YYYY-MM-DD`.
  Anything else (malformed, before the season, in the future) is silently ignored and the
  request behaves as **today** (the real date, capped at the season end).
- **No spoilers:** `/api/bracket/ncaa`, `/api/bracket/conf/<league>`, the bootstrap
  `super_regionals` / postseason schedules treat games after `asof` as unplayed (and the
  participants of later-round games are hidden). `GET /api/game/<id>?...&iso=<date after asof>`
  returns **404**.
- **Leader qualification** (`/api/conference-leaders`, `/api/stat-leaders`): batting
  `AB >= min(50, 2 x team games played)`, pitching `IP >= min(20, team games played)`.
- Not date-aware: `/api/rankings/top25` (live poll) and `/api/roster/<seo>`.

## `GET /api/bootstrap` — `clock`

```json
"clock": {"today": "2026-04-15", "asof": "2026-04-15", "live": false,
          "min": "2026-02-13", "max": "2026-06-30",
          "phases": [{"key": "regular", "label": "Regular Season",
                      "start": "2026-02-13", "end": "2026-05-18"}, ...]}
```

`today` is the effective date (the honored as-of date, else the real date capped at the season
end). `asof` is the honored as-of string, or `null` when absent/ignored; `live` is
`asof == null`. `min`/`max` bound the valid as-of range (`max` = `min(real today, season end)`).
`phases` are the chronological season windows (`phase._WINDOWS`, labelled by
`phase._SITE_LABEL`). The former `/api/dev/clock` and `/api/dev/update` routes are removed.

---

## `GET /api/game/<game_id>`

Single-game box score, line score, play-by-play, and batter/pitcher tables.

### Query parameters

| Param | Required | Description |
|-------|----------|-------------|
| `team` | no | ncaa.com seo slug of the team whose local folder to search first |
| `iso`  | no | ISO date (`YYYY-MM-DD`) of the game. With `asof`, a game dated after it returns 404 |
| `runs` | no | Host team's run total — disambiguates doubleheaders |
| `opp`  | no | Opponent ncaa.com seo slug (used for the logo) |

When `team` + `iso` are provided the endpoint first attempts `local_data.game()` (locally-saved stats.ncaa.org data); if nothing is saved it falls back to `build_game()` (live henrygd API).

### Response shape

```jsonc
{
  "venue": "Davenport Field",
  "location": "Charlottesville, VA",
  "attendance": 3412,
  "gameDate": "04/22/2026",
  "time": "6:30 PM ET",
  "weather": null,
  "duration": "Final",
  "info": { /* raw info block from boxscore */ },
  "decisions": { /* pitcher decisions */ },
  "homeTeam": "virginia",
  "awayTeam": "liberty",
  "winner": "home",               // "home" | "away" | null (tie)
  "line": {
    "away": {
      "name": "Liberty", "id": "liberty",
      "r": 3, "h": 8, "e": 1,
      "innings": [0,0,2,1,0,0,0,0,0]
    },
    "home": { /* same shape */ }
  },
  "batters": {
    "away": [ /* per-batter rows */ ],
    "home": [ /* per-batter rows */ ]
  },
  "pitchers": {
    "away": [ /* per-pitcher rows */ ],
    "home": [ /* per-pitcher rows */ ]
  },

  // Flat play-by-play list (from play_by_play.json). Present on both
  // local and live-API paths. Each entry has { text, score }.
  "plays": [
    { "text": "Marsh,Tanner flied out ...", "score": { "away": 0, "home": 0 } }
  ],

  // Grouped play-by-play (from play_by_play_detailed.json).
  // Only populated on the local path when the detailed file is saved.
  // Empty array ([]) on the live-API path or when the file is absent.
  "pbp": [
    {
      "half": "top",                    // "top" | "bottom"
      "inning": 1,                      // integer inning number
      "label": "TOP 1ST",               // ready-to-render header ("TOP"/"BOT" + ordinal)
      "battingSide": "away",            // "away" for top, "home" for bottom
      "scoreAfter": { "away": 0, "home": 1 },  // running score after this half ends
      "runs": 1,                        // total runs scored by the batting side this half
      "plays": [
        {
          "batter": "Tanner Marsh",
          "pitcher": "Max Stammel",
          "outcome": "Flyout",          // outcome label; "—" when absent
          "count": "0-1",               // ball-strike count; "" when absent
          "pitches": "K",               // pitch sequence string; "" when absent
          "outsAfter": 1,               // outs after the play (0–3)
          "bases": {                    // base occupancy AFTER the play
            "1B": false,
            "2B": false,
            "3B": false
          },
          "runs": 0,                    // runs scored on this play (len of runs_scored)
          "rbi": false,                 // whether an RBI was credited
          "score": { "away": 0, "home": 0 },  // running score AFTER the play
          "description": "Marsh,Tanner flied out down the right field line ..."
        }
      ]
    }
  ],

  "notes": [],
  "_source": "local"  // "local" when served from Data/2026/ folder, absent on live-API path
}
```

### Notes

- `pbp` groups are emitted in source order (same order as `play_by_play_detailed.json`).
- `pbp[].scoreAfter` is taken from the last play's `score` field in that half.
- `pbp[].runs` is the sum of per-play `runs` (each play's `len(runs_scored)`).
- A missing, iCloud-offloaded, or corrupt `play_by_play_detailed.json` yields `"pbp": []` — it does NOT cause the game to be dropped from the response.
- The live-API path (`gamedetail.build_game`) returns `"plays": []` and no `pbp` key.

---

---

## `GET /api/team/<seo>/splits`

Team situational batting AND pitching splits, aggregated from every saved
game's `play_by_play_detailed.json`. Returns raw per-(base-state, outs) counts
per batter (`players`) and per pitcher (`pitchers`); the frontend sums cells
and computes rate stats without a refetch.

### Path parameters

| Param | Description |
|-------|-------------|
| `seo` | ncaa.com team slug (e.g. `texas`, `vanderbilt`) |

404 when `seo` is not a known team or the team has no saved folder.

### Response shape

```jsonc
{
  "seo": "texas",
  "name": "Texas",
  "color": "#BF5700",       // team accent from colors.py
  "ink": "#FFFFFF",
  "gamesTotal": 61,         // games iterated (have boxscore + players + plays files)
  "gamesWithPbp": 61,       // subset that had a usable play_by_play_detailed.json
  "season": {
    "ab": 2019, "h": 595, "bb": 381, "tb": 1036,
    "ops": 0.919792          // OBP=(H+BB)/(AB+BB) + SLG=TB/AB (simplified, matches design.md)
  },
  "players": [
    {
      "num": "8",            // jersey number string; "" for players not in stats/batting.json
      "name": "Carson Tinney",
      "pos": "C",            // "" for unknown players
      "cells": {
        // Only non-empty cells are present; missing cell = all zeros
        // Key: "<mask>-<outs>"  mask: bit0=1B, bit1=2B, bit2=3B  outs: "0"/"1"/"2"
        "1-2": { "PA": 19, "AB": 16, "H": 7, "1B": 3, "2B": 1, "3B": 0, "HR": 3,
                 "RBI": 6, "BB": 2, "SO": 4, "HBP": 1, "IBB": 0, "ROE": 0, "FC": 1,
                 "GB": 4, "FB": 2, "LD": 1, "PU": 0, "KS": 3, "KL": 1,
                 "SF": 0, "SH": 0, "SB": 2, "CS": 1 }
        // ... up to 8 masks × 3 outs = 24 possible cell keys
      }
    }
  ],
  "pitchers": [
    {
      "num": "9",            // jersey number string; "" for players not in stats/pitching.json
      "name": "William Schmidt",
      "pos": "P",            // "" for unknown players
      "cells": {
        // Only non-empty cells are present; missing cell = all zeros
        // Key: "<mask>-<outs>"  mask: bit0=1B, bit1=2B, bit2=3B  outs: "0"/"1"/"2"
        "0-0": { "bf": 68, "ab": 57, "h": 13, "bb": 9, "so": 22, "hr": 3, "outs": 43, "r": 12,
                 "1B": 8, "2B": 3, "3B": 1, "gb": 15, "fb": 12, "ld": 3, "pu": 2, "hbp": 2,
                 "b": 120, "s": 165, "wp": 1, "bk": 0, "er": 9 }
        // ... up to 8 masks × 3 outs = 24 possible cell keys
      }
    }
  ]
}
```

`pitchers` is built from the plays `players` discards — every detailed play
where the batting side is the opponent (our team pitching) — grouped by the
play's `pitcher` field and resolved against `stats/pitching.json`. Cell fields
are counts only, no rate stats: `bf` (batters faced), `ab` (at-bats against),
`h` (hits allowed), `bb` (walks allowed), `so` (strikeouts), `hr` (home runs
allowed), `outs` (`outs_after - outs_before`, clamped ≥ 0), `r` (runs allowed
on plays while this pitcher was pitching in that base/out state, `len(runs_scored)`
per play — can exceed `bf` for a cell since one play can score multiple
runners). The frontend derives `IP = outs/3`, `WHIP = (h+bb)/IP`, opponent
`AVG = h/ab`.

### Additional pitching-cell fields (opposing-batter breakdown)

All additive to the fields above — none of them change `bf`/`ab`/`h`/`bb`/`so`/
`hr`/`outs`/`r`.

| Field | Meaning | Reliability (vs `stats/pitching.json` season totals) |
|-------|---------|--------------------------------------------------------|
| `1B`/`2B`/`3B` | Opposing-batter hit type (subset of `h`); `Home run` only bumps `h`/`hr` | **Reliable** — 90-100% of season `2b_a`/`3b_a` across teams checked |
| `gb`/`fb`/`ld`/`pu` | Opposing-batter batted-ball type, **outs only** (subset of `ab`) — same classification and same caveat as the batting side's `GB`/`FB`/`LD`/`PU` | **Moderate, expected undercount** — `ld` 92-98%, `gb`/`fb`/`pu` 65-80% of the season `gb`/`fb`/`ld`/`pu` totals (which count every batted ball, not just outs) |
| `hbp` | Hit-by-pitch allowed (`bf`-only, no `ab`/`h`/`bb`) | **Reliable** — within ~1-6% of season `hb` (note: season field is `hb`, not `hbp`) |
| `b` | Balls thrown, from the play's `pitches` sequence (count of `'B'`) | **Reliable** — ~99% of season `balls` |
| `s` | Strikes thrown: count of `'K'+'F'+'S'` in `pitches`, **+1 for any contact PA** (hit or batted-ball out other than Catcher interference — the ball put in play isn't a sequence letter) | **Reliable** — ~99% of season `strikes` |
| `wp`/`bk` | Wild pitch / balk, credited to the pitcher on the mound at the time; **not a PA**. Detected by *presence* of `"wild pitch"`/`"balk"` in the description (not an occurrence count — one event can be narrated once per runner it moves) | **Reliable** — matched season `wp`/`bk` totals almost exactly (e.g. 39/39, 4/4) across teams checked |
| `r`/`er` | Runs / earned runs allowed. Both are accumulated in a single all-plays block that runs BEFORE the PA skip filter (same pattern as `wp`/`bk`), so a run scoring on a non-PA play (Wild pitch / Passed ball / Stolen base / Balk / error-advance) is still counted — the old PA-path accumulation was removed so nothing double-counts. `er += max(0, runs_scored_count − "unearned" mentions in the description)`; `r += runs_scored_count` | **Reliable — upstream fix landed.** The previous ~30-70% undercount was a data-completeness gap in `scripts/pull_game_stats.py`'s `build_detailed()`: it silently dropped a run whenever the scoring runner's surname couldn't be matched to a tracked base. Fixed at the source — each play's runner-clause `runs_scored` list is now reconciled against the authoritative running `score` field so its *length* always matches the real score delta (padding with `None` placeholders when the specific scorer can't be identified). All 1,934 saved SEC+ACC games were re-derived. Verified per-game (summed `runs_scored` now matches final box-score totals exactly, e.g. 771/771 for Duke, 0 mismatched games) and against the season aggregate: Oklahoma 345/348 `r` (99%) / 306/308 `er` (99%), LSU 362/363 `r` (100%) / 316/317 `er` (100%), Duke 386/423 `r` (91%) / 333/361 `er` (92%, likely pitcher-attribution edge cases, not a run-tagging gap). `er` still separately depends on scorers consistently writing "unearned" in the text — a smaller residual than before, but still scorer-dependent. |

Pitch-count detail: `pitches` looks like `"BKKFK"` (`B`=ball, `K`=called
strike, `F`=foul, `S`=swinging strike). Total pitches (`PT`) is intentionally
not stored, only the `b`/`s` breakdown.

### Cell key encoding

Base-state mask is the bitwise OR of: 1B present→1, 2B present→2, 3B present→4.
Common values: `0`=empty, `1`=1st, `2`=2nd, `4`=3rd, `3`=1st&2nd, `6`=2nd&3rd (RISP),
`7`=loaded. Outs is `"0"`, `"1"`, or `"2"`.

### Outcome → cell mapping

| Outcome | PA | AB | H | XBH | BB | SO | HBP | IBB | ROE | FC | GB/FB/LD/PU | KS/KL | SF/SH | SB/CS |
|---------|----|----|---|-----|----|----|-----|-----|-----|----|-------------|-------|-------|-------|
| Single / Double / Triple / Home run | +1 | +1 | +1 | +1 | — | — | — | — | — | — | — | — | — | — |
| Walk | +1 | — | — | — | +1 | — | — | — | — | — | — | — | — | — |
| Intentional walk | +1 | — | — | — | +1 | — | — | +1 | — | — | — | — | — | — |
| Hit by pitch | +1 | — | — | — | — | — | +1 | — | — | — | — | — | — | — |
| Strikeout (swinging) | +1 | +1 | — | — | — | +1 | — | — | — | — | — | KS +1 | — | — |
| Strikeout (looking) | +1 | +1 | — | — | — | +1 | — | — | — | — | — | KL +1 | — | — |
| Strikeout (generic, untyped) | +1 | +1 | — | — | — | +1 | — | — | — | — | — | — | — | — |
| Groundout / GIDP | +1 | +1 | — | — | — | — | — | — | — | — | GB +1 | — | — | — |
| Flyout | +1 | +1 | — | — | — | — | — | — | — | — | FB +1 | — | — | — |
| Lineout | +1 | +1 | — | — | — | — | — | — | — | — | LD +1 | — | — | — |
| Pop out / Infield fly | +1 | +1 | — | — | — | — | — | — | — | — | PU +1 | — | — | — |
| Foul out | +1 | +1 | — | — | — | — | — | — | — | — | — (ambiguous, uncounted) | — | — | — |
| Reached on error | +1 | +1 | — | — | — | — | — | — | +1 | — | — | — | — | — |
| Fielder's choice | +1 | +1 | — | — | — | — | — | — | — | +1 | — | — | — | — |
| Catcher interference | +1 | +1 | — | — | — | — | — | — | — | — | — | — | — | — |
| `—` / Wild pitch / Passed ball / Baserunning (incl. most sac fly/bunt plays — see below) | skipped | | | | | | | | | | | | | |
| Stolen base / Caught stealing (own team on base) | not a PA — credited to the **runner's** cell, not the batter's | | | | | | | | | | | | | SB or CS +1 |

`SF`/`SH` are **not** a separate row above — they never change which row a play
lands in. A sacrifice fly is still counted as a normal `Flyout` (AB+1, FB+1)
and a sacrifice bunt as a normal `Groundout` (AB+1, GB+1), exactly like any
other team's at-bat. `SF`/`SH` are a side-counter layered on top, additively,
whenever the description also says `"sacrifice fly"` / `"sacrifice bunt"` (see
below) — they do not subtract from or otherwise touch `AB`/`GB`/`FB`/`LD`/`PU`/`PA`.

`RBI` = `len(runs_scored)` per play. **Reliable** since the `runs_scored`
run-tagging fix in `scripts/pull_game_stats.py`'s `build_detailed()` (see the
pitching `r`/`er` reliability row above — the same upstream gap undercounted
both, since both simply read `len(play["runs_scored"])`). After re-deriving
all saved games, situational team `RBI` lands within ~2-8% of the season
`stats/batting.json` team `rbi` total for every team checked (e.g. Oklahoma
418/427, LSU 409/400, Duke 311/334). `HBP`/`IBB`/`ROE`/`FC` are purely additive
breakdowns — each is a subset of an existing count (`IBB` ⊆ `BB`, `ROE`/`FC` ⊆ `AB`,
`HBP` ⊆ `PA`) and does not change any pre-existing field's value.

`GB`/`FB`/`LD`/`PU` count **batted-ball outs only** (Groundout/GIDP, Flyout,
Lineout, Pop out/Infield fly respectively) — the PBP source only tags a
batted-ball type on outs, not on hits, so these four are an outs-only
breakdown of `AB`, not a full batted-ball-type profile of every ball in play.

`KS` (swinging strikeout) / `KL` (looking / backward-K strikeout) are a subset
of `SO`: `Strikeout (swinging)`→KS, `Strikeout (looking)`→KL, a generic
untyped `"Strikeout"` outcome increments `SO` only. So `KS + KL <= SO`.

`SF` (sacrifice fly) / `SH` (sacrifice bunt) are **tracked in the payload but
not surfaced in the frontend**, and unlike every other field here they are a
pure side-counter: they never change `AB`/`GB`/`FB`/`LD`/`PU`/`PA` — a
sacrifice fly/bunt still counts as a normal `Flyout`/`Groundout` in every
other field, so `AB` accounting stays uniform regardless of whether a play
happened to be a sacrifice. `SF`/`SH` are detected from the play's free-text
description (`"sacrifice fly"` → SF+1; `"sacrifice bunt"` minus `"fielder's
choice"` → SH+1), added on top, only for plays that already resolved through
the normal batter path above — there is no special-case recovery for plays
with a blank `batter` field. **These two fields badly undercount and must not
be treated as a real per-team total**: most sac fly/bunt plays classify
upstream as outcome "—"/"Baserunning" with `batter` blank (the builder's
runner-event heuristic swallows the whole play before assigning a batter), so
they never reach the counting logic at all — `SF`/`SH` only catch the rare sac
play that happens to land on a clean `Flyout`/`Groundout` outcome with a
resolvable batter, which is often close to zero. This is a data-source
limitation (some official scorers narrate the "sacrifice" qualifier
consistently, others rarely or never do, even though the season aggregate
`stats/batting.json` `sf`/`sh` still counts the play correctly) — not a bug in
`team_splits`.

`SB` (stolen base) / `CS` (caught stealing) credit the **runner**, parsed from
the description (`"<runner> stole second/third/home"` → SB; `"<runner> out at
<base> ..., caught stealing"` / `"<runner> out caught stealing at <base>,
..."` → CS), independent of the play's own `outcome` — a steal/CS can be a
standalone play or embedded alongside a different batter's own PA in the same
saved play (e.g. a strikeout with a runner caught stealing on the same pitch).
Not a PA: doesn't touch `PA`/`AB`/anything else, so a cell can have `SB`/`CS` >
0 with `PA == 0`. Unlike SF/SH, this narration is consistent across teams —
situational SB/CS totals land within a handful of counts of the season
`stats/batting.json` `sb`/`cs` totals for every team spot-checked.

### Notes

- Memoized under key `splits:<seo>:<effective date>` with a 21 600 s (6 h) TTL (one
  payload covering both `players` and `pitchers`). Accepts `asof`: only games on/before it
  are read, and the roster/OPS baseline is summed from per-game files rather than
  `stats/*.json` when `asof` precedes the team's last saved game.
- `gamesWithPbp == 0` → `players: []` and `pitchers: []` (no PBP saved yet).
- Players appearing in PBP but not in `stats/batting.json` (or pitchers not in
  `stats/pitching.json`) are dropped, not invented — never surface with blank identity.

---

## Other endpoints

See `app.py` for the full route list. Key routes:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bootstrap` | Teams, schedules, season phase — populates `window` globals |
| `GET` | `/api/team/<seo>` | Team stats page (batting + pitching) |
| `GET` | `/api/team/<seo>/splits` | Situational batting splits (see above) |
| `GET` | `/api/game/<id>` | Single-game detail (see above) |
| `GET` | `/api/bracket/ncaa` | Full 64-team NCAA bracket |
| `GET` | `/api/bracket/conf/<league>` | Conference tournament bracket |
| `GET` | `/api/player/<seo>/<name>` | Per-player season history |
| `GET` | `/api/compare` | Side-by-side team or player comparison |
