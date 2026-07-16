# Data shapes

## Game-detail play-by-play (`/api/game/<id>` → `detail.pbp`)

The game view's play-by-play is sourced from each saved game's
`play_by_play_detailed.json` (the richer per-play breakdown), grouped by
half-inning. The flat `detail.plays` array (from `play_by_play.json`) is kept as
a fallback for the live-API path, which has no detailed data.

`local_data.game(...)` adds a `pbp` field alongside the existing `plays`:

```jsonc
"pbp": [
  {
    "half": "top",              // "top" | "bottom"
    "inning": 1,                 // integer inning number
    "label": "TOP 1ST",          // ready-to-render header
    "battingSide": "away",       // "away" in the top, "home" in the bottom
    "scoreAfter": { "away": 0, "home": 1 },  // running score at end of this half
    "runs": 1,                   // runs scored by the batting side this half
    "plays": [
      {
        "batter": "Tanner Marsh",
        "pitcher": "Max Stammel",
        "outcome": "Flyout",     // parsed label; "—" when unknown
        "count": "0-1",          // ball-strike count ("" if absent)
        "pitches": "K",          // pitch sequence ("" if absent)
        "outsAfter": 1,          // outs after the play (0–3)
        "bases": { "1B": false, "2B": false, "3B": false }, // occupancy AFTER the play
        "runs": 0,               // runs scored on this play (len of runs_scored)
        "rbi": false,            // play was credited an RBI
        "score": { "away": 0, "home": 0 },  // running score AFTER the play
        "description": "Marsh,Tanner flied out down the right field line ..."
      }
    ]
  }
]
```

### Source mapping (`play_by_play_detailed.json` → `pbp`)

Each detailed play has: `inning` (`"Top 1"`), `pitcher`, `batter`, `outcome`,
`count`, `pitches`, `rbi`, `runs_scored` (list), `outs_before`/`outs_after`,
`runners_before`/`runners_after` (`{"1B","2B","3B"}` → name or `null`),
`score` (`{away, home}`), `description`.

- `inning` `"Top 1"` → split into `half` (`"top"`/`"bottom"`, lowercased) and
  `inning` (int). `label` = `"TOP"`/`"BOT"` + ` ` + `ordinal(inning)` (1→`1ST`,
  2→`2ND`, 3→`3RD`, 4+→`NTH`) — e.g. `TOP 1ST`, `BOT 9TH`.
- `battingSide` = `"away"` for top halves, `"home"` for bottom.
- `bases[B]` = `runners_after[B] is not None` (occupancy, not the runner name).
- play-level `runs` = `len(runs_scored)`.
- half-level `scoreAfter` / `runs` come from the last play in the half
  (`score` after the half's final play; `runs` summed over the half's plays).
- Plays keep their source order; halves are emitted in source order.

### Robustness

- `play_by_play_detailed.json` is loaded **optionally** — a missing/corrupt/
  iCloud-offloaded detailed file must NOT drop the game (the existing required
  set stays box + players + simple plays). When it's absent, `pbp` is `[]` and
  the frontend falls back to the flat `plays` list.
- The live-API path (`gamedetail.build_game`) continues to return `plays: []`
  and no `pbp`; the frontend handles both.
