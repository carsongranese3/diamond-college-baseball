// Situational Splits view — a third statMode on the team Stats tab.
// Rendered by team.jsx when statMode === "situational".
// Data is lazily fetched via window.fetchTeamSplits(seo) → GET /api/team/<seo>/splits.
// Toggling the diamond / outs is instant (cells are pre-summed client-side).

// Batter-handedness column (pitching mode) stays hidden until real batter
// Bats L/R data is pulled in — flip this back on to re-enable it. The
// markup, `hand`/`setHand` state, and CSS are left in place either way.
const SHOW_HANDEDNESS = false;

// Minimum sample (PA for batting, BF for pitching) for a situational-heatmap
// cell to be colored; smaller samples render gray/dim so noise doesn't read
// as hot or cold.
const HEAT_MIN_SAMPLE = 8;

window.SituationalView = function SituationalView({ team, data, viewMode: viewModeProp, setViewMode: setViewModeProp }) {
  // ── Hooks (always at top level) ─────────────────────────────────────────
  // Default: mask=1 (runner on 1st), outs=2 — mirrors the prototype's default state.
  const [mask, setMask] = React.useState(1);   // base mask: bit0=1B, bit1=2B, bit2=3B | "any"
  const [outs, setOuts] = React.useState(2);   // 0 | 1 | 2 | "any"
  // Batting vs pitching table toggle (fielding intentionally omitted). This is the
  // situational "section": when the parent supplies viewMode/setViewMode it's
  // controlled and rides in the URL (like the Players tab's Batting/Pitching);
  // otherwise it falls back to local state so the view still works standalone.
  const [viewModeLocal, setViewModeLocal] = React.useState("batting");   // "batting" | "pitching"
  const viewMode = viewModeProp || viewModeLocal;
  const setViewMode = setViewModeProp || setViewModeLocal;
  // Batter-handedness selector — PITCHING view only. Only "any" is wired to real
  // data today; L/R are inert visual placeholders (no handedness data exists yet).
  const [hand, setHand] = React.useState("any");   // "any" | "L" | "R" (L/R currently inert)
  // Which batting heatmaps are shown — multi-select, basic + advanced combined
  // into one row (no separate Basic/Advanced grouping). Default matches the
  // original three (AVG/OBP/SLG); OPS and ISO start off but are one click away.
  const [statSel, setStatSel] = React.useState(() => new Set(["avg", "obp", "slg"]));
  // Which pitching heatmaps are shown — mirrors `statSel` but independent,
  // since batting/pitching pill selections shouldn't interfere with each other.
  const [pitchStatSel, setPitchStatSel] = React.useState(() => new Set(["era", "whip", "kPct"]));
  // Which heatmap stat was last clicked — drives the yellow clicked-cell
  // highlight (that one cell, in that one heatmap) and the table sort below.
  const [sortStat, setSortStat] = React.useState(null);

  // ── Pure helpers ────────────────────────────────────────────────────────
  // Format a rate stat: 3 decimals, strip leading zero for 0 < x < 1 → ".342".
  // Matches the prototype's _f3 exactly (negative values keep the zero: "-0.050").
  const _f3 = (x) => {
    if (x == null) return "—";
    if (x >= 1)    return x.toFixed(3);
    return x.toFixed(3).replace(/^0\./, ".");
  };
  // Format a rate stat: 2 decimals, no leading-zero stripping (WHIP-style).
  const _f2 = (x) => (x == null ? "—" : x.toFixed(2));
  // Format a rate as a one-decimal percent (e.g. 0.0942 → "9.4%").
  const _fPct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

  // Expand the selected (mask, outs) into the concrete cell keys to sum.
  // mask === "any" → any base OCCUPIED, i.e. masks 1-7 (bases-empty, mask 0, is
  // excluded — it's its own state, reachable by deselecting every base).
  // outs === "any" → all 3 out counts.
  const _keysFor = (m, o) => {
    const masks    = m === "any" ? [1, 2, 3, 4, 5, 6, 7] : [m];
    const outsList = o === "any" ? [0, 1, 2] : [o];
    const keys = [];
    masks.forEach((mm) => outsList.forEach((oo) => keys.push(`${mm}-${oo}`)));
    return keys;
  };

  // Aggregate a batter's cells for the selected (mask, outs) state.
  // Cell keys are "<mask>-<outs>" (e.g. "6-1"); field names match data-shapes.md exactly.
  const _agg = (player, m, o) => {
    const keys = _keysFor(m, o);
    let PA = 0, AB = 0, H = 0, d2 = 0, d3 = 0, HR = 0, RBI = 0, BB = 0, SO = 0;
    let ones = 0, HBP = 0, IBB = 0, ROE = 0, FC = 0;
    let GB = 0, FB = 0, LD = 0, PU = 0;
    let KS = 0, KL = 0;
    let SB = 0, CS = 0;
    const cells = player.cells || {};
    keys.forEach((k) => {
      const c = cells[k];
      if (!c) return;
      PA  += c.PA    || 0;
      AB  += c.AB    || 0;
      H   += c.H     || 0;
      d2  += c["2B"] || 0;
      d3  += c["3B"] || 0;
      HR  += c.HR    || 0;
      RBI += c.RBI   || 0;
      BB  += c.BB    || 0;
      SO  += c.SO    || 0;
      ones += c["1B"] || 0;
      HBP  += c.HBP  || 0;
      IBB  += c.IBB  || 0;
      ROE  += c.ROE  || 0;
      FC   += c.FC   || 0;
      GB   += c.GB   || 0;
      FB   += c.FB   || 0;
      LD   += c.LD   || 0;
      PU   += c.PU   || 0;
      KS   += c.KS   || 0;
      KL   += c.KL   || 0;
      SB   += c.SB   || 0;
      CS   += c.CS   || 0;
    });
    return { PA, AB, H, d2, d3, HR, RBI, BB, SO, ones, HBP, IBB, ROE, FC, GB, FB, LD, PU, KS, KL, SB, CS };
  };

  // Build one table row from aggregated batter counts.
  // Rate-stat math matches the prototype: OBP ignores HBP/SF (only H+BB / AB+BB).
  const _row = (player, m, o) => {
    const t   = _agg(player, m, o);
    const _1B = t.H - t.d2 - t.d3 - t.HR;
    const tb  = _1B + 2 * t.d2 + 3 * t.d3 + 4 * t.HR;
    const avg = t.AB > 0               ? t.H / t.AB                    : null;
    const obp = (t.AB + t.BB) > 0     ? (t.H + t.BB) / (t.AB + t.BB) : null;
    const slg = t.AB > 0              ? tb / t.AB                      : null;
    const ops = (obp != null && slg != null) ? obp + slg               : null;
    const iso = (slg != null && avg != null) ? slg - avg               : null;
    const bbPct = t.PA > 0 ? t.BB / t.PA : null;
    const kPct  = t.PA > 0 ? t.SO / t.PA : null;
    // Row-2 percentage pills: every countable stat expressed as a rate of PA
    // (guard PA=0 → null), mirroring bbPct/kPct above.
    const hPct    = t.PA > 0 ? t.H    / t.PA : null;
    const oneBPct = t.PA > 0 ? t.ones / t.PA : null;
    const twoBPct = t.PA > 0 ? t.d2   / t.PA : null;
    const threeBPct = t.PA > 0 ? t.d3 / t.PA : null;
    const hrPct   = t.PA > 0 ? t.HR   / t.PA : null;
    const ksPct   = t.PA > 0 ? t.KS   / t.PA : null;
    const klPct   = t.PA > 0 ? t.KL   / t.PA : null;
    const hbpPct  = t.PA > 0 ? t.HBP  / t.PA : null;
    const ibbPct  = t.PA > 0 ? t.IBB  / t.PA : null;
    const roePct  = t.PA > 0 ? t.ROE  / t.PA : null;
    const fcPct   = t.PA > 0 ? t.FC   / t.PA : null;
    const gbPct   = t.PA > 0 ? t.GB   / t.PA : null;
    const fbPct   = t.PA > 0 ? t.FB   / t.PA : null;
    const ldPct   = t.PA > 0 ? t.LD   / t.PA : null;
    const puPct   = t.PA > 0 ? t.PU   / t.PA : null;
    // XBH (now a row-1 count) and its row-2 rate-of-PA percentage.
    const xbh     = t.d2 + t.d3 + t.HR;
    const xbhPct  = t.PA > 0 ? xbh / t.PA : null;
    // Row-3 "advanced" pills — none are rates of PA like row 2; each has its
    // own denominator (guarded individually below).
    const bbK   = t.SO > 0 ? t.BB / t.SO : null;
    const abHr  = t.HR > 0 ? t.AB / t.HR : null;
    const rc    = (t.AB + t.BB) > 0 ? (t.H + t.BB) * tb / (t.AB + t.BB) : null;
    const secA  = t.AB > 0 ? (tb - t.H + t.BB + t.SB - t.CS) / t.AB : null;
    const gpa    = (obp != null && slg != null) ? (1.8 * obp + slg) / 4 : null;
    const tbH    = t.H > 0 ? tb / t.H : null;
    const hrH    = t.H > 0 ? t.HR / t.H : null;
    const paSo   = t.SO > 0 ? t.PA / t.SO : null;
    const conPct = t.AB > 0 ? (t.AB - t.SO) / t.AB : null;
    const bipPct = t.PA > 0 ? (t.AB - t.SO - t.HR) / t.PA : null;
    const gbFb   = t.FB > 0 ? t.GB / t.FB : null;
    const hrFb   = (t.FB + t.HR) > 0 ? t.HR / (t.FB + t.HR) : null;
    const babipDenom = t.AB - t.SO - t.HR;
    const babip  = babipDenom > 0 ? (t.H - t.HR) / babipDenom : null;
    const abRbi  = t.RBI > 0 ? t.AB / t.RBI : null;
    return {
      num: player.num, name: player.name, pos: player.pos,
      PA: t.PA, AB: t.AB, H: t.H, d2: t.d2, d3: t.d3, HR: t.HR, RBI: t.RBI, BB: t.BB, SO: t.SO,
      "1B": t.ones, HBP: t.HBP, IBB: t.IBB, ROE: t.ROE, FC: t.FC,
      GB: t.GB, FB: t.FB, LD: t.LD, PU: t.PU,
      KS: t.KS, KL: t.KL,
      SB: t.SB, CS: t.CS,
      avg, obp, slg, ops, tb, iso, bbPct, kPct,
      hPct, "1BPct": oneBPct, "2BPct": twoBPct, "3BPct": threeBPct, hrPct, xbhPct,
      ksPct, klPct, hbpPct, ibbPct, roePct, fcPct, gbPct, fbPct, ldPct, puPct,
      xbh, bbK, abHr, rc, secA,
      gpa, tbH, hrH, paSo, conPct, bipPct, gbFb, hrFb, babip, abRbi,
    };
  };

  // Aggregate a pitcher's cells for the selected (mask, outs) state. Each
  // cell carries the base fields (bf, ab, h, bb, so, hr, outs, r — `r` is no
  // longer surfaced anywhere, see below) plus the opposing-batter breakdown
  // fields (1B/2B/3B, gb/fb/ld/pu, hbp, b/s, wp/bk, er — see docs/api.md).
  const _aggPitcher = (pitcher, m, o) => {
    const keys = _keysFor(m, o);
    let BF = 0, AB = 0, H = 0, BB = 0, SO = 0, HR = 0, OUTS = 0;
    let ER = 0, HBP = 0, WP = 0, BK = 0, GB = 0, FB = 0, LD = 0, PU = 0, S = 0, B = 0;
    let ONE = 0, TWO = 0, THREE = 0;
    const cells = pitcher.cells || {};
    keys.forEach((k) => {
      const c = cells[k];
      if (!c) return;
      BF   += c.bf   || 0;
      AB   += c.ab   || 0;
      H    += c.h    || 0;
      BB   += c.bb   || 0;
      SO   += c.so   || 0;
      HR   += c.hr   || 0;
      OUTS += c.outs || 0;
      ER   += c.er   || 0;
      HBP  += c.hbp  || 0;
      WP   += c.wp   || 0;
      BK   += c.bk   || 0;
      GB   += c.gb   || 0;
      FB   += c.fb   || 0;
      LD   += c.ld   || 0;
      PU   += c.pu   || 0;
      S    += c.s    || 0;
      B    += c.b    || 0;
      ONE   += c["1B"] || 0;
      TWO   += c["2B"] || 0;
      THREE += c["3B"] || 0;
    });
    return { BF, AB, H, BB, SO, HR, OUTS, ER, HBP, WP, BK, GB, FB, LD, PU, S, B, ONE, TWO, THREE };
  };

  // Innings-pitched notation from a raw outs count (e.g. 19 outs → "6.1").
  // No shared frontend IP formatter exists yet (boxutil.outs_to_ip is Python-only), so
  // this mirrors that same "whole.remainder" convention inline.
  const _fmtIp = (outsCount) => `${Math.floor(outsCount / 3)}.${outsCount % 3}`;

  // Build one table row from aggregated pitcher counts — mirrors `_row`'s
  // shape/role for batting. Field names here are the ones `PITCHING_SORT_FIELD`
  // points at for the table's dynamic selected-stat columns; the counting
  // fields mostly keep their pre-existing capitalized names (BF/H/BB/SO/HR),
  // everything new is lowercase.
  const _rowPitcher = (pitcher, m, o) => {
    const t = _aggPitcher(pitcher, m, o);
    const xbh = t.TWO + t.THREE + t.HR;
    // Row-3 rates.
    const era    = t.OUTS > 0 ? (t.ER * 27) / t.OUTS : null;
    const whip   = t.OUTS > 0 ? (t.H + t.BB) * 3 / t.OUTS : null;
    const oppAvg = t.AB > 0 ? t.H / t.AB : null;
    const oppSlg = t.AB > 0 ? (t.ONE + 2 * t.TWO + 3 * t.THREE + 4 * t.HR) / t.AB : null;
    const oppIso = (oppSlg != null && oppAvg != null) ? oppSlg - oppAvg : null;
    const oppObp = t.BF > 0 ? (t.H + t.BB + t.HBP) / t.BF : null;
    const oppOps = (oppObp != null && oppSlg != null) ? oppObp + oppSlg : null;
    const bipPct = t.BF > 0 ? (t.AB - t.SO - t.HR) / t.BF : null;
    const gbFb   = t.FB > 0 ? t.GB / t.FB : null;
    const hrFb   = (t.FB + t.HR) > 0 ? t.HR / (t.FB + t.HR) : null;
    const babipDenom = t.AB - t.SO - t.HR;
    const babip  = babipDenom > 0 ? (t.H - t.HR) / babipDenom : null;
    // Row-2 percentages (rate of BF, except S%/B% which are rate of S+B).
    const sPct      = (t.S + t.B) > 0 ? t.S / (t.S + t.B) : null;
    const bPct      = (t.S + t.B) > 0 ? t.B / (t.S + t.B) : null;
    const oPct      = t.BF > 0 ? t.OUTS  / t.BF : null;
    const hBfPct    = t.BF > 0 ? t.H     / t.BF : null;
    const oneBPct   = t.BF > 0 ? t.ONE   / t.BF : null;
    const twoBPct   = t.BF > 0 ? t.TWO   / t.BF : null;
    const threeBPct = t.BF > 0 ? t.THREE / t.BF : null;
    const xbhPct    = t.BF > 0 ? xbh     / t.BF : null;
    const hrPct     = t.BF > 0 ? t.HR    / t.BF : null;
    const erPct     = t.BF > 0 ? t.ER    / t.BF : null;
    const kPct      = t.BF > 0 ? t.SO    / t.BF : null;
    const bbPct     = t.BF > 0 ? t.BB    / t.BF : null;
    const hbpPct    = t.BF > 0 ? t.HBP   / t.BF : null;
    const wpPct     = t.BF > 0 ? t.WP    / t.BF : null;
    const bkPct     = t.BF > 0 ? t.BK    / t.BF : null;
    const gbPct     = t.BF > 0 ? t.GB    / t.BF : null;
    const fbPct     = t.BF > 0 ? t.FB    / t.BF : null;
    const ldPct     = t.BF > 0 ? t.LD    / t.BF : null;
    const puPct     = t.BF > 0 ? t.PU    / t.BF : null;
    return {
      num: pitcher.num, name: pitcher.name, pos: pitcher.pos,
      BF: t.BF, AB: t.AB, H: t.H, BB: t.BB, SO: t.SO, HR: t.HR,
      "1B": t.ONE, "2B": t.TWO, "3B": t.THREE, xbh,
      er: t.ER, hbp: t.HBP, wp: t.WP, bk: t.BK,
      gb: t.GB, fb: t.FB, ld: t.LD, pu: t.PU, s: t.S, b: t.B,
      ip: _fmtIp(t.OUTS), outsRaw: t.OUTS,
      era, whip, oppAvg, oppSlg, oppIso, oppObp, oppOps, bipPct, gbFb, hrFb, babip,
      sPct, bPct, oPct, hBfPct, "1BPct": oneBPct, "2BPct": twoBPct, "3BPct": threeBPct,
      xbhPct, hrPct, erPct, kPct, bbPct, hbpPct, wpPct, bkPct, gbPct, fbPct, ldPct, puPct,
    };
  };

  // Team-level aggregate of ALL batters for one concrete (mask, outs) cell —
  // used by the situational heatmaps (one of these per grid square). Carries
  // every selectable stat: counting (h/2B/3B/hr/rbi/bb/so/tb), rate
  // (avg/obp/slg/ops/iso), and percent (bbPct/kPct) — the full set the
  // stat-pill row (STAT_DEFS) can toggle a heatmap for.
  const _teamCellBatting = (players, m, o) => {
    let PA = 0, AB = 0, H = 0, d2 = 0, d3 = 0, HR = 0, RBI = 0, BB = 0, SO = 0;
    let ones = 0, HBP = 0, IBB = 0, ROE = 0, FC = 0;
    let GB = 0, FB = 0, LD = 0, PU = 0;
    let KS = 0, KL = 0;
    let SB = 0, CS = 0;
    (players || []).forEach((p) => {
      const t = _agg(p, m, o);
      PA += t.PA; AB += t.AB; H += t.H; d2 += t.d2; d3 += t.d3; HR += t.HR;
      RBI += t.RBI; BB += t.BB; SO += t.SO;
      ones += t.ones; HBP += t.HBP; IBB += t.IBB; ROE += t.ROE; FC += t.FC;
      GB += t.GB; FB += t.FB; LD += t.LD; PU += t.PU;
      KS += t.KS; KL += t.KL;
      SB += t.SB; CS += t.CS;
    });
    const _1B = H - d2 - d3 - HR;
    const tb  = _1B + 2 * d2 + 3 * d3 + 4 * HR;
    const avg = AB > 0          ? H / AB               : null;
    const obp = (AB + BB) > 0 ? (H + BB) / (AB + BB) : null;
    const slg = AB > 0          ? tb / AB              : null;
    const ops = (obp != null && slg != null) ? obp + slg : null;
    const iso = (slg != null && avg != null) ? slg - avg : null;
    const bbPct = PA > 0 ? BB / PA : null;
    const kPct  = PA > 0 ? SO / PA : null;
    // Row-2 percentage heatmaps: same 15 counts, each expressed as a rate of
    // team PA (guard PA=0 → null), mirroring bbPct/kPct above.
    const hPct    = PA > 0 ? H    / PA : null;
    const oneBPct = PA > 0 ? ones / PA : null;
    const twoBPct = PA > 0 ? d2   / PA : null;
    const threeBPct = PA > 0 ? d3 / PA : null;
    const hrPct   = PA > 0 ? HR   / PA : null;
    const ksPct   = PA > 0 ? KS   / PA : null;
    const klPct   = PA > 0 ? KL   / PA : null;
    const hbpPct  = PA > 0 ? HBP  / PA : null;
    const ibbPct  = PA > 0 ? IBB  / PA : null;
    const roePct  = PA > 0 ? ROE  / PA : null;
    const fcPct   = PA > 0 ? FC   / PA : null;
    const gbPct   = PA > 0 ? GB   / PA : null;
    const fbPct   = PA > 0 ? FB   / PA : null;
    const ldPct   = PA > 0 ? LD   / PA : null;
    const puPct   = PA > 0 ? PU   / PA : null;
    // XBH (now a row-1 count) and its row-2 rate-of-PA percentage.
    const xbh     = d2 + d3 + HR;
    const xbhPct  = PA > 0 ? xbh / PA : null;
    // Row-3 "advanced" heatmaps — each has its own denominator (guarded
    // individually), not a rate of PA like row 2.
    const bbK   = SO > 0 ? BB / SO : null;
    const abHr  = HR > 0 ? AB / HR : null;
    const rc    = (AB + BB) > 0 ? (H + BB) * tb / (AB + BB) : null;
    const secA  = AB > 0 ? (tb - H + BB + SB - CS) / AB : null;
    const gpa    = (obp != null && slg != null) ? (1.8 * obp + slg) / 4 : null;
    const tbH    = H > 0 ? tb / H : null;
    const hrH    = H > 0 ? HR / H : null;
    const paSo   = SO > 0 ? PA / SO : null;
    const conPct = AB > 0 ? (AB - SO) / AB : null;
    const bipPct = PA > 0 ? (AB - SO - HR) / PA : null;
    const gbFb   = FB > 0 ? GB / FB : null;
    const hrFb   = (FB + HR) > 0 ? HR / (FB + HR) : null;
    const babipDenom = AB - SO - HR;
    const babip  = babipDenom > 0 ? (H - HR) / babipDenom : null;
    const abRbi  = RBI > 0 ? AB / RBI : null;
    return {
      PA, AB,
      h: H, "2B": d2, "3B": d3, hr: HR, rbi: RBI, bb: BB, so: SO, tb,
      "1B": ones, hbp: HBP, ibb: IBB, roe: ROE, fc: FC,
      gb: GB, fb: FB, ld: LD, pu: PU,
      ks: KS, kl: KL,
      sb: SB, cs: CS,
      avg, obp, slg, ops, iso, bbPct, kPct,
      hPct, "1BPct": oneBPct, "2BPct": twoBPct, "3BPct": threeBPct, hrPct, xbhPct,
      ksPct, klPct, hbpPct, ibbPct, roePct, fcPct, gbPct, fbPct, ldPct, puPct,
      xbh, bbK, abHr, rc, secA,
      gpa, tbH, hrH, paSo, conPct, bipPct, gbFb, hrFb, babip, abRbi,
    };
  };

  // Team-level aggregate of ALL pitchers for one concrete (mask, outs) cell —
  // carries every stat used by the table (counting line + selectable pills)
  // and by PITCH_ROW2's pills/heatmaps, mirroring `_teamCellBatting`. IMPORTANT: unlike
  // `_rowPitcher`, this object's keys must be the exact PILL keys (not
  // friendlier row-field names) since `renderHeatGrid`/`heatScales` index
  // straight into it by `s.key` — a few (k→so, o→outs) are deliberately
  // aliased to a differently-named pill key, mirroring how batting's
  // `_teamCellBatting` already does this for e.g. `h: H`.
  const _teamCellPitching = (pitchers, m, o) => {
    let BF = 0, AB = 0, H = 0, BB = 0, SO = 0, HR = 0, OUTS = 0;
    let ER = 0, HBP = 0, WP = 0, BK = 0, GB = 0, FB = 0, LD = 0, PU = 0, S = 0, B = 0;
    let ONE = 0, TWO = 0, THREE = 0;
    (pitchers || []).forEach((p) => {
      const t = _aggPitcher(p, m, o);
      BF += t.BF; AB += t.AB; H += t.H; BB += t.BB; SO += t.SO; HR += t.HR; OUTS += t.OUTS;
      ER += t.ER; HBP += t.HBP; WP += t.WP; BK += t.BK;
      GB += t.GB; FB += t.FB; LD += t.LD; PU += t.PU; S += t.S; B += t.B;
      ONE += t.ONE; TWO += t.TWO; THREE += t.THREE;
    });
    const xbh = TWO + THREE + HR;
    // Row-3 rates.
    const era    = OUTS > 0 ? (ER * 27) / OUTS : null;
    const whip   = OUTS > 0 ? (H + BB) * 3 / OUTS : null;
    const oppAvg = AB > 0 ? H / AB : null;
    const oppSlg = AB > 0 ? (ONE + 2 * TWO + 3 * THREE + 4 * HR) / AB : null;
    const oppIso = (oppSlg != null && oppAvg != null) ? oppSlg - oppAvg : null;
    const oppObp = BF > 0 ? (H + BB + HBP) / BF : null;
    const oppOps = (oppObp != null && oppSlg != null) ? oppObp + oppSlg : null;
    const bipPct = BF > 0 ? (AB - SO - HR) / BF : null;
    const gbFb   = FB > 0 ? GB / FB : null;
    const hrFb   = (FB + HR) > 0 ? HR / (FB + HR) : null;
    const babipDenom = AB - SO - HR;
    const babip  = babipDenom > 0 ? (H - HR) / babipDenom : null;
    // Row-2 percentages (rate of BF, except S%/B% which are rate of S+B).
    const sPct      = (S + B) > 0 ? S / (S + B) : null;
    const bPct      = (S + B) > 0 ? B / (S + B) : null;
    const oPct      = BF > 0 ? OUTS  / BF : null;
    const hBfPct    = BF > 0 ? H     / BF : null;
    const oneBPct   = BF > 0 ? ONE   / BF : null;
    const twoBPct   = BF > 0 ? TWO   / BF : null;
    const threeBPct = BF > 0 ? THREE / BF : null;
    const xbhPct    = BF > 0 ? xbh   / BF : null;
    const hrPct     = BF > 0 ? HR    / BF : null;
    const erPct     = BF > 0 ? ER    / BF : null;
    const kPct      = BF > 0 ? SO    / BF : null;
    const bbPct     = BF > 0 ? BB    / BF : null;
    const hbpPct    = BF > 0 ? HBP   / BF : null;
    const wpPct     = BF > 0 ? WP    / BF : null;
    const bkPct     = BF > 0 ? BK    / BF : null;
    const gbPct     = BF > 0 ? GB    / BF : null;
    const fbPct     = BF > 0 ? FB    / BF : null;
    const ldPct     = BF > 0 ? LD    / BF : null;
    const puPct     = BF > 0 ? PU    / BF : null;
    return {
      BF, AB,
      s: S, b: B, o: OUTS, h: H, "1B": ONE, "2B": TWO, "3B": THREE, xbh, hr: HR, er: ER,
      k: SO, bb: BB, hbp: HBP, wp: WP, bk: BK, gb: GB, fb: FB, ld: LD, pu: PU,
      sPct, bPct, oPct, hBfPct, "1BPct": oneBPct, "2BPct": twoBPct, "3BPct": threeBPct,
      xbhPct, hrPct, erPct, kPct, bbPct, hbpPct, wpPct, bkPct, gbPct, fbPct, ldPct, puPct,
      era, whip, oppAvg, oppSlg, oppIso, oppObp, oppOps, bipPct, gbFb, hrFb, babip,
    };
  };

  // ── Memoized computation ─────────────────────────────────────────────────
  // Re-runs only when data / mask / outs / viewMode change; sorting is
  // included. Defensively guards for `data.pitchers` not existing yet.
  // Batting heatmap-key → table-row-field map, used to sort the table by
  // whichever stat's heatmap cell was last clicked (see `sortStat`).
  const BATTING_SORT_FIELD = {
    "1B": "1B", hbp: "HBP", ibb: "IBB", roe: "ROE", fc: "FC",
    h: "H", "2B": "d2", "3B": "d3", hr: "HR", rbi: "RBI", bb: "BB", so: "SO",
    ks: "KS", kl: "KL",
    gb: "GB", fb: "FB", ld: "LD", pu: "PU",
    // NOTE: no `sb`/`cs` entries — SB/CS are internal-only inputs (used by
    // `secA` below), never their own selectable pill/column/heatmap.
    tb: "tb", avg: "avg", obp: "obp", slg: "slg", ops: "ops", iso: "iso",
    bbPct: "bbPct", kPct: "kPct",
    // Row-2 percentage pills — each maps to the same-named `_row` field.
    hPct: "hPct", "1BPct": "1BPct", "2BPct": "2BPct", "3BPct": "3BPct", hrPct: "hrPct", xbhPct: "xbhPct",
    ksPct: "ksPct", klPct: "klPct", hbpPct: "hbpPct", ibbPct: "ibbPct", roePct: "roePct",
    fcPct: "fcPct", gbPct: "gbPct", fbPct: "fbPct", ldPct: "ldPct", puPct: "puPct",
    // xbh is a row-1 count. bbK/abHr/rc/secA/gpa/tbH/hrH/paSo/conPct/bipPct/
    // gbFb/hrFb/babip/abRbi are row-3 "advanced" pills — pill/heatmap-only
    // (no table column), but the table still sorts by these when clicked.
    xbh: "xbh", bbK: "bbK", abHr: "abHr", rc: "rc", secA: "secA",
    gpa: "gpa", tbH: "tbH", hrH: "hrH", paSo: "paSo", conPct: "conPct",
    bipPct: "bipPct", gbFb: "gbFb", hrFb: "hrFb", babip: "babip", abRbi: "abRbi",
  };
  // Which batting heatmap keys are "lower is better" for the team (fewer
  // strikeouts = better) — for a hitter this is the strikeout counts (SO,
  // swinging K, looking ꓘ) and their rates (SO% via kPct, K%, ꓘ%), AB/HR
  // (fewer at-bats per homer = better), and AB/RBI (fewer at-bats per RBI =
  // better); every other batting stat is higher-is-better. Drives both
  // heatmap `invert` and the click-sort direction, mirroring
  // PITCH_INVERT_MAP/PITCH_SORT_ASCENDING.
  const BATTING_LOWER_BETTER = new Set(["so", "ks", "kl", "kPct", "ksPct", "klPct", "abHr", "abRbi"]);
  // Pitching heatmap-key → `_rowPitcher` table-row-field map — mirrors
  // BATTING_SORT_FIELD for the pitching table. Most keys are same-named on
  // the row; a few use the row's friendlier/pre-existing field name
  // (o→outsRaw, k→SO, bb→BB, hr→HR, h→H — same "team-cell uses the pill key,
  // row uses a clearer name" split batting already uses for e.g. h→H).
  // NOTE: `r`/`rPct` and the old k9/bb9/hr9/kMinusBbPct pitching pills are
  // gone — fully replaced by PITCH_COUNT_COLS (table-only) + PITCH_ROW2
  // (pills/heatmaps) below (the raw `r` cell field is still present in the
  // API response, just no longer read anywhere).
  const PITCHING_SORT_FIELD = {
    // Row 1 — counts.
    s: "s", b: "b", o: "outsRaw", h: "H", "1B": "1B", "2B": "2B", "3B": "3B",
    xbh: "xbh", hr: "HR", er: "er", k: "SO", bb: "BB", hbp: "hbp", wp: "wp", bk: "bk",
    gb: "gb", fb: "fb", ld: "ld", pu: "pu",
    // Row 2 — percentages (all rate-of-BF except sPct/bPct which are rate of S+B).
    sPct: "sPct", bPct: "bPct", oPct: "oPct", hBfPct: "hBfPct",
    "1BPct": "1BPct", "2BPct": "2BPct", "3BPct": "3BPct", xbhPct: "xbhPct",
    hrPct: "hrPct", erPct: "erPct", kPct: "kPct", bbPct: "bbPct", hbpPct: "hbpPct",
    wpPct: "wpPct", bkPct: "bkPct", gbPct: "gbPct", fbPct: "fbPct", ldPct: "ldPct", puPct: "puPct",
    // Row 3 — rates.
    era: "era", whip: "whip", oppAvg: "oppAvg", oppSlg: "oppSlg", oppIso: "oppIso",
    oppObp: "oppObp", oppOps: "oppOps", bipPct: "bipPct", gbFb: "gbFb", hrFb: "hrFb", babip: "babip",
  };
  // "Best first" direction per pitching stat when clicked: ascending
  // (lowest first) for lower-is-better metrics, descending for higher-is-
  // better — same lower/higher grouping used for heatmap `invert`
  // (PITCH_INVERT_MAP below); every key here is the "invert=YES" list.
  const PITCH_SORT_ASCENDING = new Set([
    "b", "h", "1B", "2B", "3B", "xbh", "hr", "er", "bb", "hbp", "wp", "bk",
    "bPct", "hBfPct", "1BPct", "2BPct", "3BPct", "xbhPct", "hrPct", "erPct", "bbPct", "hbpPct", "wpPct", "bkPct",
    "era", "whip", "oppAvg", "oppSlg", "oppIso", "oppObp", "oppOps", "hrFb", "babip",
  ]);
  // Sort rows descending by `field`, pushing null/undefined values to the end.
  const _sortDescNullsLast = (rows, field) => {
    rows.sort((a, b) => {
      const av = a[field], bv = b[field];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    });
  };
  // Sort rows ascending by `field`, pushing null/undefined values to the end.
  const _sortAscNullsLast = (rows, field) => {
    rows.sort((a, b) => {
      const av = a[field], bv = b[field];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;
    });
  };

  // Low-sample threshold that drives the table's grey "dim" row styling —
  // MUST match the render code exactly (`r.BF < DIM_SAMPLE_MIN` for pitching,
  // `r.PA < DIM_SAMPLE_MIN` for batting) so the tiering below lines up with
  // which rows actually render grey.
  const DIM_SAMPLE_MIN = 4;
  // Stable 3-tier ordering by sample size (PA for batting, BF for pitching):
  //   1. qualified   — sample >= DIM_SAMPLE_MIN
  //   2. some sample — 0 < sample < DIM_SAMPLE_MIN (still "has a PA/BF", but dim)
  //   3. no sample   — sample === 0 (didn't appear in this split at all)
  // Each tier keeps whatever order the preceding sort produced — three
  // order-preserving `Array.filter` passes is a stable partition.
  const _tierBySample = (rows, sampleOf) => [
    ...rows.filter((r) => sampleOf(r) >= DIM_SAMPLE_MIN),
    ...rows.filter((r) => sampleOf(r) > 0 && sampleOf(r) < DIM_SAMPLE_MIN),
    ...rows.filter((r) => sampleOf(r) === 0),
  ];

  const computed = React.useMemo(() => {
    if (viewMode === "pitching") {
      if (!data || !data.pitchers || data.pitchers.length === 0) return null;
      let rows = data.pitchers.map((p) => _rowPitcher(p, mask, outs));
      const pitchSortField = sortStat != null ? PITCHING_SORT_FIELD[sortStat] : null;
      if (pitchSortField) {
        if (PITCH_SORT_ASCENDING.has(sortStat)) {
          _sortAscNullsLast(rows, pitchSortField);
        } else {
          _sortDescNullsLast(rows, pitchSortField);
        }
      } else {
        rows.sort((a, b) => (b.BF - a.BF) || ((a.whip == null ? 99 : a.whip) - (b.whip == null ? 99 : b.whip)));
      }
      rows = _tierBySample(rows, (r) => r.BF);
      let sampleN = 0;
      rows.forEach((r) => { sampleN += r.BF; });
      return { rows, sampleN };
    }
    if (!data || !data.players || data.players.length === 0) return null;
    let rows = data.players.map((p) => _row(p, mask, outs));
    const sortField = sortStat != null ? BATTING_SORT_FIELD[sortStat] : null;
    if (sortField) {
      if (BATTING_LOWER_BETTER.has(sortStat)) {
        _sortAscNullsLast(rows, sortField);
      } else {
        _sortDescNullsLast(rows, sortField);
      }
    } else {
      rows.sort((a, b) => (b.PA - a.PA) || ((b.ops || -1) - (a.ops || -1)));
    }
    rows = _tierBySample(rows, (r) => r.PA);
    let sampleN = 0;
    rows.forEach((r) => { sampleN += r.PA; });
    return { rows, sampleN };
  }, [data, mask, outs, viewMode, sortStat]);

  // ── Situational heatmaps (all 24 base×out cells + "any outs"/"any bases"
  // aggregate cells) ─────────────────────────────────────────────────────────
  // Independent of the selected mask/outs — always computed over the full
  // 8×3 grid, PLUS a 4th "any outs" cell per concrete mask row, PLUS one
  // extra "any base" row (mask="any") with its own any/0/1/2 cells (the
  // any-any cell being every PA with a runner on — NOT the grand total, since
  // bases-empty is excluded) — so clicking a cell can jump the
  // selector straight to it. Both batting and pitching cells carry every
  // selectable stat (all `_teamCellBatting`/`_teamCellPitching` fields are
  // spread onto the cell) since any of the 15 batting / 13 pitching stat
  // pills can render a grid.
  // Every aggregate cell is built by calling the same
  // team-cell helper with mask and/or outs set to "any" — `_agg`/`_aggPitcher`
  // already sum the underlying counts across masks 1-7 / all 3 out states via
  // `_keysFor` before any rate is computed, so this mirrors the diamond's
  // base-Any button and the outs-Any dot exactly (never an average of rates).
  const heatData = React.useMemo(() => {
    if (viewMode === "pitching") {
      if (!data || !data.pitchers || data.pitchers.length === 0) return null;
      const cells = [];
      for (let m = 0; m < 8; m++) {
        for (let o = 0; o < 3; o++) {
          const t = _teamCellPitching(data.pitchers, m, o);
          cells.push({ mask: m, outs: o, sample: t.BF, ...t });
        }
        const tAny = _teamCellPitching(data.pitchers, m, "any");
        cells.push({ mask: m, outs: "any", sample: tAny.BF, ...tAny });
      }
      // "Any base" row — one cell per outs column, aggregated over masks 1-7.
      ["any", 0, 1, 2].forEach((o) => {
        const t = _teamCellPitching(data.pitchers, "any", o);
        cells.push({ mask: "any", outs: o, sample: t.BF, ...t });
      });
      return cells;
    }
    if (!data || !data.players || data.players.length === 0) return null;
    const cells = [];
    for (let m = 0; m < 8; m++) {
      for (let o = 0; o < 3; o++) {
        const t = _teamCellBatting(data.players, m, o);
        cells.push({ mask: m, outs: o, sample: t.PA, ...t });
      }
      const tAny = _teamCellBatting(data.players, m, "any");
      cells.push({ mask: m, outs: "any", sample: tAny.PA, ...tAny });
    }
    // "Any base" row — one cell per outs column, aggregated over masks 1-7.
    ["any", 0, 1, 2].forEach((o) => {
      const t = _teamCellBatting(data.players, "any", o);
      cells.push({ mask: "any", outs: o, sample: t.PA, ...t });
    });
    return cells;
  }, [data, viewMode]);

  // Per-metric min/max across the CONCRETE (0/1/2-outs × 8-mask) cells that
  // clear the sample threshold — the "any outs" column AND the "any bases"
  // row are colored on this same scale, not their own, so colors stay
  // comparable across the whole grid.
  const heatScales = React.useMemo(() => {
    const metrics = viewMode === "pitching"
      ? ["s", "b", "o", "h", "1B", "2B", "3B", "xbh", "hr", "er", "k", "bb", "hbp", "wp", "bk", "gb", "fb", "ld", "pu",
         "sPct", "bPct", "oPct", "hBfPct", "1BPct", "2BPct", "3BPct", "xbhPct", "hrPct", "erPct", "kPct", "bbPct",
         "hbpPct", "wpPct", "bkPct", "gbPct", "fbPct", "ldPct", "puPct",
         "era", "whip", "oppAvg", "oppSlg", "oppIso", "oppObp", "oppOps", "bipPct", "gbFb", "hrFb", "babip"]
      : ["1B", "hbp", "ibb", "roe", "fc", "h", "2B", "3B", "hr", "rbi", "bb", "so", "ks", "kl", "gb", "fb", "ld", "pu", "tb", "avg", "obp", "slg", "ops", "iso", "bbPct", "kPct",
         "hPct", "1BPct", "2BPct", "3BPct", "hrPct", "xbhPct", "ksPct", "klPct", "hbpPct", "ibbPct", "roePct", "fcPct", "gbPct", "fbPct", "ldPct", "puPct",
         "xbh", "bbK", "abHr", "rc", "secA",
         "gpa", "tbH", "hrH", "paSo", "conPct", "bipPct", "gbFb", "hrFb", "babip", "abRbi"];
    const scales = {};
    metrics.forEach((key) => {
      const vals = (heatData || [])
        .filter((c) => c.outs !== "any" && c.mask !== "any" && c[key] != null && c.sample >= HEAT_MIN_SAMPLE)
        .map((c) => c[key]);
      scales[key] = vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : { min: null, max: null };
    });
    return scales;
  }, [heatData, viewMode]);

  // ── Derived values (no hooks below this point) ────────────────────────────
  const teamColor  = (team && team.color) || "var(--accent)";
  const teamInk    = (team && team.ink) || "#fff";
  const noPbp      = !data || data.gamesWithPbp === 0;
  const noBatters  = !data || !data.players  || data.players.length  === 0;
  const noPitchers = !data || !data.pitchers || data.pitchers.length === 0;
  const isPitching = viewMode === "pitching";
  const noRowsForView = isPitching ? noPitchers : noBatters;

  // Batting heatmap stat picker — two separate pill rows (percentages /
  // rates+advanced), rendered as two `.split-stat-toggle` groups but sharing
  // one `statSel` Set/cap so STAT_MAX applies across both of them combined.
  // `selectedStats` flattens the two rows (in row2→row3 order) filtered down
  // to what's checked, so heatmap render order is always row2→row3
  // regardless of click order. NOTE: the former Row 1 (counting stats) pill
  // row has been removed entirely — those metrics are still computed in
  // `_agg`/`_row`/`_teamCellBatting` (the table's fixed counting-line columns
  // still need them), they're just no longer independently selectable as
  // heatmaps/pills.

  // ROW 2 — percentages (count / PA). Same order the old row 1 was minus TB/RBI
  // (no rate-of-PA for those two). `bbPct`/`kPct` already existed — `kPct`
  // is relabeled "SO%" here since it's SO/PA (a strikeout rate, not a
  // "K%" swinging-strike rate — that's the new `ksPct` pill). `hPct` is
  // labeled "H/PA" and formatted as a 3-decimal ratio (not a percent, unlike
  // every other Row-2 pill) — see the HEAT_PCT_KEYS note near its formatting.
  const STAT_ROW2 = [
    { key: "hPct",    label: "H%",    desc: "Hit Rate — share of plate appearances resulting in a hit" },
    { key: "1BPct",   label: "1B%",   desc: "Single Rate — share of plate appearances resulting in a single" },
    { key: "2BPct",   label: "2B%",   desc: "Double Rate — share of plate appearances resulting in a double" },
    { key: "3BPct",   label: "3B%",   desc: "Triple Rate — share of plate appearances resulting in a triple" },
    { key: "hrPct",   label: "HR%",   desc: "Home Run Rate — share of plate appearances resulting in a home run" },
    { key: "xbhPct",  label: "XBH%",  desc: "Extra-Base Hit Rate — share of plate appearances resulting in a double, triple, or home run" },
    { key: "bbPct",   label: "BB%",   desc: "Walk Rate — share of plate appearances resulting in a walk" },
    { key: "kPct",    label: "SO%",   desc: "Strikeout Rate — share of plate appearances resulting in a strikeout (swinging or looking)" },
    { key: "ksPct",   label: "K%",    desc: "Swinging Strikeout Rate — share of plate appearances resulting in a strikeout swinging" },
    { key: "klPct",   label: "ꓘ%",    desc: "Called Strikeout Rate — share of plate appearances resulting in a strikeout looking" },
    { key: "hbpPct",  label: "HBP%",  desc: "Hit-By-Pitch Rate — share of plate appearances resulting in a hit by pitch" },
    { key: "ibbPct",  label: "IBB%",  desc: "Intentional Walk Rate — share of plate appearances resulting in an intentional walk" },
    { key: "roePct",  label: "ROE%",  desc: "Reached-on-Error Rate — share of plate appearances resulting in reaching base on an error" },
    { key: "fcPct",   label: "FC%",   desc: "Fielder's-Choice Rate — share of plate appearances resulting in a fielder's choice" },
    { key: "gbPct",   label: "GB%",   desc: "Ground-Ball Rate — share of plate appearances resulting in a ground ball" },
    { key: "fbPct",   label: "FB%",   desc: "Fly-Ball Rate — share of plate appearances resulting in a fly ball" },
    { key: "ldPct",   label: "LD%",   desc: "Line-Drive Rate — share of plate appearances resulting in a line drive" },
    { key: "puPct",   label: "PU%",   desc: "Pop-Up Rate — share of plate appearances resulting in a pop-up" },
  ];
  // ROW 3 — rates + advanced (pill/heatmap-only; none of these have a table
  // column). SB/CS are NOT surfaced anywhere — they only feed `secA`'s
  // formula internally. Exact order per spec: AVG, OBP, SLG, OPS, ISO, GPA,
  // SECA, Tb/H, HR/H, BB/K, PA/SO, Con%, BIP%, GB/FB, HR/FB, BABIP, RC,
  // AB/HR, AB/RBI.
  const STAT_ROW3 = [
    { key: "avg",     label: "AVG",   desc: "Batting Average — H ÷ AB" },
    { key: "obp",     label: "OBP",   desc: "On-Base Percentage — (H + BB + HBP) ÷ (AB + BB + HBP + SF)" },
    { key: "slg",     label: "SLG",   desc: "Slugging Percentage — TB ÷ AB" },
    { key: "ops",     label: "OPS",   desc: "On-Base Plus Slugging — OBP + SLG" },
    { key: "iso",     label: "ISO",   desc: "Isolated Power — SLG − AVG" },
    { key: "gpa",     label: "GPA",   desc: "Gross Production Average — (1.8 × OBP + SLG) ÷ 4" },
    { key: "secA",    label: "SECA",  desc: "Secondary Average — (TB − H + BB + SB − CS) ÷ AB" },
    { key: "tbH",     label: "Tb/H",  desc: "Bases per Hit — TB ÷ H" },
    { key: "hrH",     label: "HR/H",  desc: "Home Runs per Hit — HR ÷ H" },
    { key: "bbK",     label: "BB/K",  desc: "Walk-to-Strikeout Ratio — BB ÷ SO" },
    { key: "paSo",    label: "PA/SO", desc: "PA per Strikeout — PA ÷ SO" },
    { key: "conPct",  label: "Con%",  desc: "Contact Rate — (AB − SO) ÷ AB" },
    { key: "bipPct",  label: "BIP%",  desc: "Ball-in-Play Rate — share of plate appearances that ended in a ball in play (excludes strikeouts and home runs)" },
    { key: "gbFb",    label: "GB/FB", desc: "Ground-Ball-to-Fly-Ball Ratio — GB ÷ FB" },
    { key: "hrFb",    label: "HR/FB", desc: "Home Runs per Fly Ball — HR ÷ FB" },
    { key: "babip",   label: "BABIP", desc: "BABIP — (H − HR) ÷ (AB − SO − HR + SF)" },
    { key: "rc",      label: "RC",    desc: "Runs Created — (H + BB) × TB ÷ (AB + BB)" },
    { key: "abHr",    label: "AB/HR", desc: "At Bats per Home Run — AB ÷ HR" },
    { key: "abRbi",   label: "AB/RBI", desc: "At Bats per RBI — AB ÷ RBI" },
  ];
  const STAT_MAX = 3;   // cap on simultaneous batting heatmaps, across BOTH rows combined
  // Deselecting is always allowed; selecting a new key is a no-op once the
  // cap is already met (the caller's pill should be rendered `disabled` in
  // that case — see the STAT_ROW*.map calls below).
  const toggleStat = (k) => setStatSel((prev) => {
    const isOn = prev.has(k);
    if (!isOn && prev.size >= STAT_MAX) return prev;
    const next = new Set(prev);
    if (isOn) next.delete(k); else next.add(k);
    return next;
  });
  const selectedStats = [...STAT_ROW2, ...STAT_ROW3].filter((s) => statSel.has(s.key));
  // Batting table's FIXED counting line (always shown, not selectable) —
  // exactly the stats that used to be the deleted Row-1 pills, plus PA/AB
  // which were already fixed volume columns. `key` drives `sortedColCls`
  // (same metric keys the old Row-1 pills used); the actual per-player value
  // comes from `r[BATTING_SORT_FIELD[key]]` (integers throughout, so no
  // `_fmtStatCell` needed — reuses the exact same key→row-field map the
  // click-sort already relies on).
  const BATTING_COUNT_COLS = [
    { key: "h",   label: "H" },
    { key: "1B",  label: "1B" },
    { key: "2B",  label: "2B" },
    { key: "3B",  label: "3B" },
    { key: "hr",  label: "HR" },
    { key: "xbh", label: "XBH" },
    { key: "tb",  label: "TB" },
    { key: "rbi", label: "RBI" },
    { key: "bb",  label: "BB" },
    { key: "so",  label: "SO" },
    { key: "ks",  label: "K" },
    { key: "kl",  label: "ꓘ" },
    { key: "hbp", label: "HBP" },
    { key: "ibb", label: "IBB" },
    { key: "roe", label: "ROE" },
    { key: "fc",  label: "FC" },
    { key: "gb",  label: "GB" },
    { key: "fb",  label: "FB" },
    { key: "ld",  label: "LD" },
    { key: "pu",  label: "PU" },
  ];
  // Renders one `.split-stat-toggle` pill row for a given def array —
  // identical markup/cap-disable logic for both batting (statSel/toggleStat)
  // and pitching (pitchStatSel/togglePitchStat), which is why `selSet`/
  // `toggleFn` are passed in rather than hard-coded.
  const renderStatRow = (defs, ariaLabel, selSet, toggleFn) => (
    <div className="split-stat-toggle" role="group" aria-label={ariaLabel}>
      {defs.map((s) => {
        const active = selSet.has(s.key);
        // Once 3 are selected (across ALL rows), every unselected pill is
        // disabled/dimmed until one is deselected — selected pills stay clickable.
        const atCap = !active && selSet.size >= STAT_MAX;
        return (
          <button
            key={s.key}
            type="button"
            className={`split-stat-toggle__btn ${active ? "split-stat-toggle__btn--active" : ""}`}
            onClick={() => toggleFn(s.key)}
            disabled={atCap}
            style={active ? { background: teamColor, borderColor: teamColor, color: teamInk } : {}}
            aria-pressed={active}
            title={atCap ? "Deselect a stat to pick a different one (max 3)" : undefined}
          >{s.label}{s.desc ? <span className="split-stat-toggle__btn-tip">{s.desc}</span> : null}</button>
        );
      })}
    </div>
  );

  // Pitching heatmap stat picker — ONE pill row (percentages + rates),
  // backed by `pitchStatSel`/`togglePitchStat`. The former counting-stats
  // row was removed — those stats are still computed in
  // `_aggPitcher`/`_rowPitcher`/`_teamCellPitching` (the table's fixed
  // counting-line columns still need them), they're just no longer
  // independently selectable as heatmaps/pills — mirrors exactly what
  // batting already did for its own counting row. R/R% and the old
  // k9/bb9/hr9/K-BB% pitching pills remain fully replaced by this structure
  // (the raw `r` cell field is still in the API response, just unused).

  // PITCH ROW 2 — percentages (rate of BF, except S%/B% which are rate of
  // S+B) + rates. NOTE: the H% pill's internal key is
  // `hBfPct`, NOT `hPct` — batting already uses the literal key `hPct` for
  // its "H/PA" pill (deliberately excluded from percent-formatting per an
  // earlier change), and `HEAT_PCT_KEYS`/`HEAT_COUNT_KEYS`/etc are shared
  // Sets across both view modes, so reusing `hPct` here would silently
  // un-revert that batting fix. Same label ("H%"), same formula (h/bf),
  // just a collision-free key.
  const PITCH_ROW2 = [
    { key: "sPct",    label: "S%",    desc: "Strike Rate — share of pitches that were strikes" },
    { key: "bPct",    label: "B%",    desc: "Ball Rate — share of pitches that were balls" },
    { key: "oPct",    label: "O%",    desc: "Out Rate — share of plate appearances against that ended in an out" },
    { key: "hBfPct",  label: "H%",    desc: "Hit Rate Allowed — share of plate appearances against that resulted in a hit" },
    { key: "1BPct",   label: "1B%",   desc: "Single Rate Allowed — share of plate appearances against that resulted in a single" },
    { key: "2BPct",   label: "2B%",   desc: "Double Rate Allowed — share of plate appearances against that resulted in a double" },
    { key: "3BPct",   label: "3B%",   desc: "Triple Rate Allowed — share of plate appearances against that resulted in a triple" },
    { key: "xbhPct",  label: "XBH%",  desc: "Extra-Base Hit Rate Allowed — share of plate appearances against that resulted in a double, triple, or home run" },
    { key: "hrPct",   label: "HR%",   desc: "Home Run Rate Allowed — share of plate appearances against that resulted in a home run" },
    { key: "erPct",   label: "ER%",   desc: "Earned Run Rate — share of plate appearances against that resulted in an earned run" },
    { key: "kPct",    label: "K%",    desc: "Strikeout Rate — share of plate appearances against that ended in a strikeout" },
    { key: "bbPct",   label: "BB%",   desc: "Walk Rate — share of plate appearances against that ended in a walk" },
    { key: "hbpPct",  label: "HBP%",  desc: "Hit-By-Pitch Rate — share of plate appearances against that ended in a hit by pitch" },
    { key: "wpPct",   label: "WP%",   desc: "Wild Pitch Rate — share of plate appearances against that included a wild pitch" },
    { key: "bkPct",   label: "BK%",   desc: "Balk Rate — share of plate appearances against that included a balk" },
    { key: "gbPct",   label: "GB%",   desc: "Ground-Ball Rate — share of plate appearances against that resulted in a ground ball" },
    { key: "fbPct",   label: "FB%",   desc: "Fly-Ball Rate — share of plate appearances against that resulted in a fly ball" },
    { key: "ldPct",   label: "LD%",   desc: "Line-Drive Rate — share of plate appearances against that resulted in a line drive" },
    { key: "puPct",   label: "PU%",   desc: "Pop-Up Rate — share of plate appearances against that resulted in a pop-up" },
    // rates (moved from the former row 3 onto the end of row 2)
    { key: "era",     label: "ERA",   desc: "Earned Run Average — 9 × ER ÷ IP" },
    { key: "whip",    label: "WHIP",  desc: "Walks + Hits per IP — (H + BB) ÷ IP" },
    { key: "oppAvg",  label: "OppAvg", desc: "Opponent Batting Average — H ÷ (BF − BB − HBP)" },
    { key: "oppSlg",  label: "OppSLG", desc: "Opponent Slugging — TB ÷ (BF − BB − HBP)" },
    { key: "oppIso",  label: "OppISO", desc: "Opponent ISO — OppSLG − OppAvg" },
    { key: "oppObp",  label: "OppOBP", desc: "On-Base Against — (H + BB + HBP) ÷ BF" },
    { key: "oppOps",  label: "OppOPS", desc: "Opponent OPS — OppOBP + OppSLG" },
    { key: "bipPct",  label: "BIP%",  desc: "Ball-in-Play Rate — share of plate appearances against that ended in a ball in play (excludes strikeouts and home runs)" },
    { key: "gbFb",    label: "GB/FB", desc: "Ground-Ball-to-Fly-Ball — GB ÷ FB" },
    { key: "hrFb",    label: "HR/FB", desc: "Home Runs per Fly Ball — HR ÷ FB" },
    { key: "babip",   label: "BABIP", desc: "BABIP Against — (H − HR) ÷ (BIP − HR)" },
  ];
  // Which pitching heatmap keys are "lower is better" for the team (color
  // should still read hot/intense for LOW values) — passed as `invert` to
  // renderHeatGrid, same mechanism batting's oppAVG heatmap already used.
  // Every key not listed here (or listed as `false`) is higher-is-better.
  const PITCH_INVERT_MAP = {
    s: false, b: true, o: false, h: true, "1B": true, "2B": true, "3B": true,
    xbh: true, hr: true, er: true, k: false, bb: true, hbp: true, wp: true, bk: true,
    gb: false, fb: false, ld: false, pu: false,
    sPct: false, bPct: true, oPct: false, hBfPct: true, "1BPct": true, "2BPct": true, "3BPct": true,
    xbhPct: true, hrPct: true, erPct: true, kPct: false, bbPct: true, hbpPct: true, wpPct: true, bkPct: true,
    gbPct: false, fbPct: false, ldPct: false, puPct: false,
    era: true, whip: true, oppAvg: true, oppSlg: true, oppIso: true, oppObp: true, oppOps: true,
    bipPct: false, gbFb: false, hrFb: true, babip: true,
  };
  const togglePitchStat = (k) => setPitchStatSel((prev) => {
    const isOn = prev.has(k);
    if (!isOn && prev.size >= STAT_MAX) return prev;
    const next = new Set(prev);
    if (isOn) next.delete(k); else next.add(k);
    return next;
  });
  const selectedPitchStats = [...PITCH_ROW2].filter((s) => pitchStatSel.has(s.key));
  // Pitching table's FIXED counting line (always shown, not selectable) —
  // exactly the stats that used to be the deleted PITCH_ROW1 pills. `key`
  // drives `sortedColCls` (same metric keys the old pills used); the actual
  // per-pitcher value comes from `r[PITCHING_SORT_FIELD[key]]` (integers
  // throughout, so no `_fmtStatCell` needed — reuses the exact same
  // key→row-field map the click-sort already relies on) — mirrors batting's
  // `BATTING_COUNT_COLS` exactly.
  const PITCH_COUNT_COLS = [
    { key: "s",   label: "S" },
    { key: "b",   label: "B" },
    { key: "o",   label: "O" },
    { key: "h",   label: "H" },
    { key: "1B",  label: "1B" },
    { key: "2B",  label: "2B" },
    { key: "3B",  label: "3B" },
    { key: "xbh", label: "XBH" },
    { key: "hr",  label: "HR" },
    { key: "er",  label: "ER" },
    { key: "k",   label: "K" },
    { key: "bb",  label: "BB" },
    { key: "hbp", label: "HBP" },
    { key: "wp",  label: "WP" },
    { key: "bk",  label: "BK" },
    { key: "gb",  label: "GB" },
    { key: "fb",  label: "FB" },
    { key: "ld",  label: "LD" },
    { key: "pu",  label: "PU" },
  ];

  // Base-state labels: key = bitmask (bit0=1B, bit1=2B, bit2=3B)
  const BASE_LABELS = {
    0: "BASES EMPTY", 1: "ON 1ST",   2: "ON 2ND",    4: "ON 3RD",
    3: "1ST & 2ND",   5: "CORNERS",  6: "2ND & 3RD",  7: "LOADED",
  };
  const outsLabel = outs === "any" ? "ANY OUTS" : `${outs} ${outs === 1 ? "OUT" : "OUTS"}`;
  const baseLabel = mask === "any" ? "ANY BASE" : (BASE_LABELS[mask] || "??");
  const isRisp    = mask !== "any" && (mask & 6) !== 0;   // RISP = runner on 2B or 3B

  const sampleN   = computed ? computed.sampleN : 0;
  const rows      = computed ? computed.rows    : [];

  // Which table column (if any) is highlighted: whichever heatmap stat was
  // last clicked (`sortStat`) is the stat the table is currently sorted by,
  // so its header + every body cell in that column get the old leader-row
  // color instead. No heatmap clicked yet (`sortStat === null`, default
  // sort) → no column highlighted.
  const sortedColCls = (key) => (sortStat === key ? " split-col--sorted" : "");

  // Is a given base bit set in the current mask? Always false while mask === "any"
  // (the individual toggles read as "not filtering" when Any is selected).
  const baseOn = (bit) => mask !== "any" && ((mask >> bit) & 1);
  // Inline style for an active base button (team color fill + border).
  const baseBtnStyle = (bit) => baseOn(bit)
    ? { background: teamColor, borderColor: teamColor }
    : {};
  // Toggle one base bit; clicking a base while "any" is active jumps straight to
  // that single base state instead of XOR-ing against the (non-numeric) sentinel.
  const toggleBase = (bit) => setMask((m) => (m === "any" ? bit : m ^ bit));

  // ── Situational heatmap: labels + lookup + coloring ───────────────────────
  // Short (grid) and tooltip base-state labels for the heatmap, mask 0..7 —
  // matches the bit convention above (bit0=1B, bit1=2B, bit2=3B).
  const HEAT_LABELS = {
    any: "Any", 0: "Empty", 1: "1B", 2: "2B", 3: "1B2B", 4: "3B", 5: "1B3B", 6: "2B3B", 7: "LOADED",
  };
  const HEAT_TOOLTIP_LABELS = {
    any: "Any base occupied", 0: "Bases empty", 1: "1B", 2: "2B", 3: "1B2B", 4: "3B", 5: "1B3B", 6: "2B3B", 7: "Loaded",
  };
  const heatByKey = {};
  (heatData || []).forEach((c) => { heatByKey[`${c.mask}-${c.outs}`] = c; });
  const outsWord = (o) => (o === "any" ? "any outs" : (o === 1 ? "1 out" : `${o} outs`));
  // Which heatmap keys are plain counting stats vs. percents — everything
  // else (avg/obp/slg/ops/iso, and pitching's oppAvg/oppSlg/oppIso/oppObp/
  // oppOps/hrFb/babip) is a 3-decimal rate. `s`/`b`/`o`/`er`/`k`/`wp`/`bk`
  // are pitching-only counts; `h`/`hr`/`bb`/`1B`/`2B`/`3B`/`xbh`/`hbp`/`gb`/
  // `fb`/`ld`/`pu` are shared with batting (same integer formatting either
  // way, since batting/pitching heatmaps never render simultaneously).
  const HEAT_COUNT_KEYS  = new Set(["h", "2B", "3B", "hr", "rbi", "bb", "so", "tb", "r", "1B", "hbp", "ibb", "roe", "fc", "gb", "fb", "ld", "pu", "ks", "kl", "xbh", "s", "b", "o", "er", "k", "wp", "bk"]);
  const HEAT_PCT_KEYS    = new Set([
    "bbPct", "kPct", "hPct",
    "1BPct", "2BPct", "3BPct", "hrPct", "xbhPct", "ksPct", "klPct",
    "hbpPct", "ibbPct", "roePct", "fcPct", "gbPct", "fbPct", "ldPct", "puPct",
    "conPct", "bipPct",
    // Pitching-only percentages. NOTE: pitching's own "H%" pill is keyed
    // `hBfPct` (not `hPct`) specifically to avoid colliding with batting's
    // `hPct` above, which is deliberately EXCLUDED from this Set (it's
    // labeled "H/PA" and formatted as a 3-decimal ratio, not a percent).
    "sPct", "bPct", "oPct", "hBfPct", "erPct", "wpPct", "bkPct",
  ]);
  // Rate stats formatted to 2 decimals (WHIP-style) instead of the default
  // 3-decimal `_f3` (which oppAVG/oppOBP/AVG-family/GPA/HR-H/HR-FB/BABIP
  // still use) — includes both pitching (era/whip) and batting's row-3
  // advanced ratios (BB/K, AB/HR, RC, Tb/H, PA/SO, GB/FB, AB/RBI); `gbFb` is
  // shared between the two modes (both use 2-decimal formatting).
  const HEAT_TWODEC_KEYS = new Set(["whip", "era", "bbK", "abHr", "rc", "tbH", "paSo", "gbFb", "abRbi"]);
  // Formats a single `_row` value for the batting table's dynamic
  // selected-stat columns, reusing the exact same type-based rules the
  // heatmap cells use (see `_heatValueStr`): counts render as plain
  // integers, percents via `_fPct`, WHIP-style rates via `_f2`, everything
  // else (AVG-family, GPA, HR/H, HR/FB, BABIP, SECA, H/PA, …) via `_f3`.
  const _fmtStatCell = (value, key) => {
    if (value == null) return "—";
    if (HEAT_COUNT_KEYS.has(key))  return String(value);
    if (HEAT_PCT_KEYS.has(key))    return _fPct(value);
    if (HEAT_TWODEC_KEYS.has(key)) return _f2(value);
    return _f3(value);
  };
  // A cell rings when its mask AND outs both match the current selector state
  // exactly — works uniformly for concrete cells, the "any outs" column, the
  // new "any bases" row, and the any/any grand-total corner, since `mask`/
  // `outs` and `cell.mask`/`cell.outs` are always one of the same values
  // ("any" or a concrete number) on both sides.
  const isHeatSelected = (cell) => !!cell && mask === cell.mask && outs === cell.outs;
  // The single clicked cell — the last-clicked heatmap's stat key (`sortStat`)
  // AND the currently selected mask/outs — gets a yellow highlight layered on
  // top of (overriding) the value-based gradient, in ONLY that one heatmap.
  const isClickedCell = (cell, key) => !!cell && sortStat === key && mask === cell.mask && outs === cell.outs;
  // 0..1 "how team-favorable" a cell is for one metric, scaled against this
  // team's own populated cells for THAT metric; null below the sample
  // threshold (renders gray/dim). `invert` (pitching oppAVG) means lower is
  // better, so low-value cells still read "hot".
  const _heatIntensity = (cell, key, scale, invert) => {
    const v = cell ? cell[key] : null;
    if (!cell || v == null || cell.sample < HEAT_MIN_SAMPLE) return null;
    const { min, max } = scale;
    if (min == null || max == null || max === min) return 0.5;
    let t = (v - min) / (max - min);
    if (invert) t = 1 - t;
    return Math.max(0, Math.min(1, t));
  };
  const _heatCellStyle = (cell, key, scale, invert) => {
    const t = _heatIntensity(cell, key, scale, invert);
    if (t == null) return {};
    const pct = Math.round(10 + t * 75);   // 10%–85% of team color
    return { background: `color-mix(in srgb, ${teamColor} ${pct}%, transparent)` };
  };
  const _heatValueStr = (cell, key) => {
    const v = cell ? cell[key] : null;
    if (v == null) return "—";
    if (HEAT_COUNT_KEYS.has(key))  return String(v);
    if (HEAT_PCT_KEYS.has(key))    return _fPct(v);
    if (HEAT_TWODEC_KEYS.has(key)) return _f2(v);
    return _f3(v);
  };
  const _heatTooltip = (cell, key, metricName) => {
    const label = HEAT_TOOLTIP_LABELS[cell.mask] || "??";
    const sampleWord = isPitching ? "BF" : "PA";
    return `${label}, ${outsWord(cell.outs)} — ${metricName} ${_heatValueStr(cell, key)} (${cell.sample} ${sampleWord})`;
  };

  // One parameterized 9×4 base×out heatmap — rows are "Any" bases (grand
  // aggregate, first) then the 8 concrete base states; columns are "Any"
  // outs (first) then 0 / 1 / 2. Called once per SELECTED stat in batting
  // mode (any of the STAT_ROW2/3 entries, per `selectedStats`), or once
  // per selected pitching stat in pitching mode.
  const renderHeatGrid = (key, metricName, scale, invert) => (
    <div className="split-heat-col" key={key}>
      <div className="split-heat">
        <div className="split-heat__head">
          <span className="split-heat__label">{metricName}</span>
          <div
            className="split-heat__legend"
            title="Color intensity = team-favorable rate for that split; gray/dim = sample below 8"
          >
            <span className="split-heat__legend-end">LO</span>
            <span
              className="split-heat__legend-bar"
              style={{ background: `linear-gradient(to right, color-mix(in srgb, ${teamColor} 8%, transparent), ${teamColor})` }}
            />
            <span className="split-heat__legend-end">HI</span>
          </div>
        </div>
        <div className="split-heat__grid">
          <div className="split-heat__corner" aria-hidden="true" />
          {["any", 0, 1, 2].map((o) => (
            <div key={`hh-${key}-${o}`} className="split-heat__colhead mono">{o === "any" ? "Any" : o}</div>
          ))}
          {["any", 0, 1, 2, 3, 4, 5, 6, 7].map((m) => (
            <React.Fragment key={`hr-${key}-${m}`}>
              <div className="split-heat__rowhead mono">{HEAT_LABELS[m]}</div>
              {["any", 0, 1, 2].map((o) => {
                const cell = heatByKey[`${m}-${o}`];
                const selected = isHeatSelected(cell);
                const clicked = isClickedCell(cell, key);
                return (
                  <button
                    key={`${key}-${m}-${o}`}
                    type="button"
                    className={`split-heat__cell ${selected ? "split-heat__cell--selected" : ""} ${clicked ? "split-heat__cell--clicked" : ""}`}
                    style={_heatCellStyle(cell, key, scale, invert)}
                    onClick={() => { setMask(m); setOuts(o); setSortStat(key); }}
                    title={cell ? _heatTooltip(cell, key, metricName) : `${HEAT_TOOLTIP_LABELS[m]}, ${outsWord(o)}`}
                    aria-pressed={selected}
                    aria-label={cell ? _heatTooltip(cell, key, metricName) : `${HEAT_TOOLTIP_LABELS[m]}, ${outsWord(o)}`}
                  >
                    <span className="split-heat__cell-value mono">{_heatValueStr(cell, key)}</span>
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );

  // ── Empty state ─────────────────────────────────────────────────────────
  if (noPbp) {
    return (
      <div className="stats">
        <div className="loading-block">
          No play-by-play data available for this team yet.
        </div>
      </div>
    );
  }

  // ── Full render ───────────────────────────────────────────────────────────
  return (
    <div className="stats" style={{ "--split-sort-color": teamColor }}>

      {/* ── Situation selector ── */}
      <section className="stats-section">
        <div className="split-section-head">
          <Eyebrow>Select Situation</Eyebrow>

          {/* Batting / Pitching toggle — same look as the Players-tab toggle */}
          <div className="player-toggle" role="group" aria-label="Batting or pitching splits">
            <button
              className={`player-toggle__btn ${!isPitching ? "player-toggle__btn--active" : ""}`}
              onClick={() => setViewMode("batting")}
            >Batting</button>
            <button
              className={`player-toggle__btn ${isPitching ? "player-toggle__btn--active" : ""}`}
              onClick={() => setViewMode("pitching")}
            >Pitching</button>
          </div>
        </div>

        {/* Batting-only heatmap stat pickers — two rows: percentages
               (count-of-PA rates) / rates + advanced. Both share one
               `statSel` Set, so STAT_MAX=3 caps across both rows combined.
               (The former counting-stats row was removed — those stats are
               now always shown as the table's fixed counting line instead.) */}
        {!isPitching && (
          <div className="split-stat-toggle-rows">
            {renderStatRow(STAT_ROW2, "Select up to 3 batting stat heatmaps — percentages", statSel, toggleStat)}
            {renderStatRow(STAT_ROW3, "Select up to 3 batting stat heatmaps — rates and advanced", statSel, toggleStat)}
          </div>
        )}

        {/* Pitching-only heatmap stat picker — ONE row (percentages + rates).
               (The former counting-stats row was removed — those stats are
               now always shown as the table's fixed counting line instead,
               mirroring batting's own counting-line rebuild.) */}
        {isPitching && (
          <div className="split-stat-toggle-rows">
            {renderStatRow(PITCH_ROW2, "Select up to 3 pitching stat heatmaps — percentages and rates", pitchStatSel, togglePitchStat)}
          </div>
        )}

        <div className="split-controls">

          {/* Column 1: Diamond base selector */}
          <div className="split-diamond-wrap">
            <div className="split-diamond">
              {/* Rotated-square field outline */}
              <div className="split-diamond__field" />
              {/* Pitcher's mound center dot */}
              <div className="split-diamond__dot" />
              {/* Static home plate */}
              <div className="split-diamond__plate" />

              {/* 2B — top vertex (bit 1, toggle = mask ^ 2) */}
              <button
                className="split-base split-base--2b"
                onClick={() => toggleBase(2)}
                style={baseBtnStyle(1)}
                aria-pressed={!!baseOn(1)}
                aria-label="Toggle second base"
              />
              {/* 1B — right vertex (bit 0, toggle = mask ^ 1) */}
              <button
                className="split-base split-base--1b"
                onClick={() => toggleBase(1)}
                style={baseBtnStyle(0)}
                aria-pressed={!!baseOn(0)}
                aria-label="Toggle first base"
              />
              {/* 3B — left vertex (bit 2, toggle = mask ^ 4) */}
              <button
                className="split-base split-base--3b"
                onClick={() => toggleBase(4)}
                style={baseBtnStyle(2)}
                aria-pressed={!!baseOn(2)}
                aria-label="Toggle third base"
              />

              {/* Base labels */}
              <span className="split-base-label split-base-label--2b">2B</span>
              <span className="split-base-label split-base-label--1b">1B</span>
              <span className="split-base-label split-base-label--3b">3B</span>
            </div>

            {/* Any base — aggregates masks 1-7 (runners on) for the selected outs */}
            <button
              className="split-any-btn split-base-any"
              onClick={() => setMask("any")}
              style={mask === "any"
                ? { background: teamColor, borderColor: teamColor, color: teamInk }
                : {}}
              aria-pressed={mask === "any"}
              aria-label="Any base occupied"
            >Any</button>
          </div>

          {/* Column 2: Situation summary + outs control */}
          <div className="split-summary">
            <div className="split-summary__head">
              <span className="split-summary__eyebrow">BASE / OUT STATE</span>
              {isRisp && (
                <span
                  className="split-risp-chip"
                  style={{
                    color: teamColor,
                    borderColor: teamColor,
                    background: `color-mix(in srgb, ${teamColor} 13%, transparent)`,
                  }}
                >RISP</span>
              )}
            </div>

            {/* Big mono score line in team color — baserunner state and outs on separate lines */}
            <div className="split-score-line mono" style={{ color: teamColor }}>
              <div>{baseLabel}</div>
              <div>{outsLabel}</div>
            </div>

            {/* Plate-appearance / batters-faced count */}
            <div className="split-pa-count mono">
              {sampleN} {isPitching ? "batters faced" : "plate appearances"} in this split
            </div>

            {/* Outs selector: "-" (any outs) / 0 / 1 / 2, one inline row —
                   mirrors the heatmap's own "-", 0, 1, 2 out-column order and
                   shares the same `outs` state, so the two stay in sync. */}
            <div className="split-outs">
              <span className="split-outs__label">OUTS</span>
              <div className="split-outs__controls">
                {["any", 0, 1, 2].map((n) => {
                  const active = outs === n;
                  return (
                    <div
                      key={n}
                      className="split-out-dot-wrap"
                      onClick={() => setOuts(n)}
                      role="button"
                      aria-pressed={active}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOuts(n); }}
                    >
                      <span
                        className="split-out-dot"
                        style={active ? { background: teamColor, borderColor: teamColor } : {}}
                      />
                      <span
                        className="split-out-dot__label mono"
                        style={active ? { color: teamColor } : {}}
                      >{n === "any" ? "Any" : n}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Columns 3+: base/out heatmap(s) — one per SELECTED stat, in
                 canonical order, for whichever mode is active (batting:
                 `selectedStats`/STAT_ROW2+3; pitching: `selectedPitchStats`/
                 PITCH_ROW2, with per-metric invert via PITCH_INVERT_MAP
                 so "lower is better" stats still read hot when low).
                 Click a cell to jump mask+outs to it. */}
          {!heatData ? (
            <div className="split-heat-col">
              <div className="split-heat">
                <div className="split-heat__empty muted small">No situational data yet.</div>
              </div>
            </div>
          ) : isPitching ? (
            selectedPitchStats.length === 0 ? (
              <div className="split-heat-col">
                <div className="split-heat">
                  <div className="split-heat__empty muted small">Select a stat above to see its heatmap.</div>
                </div>
              </div>
            ) : (
              <React.Fragment>
                {selectedPitchStats.map((s) => renderHeatGrid(s.key, `TEAM ${s.label}`, heatScales[s.key], PITCH_INVERT_MAP[s.key]))}
              </React.Fragment>
            )
          ) : selectedStats.length === 0 ? (
            <div className="split-heat-col">
              <div className="split-heat">
                <div className="split-heat__empty muted small">Select a stat above to see its heatmap.</div>
              </div>
            </div>
          ) : (
            <React.Fragment>
              {selectedStats.map((s) => renderHeatGrid(s.key, `TEAM ${s.label}`, heatScales[s.key], BATTING_LOWER_BETTER.has(s.key)))}
            </React.Fragment>
          )}

          {/* Column 4 (pitching only): Batter-handedness selector, on the same
                 row as the diamond and outs. L/R are visual placeholders only
                 (no handedness data exists yet); "Any" is live.
                 Gated behind SHOW_HANDEDNESS — hidden for now, kept in place. */}
          {SHOW_HANDEDNESS && isPitching && (
            <div className="split-hand-col">
              <span className="split-hand-col__eyebrow">BATTER HANDEDNESS</span>
              <div className="split-hand">
                <div className="split-hand__row">
                  <button
                    className="split-hand__box split-hand__box--l"
                    disabled
                    title="Batter-handedness splits are coming soon"
                    aria-label="Versus left-handed batters (coming soon)"
                  >
                    <span className="split-hand__box-letter">L</span>
                    <span className="split-hand__box-sub">vs LHB</span>
                  </button>
                  <div className="split-hand__plate" />
                  <button
                    className="split-hand__box split-hand__box--r"
                    disabled
                    title="Batter-handedness splits are coming soon"
                    aria-label="Versus right-handed batters (coming soon)"
                  >
                    <span className="split-hand__box-letter">R</span>
                    <span className="split-hand__box-sub">vs RHB</span>
                  </button>
                </div>
                <button
                  className={`split-hand__any ${hand === "any" ? "split-hand__any--active" : ""}`}
                  style={hand === "any" ? { background: teamColor, borderColor: teamColor, color: teamInk } : {}}
                  onClick={() => setHand("any")}
                  aria-pressed={hand === "any"}
                >ANY</button>
              </div>
            </div>
          )}

        </div>
      </section>

      {/* ── Per-player splits table ── */}
      {noRowsForView ? (
        <div className="loading-block">
          {isPitching
            ? "No pitching split data available for this team yet."
            : "No batting split data available for this team yet."}
        </div>
      ) : isPitching ? (
        <div className="boxscore__wrap">
          <table className="box-table player-table split-table">
            <thead>
              <tr>
                <th className="th th--left split-th-num">#</th>
                <th className="th th--left">PITCHER</th>
                <th className="th th--left split-th-pos">POS</th>
                <th className="th th--right split-th-cnt">BF</th>
                <th className="th th--right split-th-rate">IP</th>
                {PITCH_COUNT_COLS.map((c) => (
                  <th
                    key={c.key}
                    className={`th th--right split-th-cnt${sortedColCls(c.key)}`}
                  >{c.label}</th>
                ))}
                {selectedPitchStats.map((s) => (
                  <th
                    key={s.key}
                    className={`th th--right split-th-rate${sortedColCls(s.key)}`}
                  >{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isDim  = r.BF < 4;
                const rowCls = "split-row" + (isDim ? " split-row--dim" : "");
                return (
                  <tr key={`${r.num}-${r.name}`} className={rowCls}>
                    <td className="td mono muted small">{r.num}</td>
                    <td className="td"><span className="player-name">{r.name}</span></td>
                    <td className="td mono small muted">{r.pos}</td>
                    <td className="td td--right mono">{r.BF}</td>
                    <td className="td td--right mono">{r.ip}</td>
                    {PITCH_COUNT_COLS.map((c) => (
                      <td
                        key={c.key}
                        className={`td td--right mono${sortedColCls(c.key)}`}
                      >{r[PITCHING_SORT_FIELD[c.key]]}</td>
                    ))}
                    {selectedPitchStats.map((s) => (
                      <td
                        key={s.key}
                        className={`td td--right mono${sortedColCls(s.key)}`}
                      >{_fmtStatCell(r[PITCHING_SORT_FIELD[s.key]], s.key)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="boxscore__wrap">
          <table className="box-table player-table split-table">
            <thead>
              <tr>
                <th className="th th--left split-th-num">#</th>
                <th className="th th--left">BATTER</th>
                <th className="th th--left split-th-pos">POS</th>
                <th className="th th--right split-th-cnt">PA</th>
                <th className="th th--right split-th-cnt">AB</th>
                {BATTING_COUNT_COLS.map((c) => (
                  <th
                    key={c.key}
                    className={`th th--right split-th-cnt${sortedColCls(c.key)}`}
                  >{c.label}</th>
                ))}
                {selectedStats.map((s) => (
                  <th
                    key={s.key}
                    className={`th th--right split-th-rate${sortedColCls(s.key)}`}
                  >{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isDim  = r.PA < 4;
                const rowCls = "split-row" + (isDim ? " split-row--dim" : "");
                return (
                  <tr key={`${r.num}-${r.name}`} className={rowCls}>
                    <td className="td mono muted small">{r.num}</td>
                    <td className="td"><span className="player-name">{r.name}</span></td>
                    <td className="td mono small muted">{r.pos}</td>
                    <td className="td td--right mono">{r.PA}</td>
                    <td className="td td--right mono">{r.AB}</td>
                    {BATTING_COUNT_COLS.map((c) => (
                      <td
                        key={c.key}
                        className={`td td--right mono${sortedColCls(c.key)}`}
                      >{r[BATTING_SORT_FIELD[c.key]]}</td>
                    ))}
                    {selectedStats.map((s) => (
                      <td
                        key={s.key}
                        className={`td td--right mono${sortedColCls(s.key)}`}
                      >{_fmtStatCell(r[BATTING_SORT_FIELD[s.key]], s.key)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Coverage footnote — only when PBP coverage is partial */}
      {data.gamesWithPbp < data.gamesTotal && (
        <div className="player-note muted small">
          Based on {data.gamesWithPbp} of {data.gamesTotal} games with play-by-play data.
        </div>
      )}

    </div>
  );
};
