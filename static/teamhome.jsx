// Team "Home" tab — season-aware landing for one team. Renders below the team
// hero/tabs that TeamDetail already provides, so no second hero here. Reuses the
// shared adapters/atoms from home.jsx (hpSecTeams, hpPhase, HPLabel, HPLogo, ...).
// Real data: this week + recent from the schedule, conference standing from
// TEAMS, team leaders from the lazy /api/team crawl. Postseason-only extras
// (national seed, road-to-Omaha path, eliminated narrative) are left for later.

// Group consecutive games vs the same opponent into runs (a weekend/postseason
// series is one run; single games are runs of length 1).
function groupRuns(games) {
  const runs = [];
  for (const g of games) {
    const last = runs[runs.length - 1];
    if (last && last[0].opp && g.opp && last[0].opp.id === g.opp.id) last.push(g);
    else runs.push([g]);
  }
  return runs;
}

const _known = (o) => o && o.id && (window.TEAM_BY_ID || {})[o.id];

// The team's Super Regional matchup from the bracket (carries official national
// seeds). Returns { me, opp } where each is { seo, name, logo, seed } or null.
function teamSuper(teamId) {
  for (const sr of (window.SUPER_REGIONALS || [])) {
    if (sr.top && sr.top.seo === teamId) return { me: sr.top, opp: sr.bottom, city: sr.city };
    if (sr.bottom && sr.bottom.seo === teamId) return { me: sr.bottom, opp: sr.top, city: sr.city };
  }
  return null;
}

// A team row inside a postseason card: logo + name + seed (the team's NCAA seed
// isn't in our data, so we show its national rank as the next-best number).
function SeriesTeam({ t, seed, accent, onTeam, me }) {
  if (!t) return null;
  const click = _known(t);
  return (
    <button className="bare-btn th-post__team" disabled={!click}
      onClick={() => click && onTeam && onTeam(t.id)}>
      <span className="th-post__teamname"><HPLogo team={t} size={22} /><span>{t.name}</span></span>
      {seed != null && (
        <span className="mono th-post__seed" style={me && accent ? { color: accent } : null}>NO.&nbsp;{seed}</span>
      )}
    </button>
  );
}

