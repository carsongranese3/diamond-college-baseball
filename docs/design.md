# Design: Situational Splits

Source prototype: claude.ai/design project "Situational stats section"
(`3955356c-0e47-4d73-9d7e-2b2abcc69007`). Saved files:
- `design/Situational Splits.dc.html` — the screen (diamond selector + summary + table import)
- `design/SituationalTable.dc.html` — the per-batter split table

The prototype renders **synthetic** data (a seeded RNG). We implement the **same
layout and interaction** but with **real splits computed from each team's saved
`play_by_play_detailed.json`**, and reskinned into the app's existing aesthetic
(`static/styles.css` tokens + fonts), not the prototype's raw inline styles.

## Where it lives in the app

A third mode on the team **Stats** tab, beside Team / Players:
`/team/<seo>/stats?mode=situational` (`statMode === "situational"` in `team.jsx`).
Wire it through `app.jsx` `viewForPath`/`pathForView` (accept `"situational"` as
a non-default mode) and the `.segmented` control in `team.jsx`. Data loads lazily
via a new `window.fetchTeamSplits(seo)` → `GET /api/team/<seo>/splits`.

## The interaction (port the prototype's view-model, real counts)

State: a base **mask** (bit0 = 1B, bit1 = 2B, bit2 = 3B) and **outs** (0, 1, 2,
or `"any"`). Default in the prototype is mask=1 (runner on 1st), outs=2.

- **Diamond**: 2B at top, 1B at right, 3B at left, home plate at bottom (static).
  Clicking a base toggles that bit. Occupied bases light up in the **team's
  color** (`team.color`; the prototype's `#BF5700` is literally Texas's color).
- **OUTS**: three dots labelled 0/1/2 + an **ANY** pill. Selecting one sets outs;
  ANY sums across 0/1/2.
- **Summary** (center): "BASE / OUT STATE" label, a `RISP` tag when
  `(mask & 6) !== 0`, a big mono score line `<bases> · <outs>` (e.g.
  "ON 1ST · 2 OUTS"), and "<N> plate appearances in this split".
- **TEAM OPS** (right): the team OPS for the selected split + a
  `±.0NN vs season` delta (green up / red down) against the team's season OPS.
- **Table**: one row per batter for the selected split — columns
  `# · BATTER · POS · PA · AB · H · HR · RBI · BB · SO · AVG · OBP · SLG · OPS`.
  Rows sorted by PA desc, then OPS desc. Rows with `PA < 4` are dimmed
  (opacity .45). The split OPS leader (among PA ≥ 6) gets a colored OPS value +
  a left accent border.

Base-state labels (full / short), keyed by mask:
`0` EMPTY · `1` ON 1ST · `2` ON 2ND · `4` ON 3RD · `3` 1ST & 2ND ·
`5` CORNERS (1ST & 3RD) · `6` 2ND & 3RD · `7` LOADED.

## Rate-stat math (exactly the prototype's)

Per batter, per selected split, from summed counts:
```
1B  = H − 2B − 3B − HR
TB  = 1B + 2*2B + 3*3B + 4*HR
AVG = H / AB
OBP = (H + BB) / (AB + BB)          // prototype ignores HBP/SF in OBP
SLG = TB / AB
OPS = OBP + SLG
```
Team OPS uses summed team AB/H/BB/TB the same way. Format: 3 decimals, leading
zero stripped for values < 1 (`.342`), `—` when undefined.

## Aesthetic mapping (prototype → app tokens)

| Prototype | App token / class |
|---|---|
| bg `#070A11` / card `#0A0D14` | `--bg` / `--paper` |
| hairlines `rgba(255,255,255,.06-.10)` | `--line` / `--line-2` |
| label grey `#5c636f` | `--muted` (use `.eyebrow`) |
| accent `#BF5700` (Texas) | `team.color` (per-team), `--accent` structural |
| Newsreader / Archivo / JetBrains Mono | `DM Serif Display` / `Inter Tight` / `JetBrains Mono` |
| segmented Basic/Advanced/Situational | existing `.segmented` Team/Players + a Situational btn |
| stat readouts | `.stats-section` + `.stat-grid` + `StatCell`, `<Eyebrow>` |
| split table | `.boxscore__wrap > table.box-table.player-table`, `.th/.td/.mono` |

Reuse `_f3`/sorting/`leader` logic from the prototype script verbatim; reuse the
app's `advBatting`-style formatting where it already exists.
