// stage_page.jsx — postseason "stage" homepages (Broadcast Bold), one reusable
// component (StagePage) driven by a per-phase config built from real data.
// Phases: sec_tournament, regionals, super_regionals, cws, cws_finals.
// Reuses the .bbx theme tokens + home.jsx atoms (HPLogo, hpSecTeams).

/* ---------- static per-phase facts (venue/format/dates from the design) ---------- */
const STAGE_META = {
  sec_tournament: {
    stage: 1, title: "SEC TOURNAMENT", dates: "MAY 19–24", round: "SEC Tournament",
    meta: [["LOCATION", "Hoover, AL"], ["VENUE", "Hoover Metropolitan Stadium"],
           ["FORMAT", "Double Elimination"]],
    featuredTag: "HEADLINER", scheduleTitle: "TODAY'S GAMES", fieldTitle: "THE FIELD",
  },
  regionals: {
    stage: 2, title: "NCAA REGIONALS", dates: "MAY 29 – JUN 1", round: "NCAA Regional",
    meta: [["FIELD", "64 Teams · 16 Regionals"], ["FORMAT", "4-Team Double Elim"]],
    featuredTag: "GAME OF THE DAY", scheduleTitle: "TODAY'S GAMES", fieldTitle: "SEC IN THE REGIONALS",
  },
  super_regionals: {
    stage: 3, title: "SUPER REGIONALS", dates: "JUN 6–9", round: "NCAA Super Regional",
    meta: [["FIELD", "16 Teams · 8 Series"], ["FORMAT", "Best-of-3 Series"]],
    featuredTag: "SERIES OF THE DAY", scheduleTitle: "TODAY'S GAMES", fieldTitle: "SEC IN THE SUPERS",
  },
  cws: {
    stage: 4, title: "COLLEGE WORLD SERIES", dates: "JUN 13–22", round: "College World Series",
    meta: [["LOCATION", "Omaha, NE"], ["VENUE", "Charles Schwab Field"], ["FORMAT", "8 Teams · 2 Brackets"]],
    featuredTag: "GAME OF THE DAY", scheduleTitle: "TODAY IN OMAHA", fieldTitle: "THE OMAHA EIGHT",
  },
  cws_finals: {
    stage: 5, title: "CWS FINALS", dates: "NATIONAL CHAMPIONSHIP", round: "College World Series",
    meta: [["SERIES", "Best-of-3"], ["VENUE", "Charles Schwab Field · Omaha"]],
    featuredTag: "FOR THE NATIONAL TITLE", scheduleTitle: "CHAMPIONSHIP SERIES", fieldTitle: "",
    hideTicker: true,
  },
};
const ROUND_ORDER = ["SEC Tournament", "NCAA Regional", "NCAA Super Regional", "College World Series"];

/* ---------- real-data helpers ---------- */
function stgToday() { return (window.SEASON_CLOCK || {}).today || window.SEASON_UPDATED; }
function stgAbbr(t) { return (t && (t.mark || (t.name || "").slice(0, 3).toUpperCase())) || "—"; }
function stgRec(t) { return t && t.ovrW != null ? `${t.ovrW}–${t.ovrL}` : ""; }

// All games (deduped) on a given iso, both teams resolved + scores oriented home/away.
function stgGamesOn(day) {
  const sch = window.SCHEDULES || {}, byId = window.TEAM_BY_ID || {}, seen = new Set(), out = [];
  for (const seo in sch) for (const g of sch[seo] || []) {
    if (!g.iso || g.iso !== day || seen.has(g.id)) continue;
    seen.add(g.id);
    const me = byId[seo], opp = (g.opp && byId[g.opp.id]) || g.opp || null;
    const home = g.home ? me : opp, away = g.home ? opp : me;
    const hs = g.home ? (g.score && g.score.us) : (g.score && g.score.them);
    const as = g.home ? (g.score && g.score.them) : (g.score && g.score.us);
    out.push({ g, hostId: seo, home, away, hs, as, final: !!g.result,
               time: g.time, phase: g.phase || "regular" });
  }
  return out;
}
// The day to show: today if it has games, else the most recent prior date with games.
function stgDay() {
  const today = stgToday();
  if (stgGamesOn(today).length) return today;
  const sch = window.SCHEDULES || {};
  const dates = [];
  for (const seo in sch) for (const g of sch[seo] || []) if (g.iso && g.iso <= today && g.result) dates.push(g.iso);
  dates.sort();
  return dates[dates.length - 1] || today;
}

