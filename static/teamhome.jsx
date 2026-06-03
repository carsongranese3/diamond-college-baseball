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
    if (sr.top && sr.top.seo === teamId) return { me: sr.top, opp: sr.bottom };
    if (sr.bottom && sr.bottom.seo === teamId) return { me: sr.bottom, opp: sr.top };
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

// This Week — season-aware. Dispatches on the round of the team's next game.
function ThisWeek({ schedule, team, onTeam }) {
  const played = schedule.filter((g) => g.result);
  const upcoming = schedule.filter((g) => !g.result);
  if (!upcoming.length) {
    return <div className="hp-placeholder">Season complete — no games on the schedule.</div>;
  }
  const round = upcoming[0].phase || "regular";
  if (round === "NCAA Super Regional" || round === "College World Series")
    return <WeekSeries team={team} upcoming={upcoming} onTeam={onTeam} round={round} />;
  if (round === "NCAA Regional")
    return <WeekRegional team={team} played={played} upcoming={upcoming} onTeam={onTeam} />;
  if (round === "SEC Tournament")
    return <WeekNextGame team={team} game={upcoming[0]} onTeam={onTeam} label="Next Game" />;
  return <WeekRegular team={team} upcoming={upcoming} onTeam={onTeam} />;
}

// Super Regional / CWS — a best-of-3 (or series) matchup with seeds and games.
function WeekSeries({ team, upcoming, onTeam, round }) {
  const isCWS = round === "College World Series";
  // Official matchup + national seeds from the bracket; schedule supplies the dates.
  const sup = teamSuper(team.id);
  const oppRaw = sup ? sup.opp : upcoming[0].opp;
  const oppTeam = oppRaw ? { id: oppRaw.seo || oppRaw.id, name: oppRaw.name, logo: oppRaw.logo,
                             mark: (oppRaw.name || "").slice(0, 4).toUpperCase() } : null;
  const mySeed = sup && sup.me ? sup.me.seed : null;
  const oppSeed = sup && sup.opp ? sup.opp.seed : null;
  const hostName = upcoming[0].home ? team.name : (oppTeam ? oppTeam.name : "");
  const title = isCWS ? "College World Series" : `${hostName} Super Regional`;
  const sub = isCWS ? "At Charles Schwab Field · Omaha"
                    : "Best-of-3 · Winner advances to the College World Series";
  const games = upcoming.slice(0, 3);
  const needGame3 = !isCWS && games.length < 3;
  return (
    <div className="th-post">
      <div className="th-post__title">{title}</div>
      <div className="th-post__sub mono">{sub}</div>
      <div className="th-post__teams">
        <SeriesTeam t={team} seed={mySeed} accent={team.color} onTeam={onTeam} me />
        <SeriesTeam t={oppTeam} seed={oppSeed} onTeam={onTeam} />
      </div>
      <div className="th-post__games" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {games.map((g, i) => (
          <div key={g.id} className="th-pgame">
            <div className="mono th-pgame__g">Game {i + 1}</div>
            <div className="mono th-pgame__date">{g.date}</div>
            <div className="mono hp-faint">{g.time || "TBD"}</div>
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
    </div>
  );
}

// NCAA Regional — a 4-team double-elimination field. The other teams in the
// regional are inferred from the distinct opponents across the team's regional
// games (played + upcoming).
function WeekRegional({ team, played, upcoming, onTeam }) {
  const regGames = [...played, ...upcoming].filter((g) => g.phase === "NCAA Regional");
  const seen = new Set();
  const field = [];
  for (const g of regGames) {
    const o = g.opp;
    if (o && o.id && !seen.has(o.id)) { seen.add(o.id); field.push(o); }
  }
  const next = upcoming.filter((g) => g.phase === "NCAA Regional").slice(0, 4);
  return (
    <div className="th-post">
      <div className="th-post__title">{team.name} Regional</div>
      <div className="th-post__sub mono">Double-elimination · Winner advances to a Super Regional</div>
      <div className="th-post__teams">
        <SeriesTeam t={team} accent={team.color} onTeam={onTeam} me />
        {field.map((o) => <SeriesTeam key={o.id} t={o} onTeam={onTeam} />)}
      </div>
      {next.length > 0 && (
        <div className="th-post__games" style={{ gridTemplateColumns: `repeat(${Math.min(next.length, 3)}, 1fr)` }}>
          {next.map((g) => (
            <div key={g.id} className="th-pgame">
              <div className="mono th-pgame__g">{g.home ? "vs" : "at"} {g.opp ? g.opp.name : "TBD"}</div>
              <div className="mono th-pgame__date">{g.date}</div>
              <div className="mono hp-faint">{g.time || "TBD"}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// A single upcoming game (SEC Tournament's next game).
function WeekNextGame({ team, game, onTeam, label }) {
  const opp = game.opp;
  const click = _known(opp);
  return (
    <div className="th-series" style={{ borderLeftColor: team.color }}>
      <div className="th-series__head">
        <span className="hp-eyebrow">{label || "Next Game"}</span>
        <span className="mono hp-faint">{game.date}{game.time ? " · " + game.time : ""}</span>
      </div>
      <button className="bare-btn th-series__opp" disabled={!click}
        onClick={() => click && onTeam && onTeam(opp.id)}>
        <span className="mono hp-muted">{game.home ? "VS" : "AT"}</span>
        <HPLogo team={opp} size={28} />
        <span className="th-series__oppname">{opp ? opp.name : "TBD"}</span>
        {opp && opp.rank && <span className="chip-rank">#{opp.rank}</span>}
      </button>
    </div>
  );
}

// Regular season — a midweek game (if any) plus the weekend series.
function WeekRegular({ team, upcoming, onTeam }) {
  const runs = groupRuns(upcoming);
  const weekend = runs.find((r) => r.length >= 2) || null;
  if (!weekend) return <WeekNextGame team={team} game={upcoming[0]} onTeam={onTeam} label="Next Up" />;
  const midweek = runs[0] && runs[0].length === 1 && runs[0] !== weekend ? runs[0][0] : null;
  const opp = weekend[0].opp;
  const click = _known(opp);
  const seriesCard = (
    <div className="th-series" style={{ borderLeftColor: team.color }}>
      <div className="th-series__head">
        <span className="th-tag th-tag--solid">Weekend Series</span>
        <span className="mono hp-faint">{weekend.length} games</span>
      </div>
      <button className="bare-btn th-series__opp" disabled={!click}
        onClick={() => click && onTeam && onTeam(opp.id)}>
        <span className="mono hp-muted">{weekend[0].home ? "VS" : "AT"}</span>
        <HPLogo team={opp} size={28} />
        <span className="th-series__oppname">{opp ? opp.name : "TBD"}</span>
        {opp && opp.rank && <span className="chip-rank">#{opp.rank}</span>}
      </button>
      <div className="th-series__games" style={{ gridTemplateColumns: `repeat(${weekend.length}, 1fr)` }}>
        {weekend.map((g) => (
          <div key={g.id} className="th-game">
            <div className="mono th-game__date">{g.date}</div>
            <div className="mono hp-faint">{g.time || "TBD"}</div>
          </div>
        ))}
      </div>
    </div>
  );
  if (!midweek) return seriesCard;
  return (
    <div className="th-reg">
      <div className="th-mid">
        <span className="th-tag th-tag--outline">Midweek</span>
        <div className="th-mid__opp">
          <span className="mono hp-muted">{midweek.home ? "VS" : "AT"}</span>
          <span className="th-mid__oppname">{midweek.opp ? midweek.opp.name : "TBD"}</span>
        </div>
        <div className="mono hp-faint">{midweek.date}{midweek.time ? " · " + midweek.time : ""}</div>
      </div>
      {seriesCard}
    </div>
  );
}

// Recent results from the team's most recent round only (e.g. just the NCAA
// Regional games), with that specific round's name shown above. Games run
// oldest -> newest, so the most recent game sits at the bottom. Regular-season
// teams fall back to their last few games with no round header.
function RecentList({ schedule, onGameClick }) {
  const played = schedule.filter((g) => g.result);
  if (!played.length) return <div className="hp-placeholder">No results yet.</div>;
  const round = played[played.length - 1].phase || "regular";
  const inRound = played.filter((g) => (g.phase || "regular") === round);
  const games = round === "regular" ? inRound.slice(-5) : inRound;
  return (
    <div>
      {round !== "regular" && <div className="th-recent__head">{round}</div>}
      <div className="th-recent">
        {games.map((g) => (
          <button key={g.id} className="bare-btn th-recent__row" onClick={() => onGameClick && onGameClick(g)}>
            <span className={"chip " + (g.result === "W" ? "chip-w" : "chip-l")}>{g.result}</span>
            <span className="mono th-recent__score">{g.score.us}&ndash;{g.score.them}</span>
            <span className="th-recent__opp">{g.opp ? g.opp.name : ""}</span>
            <span className="mono hp-faint th-recent__date">{g.date}</span>
          </button>
        ))}
      </div>
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
        <HPLabel color={post ? "var(--gold)" : null}>This Week</HPLabel>
        <ThisWeek schedule={schedule} team={team} onTeam={onTeam} />
      </section>

      <section className="hp-hero">
        <HPLabel>Team Leaders</HPLabel>
        {teamData
          ? <TeamLeaders leaders={teamData.leaders} />
          : <div className="hp-placeholder">Loading team leaders…</div>}
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
    </div>
  );
};

window.TeamHome = TeamHome;
