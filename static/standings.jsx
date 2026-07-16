// Standings view — front page

// SEC rankings over time — each team's weekly standings position (1 = top),
// from /api/rankings/history (built from the precomputed per-team records.json).
// Rank on the Y-axis (1 at top), week of conference play on the X-axis; one line
// per team in its color, with the team logo at the line's end.
function RankGraph({ onTeamClick, league }) {
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    setData(null); setErr(null);
    window.fetchRankingsHistory(league)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [league]);
  if (err) return <div className="hp-placeholder hp-placeholder--tall">Couldn't load the rankings graph.</div>;
  if (!data) return <div className="hp-placeholder hp-placeholder--tall">Loading rankings graph…</div>;

  const weeks = data.weeks || [];
  const N = weeks.length;
  const byId = window.TEAM_BY_ID || {};
  const lines = Object.entries(data.teams || {})
    .map(([seo, series]) => ({ seo, team: byId[seo] || { name: seo }, series }))
    .filter((l) => l.series.length);
  const nTeams = lines.length || 16;

  // Geometry (viewBox units; the SVG scales to its container width).
  const W = 960, H = 540, padL = 32, padR = 80, padT = 20, padB = 44;
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  const xFor = (n) => (N <= 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * (n - 1) / (N - 1));
  const yFor = (rank) => y0 + (y1 - y0) * (rank - 1) / Math.max(nTeams - 1, 1);
  const rankTicks = [...new Set([1, 4, 8, 12, nTeams])];

  return (
    <div className="rank-graph">
      <svg viewBox={`0 0 ${W} ${H}`} className="rank-graph__svg" role="img"
           aria-label="SEC standings position by week of conference play">
        {/* horizontal rank gridlines */}
        {Array.from({ length: nTeams }, (_, i) => i + 1).map((r) => (
          <line key={"h" + r} x1={x0} x2={x1} y1={yFor(r)} y2={yFor(r)}
                className={"rg-grid" + (rankTicks.includes(r) ? " rg-grid--major" : "")} />
        ))}
        {rankTicks.map((r) => (
          <text key={"rl" + r} x={x0 - 9} y={yFor(r) + 4} className="rg-axis" textAnchor="end">{r}</text>
        ))}
        {/* week numbers */}
        {weeks.map((w) => (
          <text key={"wl" + w.n} x={xFor(w.n)} y={y1 + 24} className="rg-axis" textAnchor="middle">{w.n}</text>
        ))}
        <text x={(x0 + x1) / 2} y={H - 8} className="rg-axis rg-axis--title" textAnchor="middle">
          Week of conference play
        </text>
        {/* team lines */}
        {lines.map((l) => (
          <polyline key={l.seo} className="rg-line" fill="none" stroke={l.team.color || "#888"}
                    points={l.series.map((p) => `${xFor(p.n)},${yFor(p.rank)}`).join(" ")}>
            <title>{l.team.name}</title>
          </polyline>
        ))}
        {/* end-of-line logo badges (each team's final rank is unique, so they stack) */}
        {lines.map((l) => {
          const last = l.series[l.series.length - 1];
          const cx = xFor(last.n), cy = yFor(last.rank), s = 26;
          return (
            <g key={"lg" + l.seo} className="rg-badge" transform={`translate(${cx + 8}, ${cy - s / 2})`}
               onClick={() => onTeamClick && byId[l.seo] && onTeamClick(l.seo)}>
              <title>{`${l.team.name} — #${last.rank} (${last.confW}–${last.confL})`}</title>
              <circle cx={s / 2} cy={s / 2} r={s / 2} className="rg-badge__bg" />
              {l.team.logo
                ? <image href={l.team.logo} x={3} y={3} width={s - 6} height={s - 6} />
                : <text x={s / 2} y={s / 2 + 4} textAnchor="middle" className="rg-badge__mark">{l.team.mark}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// NCAA view: the official Division I Top 25 poll (from /api/rankings/top25).
// Teams we have data for are clickable with their real crest; others show a
// name + best-effort logo (Monogram falls back to initials if it 404s).
// The national D1 poll as a table. `league` (a conference display name like "SEC")
// filters to that conference's ranked teams; `limit` caps the row count.
function Top25Table({ onTeamClick, league, limit }) {
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    window.fetchTop25()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, []);
  if (err) return <div className="loading-block">Couldn't load the Top 25.</div>;
  if (!data) return <div className="loading-block">Loading Top 25…</div>;
  let rows = data;
  if (league && league !== "NCAA")
    rows = rows.filter((t) => (t.conference || "").toUpperCase() === String(league).toUpperCase());
  if (limit) rows = rows.slice(0, limit);
  if (!rows.length) return <div className="loading-block">No ranked teams.</div>;
  return (
    <div className="table-wrap">
      <table className="stand-table">
        <thead>
          <tr>
            <th className="th th--left">Rank</th>
            <th className="th th--left">Team</th>
            <th className="th th--right">Record</th>
            <th className="th th--right">Prev</th>
            <th className="th th--left"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const teamObj = { id: t.seo, logo: t.logo, name: t.name,
                              mark: (t.name || "").slice(0, 4).toUpperCase() };
            return (
              <tr key={t.seo || t.rank} className={"row" + (t.known ? "" : " row--static")}
                  onClick={() => t.known && onTeamClick && onTeamClick(t.seo)}>
                <td className="td td--pos">{String(t.rank).padStart(2, "0")}</td>
                <td className="td td--team">
                  <div className="team-cell">
                    <Monogram team={teamObj} size={36} />
                    <div className="team-cell__text">
                      <div className="team-cell__name">{t.name}</div>
                      <div className="team-cell__city">{t.conference || ""}</div>
                    </div>
                  </div>
                </td>
                <td className="td td--right mono">{t.record}</td>
                <td className="td td--right mono muted">{t.prev || "—"}</td>
                <td className="td td--left"><RankDelta rank={t.rank} prev={t.prev} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const Standings = ({ onTeamClick, league }) => {
  const [sortBy, setSortBy] = React.useState("conf");
  const [view, setView] = React.useState("table");   // table | graph

  const sorted = React.useMemo(() => {
    const arr = [...window.leagueTeams(league)];
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
  }, [sortBy, league]);

  const headerCell = (key, label, align = "right") => (
    <th
      className={`th th--${align} ${sortBy === key ? "th--active" : ""}`}
      onClick={() => setSortBy(key)}
    >
      {label}
      {sortBy === key && <span className="th__sort"> ▾</span>}
    </th>
  );

  // Off-season: the "final standings" become the Top 10 of the national poll.
  // A conference view is filtered to that conference's ranked teams (which may be
  // fewer than 10); the NCAA view shows the national Top 10.
  const offseason = !!(window.SEASON_PHASE && window.SEASON_PHASE.phase === "offseason");
  if (offseason) {
    const conf = league && league !== "NCAA";
    return (
      <div className="standings">
        <header className="standings__header">
          <Eyebrow>2026 Season · Final</Eyebrow>
          <h1 className="display">Final {league || "NCAA"} Standings</h1>
          <div className="standings__sub">
            <span>{conf ? `${league} teams in the D1 Top 25` : "Division I Top 25"}</span>
            <span className="dot">·</span>
            <span>Final national poll</span>
            <span className="dot">·</span>
            <span className="muted">Tap a ranked team for its schedule &amp; stats</span>
          </div>
        </header>
        <Top25Table onTeamClick={onTeamClick} league={league} limit={25} />
        <footer className="standings__footer">
          <span>Data shown is illustrative — 2026 season mockup.</span>
        </footer>
      </div>
    );
  }

  // NCAA = the official Top 25 poll, not a conference table.
  if (league === "NCAA") {
    return (
      <div className="standings">
        <header className="standings__header">
          <Eyebrow>2026 Season · Live from ncaa.com</Eyebrow>
          <h1 className="display">NCAA Baseball</h1>
          <div className="standings__sub">
            <span>Division I Top 25</span>
            <span className="dot">·</span>
            <span>Official poll</span>
            <span className="dot">·</span>
            <span className="muted">Tap a ranked team for its schedule &amp; stats</span>
          </div>
        </header>
        <Top25Table onTeamClick={onTeamClick} />
        <footer className="standings__footer">
          <span>Data shown is illustrative — 2026 season mockup.</span>
        </footer>
      </div>
    );
  }

  return (
    <div className="standings">
      <header className="standings__header">
        <Eyebrow>2026 Season · Live from ncaa.com</Eyebrow>
        <h1 className="display">{league || "NCAA"} Baseball</h1>
        <div className="standings__sub">
          <span>{league === "NCAA" ? "All Teams" : "Conference Standings"}</span>
          <span className="dot">·</span>
          <span>Updated {window.SEASON_UPDATED ? new Date(window.SEASON_UPDATED).toLocaleDateString() : "—"}</span>
          <span className="dot">·</span>
          <span className="muted">Tap a team to view schedule &amp; stats</span>
        </div>
      </header>

      <div className="standings__controls">
        <div className="segmented">
          <button className={`segmented__btn ${view === "table" ? "segmented__btn--active" : ""}`}
                  onClick={() => setView("table")}>Table</button>
          <button className={`segmented__btn ${view === "graph" ? "segmented__btn--active" : ""}`}
                  onClick={() => setView("graph")}>Graph</button>
        </div>
        {view === "table" && (
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
        )}
        {view === "graph" && (
          <span className="standings__graphnote muted">{league || "NCAA"} standings position by week · line ends at the team logo</span>
        )}
      </div>

      {view === "graph" && <RankGraph onTeamClick={onTeamClick} league={league} />}

      <div className="table-wrap" style={view === "graph" ? { display: "none" } : null}>
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