// Has the team actually PLAYED a round later than `round` (advanced past it)?
// Only counts games with a result, so in the time machine a future round that's
// still on the schedule (result cleared) doesn't read as "advanced".
function stgAdvancedPast(sched, round) {
  const i = ROUND_ORDER.indexOf(round);
  return (sched || []).some((g) => g.result && ROUND_ORDER.indexOf(g.phase) > i);
}
// Status tag for a team in the current round, from its W/L there + whether it moved on.
function stgStatus(phase, wins, losses, advanced) {
  const champ = phase === "cws_finals";
  if (phase === "super_regionals" || champ) {
    if (advanced) return { tag: "ADVANCED", kind: "good" };
    if (losses >= 2) return { tag: "ELIMINATED", kind: "bad" };
    if (wins >= 2) return { tag: champ ? "CHAMPION" : "ADVANCED", kind: "good" };
    if (wins > losses) return { tag: `LEADS ${wins}–${losses}`, kind: "warn" };
    if (losses > wins) return { tag: `TRAILS ${wins}–${losses}`, kind: "warn" };
    return { tag: wins + losses ? `TIED ${wins}–${losses}` : "GAME 1", kind: "warn" };
  }
  if (advanced) return { tag: "ADVANCED", kind: "good" };
  if (losses >= 2) return { tag: "ELIMINATED", kind: "bad" };
  if (wins + losses === 0) return { tag: "UPCOMING", kind: "warn" };
  return { tag: "ALIVE", kind: "good" };
}

// A team's display seed for the phase: SEC standing for the conference tournament,
// national rank otherwise.
function stgSeedOf(phase, team) {
  if (phase === "sec_tournament") {
    const i = hpSecTeams().findIndex((t) => t.id === (team && team.id));
    return i >= 0 ? i + 1 : "—";
  }
  return (team && team.rank) || "—";
}

// {seo: official national seed (1–16)} from the bracket — only the 16 host seeds
// carry a national seed; everyone else is unseeded.
function stgSeedMap(data) {
  const r1 = ((data && data.rounds) || []).find((r) => r.number === 1);
  const map = {};
  for (const g of (r1 ? r1.groups : []) || [])
    for (const t of g.teams || []) if (t.seed != null) map[t.seo] = t.seed;
  return map;
}

// SEC teams in the current round, with seed + record + status tag. `seedMap` (when
// supplied) gives official national seeds; the SEC tournament uses standing order.
function stgField(phase, seedMap) {
  const round = STAGE_META[phase].round;
  const teams = hpSecTeams();
  const out = [];
  teams.forEach((t, idx) => {
    const sched = (window.SCHEDULES || {})[t.id] || [];
    const inRound = sched.filter((g) => (g.phase || "regular") === round);
    if (!inRound.length) return;                       // not part of this round
    const played = inRound.filter((g) => g.result);
    const wins = played.filter((g) => g.result === "W").length;
    const losses = played.filter((g) => g.result === "L").length;
    const adv = stgAdvancedPast(sched, round);
    const st = stgStatus(phase, wins, losses, adv);
    // Seed: SEC standing for the conf tournament, official national seed (from the
    // bracket) for the NCAA rounds; unseeded teams show "—".
    const seed = phase === "sec_tournament" ? idx + 1
               : (seedMap && seedMap[t.id] != null ? seedMap[t.id] : "—");
    const lastOpp = (played[played.length - 1] || inRound[inRound.length - 1] || {}).opp;
    out.push({ team: t, seed, rec: stgRec(t), tag: st.tag, kind: st.kind,
               sub: lastOpp ? `vs ${lastOpp.name}` : "" });
  });
  // Always seeded order (seeded ascending, unseeded last) — eliminated teams keep
  // their seed position instead of sinking to the bottom.
  return out.sort((a, b) => (typeof a.seed === "number" ? a.seed : 999)
                          - (typeof b.seed === "number" ? b.seed : 999));
}

// The most relevant date for a round: today if it has games of that round, else
// the soonest upcoming round date (preview day), else the most recent one. Keeps a
// stage focused on its own round even on the gap days between rounds.
function stgRoundDay(round) {
  const today = stgToday();
  const dates = new Set();
  const sch = window.SCHEDULES || {};
  for (const seo in sch) for (const g of sch[seo] || [])
    if (g.iso && (g.phase || "regular") === round) dates.add(g.iso);
  const arr = [...dates].sort();
  if (arr.indexOf(today) >= 0) return today;
  const up = arr.find((d) => d > today);
  if (up) return up;
  return arr.length ? arr[arr.length - 1] : today;
}

// rows (from stgGamesOn) shaped for the schedule list.
function stgScheduleFrom(rows) {
  return rows.map((r) => ({
    game: r.g, hostId: r.hostId,
    status: r.final ? "FINAL" : (r.time || "TBD"),
    done: r.final, live: false,
    a: { team: r.away, rec: stgRec(r.away) }, b: { team: r.home, rec: stgRec(r.home) },
    sa: r.as, sb: r.hs,
    when: r.final ? "Final" : (r.time || "TBD"),
  }));
}

