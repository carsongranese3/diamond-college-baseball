// Team detail view — continuous schedule + Team/Players stats toggle

// Postseason status from the schedule — whether the team advanced, was
// eliminated, won it all, or missed the bracket. A team is "out" only when it
// actually LOST its last round (≥2 losses in a double-elim/best-of-3, or lost the
// CWS); winning the round means it advanced even if the next round's matchups
// aren't on the schedule yet. (Counts round losses, not the last game's result,
// so a double-elim run that ends W/L/L/W still reads as eliminated.)
function teamPostseasonStatus(schedule) {
  const ROUND_LABEL = {
    "NCAA Regional": "Regionals", "NCAA Super Regional": "Super Regionals",
    "College World Series": "College World Series", "SEC Tournament": "SEC Tournament",
  };
  // Only the NCAA bracket rounds advance by winning (regional -> super -> CWS).
  // The SEC Tournament leads to the NCAAs by selection, not by winning, so it's
  // not an "advance" round — a team whose season ends there is just out.
  const NEXT_ROUND = {
    "NCAA Regional": "Super Regional", "NCAA Super Regional": "College World Series",
  };
  const played = (schedule || []).filter((g) => g.result);
  const seasonOver = played.length > 0 && !(schedule || []).some((g) => !g.result);
  const lastGame = played.length ? played[played.length - 1] : null;
  const lastRound = lastGame ? (lastGame.phase || "regular") : null;
  const inPost = !!lastRound && lastRound !== "regular";
  // Losses within the last round — a regional (double-elim) or super regional
  // (best-of-3) ends in elimination at 2 losses, so a team that's done with fewer
  // WON the round (robust to same-day games sorting either way).
  const roundLosses = played.filter(
    (g) => (g.phase || "regular") === lastRound && g.result === "L").length;
  const wonCWS = lastRound === "College World Series" && !!lastGame && lastGame.result === "W";
  const wonRound = lastRound === "College World Series" ? wonCWS : roundLosses < 2;
  const nationalChamp = seasonOver && wonCWS;
  // Advanced only out of a bracket round it actually won; everything else with the
  // season over is eliminated (CWS losers, SEC-tourney exits, 2-loss rounds).
  const advanced = seasonOver && inPost && wonRound && !nationalChamp && !!NEXT_ROUND[lastRound];
  const eliminated = seasonOver && inPost && !advanced && !nationalChamp;
  const missedPost = seasonOver && !inPost;
  return {
    seasonOver, lastRound, nationalChamp, advanced, eliminated, missedPost,
    advancedText: advanced ? `Advanced · ${NEXT_ROUND[lastRound]}` : "",
    outText: eliminated ? `Eliminated · ${ROUND_LABEL[lastRound] || "Postseason"}` : "Missed Postseason",
  };
}

// Unified "what is this team right now" — a single status value for the team
// hero. Finished teams report their terminal outcome (reusing the flags from
// teamPostseasonStatus); teams still playing report the round they're currently
// in. Returns { key, label }.
function teamSeasonStatus(schedule) {
  const ts = teamPostseasonStatus(schedule);
  if (ts.nationalChamp) return { key: "national_champ", label: "National Champions" };
  if (ts.advanced)      return { key: "advanced", label: ts.advancedText };
  if (ts.eliminated)    return { key: "eliminated", label: ts.outText };
  if (ts.missedPost)    return { key: "missed_post", label: ts.outText };
  // Still playing — name the round of the next unplayed game (fall back to the
  // last game's round, then "regular").
  const ROUND = {
    "SEC Tournament":      { key: "sec_tournament",  label: "In the SEC Tournament" },
    "NCAA Regional":       { key: "regionals",       label: "In the Regionals" },
    "NCAA Super Regional": { key: "super_regionals", label: "In the Super Regionals" },
    "College World Series": { key: "cws",            label: "In the College World Series" },
  };
  const next = (schedule || []).find((g) => !g.result);
  const played = (schedule || []).filter((g) => g.result);
  const round = (next && next.phase)
    || (played.length ? played[played.length - 1].phase : null) || "regular";
  const status = ROUND[round] || { key: "regular", label: "Regular Season" };
  // CWS games share their game-level label with the finals; promote to "Finals"
  // when the site phase says so.
  if (status.key === "cws" && (window.SEASON_PHASE || {}).phase === "cws_finals")
    return { key: "cws_finals", label: "In the CWS Finals" };
  return status;
}