// Calendar-week key — the Monday of the ISO week containing `iso` — so games
// group into Mon–Sun weeks.
function weekKey(iso) {
  const d = new Date(iso + "T00:00:00");
  const dow = (d.getDay() + 6) % 7;            // 0 = Monday
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Split the schedule into "this week" (the week of the next unplayed game — or the
// last week once the season's over) and the week before it. This Week keeps every
// game of its week (played ones show their result) and only rolls over once they
// are ALL final; Recent is the previous week that has games.
function weeklySplit(schedule) {
  const games = schedule.filter((g) => g.iso);
  if (!games.length) return { thisWeek: [], recent: [], round: "regular" };
  const anchor = games.find((g) => !g.result) || games[games.length - 1];
  const curWk = weekKey(anchor.iso);
  const round = anchor.phase || "regular";
  const weeks = [...new Set(games.map((g) => weekKey(g.iso)))].sort();
  const i = weeks.indexOf(curWk);
  const recentWk = i > 0 ? weeks[i - 1] : null;
  return {
    // current week, kept to the current round so a postseason week doesn't pull in
    // a prior round's stray game
    thisWeek: games.filter((g) => weekKey(g.iso) === curWk && (g.phase || "regular") === round),
    recent: recentWk ? games.filter((g) => weekKey(g.iso) === recentWk) : [],
    round,
  };
}

// Did the team win its regional and move on? True once the schedule carries a
// later round (Super Regional / CWS).
function advancedPastRegional(schedule) {
  return schedule.some((g) => g.phase === "NCAA Super Regional" || g.phase === "College World Series");
}

// A game's outcome cell: the W/L result + score once final, else the start time.
function gameOutcome(g) {
  if (!g.result) return <span className="mono hp-faint">{g.time || "TBD"}</span>;
  return (
    <span className={"chip " + (g.result === "W" ? "chip-w" : "chip-l")}>
      {g.result} {g.score.us}&ndash;{g.score.them}
    </span>
  );
}

// A week's games as a list: each row is a final result (clickable to the box
// score) or an upcoming slot with its start time.
function WeekGames({ games, onGameClick }) {
  return (
    <div className="th-week">
      {games.map((g) => {
        const opp = g.opp, played = !!g.result;
        return (
          <button key={g.id} className="th-week__row" disabled={!played}
            onClick={played ? () => onGameClick && onGameClick(g) : undefined}>
            <span className="th-week__opp">
              <span className="mono hp-muted th-week__va">{g.home ? "vs" : "at"}</span>
              {opp && <HPLogo team={opp} size={20} />}
              <span className="th-week__name">{opp ? opp.name : "TBD"}</span>
              {opp && opp.rank ? <span className="chip-rank">#{opp.rank}</span> : null}
            </span>
            <span className="th-week__right">
              <span className="mono hp-faint th-week__date">{g.date}</span>
              {gameOutcome(g)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// This Week — the current week's whole slate. Played games show their result and
// the section only advances to next week once every game is final.
function ThisWeek({ schedule, team, onTeam, onGameClick }) {
  const { thisWeek, round } = weeklySplit(schedule);
  if (!thisWeek.length) {
    return <div className="hp-placeholder">Season complete — no games on the schedule.</div>;
  }
  if (round === "College World Series") {
    // The CWS is an 8-team double-elimination event (two 4-team brackets) — same
    // shape as a Regional, so it gets the field layout. The Finals are a separate
    // two-team best-of-3, so those keep the series look (site phase says which).
    if ((window.SEASON_PHASE || {}).phase === "cws_finals")
      return <WeekSeries team={team} games={thisWeek} onTeam={onTeam} onGameClick={onGameClick} round={round} />;
    return <WeekCWS team={team} games={thisWeek} onTeam={onTeam} onGameClick={onGameClick} />;
  }
  if (round === "NCAA Super Regional")
    return <WeekSeries team={team} games={thisWeek} onTeam={onTeam} onGameClick={onGameClick} round={round} />;
  if (round === "NCAA Regional")
    return <WeekRegional team={team} games={thisWeek} onTeam={onTeam} onGameClick={onGameClick}
      advanced={advancedPastRegional(schedule)} cols={4} />;
  return <WeekGames games={thisWeek} onGameClick={onGameClick} />;
}

// Super Regional / CWS — matchup + seeds, with every game of the series kept;
// played games show their result, upcoming ones their time.
function WeekSeries({ team, games, onTeam, onGameClick, round }) {
  const isCWS = round === "College World Series";
  const first = games[0] || {};
  // Super-regional matchup + national seeds come from the bracket feed; the CWS
  // opponent comes from the scheduled game itself (teamSuper is super-regional only).
  const sup = isCWS ? null : teamSuper(team.id);
  const oppRaw = sup ? sup.opp : first.opp;
  const oppTeam = oppRaw ? { id: oppRaw.seo || oppRaw.id, name: oppRaw.name, logo: oppRaw.logo,
                             mark: (oppRaw.name || "").slice(0, 4).toUpperCase() } : null;
  const mySeed = sup && sup.me ? sup.me.seed : null;
  const oppSeed = sup && sup.opp ? sup.opp.seed : null;
  const hostName = first.home ? team.name : (oppTeam ? oppTeam.name : "");
  // Name the series for the host's CITY (Austin, not Texas); fall back to the
  // host school name if the bracket didn't supply a city.
  const hostCity = (sup && sup.city) || hostName;
  const title = isCWS ? "College World Series" : `${hostCity} Super Regional`;
  const sub = isCWS ? "At Charles Schwab Field · Omaha"
                    : "Best-of-3 · Winner advances to the College World Series";
  const slots = games.slice(0, 3);
  const needGame3 = !isCWS && slots.length < 3;
  // Clicking the games box opens the SAME super-regional detail modal the bracket
  // uses — found by this team's seo in the NCAA bracket tree.
  const [superModal, setSuperModal] = React.useState(null);
  const openSeries = () => {
    if (isCWS || !window.fetchBracket) return;
    window.fetchBracket("ncaa")
      .then((d) => { const p = window.findSuperPairing(d, team.id); if (p) setSuperModal(p); })
      .catch(() => {});
  };
  const SM = window.SuperModal;
  return (
    <div className="th-post">
      <div className="th-post__title">{title}</div>
      <div className="th-post__sub mono">{sub}</div>
      <div className="th-post__teams">
        {(() => {
          const meRow = <SeriesTeam t={team} seed={mySeed} accent={team.color} onTeam={onTeam} me />;
          const oppRow = <SeriesTeam t={oppTeam} seed={oppSeed} onTeam={onTeam} />;
          // Home team beneath the visitor (CWS is at a neutral site — no host).
          const meHome = !isCWS && (sup && sup.me ? sup.me.home : first.home);
          return meHome
            ? <React.Fragment>{oppRow}{meRow}</React.Fragment>
            : <React.Fragment>{meRow}{oppRow}</React.Fragment>;
        })()}
      </div>
      <div className={"th-post__games" + (isCWS ? "" : " th-post__games--click")}
        style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
        onClick={isCWS ? undefined : openSeries} role={isCWS ? undefined : "button"}>
        {slots.map((g, i) => (
          <div key={g.id} className={"th-pgame" + (g.result ? " th-pgame--final" : "")}>
            <div className="mono th-pgame__g">Game {i + 1}</div>
            <div className="mono th-pgame__date">{g.date}</div>
            <div className="th-pgame__out">{gameOutcome(g)}</div>
          </div>
        ))}
        {needGame3 && (
          <div className="th-pgame th-pgame--ifnec">
            <div className="mono th-pgame__g">Game 3</div>
            <div className="mono th-pgame__date">If necessary</div>
            <div className="mono hp-faint">TBD</div>
          </div>
        )}
      </div>
      {superModal && SM && <SM pairing={superModal} onClose={() => setSuperModal(null)} />}
    </div>
  );
}

// NCAA Regional — a 4-team double-elimination field. The other teams are inferred
// from the distinct opponents across the team's regional games this week; every
// game is kept and played games show their result.
function WeekRegional({ team, games, onTeam, onGameClick, advanced, cols = 4, title, sub, field: fieldProp }) {
  // The field is either supplied by the caller (the CWS sources it from the real
  // bracket half) or inferred from the distinct opponents in the team's games.
  let field = fieldProp;
  if (!Array.isArray(field)) {
    const seen = new Set();
    field = [];
    for (const g of games) {
      const o = g.opp;
      if (o && o.id && !seen.has(o.id)) { seen.add(o.id); field.push(o); }
    }
  }
  // A regional is 4-team double-elimination — show 4 game slots at all times.
  // Known games fill in (result or scheduled), the rest are TBD; once the team's
  // regional is decided — they advanced (won) or were eliminated (2 losses) — the
  // games they won't play are crossed out.
  // The regional is "over" for this team only once they have no regional games
  // left to play AND they've either advanced (won) or been eliminated (2 losses).
  // While a game is still upcoming, the empty slots stay TBD (a 4th may be needed).
  const upcoming = games.some((g) => !g.result);
  const losses = games.filter((g) => g.result === "L").length;
  const over = !upcoming && (advanced || losses >= 2);
  const total = Math.max(4, games.length);
  return (
    <div className="th-post">
      <div className="th-post__title">{title || `${(window.REGIONAL_CITY_BY_TEAM || {})[team.id] || team.name} Regional`}</div>
      <div className="th-post__sub mono">{sub || "Double-elimination · Winner advances to a Super Regional"}</div>
      <div className="th-post__teams">
        <SeriesTeam t={team} accent={team.color} onTeam={onTeam} me />
        {field.map((o) => <SeriesTeam key={o.id} t={o} onTeam={onTeam} />)}
      </div>
      <div className="th-post__games" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: total }, (_, i) => {
          const g = games[i];
          if (g) {
            return (
              <div key={g.id} className={"th-pgame" + (g.result ? " th-pgame--final" : "")}
                onClick={g.result && onGameClick ? () => onGameClick(g) : undefined}
                style={g.result && onGameClick ? { cursor: "pointer" } : undefined}>
                <div className="mono th-pgame__g">{g.home ? "vs" : "at"} {g.opp ? g.opp.name : "TBD"}</div>
                <div className="mono th-pgame__date">{g.date}</div>
                <div className="th-pgame__out">{gameOutcome(g)}</div>
              </div>
            );
          }
          // Empty slot: TBD while the regional's live; crossed out once it's over.
          return (
            <div key={"slot" + i} className={"th-pgame th-pgame--empty" + (over ? " th-pgame--out" : "")}>
              <div className="mono th-pgame__g">Game {i + 1}</div>
              <div className="mono th-pgame__date">{over ? "—" : "TBD"}</div>
              <div className="th-pgame__out mono hp-faint">{over ? "Did not play" : "TBD"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// On-page opponents drawn from a team's own games (the fallback field while the
// bracket loads, or if it's unavailable).
function cwsFieldFromGames(games) {
  const seen = new Set();
  const out = [];
  for (const g of games) {
    const o = g.opp;
    if (o && o.id && !seen.has(o.id) && (window.TEAM_BY_ID || {})[o.id]) {
      seen.add(o.id);
      out.push(window.TEAM_BY_ID[o.id]);
    }
  }
  return out;
}

// College World Series — the team's Omaha bracket, shown with the same field
// layout as a Regional. The field is the OTHER teams in this team's 4-team pod
// that also have a page on the site (e.g. for Texas: Georgia, Alabama, Oklahoma —
// not the non-SEC team in the pod). Sourced from the real NCAA bracket so pod-
// mates the team hasn't played yet still appear; the game grid below still
// reflects the team's actual games.
function WeekCWS({ team, games, onTeam, onGameClick }) {
  const [mates, setMates] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    if (window.fetchBracket && window.findCwsHalf) {
      window.fetchBracket("ncaa").then((d) => {
        if (!live) return;
        const half = window.findCwsHalf(d, team.id);
        const byId = window.TEAM_BY_ID || {};
        const seen = new Set([team.id]);
        const out = [];
        for (const g of (half ? half.games || [] : [])) {
          for (const s of [g.top, g.bottom]) {
            if (s && s.seo && !seen.has(s.seo) && byId[s.seo]) {
              seen.add(s.seo);
              out.push(byId[s.seo]);
            }
          }
        }
        setMates(out);
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [team.id]);
  // Until the bracket resolves, fall back to the on-page opponents from this
  // team's own games so the card isn't empty.
  const field = Array.isArray(mates) ? mates : cwsFieldFromGames(games);
  return (
    <WeekRegional team={team} games={games} onTeam={onTeam} onGameClick={onGameClick}
      advanced={false} cols={4} field={field}
      title="College World Series"
      sub="Omaha · Double-elimination · Winner advances to the Finals" />
  );
}

// Recent — the week BEFORE "This Week" (the previous week that has games), so a
// finished week's games linger here until the current week is over. Played games
// link to their box score; a postseason round shows its name above.
function RecentList({ schedule, onGameClick }) {
  const { recent } = weeklySplit(schedule);
  if (!recent.length) return <div className="hp-placeholder">No results yet.</div>;
  const round = (recent.find((g) => g.result) || recent[0]).phase || "regular";
  return (
    <div>
      {round !== "regular" && <div className="th-recent__head">{round}</div>}
      <WeekGames games={recent} onGameClick={onGameClick} />
    </div>
  );
}

// SEC series recap — the team's conference weekend series and how each went.
// Replaces "Recent" for eliminated teams (their conference-season recap), in
// chronological order. Each row: series outcome (W/L/T) + record + opponent.
function SecSeries({ schedule, onTeam }) {
  const conf = schedule.filter((g) => g.result && g.opp && g.opp.conf && (g.phase || "regular") === "regular");
  const series = groupRuns(conf);
  if (!series.length) return <div className="hp-placeholder">No conference series.</div>;
  return (
    <div className="th-recent">
      {series.map((run, i) => {
        const w = run.filter((g) => g.result === "W").length;
        const l = run.length - w;
        const won = w > l, split = w === l;
        const swept = run.length >= 3 && (w === 0 || l === 0);
        const opp = run[0].opp;
        const click = _known(opp);
        return (
          <button key={i} className="bare-btn th-recent__row" disabled={!click}
            onClick={() => click && onTeam && onTeam(opp.id)}>
            <span className={"chip " + (won ? "chip-w" : split ? "" : "chip-l")}>{won ? "W" : split ? "T" : "L"}</span>
            <span className="mono th-recent__score">{w}&ndash;{l}</span>
            <span className="th-recent__opp">{opp ? opp.name : ""}</span>
            <span className="mono hp-faint th-recent__date">{swept ? "Swept" : (run[0].home ? "vs" : "at")}</span>
          </button>
        );
      })}
    </div>
  );
}

// Compact "how the season ended" for an eliminated team: the furthest round it
// reached + its final game. Fills the gap under Conference Standing.
function HowItEnded({ schedule }) {
  const played = schedule.filter((g) => g.result);
  if (!played.length) return null;
  // Show every game from the last round the team reached (e.g. all of their
  // Regional games). A regular-season ending has no round, so fall back to the
  // last handful of games.
  const round = played[played.length - 1].phase || "regular";
  const inRound = played.filter((g) => (g.phase || "regular") === round);
  const games = round === "regular" ? inRound.slice(-5) : inRound;
  const post = round !== "regular";
  return (
    <div className="th-ended">
      <div className="th-ended__round" style={post ? null : { color: "var(--muted)" }}>
        {post ? round : "Regular Season"}
      </div>
      {games.map((g) => (
        <div key={g.id} className="th-ended__game">
          <span className={"chip " + (g.result === "W" ? "chip-w" : "chip-l")}>{g.result}</span>
          <span className="mono th-ended__score">{g.score.us}&ndash;{g.score.them}</span>
          <span className="th-ended__opp">{g.home ? "vs" : "at"} {g.opp ? g.opp.name : ""}</span>
          <span className="mono hp-faint">{g.date}</span>
        </div>
      ))}
    </div>
  );
}

// Window of 5 standings rows centred on this team.
function ConfStrip({ teamId }) {
  // The strip follows the TEAM's own conference, not the global league selector.
  const meTeam = (window.TEAM_BY_ID || {})[teamId];
  const conf = (meTeam && meTeam.conference) || window.CURRENT_LEAGUE;
  const teams = hpSecTeams(conf);
  const idx = teams.findIndex((t) => t.id === teamId);
  const total = teams.length;
  const win = 5;
  let start = Math.max(0, idx - 2);
  start = Math.min(start, Math.max(0, total - win));
  const slice = teams.slice(start, start + win);
  return (
    <div className="th-strip">
      <div className="th-strip__meta mono hp-ink2">#{idx + 1} of {total} in the {conf || "conference"}</div>
      {slice.map((t, i) => {
        const me = t.id === teamId;
        const pos = start + i + 1;
        return (
          <div key={t.id} className={"th-strip__row" + (me ? " th-strip__row--me" : "")}
            style={me ? { borderLeftColor: t.color } : null}>
            <span className="mono hp-faint">{String(pos).padStart(2, "0")}</span>
            <span className="th-strip__team">
              <HPLogo team={t} size={22} />
              <span className={me ? "bold" : ""}>{t.name}</span>
            </span>
            <span className="mono hp-r">{t.confW}&ndash;{t.confL}</span>
            <span className="hp-r"><HPStreak streak={t.streak} /></span>
          </div>
        );
      })}
    </div>
  );
}

// Team stat leaders, from the (lazy, memoized) /api/team crawl — same shape the
// Stats tab renders: [{ pos, note, name, line }].
function TeamLeaders({ leaders }) {
  if (!leaders || !leaders.length) {
    return <div className="hp-placeholder">No leaders available.</div>;
  }
  return (
    <div className="th-leaders">
      {leaders.map((l, i) => (
        <div key={i} className="th-leader">
          <div className="hp-eyebrow">{l.note || l.pos}</div>
          <div className="th-leader__row">
            <span className="th-leader__name">{l.name || l.line}</span>
            {l.pos && <span className="th-leader__pos">{l.pos}</span>}
            {l.name && <span className="th-leader__val">{l.line}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

const TeamHome = ({ teamId, onTeam, onGameClick }) => {
  const team = window.TEAM_BY_ID[teamId];
  const schedule = window.SCHEDULES[teamId] || [];
  const post = hpPhase() === "postseason" && (window.SEASON_PHASE || {}).phase !== "offseason";
  const hasUpcoming = schedule.some((g) => !g.result);
  // A team that just WON its round but whose next matchup isn't on the schedule
  // yet keeps the weekly layout (This Week = the round it won, Recent = the one
  // before) — not the season-over recap — until those upcoming games appear.
  const advanced = teamPostseasonStatus(schedule).advanced;
  const showWeekly = hasUpcoming || advanced;

  // Team leaders need the per-team box-score crawl (memoized in bootstrap.js).
  const [teamData, setTeamData] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    setTeamData(null);
    window.fetchTeam(teamId).then((d) => { if (live) setTeamData(d); }).catch(() => {});
    return () => { live = false; };
  }, [teamId]);

  return (
    <div className="hp hp--team">
      {showWeekly && (
        <section className="hp-hero">
          <HPLabel color={post ? "var(--gold)" : null}>{advanced && !hasUpcoming ? "Latest" : "This Week"}</HPLabel>
          <ThisWeek schedule={schedule} team={team} onTeam={onTeam} onGameClick={onGameClick} />
        </section>
      )}

      <section className="hp-split">
        <div>
          <HPLabel>{showWeekly ? "Recent" : "SEC Series"}</HPLabel>
          {showWeekly
            ? <RecentList schedule={schedule} onGameClick={onGameClick} />
            : <SecSeries schedule={schedule} onTeam={onTeam} />}
        </div>
        <div className="hp-split__rule" />
        <div>
          <HPLabel>Conference Standing</HPLabel>
          <ConfStrip teamId={teamId} />
          {!showWeekly && (
            <div className="th-ended-wrap">
              <HPLabel>How It Ended</HPLabel>
              <HowItEnded schedule={schedule} />
            </div>
          )}
        </div>
      </section>

      <section className="hp-hero">
        <HPLabel>Team Leaders</HPLabel>
        {teamData
          ? <TeamLeaders leaders={teamData.leaders} />
          : <div className="hp-placeholder">Loading team leaders…</div>}
      </section>
    </div>
  );
};

window.TeamHome = TeamHome;
