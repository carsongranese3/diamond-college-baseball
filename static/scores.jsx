// Scores view — a daily scoreboard built from the per-team schedules.

// Parse an ISO date locally (avoids the UTC day-shift of new Date("YYYY-MM-DD")).
function _parseIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const _fmtLong = (iso) =>
  _parseIso(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const _fmtShort = (iso) =>
  _parseIso(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

// Flatten window.SCHEDULES (one entry per SEC team) into neutral home/away game
// cards grouped by date. SEC-vs-SEC games appear under both teams, so dedupe by id.
function _scoreboardByDate() {
  const byId = {};
  for (const [seo, games] of Object.entries(window.SCHEDULES || {})) {
    const me = window.TEAM_BY_ID[seo];
    if (!me) continue;
    for (const g of games) {
      if (!g.iso || byId[g.id]) continue;
      const opp = g.opp;
      const final = !!g.score;
      let home, away, homeScore, awayScore;
      if (g.home) {
        home = me; away = opp;
        homeScore = final ? g.score.us : null;
        awayScore = final ? g.score.them : null;
      } else {
        home = opp; away = me;
        homeScore = final ? g.score.them : null;
        awayScore = final ? g.score.us : null;
      }
      byId[g.id] = {
        id: g.id, iso: g.iso, time: g.time, final,
        home, away, homeScore, awayScore,
        hostSeo: seo, hostGame: g, // for opening the box-score detail
      };
    }
  }
  const byDate = {};
  for (const game of Object.values(byId)) {
    (byDate[game.iso] = byDate[game.iso] || []).push(game);
  }
  for (const iso in byDate) {
    byDate[iso].sort((a, b) => (b.final - a.final) || a.home.name.localeCompare(b.home.name));
  }
  return byDate;
}

const ScoreRow = ({ game, onClick }) => {
  const { home, away, homeScore, awayScore, final, time } = game;
  const homeWon = final && homeScore > awayScore;
  const awayWon = final && awayScore > homeScore;
  const teamLine = (team, won) => (
    <div className={`score-row__team ${final ? (won ? "score-row__team--win" : "score-row__team--lose") : ""}`}>
      <Monogram team={team} size={28} />
      <span className="score-row__name">
        {team.rank && <span className="rank-chip rank-sm">#{team.rank}</span>} {team.name}
      </span>
      <span className="score-row__num mono">{final ? (team === home ? homeScore : awayScore) : ""}</span>
    </div>
  );
  return (
    <div
      className={`score-row ${final ? "" : "score-row--upcoming"}`}
      onClick={final ? onClick : undefined}
    >
      <div className="score-row__status">
        {final
          ? <span className="score-row__final mono">Final</span>
          : <span className="score-row__time mono">{time || "TBD"}</span>}
      </div>
      <div className="score-row__teams">
        {teamLine(away, awayWon)}
        {teamLine(home, homeWon)}
      </div>
      <div className="score-row__chev">{final ? "›" : ""}</div>
    </div>
  );
};

const Scores = ({ onGameClick, initialDate, onDateChange }) => {
  const byDate = React.useMemo(_scoreboardByDate, []);
  const dates = React.useMemo(() => Object.keys(byDate).sort(), [byDate]);

  // Default to today if it has games, else the most recent past date with games.
  const defaultIdx = React.useMemo(() => {
    if (!dates.length) return 0;
    const todayIso = new Date().toISOString().slice(0, 10);
    let idx = -1;
    for (let i = 0; i < dates.length && dates[i] <= todayIso; i++) idx = i;
    return idx >= 0 ? idx : dates.length - 1;
  }, [dates]);

  // If the URL names a date that has games, start there; else fall to the default.
  const initialIdx = React.useMemo(() => {
    if (initialDate && dates.includes(initialDate)) return dates.indexOf(initialDate);
    return defaultIdx;
  }, [initialDate, dates, defaultIdx]);

  const [idx, setIdx] = React.useState(initialIdx);
  React.useEffect(() => { setIdx(initialIdx); }, [initialIdx]);

  const iso = dates[idx];
  // Report the selected date up so the URL stays in sync. (Hook must run before
  // any early return, so it's keyed on iso which is undefined when empty.)
  React.useEffect(() => { if (onDateChange && iso) onDateChange(iso); }, [iso]);

  if (!dates.length) {
    return <div className="loading-block">No games found for the season yet.</div>;
  }
  const games = byDate[iso] || [];
  const finals = games.filter((g) => g.final).length;

  return (
    <div className="scores">
      <header className="scores__header">
        <Eyebrow>2026 Season · Daily Scoreboard</Eyebrow>
        <h1 className="display">Scores</h1>
      </header>

      <div className="scores__nav">
        <button
          className="scores__arrow"
          disabled={idx === 0}
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          aria-label="Previous day"
        >‹</button>

        <div className="scores__date-wrap">
          <div className="scores__date-main">{_fmtLong(iso)}</div>
          <div className="scores__date-sub mono">
            {games.length} game{games.length === 1 ? "" : "s"} · {finals} final
          </div>
          <select
            className="scores__select"
            value={iso}
            onChange={(e) => setIdx(dates.indexOf(e.target.value))}
            aria-label="Select a date"
          >
            {dates.map((d) => <option key={d} value={d}>{_fmtShort(d)}</option>)}
          </select>
        </div>

        <button
          className="scores__arrow"
          disabled={idx === dates.length - 1}
          onClick={() => setIdx((i) => Math.min(dates.length - 1, i + 1))}
          aria-label="Next day"
        >›</button>
      </div>

      <div className="sched-list">
        {games.map((g) => (
          <ScoreRow
            key={g.id}
            game={g}
            onClick={() => onGameClick(g.hostGame, g.hostSeo)}
          />
        ))}
      </div>
    </div>
  );
};

window.Scores = Scores;