const TeamDetail = ({ teamId, initialTab, initialStatMode, initialStatView, initialStatLevel,
                      onTabChange, onStatChange, onBack, onTeam, onGameClick, onPlayerClick }) => {
  const team = window.TEAM_BY_ID[teamId];
  const [tab, setTabState] = React.useState(initialTab || "home");
  const [statMode, setStatModeState] = React.useState(initialStatMode || "team");      // team | players
  const [playerView, setPlayerViewState] = React.useState(initialStatView || "batting"); // batting | pitching
  const [statLevel, setStatLevelState] = React.useState(initialStatLevel || "basic");  // basic | advanced
  const schedule = window.SCHEDULES[teamId] || [];

  // Follow the URL when it changes (back/forward, or a new deep-link).
  React.useEffect(() => { setTabState(initialTab || "home"); }, [initialTab, teamId]);
  React.useEffect(() => { setStatModeState(initialStatMode || "team"); }, [initialStatMode]);
  React.useEffect(() => { setPlayerViewState(initialStatView || "batting"); }, [initialStatView]);
  React.useEffect(() => { setStatLevelState(initialStatLevel || "basic"); }, [initialStatLevel]);
  // Changing a tab or stat option updates the URL so each is its own shareable link.
  const setTab = (t) => { setTabState(t); if (onTabChange) onTabChange(t); };
  const setStatMode = (m) => { setStatModeState(m); if (onStatChange) onStatChange({ statMode: m }); };
  const setPlayerView = (v) => { setPlayerViewState(v); if (onStatChange) onStatChange({ statView: v }); };
  const setStatLevel = (l) => { setStatLevelState(l); if (onStatChange) onStatChange({ statLevel: l }); };

  // Team season stats + roster are an expensive per-team crawl, fetched lazily
  // the first time the Stats tab is opened.
  const [teamData, setTeamData] = React.useState(null);
  const [statError, setStatError] = React.useState(null);
  React.useEffect(() => {
    if (tab === "stats" && !teamData && !statError) {
      window.fetchTeam(teamId).then(setTeamData).catch((e) => setStatError(e.message));
    }
  }, [tab, teamData, statError, teamId]);

  // sec position by RPI rank order
  const position = React.useMemo(() => {
    const arr = [...window.TEAMS].sort(
      (a, b) => (a.rpi ?? 999) - (b.rpi ?? 999)
    );
    return arr.findIndex(t => t.id === teamId) + 1;
  }, [teamId]);

  // Season-status flags for the hero corner: conference champion (best conference
  // record, once the regular season is done) and whether the team's been
  // eliminated, in which round.
  const champId = React.useMemo(() => {
    const arr = [...(window.TEAMS || [])].sort((a, b) => {
      const ap = a.confW / Math.max(a.confW + a.confL, 1);
      const bp = b.confW / Math.max(b.confW + b.confL, 1);
      return bp - ap || b.confW - a.confW;
    });
    return arr[0] ? arr[0].id : null;
  }, []);
  const regularOver = (window.SEASON_PHASE && window.SEASON_PHASE.phase) !== "regular";
  const isConfChamp = regularOver && champId === teamId;

  const { nationalChamp, advanced, eliminated, missedPost, advancedText, outText } =
    teamPostseasonStatus(schedule);
  // In-progress postseason status (e.g. "In the Super Regionals") — shown only
  // while the team is still alive in a bracket round; terminal states above own
  // the hero otherwise.
  const liveStatus = teamSeasonStatus(schedule);
  const inPostseason = ["sec_tournament", "regionals", "super_regionals", "cws", "cws_finals"]
    .includes(liveStatus.key);

  return (
    <div className="team-detail">
      <BackLink onClick={onBack}>Standings</BackLink>

      <header className="team-hero" style={{ "--team-color": team.color, "--team-ink": team.ink }}>
        <div className="team-hero__band" />
        {(nationalChamp || isConfChamp || advanced || eliminated || missedPost || inPostseason) && (
          <div className="team-hero__flags">
            {nationalChamp && <span className="team-flag team-flag--natty">🏆 National Champions</span>}
            {isConfChamp && <span className="team-flag team-flag--champ">★ SEC Champions</span>}
            {inPostseason && <span className="team-flag team-flag--active">{liveStatus.label}</span>}
            {advanced && <span className="team-flag team-flag--advanced">{advancedText}</span>}
            {(eliminated || missedPost) && <span className="team-flag team-flag--out">{outText}</span>}
          </div>
        )}
        <div className="team-hero__inner">
          <Monogram team={team} size={88} />
          <div className="team-hero__text">
            <div className="team-hero__kicker">
              <RankChip rank={team.rank} size="lg" />
              <span className="muted">SEC #{position} · {team.city}</span>
            </div>
            <h1 className="display team-hero__name">{team.name}</h1>
            <div className="team-hero__stats">
              <div className="micro-stat">
                <div className="micro-stat__label">Conference</div>
                <div className="micro-stat__value mono">{team.confW}–{team.confL}</div>
              </div>
              <div className="micro-stat">
                <div className="micro-stat__label">Overall</div>
                <div className="micro-stat__value mono">{team.ovrW}–{team.ovrL}</div>
              </div>
              <div className="micro-stat">
                <div className="micro-stat__label">Streak</div>
                <div className="micro-stat__value mono">{team.streak}</div>
              </div>
              <div className="micro-stat">
                <div className="micro-stat__label">RPI</div>
                <div className="micro-stat__value mono">#{team.rpi}</div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="tabs">
        <button
          className={`tab ${tab === "home" ? "tab--active" : ""}`}
          onClick={() => setTab("home")}
        >
          Home
        </button>
        <button
          className={`tab ${tab === "schedule" ? "tab--active" : ""}`}
          onClick={() => setTab("schedule")}
        >
          Schedule
        </button>
        <button
          className={`tab ${tab === "roster" ? "tab--active" : ""}`}
          onClick={() => setTab("roster")}
        >
          Roster
        </button>
        <button
          className={`tab ${tab === "stats" ? "tab--active" : ""}`}
          onClick={() => setTab("stats")}
        >
          Stats
        </button>
        <div className="tab-spacer" />
        {tab === "stats" && (
          <div className="segmented">
            <button
              className={`segmented__btn ${statMode === "team" ? "segmented__btn--active" : ""}`}
              onClick={() => setStatMode("team")}
            >Team</button>
            <button
              className={`segmented__btn ${statMode === "players" ? "segmented__btn--active" : ""}`}
              onClick={() => setStatMode("players")}
            >Players</button>
          </div>
        )}
      </div>

      {tab === "home" && (
        <TeamHome
          teamId={teamId}
          onTeam={onTeam}
          onGameClick={(g) => onGameClick(g, team.id)}
        />
      )}
      {tab === "schedule" && (
        <ScheduleView
          schedule={schedule}
          team={team}
          onGameClick={(g) => onGameClick(g, team.id)}
        />
      )}
      {tab === "stats" && statError && (
        <div className="loading-block">Could not load stats — {statError}</div>
      )}
      {tab === "stats" && !statError && !teamData && (
        <div className="loading-block">
          Crawling box scores for season stats… first load can take a moment.
        </div>
      )}
      {tab === "stats" && teamData && statMode === "team" && (
        <TeamStatsView stats={teamData} team={team} />
      )}
      {tab === "stats" && teamData && statMode === "players" && (
        <PlayerStatsView
          roster={teamData.roster}
          playerView={playerView}
          setPlayerView={setPlayerView}
          statLevel={statLevel}
          setStatLevel={setStatLevel}
          onPlayerClick={onPlayerClick}
        />
      )}
      {tab === "roster" && (
        <RosterView teamId={teamId} onPlayerClick={onPlayerClick} />
      )}
    </div>
  );
};