// Featured matchup = the marquee game among `rows` (two best teams by rank).
function stgFeatured(phase, rows, day) {
  if (!rows.length) return null;
  const seed = (g) => ((g.home && g.home.rank) || 50) + ((g.away && g.away.rank) || 50);
  const best = rows.slice().sort((x, y) => seed(x) - seed(y))[0];
  const center = best.final
    ? { top: "FINAL", big: `${best.hs}–${best.as}`, bot: "" }
    : { top: "FIRST PITCH", big: best.time || "TBD", bot: "" };
  return {
    tag: STAGE_META[phase].featuredTag,
    round: STAGE_META[phase].title,
    game: best.g, hostId: best.hostId,
    a: { team: best.home, seed: stgSeedOf(phase, best.home), label: "HOME", rec: stgRec(best.home) },
    b: { team: best.away, seed: stgSeedOf(phase, best.away), label: "AWAY", rec: stgRec(best.away) },
    center,
    strip: [["DATE", best.g.date || day], ["MATCHUP", `${stgAbbr(best.away)} @ ${stgAbbr(best.home)}`],
            ["ROUND", STAGE_META[phase].title], ["STATUS", best.final ? "Final" : "Upcoming"]],
  };
}

// Players to watch — four DISTINCT real conference leaders (a player who leads two
// categories only takes one card; the next category fills with someone new).
function stgPlayers(leaders) {
  if (!leaders) return [];
  const byId = window.TEAM_BY_ID || {};
  const cats = [["avg", "AVG"], ["hr", "HR"], ["rbi", "RBI"], ["era", "ERA"], ["k", "K"], ["whip", "WHIP"]];
  const seen = new Set(), out = [];
  for (const [key, lbl] of cats) {
    if (out.length >= 4) break;
    const top = ((leaders[key] || {}).list || []).find((r) => !seen.has(r.player));
    if (!top) continue;
    seen.add(top.player);
    out.push({ team: byId[top.team], pos: top.pos, name: top.player,
               line: [[top.value, lbl]], note: `SEC leader · ${(leaders[key] || {}).label || lbl}` });
  }
  return out;
}

