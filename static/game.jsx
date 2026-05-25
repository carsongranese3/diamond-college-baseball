// Game detail view — box score + player lines

const GameDetail = ({ game, hostTeamId, onBack, onTeamClick, onPlayerClick, backLabel }) => {
  const host = window.TEAM_BY_ID[hostTeamId];
  const backText = backLabel || `${host.name} schedule`;
  const [detail, setDetail] = React.useState(null);
  const [error, setError] = React.useState(null);
  // Which team's box-score tables to show; default to the host team's side.
  const [statTeam, setStatTeam] = React.useState(game.home ? "home" : "away");

  React.useEffect(() => {
    setDetail(null);
    setError(null);
    setStatTeam(game.home ? "home" : "away");
    window.fetchGame(game, hostTeamId).then(setDetail).catch((e) => setError(e.message));
  }, [game.id]);

  if (error) {
    return (
      <div className="game-detail">
        <BackLink onClick={onBack}>{backText}</BackLink>
        <div className="loading-block">No box score available — {error}</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="game-detail">
        <BackLink onClick={onBack}>{backText}</BackLink>
        <div className="loading-block">Loading box score…</div>
      </div>
    );
  }

  const innCount = Math.max(
    9,
    detail.line.away.innings.length,
    detail.line.home.innings.length
  );
  const awayWin = detail.winner
    ? detail.winner === "away"
    : detail.line.away.r > detail.line.home.r;
  const homeWin = detail.winner
    ? detail.winner === "home"
    : detail.line.home.r > detail.line.away.r;

  return (
    <div className="game-detail">
      <BackLink onClick={onBack}>{backText}</BackLink>

      <header className="game-hero">
        <Eyebrow>{game.date}{detail.venue ? ` · ${detail.venue}` : ""}</Eyebrow>

        <div className="game-hero__matchup">
          <TeamScore team={detail.line.away} runs={detail.line.away.r}
            winner={awayWin} label="Away" onTeamClick={onTeamClick} />
          <div className="game-hero__mid">
            <div className="game-hero__final">{detail.duration || "FINAL"}</div>
          </div>
          <TeamScore team={detail.line.home} runs={detail.line.home.r}
            winner={homeWin} label="Home" onTeamClick={onTeamClick} />
        </div>
      </header>

      <section className="boxscore">
        <Eyebrow>Line Score</Eyebrow>
        <div className="boxscore__wrap">
          <table className="box-table">
            <thead>
              <tr>
                <th className="th th--left">Team</th>
                {Array.from({ length: innCount }, (_, i) => (
                  <th key={i} className="th th--right mono">{i + 1}</th>
                ))}
                <th className="th th--right mono">R</th>
                <th className="th th--right mono">H</th>
                <th className="th th--right mono">E</th>
              </tr>
            </thead>
            <tbody>
              {[detail.line.away, detail.line.home].map((side, idx) => (
                <tr key={idx}>
                  <td className="td">
                    <div className="box-team">
                      <Monogram team={side} size={24} />
                      <span className="box-team__name">{side.name}</span>
                    </div>
                  </td>
                  {Array.from({ length: innCount }, (_, i) => (
                    <td key={i} className="td td--right mono">
                      {side.innings[i] != null ? side.innings[i] : ""}
                    </td>
                  ))}
                  <td className="td td--right mono bold">{side.r}</td>
                  <td className="td td--right mono">{side.h}</td>
                  <td className="td td--right mono">{side.e}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="player-toggle">
        <button
          className={`player-toggle__btn ${statTeam === "away" ? "player-toggle__btn--active" : ""}`}
          onClick={() => setStatTeam("away")}
        >{detail.line.away.name}</button>
        <button
          className={`player-toggle__btn ${statTeam === "home" ? "player-toggle__btn--active" : ""}`}
          onClick={() => setStatTeam("home")}
        >{detail.line.home.name}</button>
      </div>

      <section className="boxscore">
        <Eyebrow>Batters · {detail.line[statTeam].name}</Eyebrow>
        <BatterTable rows={detail.batters[statTeam]} seo={detail.line[statTeam].seo} onPlayerClick={onPlayerClick} />
      </section>
      <section className="boxscore">
        <Eyebrow>Pitchers · {detail.line[statTeam].name}</Eyebrow>
        <PitcherTable rows={detail.pitchers[statTeam]} seo={detail.line[statTeam].seo} onPlayerClick={onPlayerClick} />
      </section>

      {detail.plays && detail.plays.length > 0 && (
        <section className="boxscore">
          <Eyebrow>Play-by-play</Eyebrow>
          <div className="pbp">
            {detail.plays.map((p, i) => (
              <div className="pbp__row" key={i}>
                <span className="pbp__text">{p.text}</span>
                {p.score ? <span className="pbp__score mono">{p.score}</span> : null}
              </div>
            ))}
          </div>
        </section>
      )}

      {detail.notes && detail.notes.length > 0 && (
        <section className="boxscore boxscore--notes">
          <Eyebrow>Game notes</Eyebrow>
          <ul className="notes">
            {detail.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
};

const TeamScore = ({ team, runs, winner, label, onTeamClick }) => {
  const matchTeam = window.TEAM_BY_ID[team.seo];
  return (
    <div
      className={`team-score ${winner ? "team-score--win" : ""}`}
      style={{ "--c": team.color || "#1B1B1B", "--ink": team.ink || "#FFFFFF" }}
    >
      <div className="team-score__label">{label}</div>
      <div
        className="team-score__row"
        onClick={matchTeam ? () => onTeamClick(team.seo) : undefined}
        style={matchTeam ? { cursor: "pointer" } : undefined}
      >
        <Monogram team={team} size={56} />
        <div className="team-score__text">
          <div className="team-score__name">{team.name}</div>
          {matchTeam && matchTeam.rank != null && (
            <div className="team-score__rank">
              <RankChip rank={matchTeam.rank} size="sm" />
            </div>
          )}
        </div>
      </div>
      <div className="team-score__runs mono">{runs}</div>
    </div>
  );
};

const OpponentCard = ({ game, hostTeamId, onTeamClick }) => {
  const opp = game.opp;
  return (
    <section className="opp-card">
      <Eyebrow>Opponent</Eyebrow>
      <div className="opp-card__inner" style={{ "--c": opp.color || "#1B1B1B", "--ink": opp.ink || "#FFFFFF" }}>
        <Monogram team={opp} size={72} />
        <div className="opp-card__body">
          <div className="opp-card__kicker">
            {opp.rank != null ? <RankChip rank={opp.rank} size="lg" /> : <span className="muted small">Unranked</span>}
            <span className="muted small">{opp.conf ? "SEC Conference" : "Non-conference"}</span>
          </div>
          <div className="opp-card__name">{opp.name}</div>
          <div className="opp-card__meta">
            <span>{game.home ? "Visiting" : "Hosting"} {window.TEAM_BY_ID[hostTeamId].name}</span>
          </div>
        </div>
        {opp.conf && (
          <button className="opp-card__cta" onClick={() => onTeamClick(opp.id)}>
            View team →
          </button>
        )}
      </div>
    </section>
  );
};

const BatterTable = ({ rows, seo, onPlayerClick }) => {
  const totals = rows.reduce((acc, r) => ({
    ab: acc.ab + r.ab, rr: acc.rr + r.r, h: acc.h + r.h, rbi: acc.rbi + r.rbi, bb: acc.bb + r.bb, k: acc.k + r.k
  }), { ab:0, rr:0, h:0, rbi:0, bb:0, k:0 });
  return (
    <table className="box-table">
      <thead>
        <tr>
          <th className="th th--left">Batter</th>
          <th className="th th--left">Pos</th>
          <th className="th th--right">AB</th>
          <th className="th th--right">R</th>
          <th className="th th--right">H</th>
          <th className="th th--right">RBI</th>
          <th className="th th--right">BB</th>
          <th className="th th--right">K</th>
          <th className="th th--right">AVG</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="td"><span className="player-link" onClick={() => onPlayerClick && seo && onPlayerClick(seo, r.name)}>{r.name}</span></td>
            <td className="td mono small muted">{r.pos}</td>
            <td className="td td--right mono">{r.ab}</td>
            <td className="td td--right mono">{r.r}</td>
            <td className="td td--right mono">{r.h}</td>
            <td className="td td--right mono">{r.rbi}</td>
            <td className="td td--right mono">{r.bb}</td>
            <td className="td td--right mono">{r.k}</td>
            <td className="td td--right mono muted">{r.avg}</td>
          </tr>
        ))}
        <tr className="row-totals">
          <td className="td">Totals</td>
          <td className="td"></td>
          <td className="td td--right mono">{totals.ab}</td>
          <td className="td td--right mono">{totals.rr}</td>
          <td className="td td--right mono">{totals.h}</td>
          <td className="td td--right mono">{totals.rbi}</td>
          <td className="td td--right mono">{totals.bb}</td>
          <td className="td td--right mono">{totals.k}</td>
          <td className="td td--right mono"></td>
        </tr>
      </tbody>
    </table>
  );
};

const PitcherTable = ({ rows, seo, onPlayerClick }) => (
  <table className="box-table">
    <thead>
      <tr>
        <th className="th th--left">Pitcher</th>
        <th className="th th--right">IP</th>
        <th className="th th--right">H</th>
        <th className="th th--right">R</th>
        <th className="th th--right">ER</th>
        <th className="th th--right">BB</th>
        <th className="th th--right">K</th>
        <th className="th th--right">ERA</th>
        <th className="th th--right">Dec</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((r, i) => (
        <tr key={i}>
          <td className="td"><span className="player-link" onClick={() => onPlayerClick && seo && onPlayerClick(seo, r.name)}>{r.name}</span></td>
          <td className="td td--right mono">{r.ip}</td>
          <td className="td td--right mono">{r.h}</td>
          <td className="td td--right mono">{r.r}</td>
          <td className="td td--right mono">{r.er}</td>
          <td className="td td--right mono">{r.bb}</td>
          <td className="td td--right mono">{r.k}</td>
          <td className="td td--right mono muted">{r.era}</td>
          <td className="td td--right mono small">{r.dec}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

window.GameDetail = GameDetail;