// One continuous, chronological list of every game.
// "Today" lands between the last result and the first scheduled game.
const ScheduleView = ({ schedule, team, onGameClick }) => {
  // Schedule is already in chronological order in data.js — just walk it.
  // We insert a divider in front of the first unplayed game.
  const firstUpcomingIdx = schedule.findIndex(g => !g.result);

  const wins = schedule.filter(g => g.result === "W").length;
  const losses = schedule.filter(g => g.result === "L").length;
  const upcoming = schedule.length - wins - losses;

  return (
    <div className="schedule">
      <div className="sched-summary">
        <div className="sched-summary__item">
          <div className="sched-summary__label">Played</div>
          <div className="sched-summary__value mono">{wins + losses}</div>
        </div>
        <div className="sched-summary__item">
          <div className="sched-summary__label">Record</div>
          <div className="sched-summary__value mono">{wins}–{losses}</div>
        </div>
        <div className="sched-summary__item">
          <div className="sched-summary__label">Upcoming</div>
          <div className="sched-summary__value mono">{upcoming}</div>
        </div>
        <div className="sched-summary__item">
          <div className="sched-summary__label">Win %</div>
          <div className="sched-summary__value mono">
            {(wins / Math.max(wins + losses, 1)).toFixed(3).replace(/^0/, "")}
          </div>
        </div>
      </div>

      <div className="sched-list">
        {schedule.map((g, i) => {
          const phase = g.phase || "regular";
          const prevPhase = i > 0 ? (schedule[i - 1].phase || "regular") : "regular";
          const showPhase = phase !== "regular" && phase !== prevPhase;
          const showUpcoming = i === firstUpcomingIdx && firstUpcomingIdx > 0 && !showPhase;
          return (
            <React.Fragment key={g.id}>
              {showPhase && (
                <div className="sched-divider sched-divider--phase">
                  <span className="sched-divider__line" />
                  <span className="sched-divider__label">{phase}</span>
                  <span className="sched-divider__line" />
                </div>
              )}
              {showUpcoming && (
                <div className="sched-divider">
                  <span className="sched-divider__line" />
                  <span className="sched-divider__label">Upcoming</span>
                  <span className="sched-divider__line" />
                </div>
              )}
              <ScheduleRow game={g} onClick={() => g.result ? onGameClick(g) : null} />
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

const ScheduleRow = ({ game, onClick }) => {
  const isUpcoming = !game.result;
  return (
    <div
      className={`sched-row ${isUpcoming ? "sched-row--upcoming" : ""} ${game.result === "W" ? "sched-row--win" : game.result === "L" ? "sched-row--loss" : ""}`}
      onClick={onClick}
    >
      <div className="sched-row__date">
        <div className="sched-row__date-main mono">{game.date}</div>
        <div className="sched-row__date-sub mono">{isUpcoming ? game.time || "TBD" : "Final"}</div>
      </div>

      <div className="sched-row__vs">
        <span className="sched-row__vs-text">{game.home ? "vs" : "at"}</span>
      </div>

      <div className="sched-row__opp">
        <Monogram team={game.opp} size={32} />
        <div className="sched-row__opp-text">
          <div className="sched-row__opp-name">
            {game.opp.rank && <span className="rank-chip rank-sm">#{game.opp.rank}</span>} {game.opp.name}
          </div>
          <div className="sched-row__opp-conf">{game.opp.conf ? "SEC Conference" : "Non-conference"}</div>
        </div>
      </div>

      <div className="sched-row__result">
        {isUpcoming ? (
          <span className="sched-row__upcoming-pill">Scheduled</span>
        ) : (
          <>
            <span className={`result-chip ${game.result === "W" ? "win" : "loss"}`}>{game.result}</span>
            <span className="sched-row__score mono">{game.score.us}–{game.score.them}</span>
          </>
        )}
      </div>

      <div className="sched-row__chev">{isUpcoming ? "" : "›"}</div>
    </div>
  );
};

const TeamStatsView = ({ stats, team }) => {
  return (
    <div className="stats">
      <section className="stats-section">
        <Eyebrow>Batting · Team totals</Eyebrow>
        <div className="stat-grid stat-grid--4">
          <StatCell label="AVG"  value={stats.batting.avg} />
          <StatCell label="OBP"  value={stats.batting.obp} />
          <StatCell label="SLG"  value={stats.batting.slg} />
          <StatCell label="OPS"  value={(parseFloat(stats.batting.obp) + parseFloat(stats.batting.slg)).toFixed(3).replace(/^0/, "")} />
          <StatCell label="Runs" value={stats.batting.runs} />
          <StatCell label="Hits" value={stats.batting.h} />
          <StatCell label="HR"   value={stats.batting.hr} />
          <StatCell label="RBI"  value={stats.batting.rbi} />
        </div>
      </section>

      <section className="stats-section">
        <Eyebrow>Pitching · Team totals</Eyebrow>
        <div className="stat-grid stat-grid--4">
          <StatCell label="ERA"  value={stats.pitching.era} />
          <StatCell label="WHIP" value={stats.pitching.whip} />
          <StatCell label="K"    value={stats.pitching.k} />
          <StatCell label="BB"   value={stats.pitching.bb} />
          <StatCell label="SV"   value={stats.pitching.sv} />
          <StatCell label="IP"   value={stats.pitching.ip} />
          <StatCell label="OBA"  value={stats.pitching.oba} />
          <StatCell label="HR/9" value={(stats.pitching.hr_a * 9 / parseFloat(stats.pitching.ip)).toFixed(2)} />
        </div>
      </section>

      <section className="stats-section">
        <Eyebrow>Fielding</Eyebrow>
        <div className="stat-grid stat-grid--3">
          <StatCell label="Fielding pct" value={stats.fielding.pct} />
          <StatCell label="Errors"       value={stats.fielding.e} />
          <StatCell label="Double plays" value={stats.fielding.dp} />
        </div>
      </section>
    </div>
  );
};

// Column sets per view + level. Each column: {k, label, cls?}. cls applies to
// the data cell ("bold" for the headline stat, "muted" for secondary). Advanced
// columns have no value in the data yet, so they render blank ("—") for now.
const STAT_COLUMNS = {
  batting: {
    basic: [
      { k: "g", label: "G" }, { k: "ab", label: "AB" }, { k: "pa", label: "PA" },
      { k: "r", label: "R" },
      { k: "h", label: "H" }, { k: "hr", label: "HR" }, { k: "rbi", label: "RBI" },
      { k: "bb", label: "BB" }, { k: "k", label: "K" }, { k: "sb", label: "SB" },
      { k: "avg", label: "AVG", cls: "bold" },
    ],
    advanced: [
      { k: "obp", label: "OBP", cls: "muted",
        desc: "On-base percentage — (H + BB + HBP) / (AB + BB + HBP + SF). How often a batter reaches base." },
      { k: "slg", label: "SLG", cls: "muted",
        desc: "Slugging percentage — total bases per at-bat (TB / AB). Measures power." },
      { k: "ops", label: "OPS", cls: "bold",
        desc: "On-base plus slugging — OBP + SLG. A quick all-around offense number." },
      { k: "babip", label: "BABIP",
        desc: "Batting avg on balls in play — (H − HR) / (AB − K − HR + SF). High values can signal luck." },
      { k: "bbpct", label: "BB%",
        desc: "Walk rate — walks per plate appearance (BB / PA)." },
      { k: "kpct", label: "K%",
        desc: "Strikeout rate — strikeouts per plate appearance (K / PA)." },
      { k: "secavg", label: "SEC",
        desc: "Secondary average — (TB − H + BB + SB − CS) / AB. Value beyond batting average." },
      { k: "rc", label: "RC",
        desc: "Runs created — (H + BB) × TB / (AB + BB). Estimated runs a hitter generates." },
    ],
  },
  pitching: {
    basic: [
      { k: "g", label: "G" }, { k: "gs", label: "GS" }, { k: "w", label: "W" },
      { k: "l", label: "L" }, { k: "sv", label: "SV" }, { k: "ip", label: "IP" },
      { k: "h", label: "H" }, { k: "r", label: "R" }, { k: "er", label: "ER" },
      { k: "bb", label: "BB" }, { k: "k", label: "K" },
      { k: "era", label: "ERA", cls: "bold" },
    ],
    advanced: [
      { k: "whip", label: "WHIP",
        desc: "Walks + hits per inning pitched — (BB + H) / IP. Baserunners allowed per inning." },
      { k: "k9", label: "K/9",
        desc: "Strikeouts per 9 innings — K × 9 / IP." },
      { k: "bb9", label: "BB/9",
        desc: "Walks per 9 innings — BB × 9 / IP." },
      { k: "hr9", label: "HR/9",
        desc: "Home runs allowed per 9 innings — HR × 9 / IP." },
      { k: "kbb", label: "K/BB",
        desc: "Strikeout-to-walk ratio — K / BB. Command indicator." },
      { k: "fip", label: "FIP",
        desc: "Fielding independent pitching — (13×HR + 3×(BB+HBP) − 2×K) / IP + 3.10. ERA estimator using only outcomes a pitcher controls." },
      { k: "kbbpct", label: "K-BB%",
        desc: "Strikeout rate minus walk rate — (K − BB) / batters faced. Very predictive." },
      { k: "lobpct", label: "LOB%",
        desc: "Left-on-base % — (H + BB + HBP − R) / (H + BB + HBP − 1.4×HR). Share of baserunners stranded." },
    ],
  },
};

// The raw counting batting stats carried in batting.json — the set for the Display
// Stats chip bar — plus the batted-ball types (GB/FB/LD/PU) and OUTS. (The table
// itself still shows the STAT_COLUMNS basic/advanced subsets, which include the
// derived rate stats.)
const BATTING_ALL_CHIPS = [
  { k: "g", label: "G", desc: "Games" }, { k: "pa", label: "PA", desc: "Plate Appearances" },
  { k: "ab", label: "AB", desc: "At-Bats" }, { k: "r", label: "R", desc: "Runs" },
  { k: "h", label: "H", desc: "Hits" }, { k: "1b", label: "1B", desc: "Singles" },
  { k: "2b", label: "2B", desc: "Doubles" }, { k: "3b", label: "3B", desc: "Triples" },
  { k: "hr", label: "HR", desc: "Home Runs" }, { k: "tb", label: "TB", desc: "Total Bases" },
  { k: "rbi", label: "RBI", desc: "Runs Batted In" }, { k: "bb", label: "BB", desc: "Walks" },
  { k: "ibb", label: "IBB", desc: "Intentional Walks" },
  { k: "k", label: "SO", desc: "Strikeouts (total)" },
  { k: "ks", label: "K", desc: "Swinging Strikeouts" },
  { k: "kl", label: "ꓘ", desc: "Looking Strikeouts" },
  { k: "hbp", label: "HBP", desc: "Hit By Pitch" },
  { k: "sf", label: "SF", desc: "Sacrifice Flies" }, { k: "sh", label: "SH", desc: "Sacrifice Hits (bunts)" },
  { k: "sb", label: "SB", desc: "Stolen Bases" }, { k: "cs", label: "CS", desc: "Caught Stealing" },
  { k: "po", label: "PO", desc: "Times Picked Off" },
  { k: "gb", label: "GB", desc: "Ground Balls" }, { k: "fb", label: "FB", desc: "Fly Balls" },
  { k: "ld", label: "LD", desc: "Line Drives" }, { k: "pu", label: "PU", desc: "Pop-Ups" },
  { k: "outs", label: "OUTS", desc: "Outs Made" },
  { k: "roe", label: "ROE", desc: "Reached On Error" }, { k: "fc", label: "FC", desc: "Reached On Fielder's Choice" },
  { k: "ci", label: "CI", desc: "Reached On Catcher's Interference" },
];

// Default Batting · Basic columns (the classic counting line) — a subset of the chips.
const BAT_BASIC_DEFAULT = ["g", "ab", "pa", "r", "h", "hr", "rbi", "bb", "k", "sb"];
const STAT_COLS_MAX = 10;   // most stat columns shown at once on a · Basic view

// The full pitching counting line carried in pitching.json / exposed by local_data —
// HR/2B/3B are the allowed totals; PT/S/B are the sequence pitch counts.
const PITCHING_ALL_CHIPS = [
  { k: "g", label: "G", desc: "Games" }, { k: "gs", label: "GS", desc: "Games Started" },
  { k: "w", label: "W", desc: "Wins" }, { k: "l", label: "L", desc: "Losses" },
  { k: "sv", label: "SV", desc: "Saves" }, { k: "ip", label: "IP", desc: "Innings Pitched" },
  { k: "outs", label: "O", desc: "Outs Recorded" }, { k: "bf", label: "BF", desc: "Batters Faced" },
  { k: "h", label: "H", desc: "Hits Allowed" }, { k: "r", label: "R", desc: "Runs Allowed" },
  { k: "er", label: "ER", desc: "Earned Runs" }, { k: "ur", label: "UR", desc: "Unearned Runs" },
  { k: "bb", label: "BB", desc: "Walks" }, { k: "ibb", label: "IBB", desc: "Intentional Walks" },
  { k: "k", label: "K", desc: "Strikeouts" },
  { k: "hbp", label: "HBP", desc: "Hit Batters" }, { k: "wp", label: "WP", desc: "Wild Pitches" },
  { k: "bk", label: "BK", desc: "Balks" },
  { k: "hr", label: "HR", desc: "Home Runs Allowed" }, { k: "2b", label: "2B", desc: "Doubles Allowed" },
  { k: "3b", label: "3B", desc: "Triples Allowed" },
  { k: "ir", label: "IR", desc: "Inherited Runners" }, { k: "irs", label: "IRS", desc: "Inherited Runners Scored" },
  { k: "gb", label: "GB", desc: "Ground Balls" }, { k: "fb", label: "FB", desc: "Fly Balls" },
  { k: "ld", label: "LD", desc: "Line Drives" }, { k: "pu", label: "PU", desc: "Pop-Ups" },
  { k: "gidp", label: "GIDP", desc: "Double Plays Induced" },
  { k: "pt", label: "PT", desc: "Pitches" }, { k: "strikes", label: "S", desc: "Strikes" },
  { k: "balls", label: "B", desc: "Balls" },
];
// Default Pitching · Basic columns (the classic pitching line).
const PIT_BASIC_DEFAULT = ["g", "gs", "w", "l", "sv", "ip", "h", "er", "bb", "k"];

// Batting · Advanced — all derived from the counting stats. label = abbr, desc =
// "Full name — formula". Computed client-side by advBatting() onto each row.
const BATTING_ADV_CHIPS = [
  { k: "avg", label: "AVG", desc: "Batting Average — H ÷ AB" },
  { k: "obp", label: "OBP", desc: "On-Base Percentage — (H + BB + HBP) ÷ (AB + BB + HBP + SF)" },
  { k: "slg", label: "SLG", desc: "Slugging Percentage — TB ÷ AB" },
  { k: "ops", label: "OPS", desc: "On-Base Plus Slugging — OBP + SLG" },
  { k: "iso", label: "ISO", desc: "Isolated Power — SLG − AVG" },
  { k: "gpa", label: "GPA", desc: "Gross Production Average — (1.8 × OBP + SLG) ÷ 4" },
  { k: "seca", label: "SecA", desc: "Secondary Average — (TB − H + BB + SB − CS) ÷ AB" },
  { k: "xbh", label: "XBH", desc: "Extra-Base Hits — 2B + 3B + HR" },
  { k: "xbhpct", label: "XBH%", desc: "Extra-Base Hit Rate — (2B + 3B + HR) ÷ H" },
  { k: "tbph", label: "TB/H", desc: "Bases per Hit — TB ÷ H" },
  { k: "hrph", label: "HR/H", desc: "Home Runs per Hit — HR ÷ H" },
  { k: "bbpct", label: "BB%", desc: "Walk Rate — BB ÷ PA" },
  { k: "kpct", label: "SO%", desc: "Strikeout Rate — SO ÷ PA" },
  { k: "bbk", label: "BB/K", desc: "Walk-to-Strikeout Ratio — BB ÷ SO" },
  { k: "paso", label: "PA/SO", desc: "PA per Strikeout — PA ÷ SO" },
  { k: "contact", label: "Con%", desc: "Contact Rate — (AB − SO) ÷ AB" },
  { k: "ibbpct", label: "IBB%", desc: "Intentional Walk Rate — IBB ÷ PA" },
  { k: "hbppct", label: "HBP%", desc: "Hit-By-Pitch Rate — HBP ÷ PA" },
  { k: "swsh", label: "Sw%", desc: "Swinging-Strikeout Share — K ÷ SO" },
  { k: "clsh", label: "ꓘ%", desc: "Called-Strikeout Share — ꓘ ÷ SO" },
  { k: "bip", label: "BIP", desc: "Balls in Play — GB + FB + LD + PU" },
  { k: "gbpct", label: "GB%", desc: "Ground-Ball Rate — GB ÷ BIP" },
  { k: "fbpct", label: "FB%", desc: "Fly-Ball Rate — FB ÷ BIP" },
  { k: "ldpct", label: "LD%", desc: "Line-Drive Rate — LD ÷ BIP" },
  { k: "pupct", label: "PU%", desc: "Pop-up / Infield-Fly Rate — PU ÷ BIP" },
  { k: "gbfb", label: "GB/FB", desc: "Ground-Ball-to-Fly-Ball Ratio — GB ÷ FB" },
  { k: "hrfb", label: "HR/FB", desc: "Home Runs per Fly Ball — HR ÷ FB" },
  { k: "babip", label: "BABIP", desc: "BABIP — (H − HR) ÷ (AB − SO − HR + SF)" },
  { k: "rc", label: "RC", desc: "Runs Created — (H + BB) × TB ÷ (AB + BB)" },
  { k: "rc27", label: "RC/27", desc: "Runs Created per 27 outs — (RC ÷ OUTS) × 27" },
  { k: "sbpct", label: "SB%", desc: "Stolen-Base Percentage — SB ÷ (SB + CS)" },
  { k: "psn", label: "PSN", desc: "Power-Speed Number — (2 × HR × SB) ÷ (HR + SB)" },
  { k: "hrpct", label: "HR%", desc: "Home Run Rate — HR ÷ PA" },
  { k: "abhr", label: "AB/HR", desc: "At Bats per Home Run — AB ÷ HR" },
  { k: "hpa", label: "H/PA", desc: "Hits per Plate Appearance — H ÷ PA" },
  { k: "rg", label: "R/G", desc: "Runs per Game — R ÷ G" },
  { k: "rbig", label: "RBI/G", desc: "RBI per Game — RBI ÷ G" },
  { k: "abrbi", label: "AB/RBI", desc: "At Bats per RBI — AB ÷ RBI" },
];
// FIP constant for 2026, computed so league FIP = league ERA across all pulled
// teams: lgERA(5.07) − (13·HR+3·(BB+HBP)−2·K)/lgIP(1.34). Recompute if data changes.
const FIP_CONSTANT = 3.73;

// Pitching · Advanced — derived from the pitching counting line. IP uses true
// innings (outs ÷ 3), never the "95.1" display string. label = abbr, desc =
// "Full name — formula".
const PITCHING_ADV_CHIPS = [
  { k: "era", label: "ERA", desc: "Earned Run Average — 9 × ER ÷ IP" },
  { k: "ra9", label: "RA9", desc: "Runs Allowed per 9 — 9 × R ÷ IP" },
  { k: "whip", label: "WHIP", desc: "Walks + Hits per IP — (H + BB) ÷ IP" },
  { k: "k9", label: "K/9", desc: "Strikeouts per 9 — 9 × K ÷ IP" },
  { k: "bb9", label: "BB/9", desc: "Walks per 9 — 9 × BB ÷ IP" },
  { k: "h9", label: "H/9", desc: "Hits per 9 — 9 × H ÷ IP" },
  { k: "hr9", label: "HR/9", desc: "Home Runs per 9 — 9 × HR ÷ IP" },
  { k: "kbb", label: "K/BB", desc: "Strikeout-to-Walk Ratio — K ÷ BB" },
  { k: "kpct", label: "K%", desc: "Strikeout Rate — K ÷ BF" },
  { k: "bbpct", label: "BB%", desc: "Walk Rate — BB ÷ BF" },
  { k: "kbbpct", label: "K−BB%", desc: "Strikeout-minus-Walk Rate — (K ÷ BF) − (BB ÷ BF)" },
  { k: "ibbpct", label: "IBB%", desc: "Intentional Walk Rate — IBB ÷ BF" },
  { k: "hbp9", label: "HBP/9", desc: "HBP per 9 — 9 × HBP ÷ IP" },
  { k: "wp9", label: "WP/9", desc: "Wild Pitches per 9 — 9 × WP ÷ IP" },
  { k: "dice", label: "DICE", desc: "DICE (self-contained FIP) — 3.00 + (13×HR + 3×(BB+HBP) − 2×K) ÷ IP" },
  { k: "fip", label: "FIP", desc: "Fielding Independent Pitching — (13×HR + 3×(BB+HBP) − 2×K) ÷ IP + 3.73 (2026 league constant)" },
  { k: "lobpct", label: "LOB%", desc: "Left-On-Base Percentage — (H + BB + HBP − R) ÷ (H + BB + HBP − 1.4×HR)" },
  { k: "wlpct", label: "W−L%", desc: "Win Percentage — W ÷ (W + L)" },
  { k: "single", label: "1B", desc: "Singles Allowed — H − 2B − 3B − HR" },
  { k: "tb", label: "TB", desc: "Total Bases Allowed — 1B + 2×2B + 3×3B + 4×HR" },
  { k: "xbh", label: "XBH", desc: "Extra-Base Hits Allowed — 2B + 3B + HR" },
  { k: "oppavg", label: "OppAVG", desc: "Opponent Batting Average — H ÷ (BF − BB − HBP)" },
  { k: "oppslg", label: "OppSLG", desc: "Opponent Slugging — TB ÷ (BF − BB − HBP)" },
  { k: "oppiso", label: "OppISO", desc: "Opponent ISO — OppSLG − OppAVG" },
  { k: "oppobp", label: "OppOBP", desc: "On-Base Against — (H + BB + HBP) ÷ BF" },
  { k: "oppops", label: "OppOPS", desc: "Opponent OPS — OppOBP + OppSLG" },
  { k: "bip", label: "BIP", desc: "Balls In Play — GB + FB + LD + PU" },
  { k: "gbpct", label: "GB%", desc: "Ground-Ball Rate — GB ÷ BIP" },
  { k: "fbpct", label: "FB%", desc: "Fly-Ball Rate — FB ÷ BIP" },
  { k: "ldpct", label: "LD%", desc: "Line-Drive Rate — LD ÷ BIP" },
  { k: "pupct", label: "PU%", desc: "Pop-up Rate — PU ÷ BIP" },
  { k: "gbfb", label: "GB/FB", desc: "Ground-Ball-to-Fly-Ball — GB ÷ FB" },
  { k: "hrfb", label: "HR/FB", desc: "Home Runs per Fly Ball — HR ÷ FB" },
  { k: "babip", label: "BABIP", desc: "BABIP Against — (H − HR) ÷ (BIP − HR)" },
  { k: "gidp9", label: "GIDP/9", desc: "GIDP Induced per 9 — 9 × GIDP ÷ IP" },
  { k: "strikepct", label: "Strike%", desc: "Strike Percentage — S ÷ PT" },
  { k: "ballpct", label: "Ball%", desc: "Ball Percentage — B ÷ PT" },
  { k: "pip", label: "P/IP", desc: "Pitches per Inning — PT ÷ IP" },
  { k: "pbf", label: "P/BF", desc: "Pitches per Batter — PT ÷ BF" },
  { k: "irspct", label: "IRS%", desc: "Inherited Runners Scored % — IRS ÷ IR" },
  { k: "ipgs", label: "IP/GS", desc: "Innings per Start — IP ÷ GS" },
  { k: "ipg", label: "IP/G", desc: "Innings per Appearance — IP ÷ G" },
];

// Compute every Pitching · Advanced stat for one pitcher from its counting line.
function advPitching(p) {
  const outs = p.outs, ip = outs / 3;
  const er = p.er, r = p.r, h = p.h, bb = p.bb, k = p.k, hr = p.hr, d2 = p["2b"],
        d3 = p["3b"], hbp = p.hbp, wp = p.wp, ibb = p.ibb, bf = p.bf, w = p.w, l = p.l,
        gb = p.gb, fb = p.fb, ld = p.ld, pu = p.pu, gidp = p.gidp, strikes = p.strikes,
        balls = p.balls, pt = p.pt, ir = p.ir, irs = p.irs, gs = p.gs, g = p.g;
  const dv = (a, b) => b ? a / b : null;
  const per9 = (x) => ip ? 9 * x / ip : null;
  const f3 = (x) => x == null ? "—" : x.toFixed(3).replace(/^(-?)0\./, "$1.");
  const pc = (x) => x == null ? "—" : (x * 100).toFixed(1) + "%";
  const f2 = (x) => x == null ? "—" : x.toFixed(2);
  const fi = (x) => x == null ? "—" : String(Math.round(x));
  const single = h - d2 - d3 - hr, tb = single + 2 * d2 + 3 * d3 + 4 * hr;
  const bip = gb + fb + ld + pu, ab = bf - bb - hbp;
  const oppavg = dv(h, ab), oppslg = dv(tb, ab), oppobp = dv(h + bb + hbp, bf);
  const fipComp = ip ? (13 * hr + 3 * (bb + hbp) - 2 * k) / ip : null;
  const lobDen = h + bb + hbp - 1.4 * hr;
  return {
    era: f2(per9(er)), ra9: f2(per9(r)), whip: f2(dv(h + bb, ip)),
    k9: f2(per9(k)), bb9: f2(per9(bb)), h9: f2(per9(h)), hr9: f2(per9(hr)),
    kbb: f2(dv(k, bb)), kpct: pc(dv(k, bf)), bbpct: pc(dv(bb, bf)),
    kbbpct: pc(bf ? k / bf - bb / bf : null), ibbpct: pc(dv(ibb, bf)),
    hbp9: f2(per9(hbp)), wp9: f2(per9(wp)),
    dice: f2(fipComp != null ? 3.00 + fipComp : null),
    fip: f2(fipComp != null ? fipComp + FIP_CONSTANT : null),
    lobpct: pc(lobDen ? (h + bb + hbp - r) / lobDen : null),
    wlpct: f3(dv(w, w + l)),
    single: fi(single), tb: fi(tb), xbh: fi(d2 + d3 + hr),
    oppavg: f3(oppavg), oppslg: f3(oppslg),
    oppiso: f3(oppslg != null && oppavg != null ? oppslg - oppavg : null),
    oppobp: f3(oppobp),
    oppops: f3(oppobp != null && oppslg != null ? oppobp + oppslg : null),
    bip: fi(bip),
    gbpct: pc(dv(gb, bip)), fbpct: pc(dv(fb, bip)), ldpct: pc(dv(ld, bip)), pupct: pc(dv(pu, bip)),
    gbfb: f2(dv(gb, fb)), hrfb: f2(dv(hr, fb)),
    babip: f3(dv(h - hr, bip - hr)),
    gidp9: f2(per9(gidp)),
    strikepct: pc(dv(strikes, pt)), ballpct: pc(dv(balls, pt)),
    pip: f2(dv(pt, ip)), pbf: f2(dv(pt, bf)),
    irspct: pc(dv(irs, ir)),
    ipgs: f2(dv(ip, gs)), ipg: f2(dv(ip, g)),
  };
}

// Compute every Batting · Advanced stat for one batter from its counting line.
function advBatting(p) {
  const ab = p.ab, h = p.h, bb = p.bb, hbp = p.hbp || 0, sf = p.sf || 0, tb = p.tb,
        pa = p.pa, d2 = p["2b"], d3 = p["3b"], hr = p.hr, sb = p.sb, cs = p.cs,
        so = p.k, ks = p.ks, kl = p.kl, ibb = p.ibb, gb = p.gb, fb = p.fb, ld = p.ld,
        pu = p.pu, outs = p.outs, r = p.r, g = p.g, rbi = p.rbi;
  const dv = (a, b) => b ? a / b : null;
  const f3 = (x) => x == null ? "—" : x.toFixed(3).replace(/^(-?)0\./, "$1.");
  const pc = (x) => x == null ? "—" : (x * 100).toFixed(1) + "%";
  const f2 = (x) => x == null ? "—" : x.toFixed(2);
  const fi = (x) => x == null ? "—" : String(Math.round(x));
  const avg = dv(h, ab), slg = dv(tb, ab), obp = dv(h + bb + hbp, ab + bb + hbp + sf);
  const ops = (obp != null && slg != null) ? obp + slg : null;
  const bip = gb + fb + ld + pu, xbh = d2 + d3 + hr;
  const rc = (ab + bb) ? (h + bb) * tb / (ab + bb) : null;
  return {
    avg: f3(avg), obp: f3(obp), slg: f3(slg), ops: f3(ops),
    iso: f3(slg != null && avg != null ? slg - avg : null),
    gpa: f3(obp != null && slg != null ? (1.8 * obp + slg) / 4 : null),
    seca: f3(dv(tb - h + bb + sb - cs, ab)),
    xbh: fi(xbh), xbhpct: pc(dv(xbh, h)),
    tbph: f2(dv(tb, h)), hrph: f2(dv(hr, h)),
    bbpct: pc(dv(bb, pa)), kpct: pc(dv(so, pa)),
    bbk: f2(dv(bb, so)), paso: f2(dv(pa, so)),
    contact: pc(dv(ab - so, ab)),
    ibbpct: pc(dv(ibb, pa)), hbppct: pc(dv(hbp, pa)),
    swsh: pc(dv(ks, so)), clsh: pc(dv(kl, so)),
    bip: fi(bip),
    gbpct: pc(dv(gb, bip)), fbpct: pc(dv(fb, bip)), ldpct: pc(dv(ld, bip)), pupct: pc(dv(pu, bip)),
    gbfb: f2(dv(gb, fb)), hrfb: f2(dv(hr, fb)),
    babip: f3(dv(h - hr, ab - so - hr + sf)),
    rc: f2(rc), rc27: f2(rc != null && outs ? (rc / outs) * 27 : null),
    sbpct: pc(dv(sb, sb + cs)), psn: f2((hr + sb) ? (2 * hr * sb) / (hr + sb) : null),
    hrpct: pc(dv(hr, pa)), abhr: f2(dv(ab, hr)), hpa: f3(dv(h, pa)),
    rg: f2(dv(r, g)), rbig: f2(dv(rbi, g)), abrbi: f2(dv(ab, rbi)),
  };
}

// Chips + default columns for each "<view>-<level>" combination.
const CHIPS_BY_VIEW = {
  "batting-basic": BATTING_ALL_CHIPS, "batting-advanced": BATTING_ADV_CHIPS,
  "pitching-basic": PITCHING_ALL_CHIPS, "pitching-advanced": PITCHING_ADV_CHIPS,
};
const DEFAULT_COLS_BY_VIEW = {
  "batting-basic": BAT_BASIC_DEFAULT,
  // 38 advanced stats > the 10-column cap, so default to the classic line.
  "batting-advanced": ["avg", "obp", "slg", "ops", "iso", "babip", "bbpct", "kpct", "seca", "rc"],
  "pitching-basic": PIT_BASIC_DEFAULT,
  "pitching-advanced": ["era", "ra9", "whip", "k9", "bb9", "kbb", "fip", "kpct", "bbpct", "babip"],
};

const PlayerStatsView = ({ roster, playerView, setPlayerView, statLevel, setStatLevel, onPlayerClick }) => {
  const [sortKey, setSortKey] = React.useState(null);
  const [sortDir, setSortDir] = React.useState("desc");
  // Selected columns per view+level; each is its own chip selector (max STAT_COLS_MAX).
  const [colsByView, setColsByView] = React.useState(DEFAULT_COLS_BY_VIEW);

  const viewKey = `${playerView}-${statLevel}`;
  const chips = CHIPS_BY_VIEW[viewKey];
  const selCols = colsByView[viewKey];
  const setSelCols = (updater) => setColsByView((prev) => ({
    ...prev,
    [viewKey]: typeof updater === "function" ? updater(prev[viewKey]) : updater,
  }));

  const onSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  // Toggle a chip's column on/off for the active view, capped at STAT_COLS_MAX.
  // Removing the sorted column clears the sort so the arrow doesn't point at a
  // hidden column.
  const toggleStat = (key) => {
    setSelCols((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= STAT_COLS_MAX) return prev;   // at the cap — no-op
      return [...prev, key];
    });
    if (sortKey === key) setSortKey(null);
  };

  const sortRows = (rows) => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const numA = typeof av === "string" && av.startsWith(".") ? parseFloat("0"+av) : parseFloat(av);
      const numB = typeof bv === "string" && bv.startsWith(".") ? parseFloat("0"+bv) : parseFloat(bv);
      if (!isNaN(numA) && !isNaN(numB)) return sortDir === "desc" ? numB - numA : numA - numB;
      return sortDir === "desc" ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
    });
  };

  // Every view (basic + advanced) is chip-driven; columns follow the chip order.
  const cols = chips.filter((c) => selCols.includes(c.k));
  const baseRows = playerView === "batting" ? roster.batters : roster.pitchers;
  // Batting · Advanced stats are computed client-side and merged onto each row so
  // both the cells and the sort read them like any other field.
  const rows = viewKey === "batting-advanced" ? baseRows.map((p) => ({ ...p, ...advBatting(p) }))
    : viewKey === "pitching-advanced" ? baseRows.map((p) => ({ ...p, ...advPitching(p) }))
    : baseRows;
  const idLabel = playerView === "batting" ? "Batter" : "Pitcher";
  const posLabel = playerView === "batting" ? "Pos" : "Role";
  const cell = (p, c) => (p[c.k] === undefined || p[c.k] === "" || p[c.k] === null) ? "—" : p[c.k];

  return (
    <div className="stats">
      <div className="player-statsbar">
        <div className="player-toggle">
          <button
            className={`player-toggle__btn ${playerView === "batting" ? "player-toggle__btn--active" : ""}`}
            onClick={() => setPlayerView("batting")}
          >Batting ({roster.batters.length})</button>
          <button
            className={`player-toggle__btn ${playerView === "pitching" ? "player-toggle__btn--active" : ""}`}
            onClick={() => setPlayerView("pitching")}
          >Pitching ({roster.pitchers.length})</button>
        </div>
        <div className="segmented segmented--sm">
          <button
            className={`segmented__btn ${statLevel === "basic" ? "segmented__btn--active" : ""}`}
            onClick={() => setStatLevel("basic")}
          >Basic</button>
          <button
            className={`segmented__btn ${statLevel === "advanced" ? "segmented__btn--active" : ""}`}
            onClick={() => setStatLevel("advanced")}
          >Advanced</button>
        </div>
      </div>

      {/* Display Stats chip selector — toggles columns (max 10) for every view. */}
      {(
        <div className="pstat-display">
          <div className="pstat-display__top">
            <div className="pstat-display__label">Display Stats · click to add or remove columns</div>
            <div className="pstat-display__count">{selCols.length}/{STAT_COLS_MAX} SELECTED</div>
          </div>
          <div className="pstat-chips">
            {chips.map((c) => {
              const on = selCols.includes(c.k);
              const disabled = !on && selCols.length >= STAT_COLS_MAX;
              return (
                <button
                  key={c.k}
                  type="button"
                  className={`pstat-chip ${on ? "is-on" : ""} ${disabled ? "is-disabled" : ""}`}
                  onClick={() => !disabled && toggleStat(c.k)}
                  aria-disabled={disabled}
                >{c.label}<span className="pstat-chip__tip">{c.desc}</span></button>
              );
            })}
          </div>
        </div>
      )}

      <div className="boxscore__wrap">
        <table className="box-table player-table">
          <thead>
            <tr>
              <th className="th th--left">#</th>
              <th className="th th--left">{idLabel}</th>
              <th className="th th--left">{posLabel}</th>
              {cols.map((c) => (
                <Sh key={c.k} k={c.k} label={c.label} desc={c.desc}
                    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortRows(rows).map((p, i) => (
              <tr key={i}>
                <td className="td mono muted small">{p.num}</td>
                <td className="td"><span className="player-name player-link" onClick={() => onPlayerClick && onPlayerClick(p.name)}>{p.name}</span></td>
                <td className="td mono small muted">{p.pos}</td>
                {cols.map((c) => (
                  <td key={c.k} className={`td td--right mono ${c.cls || ""}`}>{cell(p, c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="player-note muted small">
        Cumulative season totals. Click a column header to sort.
      </div>
    </div>
  );
};

// Sortable header cell. When `desc` is given, the label gets a dotted underline
// and a tooltip explaining the stat (its formula) on hover.
const Sh = ({ k, label, desc, sortKey, sortDir, onSort }) => (
  <th
    className={`th th--right th--sortable ${sortKey === k ? "th--active" : ""}`}
    onClick={() => onSort(k)}
  >
    {desc
      ? <span className="th-help" tabIndex={0}>
          {label}
          <span className="th-tip">{desc}</span>
        </span>
      : label}
    {sortKey === k && <span className="th__sort"> {sortDir === "desc" ? "▾" : "▴"}</span>}
  </th>
);

// Reads the team's static roster.txt (generated by scripts/build_roster.py). Falls back
// to a friendly empty/error state when the file isn't present yet.
const RosterView = ({ teamId, onPlayerClick }) => {
  const [players, setPlayers] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    setPlayers(null);
    setError(null);
    window.fetchRoster(teamId)
      .then(setPlayers)
      .catch((e) => setError(e.message));
  }, [teamId]);

  if (error) {
    return (
      <div className="loading-block">
        No roster file yet for this team. Generate one with{" "}
        <code>.venv/bin/python scripts/build_roster.py "{teamId}"</code>, then reload.
      </div>
    );
  }
  if (!players) {
    return <div className="loading-block">Loading roster…</div>;
  }
  if (players.length === 0) {
    return (
      <div className="loading-block">
        Roster file is empty for this team. Re-run{" "}
        <code>.venv/bin/python scripts/build_roster.py</code> after materializing the
        iCloud-offloaded game files.
      </div>
    );
  }

  return (
    <div className="stats">
      <div className="boxscore__wrap">
        <table className="box-table player-table">
          <thead>
            <tr>
              <th className="th th--left">#</th>
              <th className="th th--left">Name</th>
              <th className="th th--left">Pos</th>
              <th className="th th--left">Role</th>
              <th className="th th--right">G</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p, i) => (
              <tr key={i}>
                <td className="td mono muted small">{p.num}</td>
                <td className="td">
                  <span className="player-name player-link"
                        onClick={() => onPlayerClick && onPlayerClick(p.name)}>
                    {p.name}
                  </span>
                </td>
                <td className="td mono small muted">{p.pos}</td>
                <td className="td small muted">{p.role}</td>
                <td className="td td--right mono">{p.g}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="player-note muted small">{players.length} players</div>
    </div>
  );
};

window.TeamDetail = TeamDetail;