/* ---------- CWS: sourced from the NCAA bracket (no CWS box scores exist yet) ---------- */
// Resolve a bracket team slot to a renderable team (SEC teams get their full object).
function stgBracketTeam(s) {
  if (!s || !s.seo) return null;
  return (window.TEAM_BY_ID || {})[s.seo]
      || { id: s.seo, name: s.name, logo: s.logo, mark: (s.name || "").slice(0, 4).toUpperCase() };
}
// The Omaha Eight, grouped by bracket, with elimination status from each half's games.
function stgCwsField(data) {
  const halves = (data && data.center && data.center.halves) || {};
  const byId = window.TEAM_BY_ID || {};
  const out = [];
  ["left", "right"].forEach((side, bi) => {
    const h = halves[side];
    if (!h) return;
    const losses = {};
    for (const g of h.games || []) for (const s of [g.top, g.bottom])
      if (s && s.seo && g.state === "F" && !s.winner) losses[s.seo] = (losses[s.seo] || 0) + 1;
    (h.teams || []).forEach((t) => {
      const team = stgBracketTeam(t);
      const isOut = (losses[t.seo] || 0) >= 2;
      const champ = h.winner === t.seo;
      out.push({ team, seed: t.seed || "—", rec: byId[t.seo] ? stgRec(byId[t.seo]) : "",
                 sub: `Bracket ${bi + 1}`, tag: champ ? "BRACKET FINAL" : isOut ? "ELIMINATED" : "ALIVE",
                 kind: champ ? "good" : isOut ? "bad" : "warn" });
    });
  });
  return out;
}
// CWS games (both halves + finals) shaped for the schedule list.
function stgCwsGames(data) {
  const c = (data && data.center) || {};
  const halves = c.halves || {};
  const games = [];
  ["left", "right"].forEach((side) => (halves[side] && halves[side].games || []).forEach((g) => games.push(g)));
  (c.finals && (c.finals.games || (c.finals.top || c.finals.bottom ? [c.finals] : [])) || []).forEach((g) => games.push(g));
  return games
    .filter((g) => g.top && g.bottom && g.top.seo && g.bottom.seo)
    .map((g) => {
      const a = stgBracketTeam(g.top), b = stgBracketTeam(g.bottom);
      const done = g.state === "F";
      return { game: null, status: done ? "FINAL" : "TBD", done, live: g.state === "I",
               a: { team: a, rec: "" }, b: { team: b, rec: "" },
               sa: g.top.score, sb: g.bottom.score, when: done ? "Final" : "TBD" };
    });
}
function stgCwsFeatured(data) {
  const games = stgCwsGames(data);
  if (!games.length) return null;
  const byId = window.TEAM_BY_ID || {};
  const isSec = (g) => (g.a.team && byId[g.a.team.id]) || (g.b.team && byId[g.b.team.id]);
  // Prefer a finished SEC game, then any SEC game, then anything.
  const g = games.find((x) => x.done && isSec(x)) || games.find(isSec)
            || games.find((x) => x.done) || games[0];
  return {
    tag: STAGE_META.cws.featuredTag, round: STAGE_META.cws.title, game: null,
    a: { team: g.a.team, seed: (g.a.team && g.a.team.rank) || "—", label: "BRACKET", rec: stgRec(g.a.team) },
    b: { team: g.b.team, seed: (g.b.team && g.b.team.rank) || "—", label: "BRACKET", rec: stgRec(g.b.team) },
    center: g.done ? { top: "FINAL", big: `${g.sa}–${g.sb}`, bot: "" } : { top: "OMAHA", big: "VS", bot: "" },
    strip: [["VENUE", "Charles Schwab Field"], ["CITY", "Omaha, NE"],
            ["FORMAT", "Double Elimination"], ["NEXT", "Bracket Finals"]],
  };
}
// Finals head-to-head from the two CWS finalists (bracket half champions).
function stgFinalsCompare(data) {
  const halves = (data && data.center && data.center.halves) || {};
  const champ = (side) => {
    const h = halves[side]; if (!h || !h.winner) return null;
    return stgBracketTeam((h.teams || []).find((t) => t.seo === h.winner) || { seo: h.winner });
  };
  let a = champ("left"), b = champ("right");
  // Until both bracket champions are set, fall back to the top SEC team in each half.
  if (!a || !b) {
    const byId = window.TEAM_BY_ID || {};
    const secOf = (side) => ((halves[side] || {}).teams || [])
      .map((t) => byId[t.seo]).filter(Boolean).sort((x, y) => (x.rank || 99) - (y.rank || 99))[0];
    a = a || secOf("left"); b = b || secOf("right");
  }
  if (!a || !b) return null;
  const aT = (window.TEAM_BY_ID || {})[a.id] || a, bT = (window.TEAM_BY_ID || {})[b.id] || b;
  const num = (v) => (v == null ? 999 : v);
  return {
    title: "FINALISTS · HEAD-TO-HEAD", a: aT, b: bT,
    rows: [
      aT.ovrW != null && bT.ovrW != null ? { label: "OVERALL", a: `${aT.ovrW}–${aT.ovrL}`, b: `${bT.ovrW}–${bT.ovrL}`,
        aWins: (aT.ovrW / Math.max(aT.ovrW + aT.ovrL, 1)) >= (bT.ovrW / Math.max(bT.ovrW + bT.ovrL, 1)) } : null,
      aT.confW != null && bT.confW != null ? { label: "SEC RECORD", a: `${aT.confW}–${aT.confL}`, b: `${bT.confW}–${bT.confL}`,
        aWins: (aT.confW / Math.max(aT.confW + aT.confL, 1)) >= (bT.confW / Math.max(bT.confW + bT.confL, 1)) } : null,
      { label: "NAT'L RANK", a: aT.rank ? `#${aT.rank}` : "—", b: bT.rank ? `#${bT.rank}` : "—", aWins: num(aT.rank) <= num(bT.rank) },
      aT.rpi != null && bT.rpi != null ? { label: "RPI", a: `#${aT.rpi}`, b: `#${bT.rpi}`, aWins: num(aT.rpi) <= num(bT.rpi) } : null,
    ].filter(Boolean),
  };
}

/* ---------- Regionals: a tracker board of every SEC regional ---------- */
// One card per regional that contains an SEC team: host city + its 4 teams with
// live advanced/alive/eliminated status, from the bracket.
function stgRegionalTracker(data, today) {
  const r1 = ((data && data.rounds) || []).find((r) => r.number === 1);
  if (!r1) return null;
  const byId = window.TEAM_BY_ID || {};
  const cards = [];
  for (const g of r1.groups || []) {
    if (!(g.teams || []).some((t) => byId[t.seo])) continue;   // SEC-relevant only
    // Date-aware: only count games on/before the effective date, so in the time
    // machine the regional reads as live, not already finished.
    const losses = {};
    for (const gm of g.games || []) {
      if (gm.state !== "F" || (today && bIso(gm.date) > today)) continue;
      for (const s of [gm.top, gm.bottom])
        if (s && s.seo && !s.winner) losses[s.seo] = (losses[s.seo] || 0) + 1;
    }
    const teamList = g.teams || [];
    const aliveSeos = teamList.filter((t) => (losses[t.seo] || 0) < 2);
    const champ = aliveSeos.length === 1 ? aliveSeos[0].seo : null;   // decided by today
    const teams = teamList.map((t) => {
      const won = champ === t.seo, isOut = (losses[t.seo] || 0) >= 2;
      return { team: stgBracketTeam(t), rseed: t.rseed || t.seed || "",
               kind: won ? "good" : isOut ? "bad" : "warn",
               tag: won ? "ADVANCED" : isOut ? "OUT" : "" };
    });
    cards.push({ city: g.city || g.label, seed: g.seed, teams, decided: !!champ });
  }
  // Decided regionals (a team advanced) float to the top — that's the news.
  cards.sort((a, b) => (b.decided ? 1 : 0) - (a.decided ? 1 : 0));
  return { title: "SEC REGIONALS", cards };
}