- `runners_before`/`runners_after` are re-derived locally from each play's raw
  description text (there's no structured runner data from stats.ncaa.org), by
  walking the `3a`-separated runner sub-clauses and matching each one back to
  the occupied base whose runner surname matches. Sub-clause runner names are
  in `"Last, F."` form (e.g. `"Harris, Das. advanced to second"`); the surname
  match anchors on the full leading name text (via `_last()`, which already
  strips to the part before the comma) rather than assuming the name is a bare
  single token, so forced advances on walks/HBP/errors are tracked correctly,
  not just advances the batter causes directly (extra-base hits). Stolen bases
  ("stole second/third/home"), caught-stealing, and pickoffs are tracked the
  same way (reusing the advanced-to-base/scored/out branches), so base state
  after a steal attempt is now also correct.

### Frontend contract (`static/game.jsx`)

- If `detail.pbp?.length`, render the inning-grouped feed: collapsible
  half-inning headers (default expanded) showing `label` + `scoreAfter` per
  team, and each play as batter · outcome · `(count pitches)` · base/outs state
  · running score, with an RBI/runs marker on scoring plays.
- Else fall back to the current flat `detail.plays` list (`p.text` + `p.score`).

## Team situational splits (`GET /api/team/<seo>/splits`)

Real situational batting splits for a team's own batters, aggregated from every
saved game's `play_by_play_detailed.json`. The endpoint returns **raw counts per
(base-state, outs) cell per player**; the frontend sums the requested cells and
computes the rate stats (so toggling the diamond/outs is instant, no refetch).

Base-state **mask**: bit0 = runner on 1B, bit1 = 2B, bit2 = 3B (so 0 = empty,
6 = 2nd & 3rd, 7 = loaded). **outs**: `"0" | "1" | "2"`. A cell key is
`"<mask>-<outs>"`, e.g. `"6-1"` = RISP (2nd&3rd) with 1 out.

```jsonc
{
  "seo": "texas",
  "name": "Texas",
  "color": "#BF5700",            // team accent (colors.py), for the diamond/leader
  "ink": "#FFFFFF",
  "gamesTotal": 61,              // games in the saved season
  "gamesWithPbp": 61,            // games that had usable detailed PBP (coverage)
  "season": { "ab": 2100, "h": 640, "bb": 250, "tb": 1010, "ops": 0.812 },
  "players": [
    {
      "num": 43, "name": "Aiden Robbins", "pos": "CF",
      "cells": {
        // only non-empty cells need be present; missing cell = all zeros
        "1-2": { "PA": 18, "AB": 15, "H": 5, "1B": 3, "2B": 1, "3B": 0, "HR": 1, "RBI": 4, "BB": 3, "SO": 4,
                 "HBP": 1, "IBB": 0, "ROE": 0, "FC": 1, "GB": 3, "FB": 2, "LD": 1, "PU": 0, "KS": 3, "KL": 1,
                 "SF": 0, "SH": 0, "SB": 2, "CS": 1 },
        "6-1": { "PA": 9,  "AB": 7,  "H": 3, "1B": 2, "2B": 0, "3B": 0, "HR": 1, "RBI": 5, "BB": 2, "SO": 1,
                 "HBP": 0, "IBB": 1, "ROE": 1, "FC": 0, "GB": 1, "FB": 1, "LD": 0, "PU": 0, "KS": 1, "KL": 0,
                 "SF": 1, "SH": 0, "SB": 0, "CS": 0 } // the FB here includes a sac fly (SF is additive, not exclusive)
        // ... up to 8 masks × 3 outs = 24 possible cells
      }
    }
    // ... one entry per batter on the team
  ],
  "pitchers": [
    {
      "num": 9, "name": "William Schmidt", "pos": "P",
      "cells": {
        // only non-empty cells need be present; missing cell = all zeros
        "0-0": { "bf": 68, "ab": 57, "h": 13, "bb": 9, "so": 22, "hr": 3, "outs": 43, "r": 12,
                 "1B": 8, "2B": 3, "3B": 1, "gb": 15, "fb": 12, "ld": 3, "pu": 2, "hbp": 2,
                 "b": 120, "s": 165, "wp": 1, "bk": 0, "er": 9 },
        "6-1": { "bf": 4,  "ab": 3,  "h": 1,  "bb": 1, "so": 0,  "hr": 0, "outs": 2, "r": 2,
                 "1B": 1, "2B": 0, "3B": 0, "gb": 1, "fb": 0, "ld": 0, "pu": 0, "hbp": 0,
                 "b": 9,  "s": 11, "wp": 0, "bk": 0, "er": 2 }
        // ... up to 8 masks × 3 outs = 24 possible cells
      }
    }
    // ... one entry per pitcher on the team
  ]
}
```

### Pitching splits (`pitchers`)

Parallel to `players`, but aggregated from the plays `players` **discards** — i.e.
every detailed play where the batting side is the *opponent* (our team is
pitching), grouped by the play's `pitcher` field instead of `batter`. Uses the
same helpers as batting: `_splits_last_key` / `_splits_resolve` / `by_last`-style
fuzzy surname matching (built from `stats/pitching.json` instead of
`stats/batting.json`), the same base-mask/outs derivation, and the same
`"<mask>-<outs>"` cell key.

- **Roster seed**: `stats/pitching.json` `players` (same identity fields as the
  batting roster: `num`/`name`/`pos`). A play whose `pitcher` string doesn't
  resolve to a name on this roster is dropped (never invents a player), exactly
  like the batting side drops unresolvable `batter` values.
- **Cell fields** (integer counts only — no rate stats, mirroring `players`):
  - `bf` — batters faced (every counted PA against, same outcome vocabulary as
    batting's `PA`: hits + walks + HBP + strikeouts + all AB-out types).
  - `ab` — at-bats against (hit outcomes + AB-out outcomes, i.e. everything that
    counts an AB on the batting side).
  - `h` — hits allowed (`Single`/`Double`/`Triple`/`Home run`).
  - `bb` — walks allowed (`Walk`/`Intentional walk`).
  - `so` — strikeouts (`outcome` starts with `Strikeout`).
  - `hr` — home runs allowed (`outcome == "Home run"`).
  - `outs` — outs recorded on that play, `max(0, outs_after - outs_before)`.
  - `r` — runs allowed on plays while this pitcher was on the mound in this
    base/out state: `len(play["runs_scored"])`, same source field as batting's
    `RBI` (a play with runners on can score more than one, so `r` can exceed
    `bf` for a cell, e.g. a bases-loaded double or home run).
  - Hit-by-pitch counts toward `bf` only (no `ab`/`h`/`bb`), same as batting —
    and now also toward `hbp` (see below).
  - `1B`/`2B`/`3B` (opposing-batter hit type, subset of `h`): `Single`→1B,
    `Double`→2B, `Triple`→3B (a `Home run` only increments `h`/`ab`/`hr`, not
    a new field, exactly as before). **Reliable** — spot-checked `2B`/`3B`
    against the season `stats/pitching.json` `2b_a`/`3b_a` totals and landed
    at 90-100% across every team checked.
  - `gb`/`fb`/`ld`/`pu` (opposing-batter batted-ball type, subset of `ab`):
    same outs-only classification as the batting side's `GB`/`FB`/`LD`/`PU`
    — `Groundout`/`Grounded into double play`→gb, `Flyout`→fb, `Lineout`→ld,
    `Pop out`/`Infield fly`→pu, `Foul out` uncounted. **Same caveat as
    batting**: these count outs only (hits carry no ball-type tag), so
    `gb+fb+ld+pu` undercounts the pitcher's true ground/fly/line/pop rate
    allowed. Spot-checked against the season `stats/pitching.json`
    `gb`/`fb`/`ld`/`pu` totals (which ARE the full official per-batted-ball
    total, not outs-only): `ld` lands close (92-98%), `gb`/`fb`/`pu` land
    noticeably lower (65-80%) — worse than the batting side's equivalent gap,
    consistent with the same structural limitation (only classified outs
    count; balls in play that became hits, errors, or fielder's choices
    aren't attributed a type here even though the official stat counts them).
  - `hbp` (hit-by-pitch allowed, a `bf`-only event, no `ab`/`h`/`bb`).
    **Reliable** — lands within ~1-6% of the season `stats/pitching.json`
    `hb` field (note the season field is named `hb`, not `hbp`) for every
    team checked.
  - `b`/`s` — pitch-count breakdown parsed from the play's `pitches` sequence
    string (e.g. `"BKKFK"`; `B`=ball, `K`/`F`/`S`=called/foul/swinging
    strike). `b` = count of `'B'` in the sequence. `s` = count of
    `'K'+'F'+'S'` in the sequence, **plus +1 for any PA that ended in contact**
    (a hit, or a batted-ball out — `Groundout`/`Flyout`/`Lineout`/`Pop
    out`/`Foul out`/`Infield fly`/`Grounded into double play`/`Reached on
    error`/`Fielder's choice`, but NOT `Catcher interference`, which isn't a
    batted ball) — the ball put in play isn't itself a letter in the pitch
    sequence, so the contact pitch needs to be added back in as a strike.
    Total pitches (`PT`) is not stored — only `b`/`s`. **Reliable** — `b`/`s`
    landed at 99% of the season `stats/pitching.json` `balls`/`strikes`
    totals for every team checked.
  - `wp`/`bk` (wild pitch / balk) — **not a PA**, credited to the CURRENT
    PITCHER at the time, from the description text (presence, not count: `1
    if "wild pitch" in description else 0`, same for `"balk"`) rather than
    the play's own `outcome` — a wild pitch/balk is very often embedded
    alongside an unrelated batter's own PA in the same saved play (a
    strikeout/walk with a runner advancing on the same pitch), so `outcome`
    alone would miss most of them. Presence rather than an occurrence count
    is deliberate: a single wild pitch/balk that moves two runners gets
    narrated once per runner ("X advanced to second on a wild pitch Y
    advanced to third on a wild pitch.") — that's one physical event, not
    two; counting occurrences over-counted by ~25% in testing. **Reliable**
    — presence-based counting matched the season `stats/pitching.json`
    `wp`/`bk` totals almost exactly (39/39, 4/4 for one team; exact or
    near-exact for others checked).
  - `r`/`er` (runs / earned runs allowed) — credited to the CURRENT PITCHER
    on **every** play with a scored run while we're pitching, PA or not (a
    dedicated block runs before the PA skip filter, the same pattern used for
    `wp`/`bk`, specifically so a run scoring on a non-PA play — Wild pitch,
    Passed ball, Stolen base, Balk, a runner advancing on an error — still
    gets counted). This is the *only* place `r`/`er` are accumulated now (the
    old PA-path accumulation was removed) so a play is never double-counted.
    `er += max(0, runs_scored_count − "unearned" mentions in the play's
    description)`; `r += runs_scored_count` unconditionally.
    **Reliable, upstream fix landed** — the earlier ~30-70% undercount was
    traced to `scripts/pull_game_stats.py`'s `build_detailed()` silently
    dropping a run whenever the scoring runner's surname couldn't be matched
    to a tracked base (roughly 30% of real runs, in ~4 of every 10 games).
    Fixed at the source: after building each play's runner-clause-based
    `runs_scored` list, `build_detailed()` now reconciles its *length*
    against the authoritative running `score` field for that play (padding
    with `None` placeholders when a run's specific scorer couldn't be
    identified, trimming in the rare over-count case), so the *count* of runs
    on a play always matches the real score delta even when not every scorer
    is individually named. All 1,934 saved SEC+ACC games were re-derived with
    this fix. Verified per-game: summing `runs_scored` across every play in a
    team's saved games now matches the final box-score run totals exactly
    (e.g. 771/771 combined runs across Duke's 57 games, 0 mismatched games).
    Verified end-to-end against the season aggregate
    (`stats/pitching.json` `r`/`er`): Oklahoma 345/348 `r` (99%) and 306/308
    `er` (99%), LSU 362/363 `r` (100%) and 316/317 `er` (100%), Duke 386/423
    `r` (91%) and 333/361 `er` (92%) — Duke's slightly wider residual gap is
    most likely leftover pitcher-attribution edge cases (e.g. a mid-plate-
    appearance pitching change) rather than a run-tagging gap, since its
    per-game run totals already match exactly. `er` still separately inherits
    a **scorer-dependent "unearned"-text-matching limitation** (some official
    scorers don't consistently write "unearned"), but with the run-count now
    correct this is a much smaller residual than before.
- The frontend derives rate stats from these counts: `IP = outs / 3`,
  `WHIP = (h + bb) / IP`, opponent `AVG = h / ab`. The endpoint does not compute
  or store any rate stat, exactly like `players`.
- Same coverage caveats as batting: only games with usable detailed PBP
  contribute (see `gamesWithPbp`); a team's pitching totals here can undercount
  the season totals in `stats/pitching.json` when some games lack saved
  play-by-play. `r` (and now `er`) additionally undercount even with full PBP
  coverage — see above.

### How a play maps to a cell (in `local_data.team_splits`)

For each saved game: `_host_side(data, name)` → which side ("home"/"away") is our
team. For each detailed play, the batting side is `"away"` if
`play["inning"]` starts with "Top", else `"home"`. Plays where the batting side
is our team feed `players` (batting); plays where the batting side is the
**opponent** feed `pitchers` (our team is pitching) — every play is routed to
exactly one of the two, so a single pass over each game's plays builds both
lists. For the batting (`players`) path:

- **mask** from `runners_before`: `(1B?1:0) | (2B?2:0) | (3B?4:0)` (value is a
  name when occupied, `null` when empty).
- **outs** from `outs_before` (`"0"/"1"/"2"`; skip a play with outs ≥ 3 or missing).
- **batter** identity: match the play's `batter` to a player on the team's
  **batting roster** (`stats/batting.json`, the same set the player-stats view
  shows). PBP names vary in form (`Tinney`, `Pack Jr., Anthony`, `Galloway, R.`,
  `Duplantier J`), so try multiple (surname, first-initial) readings against the
  roster. **Drop any play whose batter doesn't match a roster surname** — do NOT
  invent a fallback player from the raw PBP string (those are name fragments,
  leaked descriptions, or opponents). This keeps the Situational player list a
  subset of the player-stats batters.
- **outcome → counts** (one PA per non-skipped play). Vocabulary from
  `scripts/pull_game_stats.py` `_OUTCOMES`:
  - `Single`→H,1B,AB · `Double`→H,2B,AB · `Triple`→H,3B,AB · `Home run`→H,HR,AB
  - `Walk`→BB (not AB) · `Intentional walk`→BB,IBB (not AB, IBB is a subset of BB)
  - `Hit by pitch`→HBP (neither AB nor BB, PA only)
  - `Strikeout*`→SO,AB · all out types (`Groundout`,`Flyout`,`Lineout`,`Pop out`,
    `Foul out`,`Infield fly`,`Grounded into double play`)→AB
  - `Reached on error`→AB,ROE (no H) · `Fielder's choice`→AB,FC (no H) ·
    `Catcher interference`→AB (no H, not counted in ROE/FC)
  - `RBI` count: use the play's `rbi`/`runs_scored` (count of `runs_scored`).
    **Reliable** since the `runs_scored`-tagging fix in
    `scripts/pull_game_stats.py`'s `build_detailed()` (see the pitching `r`/
    `er` note below) — the same upstream gap that undercounted pitching `r`
    also undercounted `RBI` (both read `len(play["runs_scored"])`). After
    re-deriving all saved games, situational team `RBI` lands within ~2-8% of
    the season `stats/batting.json` team `rbi` total across every team
    checked (e.g. Oklahoma 418/427, LSU 409/400, Duke 311/334) — a big
    improvement from the undocumented undercount that existed before this
    fix.
  - **Cell fields** (integer counts, additive to the base `PA`/`AB`/`H`/`1B`/`2B`/
    `3B`/`HR`/`RBI`/`BB`/`SO` set above): `HBP` (hit-by-pitches, subset of PA, not
    AB/BB), `IBB` (intentional walks, subset of BB), `ROE` (reached on error,
    subset of AB), `FC` (fielder's choice, subset of AB). All four are purely
    additive breakdowns of existing counts — summing them does not change any
    pre-existing field's value.
  - `GB`/`FB`/`LD`/`PU` (batted-ball type, subset of AB): counted **only** from
    batted-ball-out outcomes, since the PBP source tags a batted-ball type on
    outs but not on hits — `Groundout`/`Grounded into double play`→GB,
    `Flyout`→FB, `Lineout`→LD, `Pop out`/`Infield fly`→PU. `Foul out` is
    ambiguous and left uncounted in all four. These four count outs only (hits
    of any type are excluded), so `GB+FB+LD+PU` undercounts the batter's true
    ground/fly/line/pop rate on balls in play — it's an outs-only breakdown, not
    a full batted-ball profile.
  - `KS`/`KL` (strikeout type, subset of SO): `Strikeout (swinging)`→KS,
    `Strikeout (looking)`→KL. A generic untyped `"Strikeout"` outcome still
    increments `SO` but neither `KS` nor `KL`, so `KS + KL <= SO` (equal unless
    some strikeouts in the source data have no swinging/looking type recorded).
  - `SF`/`SH` (sacrifice fly / sacrifice bunt): **tracked but excluded from the
    frontend** and, unlike every other cell field, **purely a side-counter —
    it does NOT affect `AB`/`GB`/`FB`/`LD`/`PU`/`PA` at all**. A sac fly is
    still counted as a normal `Flyout` (AB+FB) and a sac bunt as a normal
    `Groundout` (AB+GB) in the fields above, exactly like any other team's at
    -bat, so `AB`/`GB`/`FB`/`LD`/`PU` stay uniform across every play
    regardless of whether it happened to be a sacrifice. `SF`/`SH` are then
    layered on top, additively, from the play's free-text `description`:
    `"sacrifice fly"` in the description → SF+1; `"sacrifice bunt"` (and NOT
    `"fielder's choice"`, since that means the batter reached base safely, not
    a true sacrifice) → SH+1 — but only for plays that already made it through
    the normal batter-resolution path above (no special-case recovery for
    plays with a blank `batter` field). **Coverage caveat — SF/SH badly
    undercount and must not be treated as a real per-team total**: most sac
    fly/bunt plays get misclassified upstream with `outcome` "—"/"Baserunning"
    and a blank `batter` field (the builder's runner-event heuristic swallows
    the whole play before assigning a batter), so they never reach the
    counting logic at all — `SF`/`SH` only pick up the rare sac play that
    happens to classify as a clean `Flyout`/`Groundout` outcome with a
    resolvable batter. Earlier testing (before this outs-only-additive form)
    found situational SF/SH landing anywhere from an exact match with the
    season aggregate (`stats/batting.json` `sf`/`sh`) down to near-zero for
    most teams, purely because different schools' official scorers
    inconsistently narrate the "sacrifice" qualifier at all. These two fields
    are kept in the payload for future use but the frontend does not surface
    them, and no caller should treat them as authoritative.
  - `SB`/`CS` (stolen base / caught stealing): baserunner events, credited to
    the **runner**, not the batter — not a plate appearance, so they don't
    touch `PA`/`AB`/anything else, and a cell can have `SB`/`CS` > 0 with
    `PA == 0`. Parsed from the description ("`<runner> stole second/third/
    home`" → SB; "`<runner> out at <base> ..., caught stealing`" / "`<runner>
    out caught stealing at <base>, ...`" → CS), independent of the play's own
    `outcome` — a steal/CS can be the play's sole event (`outcome` "Stolen
    base"/"Caught stealing", `batter` blank) or embedded alongside a
    different batter's own PA in the same saved play (e.g. a strikeout with a
    runner thrown out on the same pitch — stats.ncaa.org often folds both
    into one play). The runner name is resolved against the same batting
    roster as the batter (same fuzzy surname matching); unresolved names are
    dropped. Credited at the play's own `mask`/`outs` (the base/out state the
    steal attempt happened in). Unlike SF/SH, this narration is consistently
    present across teams — spot-checked SB/CS situational totals land within
    a handful of counts of the season `stats/batting.json` `sb`/`cs` totals
    for every team checked, so these two are as reliable as the other
    structured fields.
  - `—` and other runner-only events (`Wild pitch`, `Passed ball`, `Baserunning`
    not tagged as a sacrifice) → **skip** (not a PA for the batter).
  - Every counted play increments `PA`.

### Robustness / coverage
- Games without a usable `play_by_play_detailed.json` are skipped (counted in
  `gamesTotal` but not `gamesWithPbp`). If `gamesWithPbp == 0`, return the object
  with empty `players` (frontend shows an empty state).
- Memoize in `app.py` under a **distinct** key (`splits:<seo>`, TTL 21600) — do
  not reuse the `team:<seo>` key.
- The route is `/api/team/<seo>/splits` (a literal segment; no conflict with
  `/api/team/<seo>`). 404 when the seo isn't a known team.

