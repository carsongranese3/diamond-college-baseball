// Standings view — front page

const Standings = ({ onTeamClick }) => {
  const [sortBy, setSortBy] = React.useState("conf");

  const sorted = React.useMemo(() => {
    const arr = [...window.TEAMS];
    if (sortBy === "conf") {
      arr.sort((a, b) => {
        const aPct = a.confW / Math.max(a.confW + a.confL, 1);
        const bPct = b.confW / Math.max(b.confW + b.confL, 1);
        return bPct - aPct || b.confW - a.confW;
      });
    } else if (sortBy === "ovr") {
      arr.sort((a, b) => (b.ovrW / Math.max(b.ovrW + b.ovrL, 1)) - (a.ovrW / Math.max(a.ovrW + a.ovrL, 1)));
    } else if (sortBy === "rank") {
      arr.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    } else if (sortBy === "rpi") {
      arr.sort((a, b) => a.rpi - b.rpi);
    }
    return arr;
  }, [sortBy]);

  const headerCell = (key, label, align = "right") => (
    <th
      className={`th th--${align} ${sortBy === key ? "th--active" : ""}`}
      onClick={() => setSortBy(key)}
    >
      {label}
      {sortBy === key && <span className="th__sort"> ▾</span>}
    </th>
  );

  return (
    <div className="standings">
      <header className="standings__header">
        <Eyebrow>2026 Season · Live from ncaa.com</Eyebrow>
        <h1 className="display">SEC Baseball</h1>
        <div className="standings__sub">
          <span>Conference Standings</span>
          <span className="dot">·</span>
          <span>Updated {window.SEASON_UPDATED ? new Date(window.SEASON_UPDATED).toLocaleDateString() : "—"}</span>
          <span className="dot">·</span>
          <span className="muted">Tap a team to view schedule &amp; stats</span>
        </div>
      </header>

      <div className="standings__legend">
        <div className="legend-item">
          <span className="rank-chip rank-md">#1</span>
          <span>NCAA D1 Top-25 ranking</span>
        </div>
        <div className="legend-item">
          <span className="legend-streak win">W6</span>
          <span>Active win streak</span>
        </div>
        <div className="legend-item">
          <span className="legend-streak loss">L2</span>
          <span>Active losing streak</span>
        </div>
      </div>

      <div className="table-wrap">
        <table className="stand-table">
          <thead>
            <tr>
              <th className="th th--left">Pos</th>
              <th className="th th--left">Team</th>
              {headerCell("rank", "NCAA", "right")}
              {headerCell("conf", "Conf",  "right")}
              <th className="th th--right">Pct</th>
              {headerCell("ovr", "Overall", "right")}
              <th className="th th--right">Streak</th>
              {headerCell("rpi", "RPI", "right")}
              <th className="th th--right"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t, i) => {
              const pct = (t.confW / Math.max(t.confW + t.confL, 1)).toFixed(3).replace(/^0/, "");
              const streakSign = t.streak.startsWith("W") ? "win" : "loss";
              return (
                <tr key={t.id} className="row" onClick={() => onTeamClick(t.id)}>
                  <td className="td td--pos">{String(i + 1).padStart(2, "0")}</td>
                  <td className="td td--team">
                    <div className="team-cell">
                      <Monogram team={t} size={36} />
                      <div className="team-cell__text">
                        <div className="team-cell__name">{t.name}</div>
                        <div className="team-cell__city">{t.city}</div>
                      </div>
                    </div>
                  </td>
                  <td className="td td--right"><RankChip rank={t.rank} /></td>
                  <td className="td td--right mono">{t.confW}–{t.confL}</td>
                  <td className="td td--right mono muted">{pct}</td>
                  <td className="td td--right mono">{t.ovrW}–{t.ovrL}</td>
                  <td className="td td--right">
                    <span className={`legend-streak ${streakSign}`}>{t.streak}</span>
                  </td>
                  <td className="td td--right mono muted">{t.rpi}</td>
                  <td className="td td--right td--chev">›</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="standings__footer">
        <span>Data shown is illustrative — 2026 season mockup.</span>
      </footer>
    </div>
  );
};

window.Standings = Standings;