// "What's at stake today" — one card per SEC team playing a regional game today,
// classified from that team's record in the regional coming in. Built from real
// (deduped) team schedules, not the bracket slot list (which carries projections).
function stgStakes(today) {
  if (!today) return null;
  const byId = window.TEAM_BY_ID || {};
  const seen = new Set();
  const out = [];
  const lossesBeforeToday = (sched) => sched.filter(
    (g) => (g.phase || "regular") === "NCAA Regional" && g.iso < today && g.result === "L").length;
  for (const t of hpSecTeams()) {
    const sched = (window.SCHEDULES || {})[t.id] || [];
    const reg = sched.filter((g) => (g.phase || "regular") === "NCAA Regional");
    const game = reg.find((g) => g.iso === today);
    if (!game || seen.has(game.id)) continue;
    seen.add(game.id);
    const opp = (game.opp && byId[game.opp.id]) || game.opp || null;
    const myLoss = lossesBeforeToday(reg);
    const myWin = reg.filter((g) => g.iso < today && g.result === "W").length;
    const oppLoss = opp && byId[opp.id] ? lossesBeforeToday((window.SCHEDULES || {})[opp.id] || []) : null;
    let stake, kind;
    if (myWin >= 2) { stake = "REGIONAL FINAL · win to Supers"; kind = "good"; }      // cleared the bracket
    else if (myLoss >= 1) { stake = "WIN OR GO HOME"; kind = "bad"; }                 // one loss from out
    else { stake = "WINNERS' BRACKET"; kind = "warn"; }
    out.push({ a: t, b: opp, sa: game.score && game.score.us, sb: game.score && game.score.them,
               done: !!game.result, live: false, aElim: myLoss >= 1, bElim: oppLoss != null && oppLoss >= 1,
               city: (window.REGIONAL_CITY_BY_TEAM || {})[t.id] || "", stake, kind });
  }
  const rank = { good: 0, bad: 1, warn: 2 };
  out.sort((x, y) => rank[x.kind] - rank[y.kind]);
  return out.length ? { title: "WHAT'S AT STAKE TODAY", games: out } : null;
}

