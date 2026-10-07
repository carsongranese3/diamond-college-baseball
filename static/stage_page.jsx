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
// Per-conference tournament facts for the stage masthead. The site phase is the
// generic "sec_tournament"; the league selector picks which conference to show.
const CONF_TOURNEY = {
  "SEC":     { title: "SEC TOURNAMENT",     meta: [["LOCATION", "Hoover, AL"], ["VENUE", "Hoover Metropolitan Stadium"], ["FORMAT", "Double Elimination"]] },
  "ACC":     { title: "ACC TOURNAMENT",     meta: [["LOCATION", "Charlotte, NC"], ["VENUE", "Truist Field"], ["FORMAT", "Pool Play → Single Elim"]] },
  "Big Ten": { title: "BIG TEN TOURNAMENT", meta: [["LOCATION", "Omaha, NE"], ["VENUE", "Charles Schwab Field"], ["FORMAT", "Double Elimination"]] },
  "Big 12":  { title: "BIG 12 TOURNAMENT",  meta: [["LOCATION", "Arlington, TX"], ["VENUE", "Globe Life Field"], ["FORMAT", "Double Elimination"]] },
  "NCAA":    { title: "CONFERENCE TOURNAMENTS", meta: [["WEEK", "Championship Week"], ["FORMAT", "Conference Tournaments"]] },
};

// Postseason progression for "has this team advanced PAST round X?". A conference
// tournament (any league — all labels end in "Tournament") is round 0; NCAA follows.
const ROUND_ORDER = ["NCAA Regional", "NCAA Super Regional", "College World Series"];
function stgIsConfTourney(phase) { return /Tournament$/.test(phase || ""); }
function stgRoundIndex(phase) {
  if (stgIsConfTourney(phase)) return 0;
  const i = ROUND_ORDER.indexOf(phase);
  return i >= 0 ? i + 1 : -1;
}
// Whether a game's round matches a stage's round — every conference tournament is
// treated as one round (the team list is already scoped to a single league).
function stgInRound(gphase, round) {
  if (stgIsConfTourney(round)) return stgIsConfTourney(gphase);
  return (gphase || "regular") === round;
}

/* ---------- real-data helpers ---------- */
function stgToday() { return (window.SEASON_CLOCK || {}).today; }
function stgAbbr(t) { return (t && (t.mark || (t.name || "").slice(0, 3).toUpperCase())) || "—"; }
function stgRec(t) { return t && t.ovrW != null ? `${t.ovrW}–${t.ovrL}` : ""; }

