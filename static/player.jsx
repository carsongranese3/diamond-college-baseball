// Player detail view — per-season totals + game-by-game log (local Data/2026/ data).

const PlayerBattingTotals = ({ b }) => (
  <div className="stat-grid stat-grid--4">
    <StatCell label="AVG" value={b.avg} />
    <StatCell label="OBP" value={b.obp} />
    <StatCell label="SLG" value={b.slg} />
    <StatCell label="OPS" value={b.ops} />
    <StatCell label="G"   value={b.g} />
    <StatCell label="AB"  value={b.ab} />
    <StatCell label="H"   value={b.h} />
    <StatCell label="HR"  value={b.hr} />
    <StatCell label="R"   value={b.r} />
    <StatCell label="RBI" value={b.rbi} />
    <StatCell label="BB"  value={b.bb} />
    <StatCell label="SB"  value={b.sb} />
  </div>
);

const PlayerPitchingTotals = ({ p }) => (
  <div className="stat-grid stat-grid--4">
    <StatCell label="ERA"  value={p.era} />
    <StatCell label="WHIP" value={p.whip} />
    <StatCell label="OppAvg" value={p.oba} />
    <StatCell label="IP"   value={p.ip} />
    <StatCell label="K"    value={p.k} />
    <StatCell label="G"    value={p.g} />
    <StatCell label="H"    value={p.h} />
    <StatCell label="R"    value={p.r} />
    <StatCell label="ER"   value={p.er} />
    <StatCell label="BB"   value={p.bb} />
  </div>
);

const BattingGameLog = ({ games }) => (
  <div className="boxscore__wrap">
    <table className="box-table player-table">
      <thead>
        <tr>
          <th className="th th--left">Date</th>
          <th className="th th--left">Opponent</th>
          <th className="th th--right">AB</th>
          <th className="th th--right">R</th>
          <th className="th th--right">H</th>
          <th className="th th--right">2B</th>
          <th className="th th--right">3B</th>
          <th className="th th--right">HR</th>
          <th className="th th--right">RBI</th>
          <th className="th th--right">BB</th>
          <th className="th th--right">K</th>
          <th className="th th--right">SB</th>
          <th className="th th--right">AVG</th>
        </tr>
      </thead>
      <tbody>
        {games.filter((g) => g.bat).map((g, i) => (
          <tr key={i}>
            <td className="td mono small">{g.date}</td>
            <td className="td"><span className="muted small">{g.home ? "vs" : "at"}</span> {g.opp}</td>
            <td className="td td--right mono">{g.bat.ab}</td>
            <td className="td td--right mono">{g.bat.r}</td>
            <td className="td td--right mono">{g.bat.h}</td>
            <td className="td td--right mono">{g.bat["2b"]}</td>
            <td className="td td--right mono">{g.bat["3b"]}</td>
            <td className="td td--right mono">{g.bat.hr}</td>
            <td className="td td--right mono">{g.bat.rbi}</td>
            <td className="td td--right mono">{g.bat.bb}</td>
            <td className="td td--right mono">{g.bat.k}</td>
            <td className="td td--right mono">{g.bat.sb}</td>
            <td className="td td--right mono muted">{g.bat.avg}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const PitchingGameLog = ({ games }) => (
  <div className="boxscore__wrap">
    <table className="box-table player-table">
      <thead>
        <tr>
          <th className="th th--left">Date</th>
          <th className="th th--left">Opponent</th>
          <th className="th th--right">IP</th>
          <th className="th th--right">H</th>
          <th className="th th--right">R</th>
          <th className="th th--right">ER</th>
          <th className="th th--right">BB</th>
          <th className="th th--right">K</th>
          <th className="th th--right">ERA</th>
        </tr>
      </thead>
      <tbody>
        {games.filter((g) => g.pit).map((g, i) => (
          <tr key={i}>
            <td className="td mono small">{g.date}</td>
            <td className="td"><span className="muted small">{g.home ? "vs" : "at"}</span> {g.opp}</td>
            <td className="td td--right mono">{g.pit.ip}</td>
            <td className="td td--right mono">{g.pit.h}</td>
            <td className="td td--right mono">{g.pit.r}</td>
            <td className="td td--right mono">{g.pit.er}</td>
            <td className="td td--right mono">{g.pit.bb}</td>
            <td className="td td--right mono">{g.pit.k}</td>
            <td className="td td--right mono muted">{g.pit.era}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const PlayerDetail = ({ seo, playerName, onBack, backLabel }) => {
  const team = window.TEAM_BY_ID[seo];
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    setData(null);
    setError(null);
    window.fetchPlayer(seo, playerName).then(setData).catch((e) => setError(e.message));
  }, [seo, playerName]);

  const back = (
    <BackLink onClick={onBack}>{backLabel || (team && team.name) || "Back"}</BackLink>
  );

  if (error) {
    return (
      <div className="player-detail">
        {back}
        <div className="loading-block">No saved data for this player.</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="player-detail">
        {back}
        <div className="loading-block">Loading player…</div>
      </div>
    );
  }

  return (
    <div className="player-detail">
      {back}

      <header className="player-hero" style={team ? { "--team-color": team.color, "--team-ink": team.ink } : {}}>
        {team && <Monogram team={team} size={64} />}
        <div className="player-hero__text">
          <div className="player-hero__kicker mono">
            {data.num && <span>#{data.num}</span>}
            {data.pos && <span>{data.pos}</span>}
            {team && <span className="muted">{team.name}</span>}
          </div>
          <h1 className="display player-hero__name">{data.name}</h1>
        </div>
      </header>

      {data.seasons.map((s) => (
        <section className="player-season" key={s.year}>
          <Eyebrow>{s.year} Season</Eyebrow>

          {s.batting && (
            <div className="player-season__block">
              <div className="player-season__label">Batting</div>
              <PlayerBattingTotals b={s.batting} />
            </div>
          )}
          {s.pitching && (
            <div className="player-season__block">
              <div className="player-season__label">Pitching</div>
              <PlayerPitchingTotals p={s.pitching} />
            </div>
          )}

          {s.batting && (
            <div className="player-season__block">
              <div className="player-season__label">Batting — game by game</div>
              <BattingGameLog games={s.games} />
            </div>
          )}
          {s.pitching && (
            <div className="player-season__block">
              <div className="player-season__label">Pitching — game by game</div>
              <PitchingGameLog games={s.games} />
            </div>
          )}
        </section>
      ))}
    </div>
  );
};

window.PlayerDetail = PlayerDetail;