function StageStakes({ stakes, onTeam }) {
  const Row = ({ t, sc, elim, done }) => (
    <button className="stg-stk__team" onClick={() => t && onTeam && onTeam(t.id)}>
      <HPLogo team={t} size={22} />
      <span className="stg-stk__nm">{(t && t.name) || "TBD"}</span>
      {elim && <span className="stg-stk__elim">ELIM</span>}
      {done && <span className="stg-stk__sc">{sc}</span>}
    </button>
  );
  return (
    <div className="bbx-section">
      <div className="bbx-eyebrow-row">
        <span className="bbx-eyebrow bbx-gold">★ {stakes.title}</span>
        <span className="bbx-rule" />
        <span className="bbx-eyebrow bbx-faint">REGIONALS</span>
      </div>
      <div className="stg-stk">
        {stakes.games.map((g, i) => (
          <div key={i} className={"stg-stk__card stg-stk__card--" + g.kind}>
            <div className="stg-stk__head">
              <span className={"stg-tag stg-tag--" + g.kind}>{g.stake}</span>
              <span className="mono stg-faint stg-stk__city">{g.city}</span>
            </div>
            <Row t={g.a} sc={g.sa} elim={g.aElim} done={g.done} />
            <Row t={g.b} sc={g.sb} elim={g.bElim} done={g.done} />
            <div className="mono stg-stk__status">{g.done ? "FINAL" : g.live ? "● LIVE" : "TODAY"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StageTracker({ tracker, onTeam }) {
  return (
    <div className="bbx-section">
      <div className="bbx-eyebrow-row">
        <span className="bbx-eyebrow bbx-gold">★ {tracker.title}</span>
        <span className="bbx-rule" />
        <span className="bbx-eyebrow bbx-faint">REGIONAL TRACKER</span>
      </div>
      <div className="stg-track">
        {tracker.cards.map((c, i) => (
          <div key={i} className={"stg-track__card" + (c.decided ? " stg-track__card--done" : "")}>
            <div className="stg-track__head">
              {c.seed != null && c.seed !== "—" && <span className="stg-track__seed">#{c.seed}</span>}
              <span className="stg-track__city">{c.city} Regional</span>
            </div>
            {c.teams.map((t, j) => (
              <button key={j} className={"stg-track__team stg-track__team--" + t.kind}
                      onClick={() => t.team && onTeam && onTeam(t.team.id)}>
                <span className="stg-track__rseed">{t.rseed}</span>
                <HPLogo team={t.team} size={20} />
                <span className="stg-track__nm">{(t.team && t.team.name) || "TBD"}</span>
                {t.tag && <span className={"stg-tag stg-tag--" + t.kind}>{t.tag}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- presentational ---------- */
function StatusPill({ s, live }) {
  const fin = s === "FINAL";
  return <span className={"stg-pill " + (live ? "stg-pill--live" : fin ? "stg-pill--fin" : "stg-pill--up")}>
    {live ? "● LIVE" : s}</span>;
}

// Reuses the regular homepage's .bbx-hero classes (crest medallion, positioning,
// gradient, fonts) so any tweak there carries over; only the seed badge + center
// chip are stage-specific.
function StageHero({ f, onGame }) {
  const click = f.game && onGame && f.game.result ? () => onGame(f.game, f.hostId) : null;
  const Side = ({ s, side }) => {
    const t = s.team, color = (t && t.color) || "#333";
    const dir = side === "home" ? "135deg" : "225deg";
    return (
      <div className={"bbx-hero__side bbx-hero__side--" + side}
           style={{ background: `linear-gradient(${dir}, ${color} 0%, rgba(0,0,0,0.72) 100%)` }}>
        <div className="bbx-hero__tag">{s.label}</div>
        <div className="bbx-hero__name">{(t && (t.name || "").toUpperCase()) || "TBD"}</div>
        <div className="bbx-hero__rec">{s.rec}</div>
        {s.seed != null && s.seed !== "—" && (
          <div className="stg-hero__seed"><span>SEED</span>{s.seed}</div>)}
        <div className="bbx-hero__crest"><HPLogo team={t} size={116} /></div>
      </div>
    );
  };
  return (
    <div className="bbx-section">
      <div className="bbx-eyebrow-row">
        <span className="bbx-eyebrow bbx-gold">★ {f.tag}</span>
        <span className="bbx-rule" />
        <span className="bbx-eyebrow bbx-faint">{f.round}</span>
      </div>
      <div className={"bbx-hero stg-hero" + (click ? " stg-hero--click" : "")} onClick={click || undefined}>
        <Side s={f.a} side="home" />
        <Side s={f.b} side="away" />
        <div className="stg-hero__chip">
          <span className="stg-hero__chiptop">{f.center.top}</span>
          <span className="stg-hero__chipbig">{f.center.big}</span>
          {f.center.bot && <span className="stg-hero__chipbot">{f.center.bot}</span>}
        </div>
      </div>
      {f.strip && f.strip.length > 0 && (
        <div className="stg-strip">
          {f.strip.map(([k, v], i) => (
            <div key={i} className="stg-strip__cell">
              <div className="stg-strip__k">{k}</div>
              <div className="stg-strip__v">{v}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StageCompare({ c }) {
  return (
    <div className="bbx-panel stg-cmp">
      <div className="bbx-eyebrow stg-cmp__title">{c.title || "HEAD-TO-HEAD"}</div>
      <div className="stg-cmp__teams">
        <span className="stg-cmp__team"><HPLogo team={c.a} size={26} />{stgAbbr(c.a)}</span>
        <span className="bbx-faint">VS</span>
        <span className="stg-cmp__team stg-cmp__team--r">{stgAbbr(c.b)}<HPLogo team={c.b} size={26} /></span>
      </div>
      <div className="stg-cmp__rows">
        {c.rows.map((r, i) => (
          <div key={i} className="stg-cmp__row">
            <span className={"stg-cmp__v" + (r.aWins ? " stg-cmp__v--win" : "")}>{r.a}</span>
            <span className="stg-cmp__lbl">{r.label}</span>
            <span className={"stg-cmp__v stg-cmp__v--r" + (!r.aWins ? " stg-cmp__v--win" : "")}>{r.b}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StagePage({ cfg, onTeam, onGame }) {
  return (
    <div className="bbx stg">
      {/* ticker */}
      {!cfg.hideTicker && cfg.ticker && (
        <div className="bbx-ticker">
          <div className="bbx-ticker__label"><span className="bbx-pulse" />SCORES</div>
          <div className="bbx-ticker__rail">
            {cfg.ticker.length ? cfg.ticker.map((g, i) => {
              const homeLead = g.sb != null && g.sa != null && g.sb >= g.sa;
              const click = g.game && onGame && g.game.result ? () => onGame(g.game, g.hostId) : null;
              const Row = ({ t, sc, lead }) => (
                <div className={"bbx-tk__line" + (lead ? " bbx-tk__line--lead" : "")}>
                  <span className="bbx-tk__team"><HPLogo team={t} size={15} />{stgAbbr(t)}</span>
                  <span className="bbx-tk__sc">{sc != null ? sc : "–"}</span>
                </div>
              );
              return (
                <button key={i} className={"bbx-tk" + (click ? " bbx-tk--click" : "")}
                        disabled={!click} onClick={click || undefined}>
                  <Row t={g.a} sc={g.sa} lead={!homeLead && g.sa != null} />
                  <Row t={g.b} sc={g.sb} lead={homeLead && g.sb != null} />
                  <span className={"bbx-tk__st" + (g.final ? "" : " bbx-tk__st--up")}>{g.st}</span>
                </button>
              );
            }) : <div className="bbx-tk bbx-faint" style={{ padding: "10px 16px" }}>No games today.</div>}
          </div>
        </div>
      )}

      {/* title band */}
      <div className="stg-band">
        <div className="stg-band__kicker">{cfg.kicker}</div>
        <div className="stg-band__title">{cfg.title}</div>
        <div className="stg-band__meta">
          {cfg.meta.map(([k, v], i) => (
            <div key={i} className="stg-chip">
              <div className="stg-chip__k">{k}</div>
              <div className="stg-chip__v">{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* today's featured matchup / stakes board — or "no games today" */}
      {cfg.stakes ? <StageStakes stakes={cfg.stakes} onTeam={onTeam} />
        : cfg.tracker ? <StageTracker tracker={cfg.tracker} onTeam={onTeam} />
        : cfg.featured ? <StageHero f={cfg.featured} onGame={onGame} />
        : (
          <div className="bbx-section">
            <div className="bbx-eyebrow-row">
              <span className="bbx-eyebrow bbx-gold">★ TODAY</span>
              <span className="bbx-rule" />
              <span className="bbx-eyebrow bbx-faint">{cfg.title}</span>
            </div>
            <div className="stg-nogames">No games today.</div>
          </div>
        )}

      {/* schedule + field/compare — schedule scrolls so its height matches the right */}
      <div className="stg-split">
        <div className="stg-split__cell stg-split__cell--sched">
        <div className="bbx-panel stg-schedpanel">
          <div className="bbx-eyebrow stg-panel__head">{cfg.scheduleTitle}</div>
          <div className="stg-sched">
            {(cfg.schedule || []).length ? cfg.schedule.map((g, i) => {
              const click = g.game && onGame && g.game.result ? () => onGame(g.game, g.hostId) : null;
              const winA = g.done && g.sa >= g.sb, winB = g.done && g.sb >= g.sa;
              const Team = ({ s, sc, win, dim }) => (
                <div className="stg-sched__t">
                  <HPLogo team={s.team} size={20} />
                  <span className={"stg-sched__nm" + (dim ? " stg-faint" : "")}>{(s.team && s.team.name) || "TBD"}</span>
                  <span className="mono stg-faint stg-sched__rec">{s.rec}</span>
                  {(g.done || g.live) && <span className={"stg-sched__sc" + (dim ? " stg-faint" : "")}>{sc}</span>}
                </div>
              );
              return (
                <button key={i} className={"stg-sched__row" + (click ? " stg-sched__row--click" : "")}
                        disabled={!click} onClick={click || undefined}>
                  <div className="stg-sched__status"><StatusPill s={g.status} live={g.live} /></div>
                  <div className="stg-sched__teams">
                    <Team s={g.a} sc={g.sa} win={winA} dim={g.done && !winA} />
                    <Team s={g.b} sc={g.sb} win={winB} dim={g.done && !winB} />
                  </div>
                  <div className="stg-sched__right">
                    <div className="stg-sched__when">{g.when}</div>
                    {g.series && <div className="mono bbx-gold stg-sched__series">◆ {g.series}</div>}
                  </div>
                </button>
              );
            }) : <div className="bbx-faint bbx-pad">No games today.</div>}
          </div>
        </div>
        </div>

        <div className="stg-split__cell">
        {cfg.compare ? <StageCompare c={cfg.compare} /> : (
          <div className="bbx-panel">
            <div className="bbx-eyebrow stg-panel__head">{cfg.fieldTitle}</div>
            <div className="stg-field">
              {(cfg.field || []).map((t, i) => (
                <button key={i} className="stg-field__row" onClick={() => t.team && onTeam && onTeam(t.team.id)}>
                  <span className="stg-field__seed">{t.seed}</span>
                  <HPLogo team={t.team} size={20} />
                  <div className="stg-field__txt">
                    <div className="stg-field__nm">{(t.team && t.team.name) || "—"}</div>
                    {t.sub && <div className="mono stg-faint stg-field__sub">{t.sub}</div>}
                  </div>
                  <span className="mono stg-faint stg-field__rec">{t.rec}</span>
                  <span className={"stg-tag stg-tag--" + (t.kind || "good")}>{t.tag}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        </div>
      </div>

      {/* players to watch */}
      {cfg.players && cfg.players.length > 0 && (
        <div className="bbx-section">
          <div className="bbx-eyebrow-row">
            <span className="bbx-eyebrow bbx-gold">◆ PLAYERS TO WATCH</span>
            <span className="bbx-rule" />
          </div>
          <div className="stg-players">
            {cfg.players.map((p, i) => (
              <div key={i} className="stg-pcard">
                <div className="stg-pcard__photo">
                  <span>PLAYER CUTOUT</span>
                  <div className="stg-pcard__logo"><HPLogo team={p.team} size={26} /></div>
                  {p.badge && <span className="stg-pcard__badge">{p.badge}</span>}
                </div>
                <div className="stg-pcard__body">
                  <div className="mono stg-faint stg-pcard__pos">{stgAbbr(p.team)} · {p.pos}</div>
                  <div className="stg-pcard__name">{(p.name || "").toUpperCase()}</div>
                  <div className="stg-pcard__line">
                    {p.line.map(([n, l], j) => (
                      <div key={j}><div className="stg-pcard__n">{n}</div><div className="mono stg-pcard__l">{l}</div></div>
                    ))}
                  </div>
                  {p.note && <div className="stg-pcard__note">{p.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- compose: build a phase's cfg from real data ---------- */
const HomeStage = ({ phase, onTeam, onGame }) => {
  const m = STAGE_META[phase];
  const isCws = phase === "cws" || phase === "cws_finals";
  const needsBracket = isCws || phase === "regionals";
  const [leaders, setLeaders] = React.useState(null);
  const [bracket, setBracket] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    window.fetchConferenceLeaders().then((d) => live && setLeaders(d)).catch(() => {});
    if (needsBracket && window.fetchBracket)
      window.fetchBracket("ncaa").then((d) => live && setBracket(d)).catch(() => {});
    return () => { live = false; };
  }, [phase]);

  let ticker, featured, schedule, field, compare, tracker, stakes;
  if (isCws) {
    // The CWS hasn't been played in the data, so source everything from the bracket.
    const games = bracket ? stgCwsGames(bracket) : [];
    ticker = games.slice(0, 9).map((g) => ({ a: g.a.team, b: g.b.team, sa: g.sa, sb: g.sb,
                                             final: g.done, st: g.done ? "FINAL" : "TBD", game: null }));
    schedule = games;
    if (phase === "cws") {
      featured = bracket ? stgCwsFeatured(bracket) : null;
      field = bracket ? stgCwsField(bracket) : [];
      compare = null;
    } else {                                       // cws_finals
      compare = bracket ? stgFinalsCompare(bracket) : null;
      field = null;
      featured = compare ? {
        tag: m.featuredTag, round: m.title, game: null,
        a: { team: compare.a, seed: compare.a.rank || "—", label: "FINALIST", rec: stgRec(compare.a) },
        b: { team: compare.b, seed: compare.b.rank || "—", label: "FINALIST", rec: stgRec(compare.b) },
        center: { top: "SERIES", big: "BEST OF 3", bot: "" },
        strip: [["VENUE", "Charles Schwab Field"], ["CITY", "Omaha, NE"],
                ["FORMAT", "Best-of-3"], ["TITLE", "National Championship"]],
      } : null;
      // The championship series (best-of-3) between the two finalists.
      schedule = compare ? [1, 2, 3].map((n) => ({
        game: null, status: n < 3 ? "TBD" : "IF NEC", done: false, live: false,
        a: { team: compare.a, rec: stgRec(compare.a) }, b: { team: compare.b, rec: stgRec(compare.b) },
        sa: null, sb: null, when: `Game ${n}`, series: n === 3 ? "If necessary" : "Charles Schwab Field",
      })) : [];
    }
  } else {
    // Strictly TODAY's games of this round — no previewing future rounds. Empty
    // when nothing is played today (the UI shows "No games today").
    const round = m.round;
    const today = stgToday();
    const rows = stgGamesOn(today).filter((r) => (r.phase || "regular") === round);
    ticker = rows.slice(0, 9).map((r) => ({
      a: r.away, b: r.home, sa: r.as, sb: r.hs, final: r.final,
      st: r.final ? "FINAL" : (r.time || "TBD"), game: r.g, hostId: r.hostId,
    }));
    schedule = stgScheduleFrom(rows);
    field = stgField(phase, bracket ? stgSeedMap(bracket) : null);
    compare = null;
    if (phase === "regionals") {
      stakes = stgStakes(today);                 // today's games only; null if none
      featured = null;
    } else {
      featured = rows.length ? stgFeatured(phase, rows, today) : null;
    }
  }

  const cfg = {
    hideTicker: m.hideTicker || (isCws && (!ticker || !ticker.length)),
    ticker,
    kicker: `POSTSEASON · STAGE ${m.stage} OF 5 · ${m.dates}`,
    title: m.title, meta: m.meta,
    featured, tracker, stakes, scheduleTitle: m.scheduleTitle, schedule,
    fieldTitle: m.fieldTitle, field, compare,
    players: stgPlayers(leaders),
  };
  return <StagePage cfg={cfg} onTeam={onTeam} onGame={onGame} />;
};

window.StagePage = StagePage;
window.HomeStage = HomeStage;
