// Team detail view — continuous schedule + Team/Players stats toggle

const TeamDetail = ({ teamId, onBack, onGameClick }) => {
  const team = window.TEAM_BY_ID[teamId];
  const [tab, setTab] = React.useState("schedule");
  const [statMode, setStatMode] = React.useState("team");      // team | players
  const [playerView, setPlayerView] = React.useState("batting"); // batting | pitching
  const schedule = window.SCHEDULES[teamId] || [];

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

  return (
    <div className="team-detail">
      <BackLink onClick={onBack}>Standings</BackLink>

      <header className="team-hero" style={{ "--team-color": team.color, "--team-ink": team.ink }}>
        <div className="team-hero__band" />
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
          className={`tab ${tab === "schedule" ? "tab--active" : ""}`}
          onClick={() => setTab("schedule")}
        >
          Schedule
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
        />
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
          const showDivider = i === firstUpcomingIdx && firstUpcomingIdx > 0;
          return (
            <React.Fragment key={g.id}>
              {showDivider && (
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
        <Eyebrow>Team leaders</Eyebrow>
        <div className="leaders">
          {stats.leaders.map((l, i) => (
            <div key={i} className="leader">
              <div className="leader__head">
                <div className="leader__pos mono">{l.pos}</div>
                <div className="leader__note">{l.note}</div>
              </div>
              <div className="leader__name">{l.name}</div>
              <div className="leader__line mono">{l.line}</div>
            </div>
          ))}
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

const PlayerStatsView = ({ roster, playerView, setPlayerView }) => {
  const [sortKey, setSortKey] = React.useState(null);
  const [sortDir, setSortDir] = React.useState("desc");

  const onSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
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

  return (
    <div className="stats">
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

      {playerView === "batting" && (
        <div className="boxscore__wrap">
          <table className="box-table player-table">
            <thead>
              <tr>
                <th className="th th--left">#</th>
                <th className="th th--left">Batter</th>
                <th className="th th--left">Pos</th>
                <Sh k="g"   label="G"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="ab"  label="AB"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="r"   label="R"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="h"   label="H"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="hr"  label="HR"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="rbi" label="RBI" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="bb"  label="BB"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="k"   label="K"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="sb"  label="SB"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="avg" label="AVG" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="obp" label="OBP" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="slg" label="SLG" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="ops" label="OPS" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {sortRows(roster.batters).map((p, i) => (
                <tr key={i}>
                  <td className="td mono muted small">{p.num}</td>
                  <td className="td"><span className="player-name">{p.name}</span></td>
                  <td className="td mono small muted">{p.pos}</td>
                  <td className="td td--right mono">{p.g}</td>
                  <td className="td td--right mono">{p.ab}</td>
                  <td className="td td--right mono">{p.r}</td>
                  <td className="td td--right mono">{p.h}</td>
                  <td className="td td--right mono">{p.hr}</td>
                  <td className="td td--right mono">{p.rbi}</td>
                  <td className="td td--right mono">{p.bb}</td>
                  <td className="td td--right mono">{p.k}</td>
                  <td className="td td--right mono">{p.sb}</td>
                  <td className="td td--right mono bold">{p.avg}</td>
                  <td className="td td--right mono muted">{p.obp}</td>
                  <td className="td td--right mono muted">{p.slg}</td>
                  <td className="td td--right mono">{p.ops}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {playerView === "pitching" && (
        <div className="boxscore__wrap">
          <table className="box-table player-table">
            <thead>
              <tr>
                <th className="th th--left">#</th>
                <th className="th th--left">Pitcher</th>
                <th className="th th--left">Role</th>
                <Sh k="g"    label="G"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="gs"   label="GS"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="w"    label="W"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="l"    label="L"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="sv"   label="SV"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="ip"   label="IP"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="h"    label="H"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="r"    label="R"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="er"   label="ER"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="bb"   label="BB"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="k"    label="K"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="era"  label="ERA"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <Sh k="whip" label="WHIP" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {sortRows(roster.pitchers).map((p, i) => (
                <tr key={i}>
                  <td className="td mono muted small">{p.num}</td>
                  <td className="td"><span className="player-name">{p.name}</span></td>
                  <td className="td mono small muted">{p.pos}</td>
                  <td className="td td--right mono">{p.g}</td>
                  <td className="td td--right mono">{p.gs}</td>
                  <td className="td td--right mono">{p.w}</td>
                  <td className="td td--right mono">{p.l}</td>
                  <td className="td td--right mono">{p.sv}</td>
                  <td className="td td--right mono">{p.ip}</td>
                  <td className="td td--right mono">{p.h}</td>
                  <td className="td td--right mono">{p.r}</td>
                  <td className="td td--right mono">{p.er}</td>
                  <td className="td td--right mono">{p.bb}</td>
                  <td className="td td--right mono">{p.k}</td>
                  <td className="td td--right mono bold">{p.era}</td>
                  <td className="td td--right mono muted">{p.whip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="player-note muted small">
        Cumulative season totals. Click a column header to sort.
      </div>
    </div>
  );
};

// Sortable header cell
const Sh = ({ k, label, sortKey, sortDir, onSort }) => (
  <th
    className={`th th--right th--sortable ${sortKey === k ? "th--active" : ""}`}
    onClick={() => onSort(k)}
  >
    {label}
    {sortKey === k && <span className="th__sort"> {sortDir === "desc" ? "▾" : "▴"}</span>}
  </th>
);

window.TeamDetail = TeamDetail;
