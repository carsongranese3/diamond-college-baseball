// Team "Home" tab — season-aware landing for one team. Renders below the team
// hero/tabs that TeamDetail already provides, so no second hero here. Reuses the
// shared adapters/atoms from home.jsx (hpSecTeams, hpPhase, HPLabel, HPLogo, ...).
// Real data: this week + recent from the schedule, conference standing from
// TEAMS, team leaders from the lazy /api/team crawl. Postseason-only extras
// (national seed, road-to-Omaha path, eliminated narrative) are left for later.

// This week: the next upcoming game, plus any consecutive games vs the same
// opponent (a weekend/postseason series).
function ThisWeek({ schedule, team, onTeam, post }) {
  const upcoming = schedule.filter((g) => !g.result);
  if (!upcoming.length) {
    return <div className="hp-placeholder">Season complete — no games on the schedule.</div>;
  }
  const first = upcoming[0];
  const series = [first];
  for (let i = 1; i < upcoming.length; i++) {
    if (upcoming[i].opp && first.opp && upcoming[i].opp.id === first.opp.id) series.push(upcoming[i]);
    else break;
  }
  const oppId = first.opp && first.opp.id;
  const oppKnown = oppId && (window.TEAM_BY_ID || {})[oppId];
  const kind = series.length > 1
    ? (post ? "Series" : "Weekend Series")
    : (first.opp && first.opp.conf ? "Conference" : "Midweek");
  return (
    <div className="th-series" style={{ borderLeftColor: team.color }}>
      <div className="th-series__head">
        <span className="hp-eyebrow">{kind}</span>
        <span className="mono hp-faint">{series.length} game{series.length > 1 ? "s" : ""}</span>
      </div>
      <button className="bare-btn th-series__opp" disabled={!oppKnown}
        onClick={() => oppKnown && onTeam && onTeam(oppId)}>
        <span className="mono hp-muted">{first.home ? "VS" : "AT"}</span>
        <HPLogo team={first.opp} size={28} />
        <span className="th-series__oppname">{first.opp ? first.opp.name : "TBD"}</span>
        {first.opp && first.opp.rank && <span className="chip-rank">#{first.opp.rank}</span>}
      </button>
      <div className="th-series__games">
        {series.map((g) => (
          <div key={g.id} className="th-game">
            <div className="mono th-game__date">{g.date}</div>
            <div className="mono hp-faint">{g.time || "TBD"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Last few final results.
function RecentList({ schedule, onGameClick }) {
  const recent = schedule.filter((g) => g.result).slice(-4).reverse();
  if (!recent.length) return <div className="hp-placeholder">No results yet.</div>;
  return (
    <div className="th-recent">
      {recent.map((g) => (
        <button key={g.id} className="bare-btn th-recent__row" onClick={() => onGameClick && onGameClick(g)}>
          <span className={"chip " + (g.result === "W" ? "chip-w" : "chip-l")}>{g.result}</span>
          <span className="mono th-recent__score">{g.score.us}&ndash;{g.score.them}</span>
          <span className="th-recent__opp">{g.opp ? g.opp.name : ""}</span>
          <span className="mono hp-faint th-recent__date">{g.date}</span>
        </button>
      ))}
    </div>
  );
}

// Window of 5 standings rows centred on this team.
function ConfStrip({ teamId }) {
  const teams = hpSecTeams();
  const idx = teams.findIndex((t) => t.id === teamId);
  const total = teams.length;
  const win = 5;
  let start = Math.max(0, idx - 2);
  start = Math.min(start, Math.max(0, total - win));
  const slice = teams.slice(start, start + win);
  return (
    <div className="th-strip">
      <div className="th-strip__meta mono hp-ink2">#{idx + 1} of {total} in the SEC</div>
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
          <div className="th-leader__name">{l.name || l.line}</div>
          {l.name && <div className="th-leader__line mono">{l.line}</div>}
          {l.pos && <div className="mono hp-faint th-leader__pos">{l.pos}</div>}
        </div>
      ))}
    </div>
  );
}

const TeamHome = ({ teamId, onTeam, onGameClick }) => {
  const team = window.TEAM_BY_ID[teamId];
  const schedule = window.SCHEDULES[teamId] || [];
  const post = hpPhase() === "postseason";

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
      <section className="hp-hero">
        <HPLabel color={post ? "var(--gold)" : null}>{post ? "This Week · Postseason" : "This Week"}</HPLabel>
        <ThisWeek schedule={schedule} team={team} onTeam={onTeam} post={post} />
        {post && <div className="th-note hp-faint">Seeds, host site &amp; series format coming soon.</div>}
      </section>

      <section className="hp-split">
        <div>
          <HPLabel>Recent</HPLabel>
          <RecentList schedule={schedule} onGameClick={onGameClick} />
        </div>
        <div className="hp-split__rule" />
        <div>
          <HPLabel>Conference Standing</HPLabel>
          <ConfStrip teamId={teamId} />
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
