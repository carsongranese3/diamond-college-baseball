// Shared UI primitives for SEC baseball mock.

// Real team logo from the NCAA API; falls back to a colored initials chip
// if the school has no logo (or it fails to load).
const Monogram = ({ team, size = 44 }) => {
  const fontSize = size <= 28 ? 11 : size <= 36 ? 13 : size <= 48 ? 15 : 18;
  const [failed, setFailed] = React.useState(false);
  // Reset the failed flag whenever the logo changes, so an instance reused for a
  // different team (e.g. a re-sorted standings row) retries the new logo instead of
  // staying on the previous team's fallback chip.
  React.useEffect(() => { setFailed(false); }, [team.logo]);

  if (team.logo && !failed) {
    return (
      <div
        className="monogram monogram--logo"
        style={{ width: size, height: size }}
      >
        <img
          src={team.logo}
          alt={team.name || team.mark}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }
  return (
    <div
      className="monogram"
      style={{
        width: size,
        height: size,
        background: team.color || "#1B1B1B",
        color: team.ink || "#FFFFFF",
        fontSize,
      }}
    >
      <span>{team.mark}</span>
    </div>
  );
};

// Burnt-orange ranking chip; nothing if unranked.
const RankChip = ({ rank, size = "md" }) => {
  if (rank == null) return <span className="rank-chip rank-unranked">—</span>;
  return <span className={`rank-chip rank-${size}`}>#{rank}</span>;
};

// Section heading: SERIF eyebrow / kicker style
const Eyebrow = ({ children }) => (
  <div className="eyebrow">{children}</div>
);

const StatCell = ({ label, value, sub }) => (
  <div className="stat-cell">
    <div className="stat-cell__label">{label}</div>
    <div className="stat-cell__value">{value}</div>
    {sub && <div className="stat-cell__sub">{sub}</div>}
  </div>
);

const BackLink = ({ onClick, children }) => (
  <button className="back-link" onClick={onClick}>
    <span className="back-link__arrow">←</span> {children}
  </button>
);

Object.assign(window, { Monogram, RankChip, Eyebrow, StatCell, BackLink });