// All games (deduped) on a given iso, both teams resolved + scores oriented home/away.
function stgGamesOn(day) {
  const sch = window.SCHEDULES || {}, byId = window.TEAM_BY_ID || {}, seen = new Set(), out = [];
  const realToday = stgToday();
  for (const seo in sch) for (const g of sch[seo] || []) {
    if (!g.iso || g.iso !== day || seen.has(g.id)) continue;
    // A game with no result whose date has already passed never happened that day
    // (rain postponement / reschedule) — drop the stale original-date entry so a
    // moved game doesn't linger on its old day as well as its new one.
    if (!g.result && g.iso < realToday) continue;
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
// Only counts games with a result, so when viewing an earlier date a future round that's
// still on the schedule (result cleared) doesn't read as "advanced".
function stgAdvancedPast(sched, round) {
  const i = stgRoundIndex(round);
  return (sched || []).some((g) => g.result && stgRoundIndex(g.phase) > i);
}
// Status tag for a team in the current round, from its W/L there + whether it moved
// on. `upcoming` = it still has an unplayed game in the round; `lastWin` = its most
// recent played game was a win.
function stgStatus(phase, wins, losses, advanced, upcoming, lastWin) {
  const champ = phase === "cws_finals";
  if (phase === "super_regionals" || champ) {
    if (advanced) return { tag: "ADVANCED", kind: "good" };
    if (losses >= 2) return { tag: "ELIMINATED", kind: "bad" };
    if (wins >= 2) return { tag: champ ? "CHAMPION" : "ADVANCED", kind: "good" };
    if (wins > losses) return { tag: `LEADS ${wins}–${losses}`, kind: "warn" };
    if (losses > wins) return { tag: `TRAILS ${wins}–${losses}`, kind: "warn" };
    return { tag: wins + losses ? `TIED ${wins}–${losses}` : "GAME 1", kind: "warn" };
  }
  if (phase === "sec_tournament") {
    // Conference tournament: data-driven elimination — a team whose run is over (it
    // has played, has no remaining games, and hasn't advanced) is ELIMINATED if its
    // last game was a loss, or CHAMPION if it won out. Works for any bracket format
    // (single/double elim, pool play), not just a fixed 2-loss rule.
    if (advanced) return { tag: "ADVANCED", kind: "good" };
    if (wins + losses === 0) return { tag: "UPCOMING", kind: "warn" };
    if (upcoming) return { tag: "ALIVE", kind: "good" };
    return lastWin ? { tag: "CHAMPION", kind: "good" } : { tag: "ELIMINATED", kind: "bad" };
  }
  if (advanced) return { tag: "ADVANCED", kind: "good" };
  if (losses >= 2) return { tag: "ELIMINATED", kind: "bad" };
  if (wins + losses === 0) return { tag: "UPCOMING", kind: "warn" };
  return { tag: "ALIVE", kind: "good" };
}

// A team's display seed for the phase. In a single-conference conference-tournament
// view it's the conference standing (1..N by conf record); in the NCAA-wide view and
// every NCAA round it's the national Top 25 rank.
function stgSeedOf(phase, team, league) {
  if (phase === "sec_tournament") {
    const lg = league || window.CURRENT_LEAGUE;
    if (lg !== "NCAA") {
      const i = hpSecTeams(lg).findIndex((t) => t.id === (team && team.id));
      return i >= 0 ? i + 1 : "—";
    }
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

// Teams (in the selected league) in the current round, with seed + record + status
// tag. `seedMap` (when supplied) gives official national seeds for the NCAA rounds.
// The conference tournament shows ONLY the NCAA Top 25, ordered by national rank.
function stgField(phase, seedMap, league) {
  const round = STAGE_META[phase].round;
  const lg = league || window.CURRENT_LEAGUE;
  const teams = hpSecTeams(lg);
  const confTourney = phase === "sec_tournament";
  const ncaaView = lg === "NCAA";
  const out = [];
  teams.forEach((t, idx) => {
    // NCAA-wide conference-tournament view: the Top 25 only, ranked nationally. A
    // single conference keeps its own standings (every team in the round, 1..N).
    if (confTourney && ncaaView && t.rank == null) return;
    const sched = (window.SCHEDULES || {})[t.id] || [];
    const inRound = sched.filter((g) => stgInRound(g.phase, round));
    if (!inRound.length) return;                       // not part of this round
    const played = inRound.filter((g) => g.result);
    const wins = played.filter((g) => g.result === "W").length;
    const losses = played.filter((g) => g.result === "L").length;
    const upcoming = inRound.some((g) => !g.result);   // a round game still to play
    const lastWin = played.length > 0 && played[played.length - 1].result === "W";
    const adv = stgAdvancedPast(sched, round);
    const st = stgStatus(phase, wins, losses, adv, upcoming, lastWin);
    // Seed: conf tournament → national rank in the NCAA view, conference standing in
    // a single-conference view; NCAA rounds → official national seed from the bracket.
    const seed = confTourney ? (ncaaView ? t.rank : idx + 1)
               : (seedMap && seedMap[t.id] != null ? seedMap[t.id] : "—");
    const lastOpp = (played[played.length - 1] || inRound[inRound.length - 1] || {}).opp;
    out.push({ team: t, seed, rec: stgRec(t), tag: st.tag, kind: st.kind,
               sub: lastOpp ? `vs ${lastOpp.name}` : "" });
  });
  // Seeded order (seeded ascending, unseeded last) — eliminated teams keep their
  // seed position instead of sinking to the bottom.
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
    if (g.iso && stgInRound(g.phase, round)) dates.add(g.iso);
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
function stgFeatured(phase, rows, day, league) {
  if (!rows.length) return null;
  const seed = (g) => ((g.home && g.home.rank) || 50) + ((g.away && g.away.rank) || 50);
  const best = rows.slice().sort((x, y) => seed(x) - seed(y))[0];
  // Score reads away–home to match the hero layout (away on the left, home right).
  const center = best.final
    ? { top: "FINAL", big: `${best.as}–${best.hs}`, bot: "" }
    : { top: "FIRST PITCH", big: best.time || "TBD", bot: "" };
  return {
    tag: STAGE_META[phase].featuredTag,
    round: STAGE_META[phase].title,
    game: best.g, hostId: best.hostId,
    a: { team: best.home, seed: stgSeedOf(phase, best.home, league), label: "HOME", rec: stgRec(best.home) },
    b: { team: best.away, seed: stgSeedOf(phase, best.away, league), label: "AWAY", rec: stgRec(best.away) },
    center,
    strip: [["DATE", best.g.date || day], ["MATCHUP", `${stgAbbr(best.away)} @ ${stgAbbr(best.home)}`],
            ["ROUND", STAGE_META[phase].title], ["STATUS", best.final ? "Final" : "Upcoming"]],
  };
}

// Players to watch — a BATTERS ⇄ PITCHERS tabbed panel. Each tab is the league's top
// players over the previous week by the SAME formula as Player of the Week, one per
// team (so four cards = four different teams); a team can have a batter and a pitcher.
function StagePlayersToWatch({ league, onTeam }) {
  const [data, setData] = React.useState(null);
  const [side, setSide] = React.useState("batters");
  React.useEffect(() => {
    let live = true;
    setData(null);
    window.fetchPlayersToWatch(league).then((d) => live && setData(d)).catch(() => {});
    return () => { live = false; };
  }, [league]);
  // Nothing to show (e.g. preseason) — drop the section entirely.
  if (data && !(data.batters || []).length && !(data.pitchers || []).length) return null;
  const byId = window.TEAM_BY_ID || {};
  const list = data ? (data[side] || []) : [];
  return (
    <div className="bbx-section">
      <div className="bbx-eyebrow-row">
        <span className="bbx-eyebrow bbx-gold">◆ PLAYERS TO WATCH</span>
        <span className="bbx-rule" />
        <div className="bbx-seg">
          {[["batters", "BATTERS"], ["pitchers", "PITCHERS"]].map(([s, l]) => (
            <button key={s} className={"bbx-seg__btn" + (side === s ? " bbx-seg__btn--on" : "")}
                    onClick={() => setSide(s)}>{l}</button>
          ))}
        </div>
      </div>
      {!data ? <div className="bbx-faint bbx-pad">Loading…</div>
       : !list.length ? <div className="bbx-faint bbx-pad">No qualifying {side} last week.</div>
       : (
        <div className="stg-players">
          {list.map((p, i) => {
            const team = byId[p.team];
            return (
              <button key={i} className="stg-pcard stg-pcard--btn"
                      onClick={() => team && onTeam && onTeam(p.team)}>
                <div className="stg-pcard__body">
                  <div className="mono stg-faint stg-pcard__pos">{(p.abbr || stgAbbr(team))} · {p.pos}</div>
                  <div className="stg-pcard__nameline">
                    <div className="stg-pcard__name">{(p.player || "").toUpperCase()}</div>
                    <HPLogo team={team} size={40} />
                  </div>
                  <div className="stg-pcard__line">
                    {p.basic.map((s, j) => (
                      <div key={j}><div className="stg-pcard__n">{s.value}</div><div className="mono stg-pcard__l">{s.label}</div></div>
                    ))}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
       )}
    </div>
  );
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
      aT.confW != null && bT.confW != null ? { label: "CONF RECORD", a: `${aT.confW}–${aT.confL}`, b: `${bT.confW}–${bT.confL}`,
        aWins: (aT.confW / Math.max(aT.confW + aT.confL, 1)) >= (bT.confW / Math.max(bT.confW + bT.confL, 1)) } : null,
      { label: "NAT'L RANK", a: aT.rank ? `#${aT.rank}` : "NR", b: bT.rank ? `#${bT.rank}` : "NR", aWins: num(aT.rank) <= num(bT.rank) },
      aT.rpi != null && bT.rpi != null ? { label: "RPI", a: `#${aT.rpi}`, b: `#${bT.rpi}`, aWins: num(aT.rpi) <= num(bT.rpi) } : null,
    ].filter(Boolean),
  };
}

// "15:00" -> "3:00 PM"; passes through anything it can't parse.
function stg12h(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || "");
  if (!m) return t || "TBD";
  const ap = +m[1] >= 12 ? "PM" : "AM";
  return `${(+m[1] % 12) || 12}:${m[2]} ${ap}`;
}

// The best-of-3 CWS Finals as three rows (for the CHAMPIONSHIP SERIES panel). Each
// game shows its final score once played, its start time (12-hour) on game day, or
// its date beforehand. Game 3 stays TBD until the series is 1–1 (a decider is needed).
function stgFinalsSeries(compare, today) {
  if (!compare) return [];
  const A = compare.a, B = compare.b;
  const games = ((window.SCHEDULES || {})[A.id] || [])
    .filter((g) => g.opp && g.opp.id === B.id && (g.phase || "") === "College World Series")
    .sort((x, y) => (x.iso || "").localeCompare(y.iso || ""));
  let wa = 0, wb = 0;
  for (const g of games) { if (g.result === "W") wa++; else if (g.result === "L") wb++; }
  const decided = wa >= 2 || wb >= 2;
  const need3 = wa === 1 && wb === 1;               // series is 1–1 -> game 3 happens
  // The two finalists are known for the whole series, so every row — including a
  // not-yet-needed game 3 — shows A vs B. status is left blank: no left pill, the
  // right-hand "when" (score / time / date / "If necessary") carries the state.
  const rows = [];
  for (let n = 1; n <= 3; n++) {
    const g = games[n - 1];
    if (!g) {
      rows.push({
        game: null, status: "", done: false, live: false,
        a: { team: A, rec: stgRec(A) }, b: { team: B, rec: stgRec(B) },
        sa: null, sb: null,
        when: n === 3 ? (decided ? "Not needed" : need3 ? "TBD" : "If necessary") : "TBD",
        series: `Game ${n}`,
      });
      continue;
    }
    const done = !!g.result;
    const sa = g.score && g.score.us, sb = g.score && g.score.them;
    const isToday = g.iso === today;
    rows.push({
      game: g, hostId: A.id, status: "", done, live: false,
      a: { team: A, rec: stgRec(A) }, b: { team: B, rec: stgRec(B) },
      sa, sb,
      // Done games already show the score on each team row; the right-hand slot
      // reads "Final" (in gold) instead of repeating the score.
      when: done ? "Final" : (isToday && g.time ? stg12h(g.time) : (g.date || g.iso)),
      series: `Game ${n}`,
    });
  }
  return rows;
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
// Every team with a game in `round` on `today`, scoped to the current league and
// deduped per matchup — so each game appears once even when one side is a filled-in
// non-conference team whose bracket game id differs from the tracked side's. In NCAA
// view this is the full national field; in a conference view, only that conference's.
function stgRoundMatchups(round, today) {
  const S = window.SCHEDULES || {};
  const cur = window.CURRENT_LEAGUE;
  const isNCAA = !cur || cur === "NCAA";
  const leagueSet = isNCAA ? null
    : new Set((window.leagueTeams ? window.leagueTeams(cur) : (window.TEAMS || [])).map((t) => t.id));
  // Normalize seos in the matchup key — local box scores and the bracket sometimes
  // spell the same team differently (e.g. "st-john-s-ny" vs "st-johns-ny"), which
  // would otherwise show the game twice (once from each side).
  const norm = (s) => (s || "?").toLowerCase().replace(/[^a-z0-9]/g, "");
  const realToday = stgToday();
  const seen = new Set();
  const rows = [];
  for (const seo in S) {
    const reg = (S[seo] || []).filter((g) => (g.phase || "regular") === round);
    // EVERY game this team plays today — a team can play twice in a day (regional
    // doubleheaders), so we don't stop at the first.
    for (const game of reg) {
      if (game.iso !== today) continue;
      // Skip a postponed game's stale original-date entry (unplayed, date already
      // past) so a rain-delayed game doesn't show on both its old and new day.
      if (!game.result && game.iso < realToday) continue;
      const oppId = game.opp && game.opp.id;
      if (!isNCAA && !(leagueSet.has(seo) || (oppId && leagueSet.has(oppId)))) continue;
      const key = [norm(seo), norm(oppId)].sort().join("|") + "|" + today;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ seo, game, reg });
    }
  }
  return rows;
}

function stgStakes(today) {
  if (!today) return null;
  const byId = window.TEAM_BY_ID || {};
  const out = [];
  for (const { seo, game, reg } of stgRoundMatchups("NCAA Regional", today)) {
    const t = byId[seo] || { id: seo };
    const opp = (game.opp && byId[game.opp.id]) || game.opp || null;
    const prior = reg.filter((g) => g.iso < today);     // this team's regional games before today, in order
    const myLoss = prior.filter((g) => g.result === "L").length;
    const myWin = prior.filter((g) => g.result === "W").length;
    // Game 7 ("if necessary" final): the same two teams play back-to-back, so today
    // is a rematch of the most recent prior regional day. Check every opponent from
    // that day (regionals run doubleheaders, and same-day games aren't ordered), so
    // the test is symmetric — both teams classify the game identically. The >=1-loss
    // guard rejects the false positive where a still-unbeaten champ's regional final
    // is a rematch of the winners'-bracket final.
    const maxPriorIso = prior.reduce((m, g) => (g.iso > m ? g.iso : m), "");
    const lastDayOpps = prior.filter((g) => g.iso === maxPriorIso).map((g) => g.opp && g.opp.id);
    // Both game-7 participants always carry >=2 wins (you can't reach the if-necessary
    // final with fewer) — that guard rejects a WB-final loser who simply replays the
    // same team in the elimination bracket the next day.
    const isGame7 = myLoss >= 1 && myWin >= 2 && game.opp && lastDayOpps.indexOf(game.opp.id) >= 0;
    // Per-side stake, inferred from this team's W-L in the regional — opponent
    // schedules aren't loaded, but a 4-team double-elim constrains the pairing:
    //   winners' bracket (blue) = both unbeaten          → win stays alive, no one out
    //   elimination     (red)   = a loss ends the season → ordinary elim game, both with a loss
    //   advance         (green) = a win reaches Supers    → the unbeaten champ in the final, OR
    //                                                       BOTH teams in the winner-take-all game 7
    // Win count tells the regional-final survivor (>=2 wins, 1 loss) apart from an
    // ordinary elimination game (<=1 win); the rematch test tells game 7 apart.
    let aState, bState, stake, kind;
    if (isGame7) { aState = "advance"; bState = "advance"; stake = "WINNER TO SUPERS"; kind = "good"; }
    else if (myLoss === 0 && myWin >= 2) { aState = "advance"; bState = "elim"; stake = "REGIONAL FINAL · win to Supers"; kind = "good"; }
    else if (myLoss >= 1 && myWin >= 2) { aState = "elim"; bState = "advance"; stake = "REGIONAL FINAL · win or go home"; kind = "bad"; }
    else if (myLoss >= 1) { aState = "elim"; bState = "elim"; stake = "WIN OR GO HOME"; kind = "bad"; }
    else { aState = "winners"; bState = "winners"; stake = "WINNERS' BRACKET"; kind = "warn"; }
    out.push({ a: t, b: opp, sa: game.score && game.score.us, sb: game.score && game.score.them,
               done: !!game.result, live: false, aState, bState,
               aElim: aState === "elim", bElim: bState === "elim",
               game, hostId: seo,                        // raw game + host so the bar opens the box score
               // City is keyed by the host; `seo` may be the visitor, so fall back to
               // the opponent's entry (the regional is named for one of the two).
               city: (window.REGIONAL_CITY_BY_TEAM || {})[seo]
                     || (window.REGIONAL_CITY_BY_TEAM || {})[game.opp && game.opp.id] || "", stake, kind });
  }
  const rank = { good: 0, bad: 1, warn: 2 };
  out.sort((x, y) => rank[x.kind] - rank[y.kind]);
  return out.length ? { title: "WHAT'S AT STAKE TODAY", eyebrow: "REGIONALS", games: out, keys: [
    { state: "winners", label: "Winners' bracket" },
    { state: "advance", label: "Win to Supers" },
    { state: "elim", label: "Win or go home" },
  ] } : null;
}

// "What's at stake today" for Super Regionals — one bar per best-of-3 series with
// today's game. Same color model as regionals, mapped to the series state:
//   game 1 (series 0-0)  -> blue  (no one can clinch or be eliminated yet)
//   game 2 (a team leads) -> green (leader can win to Omaha) / red (trailer faces sweep)
//   game 3 (1-1, decider)  -> both green (winner to Omaha)
function stgSupers(today) {
  if (!today) return null;
  const byId = window.TEAM_BY_ID || {};
  // Series host city, keyed by either team (from the bracket's super-regional list).
  const cityByTeam = {};
  for (const sr of (window.SUPER_REGIONALS || [])) {
    if (!sr.city) continue;
    if (sr.top) cityByTeam[sr.top.seo] = sr.city;
    if (sr.bottom) cityByTeam[sr.bottom.seo] = sr.city;
  }
  const out = [];
  for (const { seo, game, reg: sup } of stgRoundMatchups("NCAA Super Regional", today)) {
    const t = byId[seo] || { id: seo };
    const opp = (game.opp && byId[game.opp.id]) || game.opp || null;
    const prior = sup.filter((g) => g.iso < today);
    const myWin = prior.filter((g) => g.result === "W").length;
    const myLoss = prior.filter((g) => g.result === "L").length;
    let aState, bState, stake, kind;
    if (myWin >= 1 && myLoss >= 1) { aState = "advance"; bState = "advance"; stake = "GAME 3 · winner to Omaha"; kind = "good"; }
    else if (myWin >= 1) { aState = "advance"; bState = "elim"; stake = "SERIES · win to Omaha"; kind = "good"; }
    else if (myLoss >= 1) { aState = "elim"; bState = "advance"; stake = "SERIES · win or go home"; kind = "bad"; }
    else { aState = "winners"; bState = "winners"; stake = "GAME 1"; kind = "warn"; }
    out.push({ a: t, b: opp, sa: game.score && game.score.us, sb: game.score && game.score.them,
               done: !!game.result, live: false, aState, bState,
               aElim: aState === "elim", bElim: bState === "elim",
               game, hostId: seo,
               city: cityByTeam[seo] || cityByTeam[game.opp && game.opp.id] || "", stake, kind });
  }
  const rank = { good: 0, bad: 1, warn: 2 };
  out.sort((x, y) => rank[x.kind] - rank[y.kind]);
  return out.length ? { title: "WHAT'S AT STAKE TODAY", eyebrow: "SUPER REGIONALS", games: out, keys: [
    { state: "winners", label: "Game 1" },
    { state: "advance", label: "Win to Omaha" },
    { state: "elim", label: "Win or go home" },
  ] } : null;
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

// "Today at the regionals" status board — a thin bar per regional: the two teams
// flank a centered score. Each SIDE is tinted by that team's stake today, so a
// regional final reads green→red (one team can win to Supers, the other can lose
// to home); winners'-bracket games are blue/blue and elimination games red/red.
// A color key under the header decodes it. Reuses the stgStakes() data.
const STAKE_COLOR = { winners: "var(--bbx-blue)", advance: "var(--bbx-hot)", elim: "var(--bbx-cold)" };
function StageRegionalBoard({ data, onTeam, onGame }) {
  if (!data || !(data.games || []).length) return null;
  const keys = data.keys || [
    { state: "winners", label: "Winners' bracket" },
    { state: "advance", label: "Win to Supers" },
    { state: "elim", label: "Win or go home" },
  ];
  return (
    <div className="bbx-section">
      <div className="bbx-eyebrow-row">
        <span className="bbx-eyebrow bbx-gold">★ {data.title}</span>
        <span className="bbx-rule" />
        <span className="bbx-eyebrow bbx-faint">{data.eyebrow || "REGIONALS"}</span>
      </div>
      <div className="stg-rb__key">
        {keys.map((k, i) => (
          <span key={i} className="stg-rb__keyitem"><i style={{ background: STAKE_COLOR[k.state] }} />{k.label}</span>
        ))}
      </div>
      <div className="stg-rb">
        {data.games.map((g, i) => {
          const aWin = g.done && g.sa != null && g.sb != null && g.sa >= g.sb;
          const bWin = g.done && g.sa != null && g.sb != null && g.sb > g.sa;
          // The whole bar opens the box score (played games only). Teams are not
          // separately clickable here — the bar is the single click target.
          const gameClick = g.game && onGame && g.game.result ? () => onGame(g.game, g.hostId) : null;
          // Each side tinted by its own stake — the bar is a gradient from the left
          // team's color to the right team's, so same-stake games read as one solid
          // tint and the regional final reads two-tone (green advance ↔ red elim).
          // Game 7 (both teams advance) gets a fuller, uniform green wash so the
          // winner-take-all final reads unmistakably green rather than dark-edged.
          const g7 = g.aState === "advance" && g.bState === "advance";
          const style = { "--rb-lc": STAKE_COLOR[g.aState] || "var(--bbx-line)",
                          "--rb-rc": STAKE_COLOR[g.bState] || "var(--bbx-line)" };
          return (
            <div key={i} className={"stg-rb__row" + (g7 ? " stg-rb__row--g7" : "") + (gameClick ? " stg-rb__row--click" : "")}
                 style={style} onClick={gameClick || undefined}
                 role={gameClick ? "button" : undefined} tabIndex={gameClick ? 0 : undefined}>
              <span className="stg-rb__site">{g.city || "—"}</span>
              <span className="stg-rb__tm stg-rb__tm--l">
                <span className="stg-rb__nm">{(g.a && g.a.name) || "TBD"}</span>
                <HPLogo team={g.a} size={18} />
              </span>
              <span className="stg-rb__score">
                {g.done
                  ? (<><span className={"stg-rb__s" + (aWin ? " stg-rb__s--w" : "")}>{g.sa}</span>
                       <span className="stg-rb__dash">–</span>
                       <span className={"stg-rb__s" + (bWin ? " stg-rb__s--w" : "")}>{g.sb}</span></>)
                  : <span className="stg-rb__vs">{g.live ? "LIVE" : "vs"}</span>}
              </span>
              <span className="stg-rb__tm stg-rb__tm--r">
                <HPLogo team={g.b} size={18} />
                <span className="stg-rb__nm">{(g.b && g.b.name) || "TBD"}</span>
              </span>
            </div>
          );
        })}
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
        {/* Away (f.b) on the left, home (f.a) on the right. `side` selects the
            mirror styling (left- vs right-hugging), not the team's home/away role. */}
        <Side s={f.b} side="home" />
        <Side s={f.a} side="away" />
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

function StagePage({ cfg, onTeam, onGame, onGameModal }) {
  // "Live" only when a game is actually in progress — started (has a score) but not
  // final yet. An upcoming game that simply hasn't been played is NOT live, so the
  // strip shows quietly ("SCORES") instead of the red LIVE banner.
  const tickerLive = (cfg.ticker || []).some((g) => !g.final && (g.sa != null || g.sb != null));
  // The right-hand panel (field standings, or a head-to-head compare). Pulled out so
  // it can sit in the split OR span full width (regionals, where the day grid above
  // replaces the schedule).
  const fieldPanel = cfg.compare ? <StageCompare c={cfg.compare} /> : (
    <div className="bbx-panel">
      <div className="bbx-eyebrow stg-panel__head">{cfg.fieldTitle}</div>
      <div className={"stg-field" + (cfg.fieldScroll ? " stg-field--scroll" : "")}>
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
  );
  return (
    <div className="bbx stg">
      {/* ticker */}
      {!cfg.hideTicker && cfg.ticker && (
        <div className={"bbx-ticker" + (tickerLive ? "" : " bbx-ticker--idle")}>
          <div className="bbx-ticker__label"><span className="bbx-pulse" />{tickerLive ? "LIVE" : "SCORES"}</div>
          <div className="bbx-ticker__rail">
            {cfg.ticker.length ? cfg.ticker.map((g, i) => {
              const homeLead = g.sb != null && g.sa != null && g.sb >= g.sa;
              const click = g.game && onGame && g.game.result ? () => onGame(g.game, g.hostId) : null;
              // Live = the bracket marks it in-progress, or (for schedule-sourced rows
              // with no live flag) a non-final game with no scheduled time. Show LIVE
              // (red) instead of the placeholder TBD.
              const liveNow = !g.final && (g.live === true || (g.live === undefined && g.st === "TBD"));
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
                  <span className={"bbx-tk__st" + (liveNow ? " bbx-tk__st--live" : g.final ? "" : " bbx-tk__st--up")}>{liveNow ? "LIVE" : g.st}</span>
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

      {/* featured matchup / stakes board — or "no games". (Regionals render their
          heat-bar board in the split below, alongside the field, so skip it here.) */}
      {cfg.dayGrid ? null
        : cfg.stakes ? <StageStakes stakes={cfg.stakes} onTeam={onTeam} />
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

      {/* Regionals: heat-bar board (the day's games) on the left, the "in the
          regionals" field on the right. Other stages keep the schedule + field. */}
      {cfg.dayGrid ? (
        <div className="stg-split">
          <div className="stg-split__cell stg-rb-cell"><StageRegionalBoard data={cfg.dayGrid} onTeam={onTeam} onGame={onGameModal} /></div>
          <div className="stg-split__cell">{fieldPanel}</div>
        </div>
      ) : (
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
              const noStatus = !g.status && !g.live;   // e.g. the CHAMPIONSHIP SERIES rows
              return (
                <button key={i} className={"stg-sched__row" + (click ? " stg-sched__row--click" : "")
                                + (noStatus ? " stg-sched__row--nostatus" : "")}
                        disabled={!click} onClick={click || undefined}>
                  {!noStatus && <div className="stg-sched__status"><StatusPill s={g.status} live={g.live} /></div>}
                  <div className="stg-sched__teams">
                    <Team s={g.a} sc={g.sa} win={winA} dim={g.done && !winA} />
                    <Team s={g.b} sc={g.sb} win={winB} dim={g.done && !winB} />
                  </div>
                  <div className="stg-sched__right">
                    <div className={"stg-sched__when" + (g.done && noStatus ? " bbx-gold" : "")}>{g.when}</div>
                    {g.series && <div className="mono bbx-gold stg-sched__series">◆ {g.series}</div>}
                  </div>
                </button>
              );
            }) : <div className="bbx-faint bbx-pad">No games today.</div>}
          </div>
        </div>
        </div>

        <div className="stg-split__cell">{fieldPanel}</div>
      </div>
      )}

      {/* players to watch — BATTERS ⇄ PITCHERS, by the player-of-week formula */}
      {cfg.league && <StagePlayersToWatch league={cfg.league} onTeam={onTeam} />}
    </div>
  );
}

/* ---------- compose: build a phase's cfg from real data ---------- */
const HomeStage = ({ phase, onTeam, onGame, onGameModal, league }) => {
  const m = STAGE_META[phase];
  const isCws = phase === "cws" || phase === "cws_finals";
  const needsBracket = isCws || phase === "regionals";
  const [bracket, setBracket] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    if (needsBracket && window.fetchBracket)
      window.fetchBracket("ncaa").then((d) => live && setBracket(d)).catch(() => {});
    return () => { live = false; };
  }, [phase, league]);

  let ticker, featured, schedule, field, compare, tracker, stakes, dayGrid, scheduleTitle = m.scheduleTitle;
  if (isCws) {
    // Today's Omaha games come from the real (dated) schedules so the board changes
    // day to day — not the whole bracket at once. The bracket still supplies the
    // field, the headliner, and the finalists. CWS + Finals share one game-level
    // round, and the slate is national (not league-scoped).
    const round = "College World Series";
    // The same Omaha game shows up under both teams' schedules, and the two sides can
    // carry different ids (saved box score vs bracket vs scoreboard), so dedupe by the
    // unordered matchup — keeping the entry with the most complete score. (Safe here:
    // the CWS has no same-day doubleheaders that would legitimately repeat a matchup.)
    const nrm = (s) => (s || "?").toLowerCase().replace(/[^a-z0-9]/g, "");
    const cwsOn = (d) => {
      const best = new Map();
      for (const r of stgGamesOn(d).filter((x) => stgInRound(x.phase, round))) {
        const key = [nrm(r.hostId), nrm(r.g && r.g.opp && r.g.opp.id)].sort().join("|");
        const score = (x) => (x.hs != null && x.as != null ? 1 : 0);
        const prev = best.get(key);
        if (!prev || score(r) > score(prev)) best.set(key, r);
      }
      return [...best.values()];
    };
    const now = stgToday();
    const todayRows = cwsOn(now);                  // strictly today -> top ticker
    let day = now, rows = todayRows;
    if (!rows.length) {                            // off-day: preview the next Omaha day
      const dates = new Set(), sch = window.SCHEDULES || {};
      for (const seo in sch) for (const g of sch[seo] || [])
        if (g.iso && stgInRound(g.phase, round)) dates.add(g.iso);
      const arr = [...dates].sort();
      day = arr.find((d) => d > now) || (arr.length ? arr[arr.length - 1] : now);
      rows = cwsOn(day);
    }
    if (day > now) scheduleTitle = "UPCOMING GAMES";
    ticker = todayRows.slice(0, 9).map((r) => ({
      a: r.away, b: r.home, sa: r.as, sb: r.hs, final: r.final,
      st: r.final ? "FINAL" : (r.time || "TBD"), game: r.g, hostId: r.hostId,
    }));
    schedule = stgScheduleFrom(rows);
    if (phase === "cws") {
      // Game of the Day = the marquee matchup among TODAY'S games (best by rank) —
      // not an arbitrary finished game pulled from the whole bracket.
      featured = rows.length ? stgFeatured(phase, rows, day, league) : null;
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
      // The CHAMPIONSHIP SERIES panel lists all three best-of-3 games (date / time /
      // final score), not just today's — so override the day-filtered schedule.
      schedule = stgFinalsSeries(compare, now);
      scheduleTitle = m.scheduleTitle;             // keep "CHAMPIONSHIP SERIES"
    }
  } else {
    // This league's games for the round, scoped so the ACC view shows ACC, not SEC.
    const round = m.round;
    const inLeague = new Set(
      (window.leagueTeams ? window.leagueTeams(league) : (window.TEAMS || [])).map((t) => t.id));
    const rowsOn = (d) => stgGamesOn(d)
      .filter((r) => stgInRound(r.phase, round) && inLeague.has(r.hostId));
    // Show today's games; but BETWEEN ROUNDS (e.g. 5/18 — the regular season is over
    // yet the conference tournament hasn't started) fall back to the soonest upcoming
    // day with this league's games (the first tournament day) instead of "No games".
    const now = stgToday();
    const todayRows = rowsOn(now);     // strictly today — drives the top ticker only
    let day = now;
    if (!todayRows.length) {
      const dates = new Set();
      const sch = window.SCHEDULES || {};
      for (const seo in sch) {
        if (!inLeague.has(seo)) continue;
        for (const g of sch[seo] || []) if (g.iso && stgInRound(g.phase, round)) dates.add(g.iso);
      }
      const arr = [...dates].sort();
      day = arr.find((d) => d > now) || (arr.length ? arr[arr.length - 1] : now);
    }
    if (day > now) scheduleTitle = "UPCOMING GAMES";   // previewing a future day
    const rows = rowsOn(day);          // schedule + headliner (may be a future day)
    // Top ticker shows ONLY games scheduled for the actual today; blank otherwise —
    // it does not preview the upcoming day the way the schedule/headliner do.
    ticker = todayRows.slice(0, 9).map((r) => ({
      a: r.away, b: r.home, sa: r.as, sb: r.hs, final: r.final,
      st: r.final ? "FINAL" : (r.time || "TBD"), game: r.g, hostId: r.hostId,
    }));
    schedule = stgScheduleFrom(rows);
    field = stgField(phase, bracket ? stgSeedMap(bracket) : null, league);
    compare = null;
    if (phase === "regionals") {
      // Condensed per-regional grid (replaces the stakes board AND the duplicate
      // Today's Games list); reuses stgStakes' grouped data.
      dayGrid = stgStakes(day);                  // that day's games only; null if none
      featured = null;
    } else if (phase === "super_regionals") {
      // Same board, mapped to best-of-3 series stakes (win to Omaha / win or go home).
      dayGrid = stgSupers(day);
      featured = null;
    } else {
      featured = rows.length ? stgFeatured(phase, rows, day, league) : null;
    }
    // Gap day before the round's games start: the board is previewing a FUTURE day,
    // so relabel "WHAT'S AT STAKE TODAY" as upcoming (and name the day) — those games
    // haven't been played yet.
    if (dayGrid && day > now) {
      const dl = (dayGrid.games || []).map((x) => x.game && x.game.date).find(Boolean);
      dayGrid.title = dl ? `WHAT'S AT STAKE · UPCOMING ${dl}` : "WHAT'S AT STAKE · UPCOMING";
    }
  }

  // During the conference-tournament phase, the masthead reflects the selected
  // league (ACC TOURNAMENT + its venue, etc.), not always the SEC's.
  const ct = phase === "sec_tournament" ? (CONF_TOURNEY[league] || CONF_TOURNEY.SEC) : null;
  if (ct && featured) featured.round = ct.title;
  const cfg = {
    hideTicker: m.hideTicker || !ticker || !ticker.length,   // blank when no games today
    ticker,
    kicker: `POSTSEASON · STAGE ${m.stage} OF 5 · ${m.dates}`,
    title: ct ? ct.title : m.title,
    meta: ct ? ct.meta : m.meta,
    featured, tracker, stakes, dayGrid, scheduleTitle, schedule,
    fieldTitle: (m.fieldTitle || "").replace(/\bSEC\b/, league === "NCAA" ? "NCAA" : (league || "SEC")),
    fieldScroll: phase === "sec_tournament" || phase === "regionals" || phase === "super_regionals",   // cap the field at ~10 rows

    field, compare,
    league: league || window.CURRENT_LEAGUE,
  };
  return <StagePage cfg={cfg} onTeam={onTeam} onGame={onGame} onGameModal={onGameModal} />;
};

window.StagePage = StagePage;
window.HomeStage = HomeStage;
