// Stats view — league-wide Stat Leaders.
//
// A sortable player leaderboard split by a mutually-exclusive Batter / Pitcher
// toggle: pick a mode, choose which stat columns to show (chips, max 10), sort by
// any column, and the leader hero up top follows whatever you sort by. Data comes
// from /api/stat-leaders (pooled, qualified players across the league's teams).
// Ported from the "Stats Page" prototype; wired to real data + the .bbx theme.

// Every stat the table can show, in display order. `group` is the mode it belongs
// to ("B" batting / "P" pitching), `w` the column width (px), `better` the sort
// direction that puts the best value on top. Keys repeat across groups (batter BB
// vs pitcher BB), so every lookup is group-scoped via stxDef().
const STX_MASTER = [
  // Batters
  { key: "ab",     label: "AB",    group: "B", w: 50, better: "high" },
  { key: "pa",     label: "PA",    group: "B", w: 50, better: "high" },
  { key: "r",      label: "R",     group: "B", w: 46, better: "high" },
  { key: "h",      label: "H",     group: "B", w: 46, better: "high" },
  { key: "hr",     label: "HR",    group: "B", w: 48, better: "high" },
  { key: "rbi",    label: "RBI",   group: "B", w: 50, better: "high" },
  { key: "bb",     label: "BB",    group: "B", w: 46, better: "high" },
  { key: "k",      label: "K",     group: "B", w: 44, better: "low" },
  { key: "sb",     label: "SB",    group: "B", w: 46, better: "high" },
  { key: "avg",    label: "AVG",   group: "B", w: 60, better: "high" },
  { key: "obp",    label: "OBP",   group: "B", w: 60, better: "high" },
  { key: "slg",    label: "SLG",   group: "B", w: 60, better: "high" },
  { key: "ops",    label: "OPS",   group: "B", w: 64, better: "high" },
  { key: "babip",  label: "BABIP", group: "B", w: 64, better: "high" },
  { key: "bbpct",  label: "BB%",   group: "B", w: 58, better: "high" },
  { key: "kpct",   label: "K%",    group: "B", w: 56, better: "low" },
  { key: "secavg", label: "SEC",   group: "B", w: 60, better: "high" },
  { key: "rc",     label: "RC",    group: "B", w: 54, better: "high" },
  // Pitchers
  { key: "gs",     label: "GS",    group: "P", w: 48, better: "high" },
  { key: "w",      label: "W",     group: "P", w: 44, better: "high" },
  { key: "l",      label: "L",     group: "P", w: 44, better: "low" },
  { key: "sv",     label: "SV",    group: "P", w: 46, better: "high" },
  { key: "ip",     label: "IP",    group: "P", w: 60, better: "high" },
  { key: "h",      label: "H",     group: "P", w: 46, better: "low" },
  { key: "r",      label: "R",     group: "P", w: 46, better: "low" },
  { key: "er",     label: "ER",    group: "P", w: 46, better: "low" },
  { key: "bb",     label: "BB",    group: "P", w: 46, better: "low" },
  { key: "k",      label: "K",     group: "P", w: 44, better: "high" },
  { key: "era",    label: "ERA",   group: "P", w: 60, better: "low" },
  { key: "whip",   label: "WHIP",  group: "P", w: 64, better: "low" },
  { key: "k9",     label: "K/9",   group: "P", w: 56, better: "high" },
  { key: "bb9",    label: "BB/9",  group: "P", w: 58, better: "low" },
  { key: "hr9",    label: "HR/9",  group: "P", w: 58, better: "low" },
  { key: "kbb",    label: "KBB",   group: "P", w: 56, better: "high" },
  { key: "fip",    label: "FIP",   group: "P", w: 58, better: "low" },
  { key: "kbbpct", label: "K-BB%", group: "P", w: 66, better: "high" },
  { key: "lobpct", label: "LOB%",  group: "P", w: 62, better: "high" },
];
// Group-scoped lookup — keys repeat across batting/pitching.
const stxDef = (mode, key) => STX_MASTER.find((s) => s.group === mode && s.key === key);

// Per-mode starting columns + sort. Switching mode resets to these.
const STX_DEFAULTS = {
  B: { selected: { avg: true, hr: true, rbi: true, obp: true, ops: true }, sortKey: "avg" },
  P: { selected: { era: true, whip: true, w: true, k: true, ip: true }, sortKey: "era" },
};
const STX_MAX = 10;        // most stat columns selectable at once
const STX_ROWS = 25;       // players shown in the table (rank 1–25)
// Hero stat boxes per mode.
const STX_HERO = { B: ["avg", "hr", "rbi", "ops"], P: ["era", "w", "k", "whip"] };

// "#FF8200" -> "rgba(255,130,0,a)" for the leader-hero gradient.
function stxRgba(hex, a) {
  const h = (hex || "#444").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
// Numeric value for sorting. Rate stats arrive as strings (".327", "2.04") and IP
// as "109.1" — parseFloat orders them all fine. null/missing -> null (sorts last).
function stxNum(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

const Stats = ({ league, onTeamClick }) => {
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [mode, setMode] = React.useState("B");
  const [selected, setSelected] = React.useState(STX_DEFAULTS.B.selected);
  const [sortKey, setSortKey] = React.useState(STX_DEFAULTS.B.sortKey);
  // Sort direction is NOT user-toggleable: each stat always sorts so its best value
  // is on top (high-is-better -> descending, low-is-better like ERA/K% -> ascending).

  React.useEffect(() => {
    let live = true;
    setData(null); setErr(null);
    window.fetchStatLeaders(league)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [league]);

  // Flip Batter <-> Pitcher: reset the chip set + sort to that mode's defaults.
  const setModeReset = (m) => {
    if (m === mode) return;
    const d = STX_DEFAULTS[m];
    setMode(m);
    setSelected(d.selected);
    setSortKey(d.sortKey);
  };

  // Add/remove a stat column (cap STX_MAX). If the current sort column is removed,
  // fall back to the first still-selected column.
  const toggleStat = (key) => {
    setSelected((prev) => {
      const sel = { ...prev };
      if (sel[key]) {
        delete sel[key];
      } else {
        if (Object.keys(sel).length >= STX_MAX) return prev;   // at the cap — no-op
        sel[key] = true;
      }
      if (!sel[sortKey]) {
        const next = STX_MASTER.filter((s) => s.group === mode && sel[s.key])[0];
        if (next) setSortKey(next.key);
      }
      return sel;
    });
  };

  // Clicking a header just picks the stat to sort by — direction is fixed per stat.
  const setSort = (key) => setSortKey(key);

  const built = React.useMemo(() => {
    if (!data) return null;
    const pool = (mode === "B" ? data.batters : data.pitchers) || [];
    const selectedDefs = STX_MASTER.filter((s) => s.group === mode && selected[s.key]);

    // Direction is fixed by the stat: best value on top. Lower-is-better -> ascending.
    const sortDir = (stxDef(mode, sortKey) || {}).better === "low" ? "asc" : "desc";

    // Sort the whole pool (nulls last), then cut to the visible rows.
    const sorted = [...pool].sort((x, y) => {
      const a = stxNum(x[sortKey]), b = stxNum(y[sortKey]);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      const r = a < b ? -1 : a > b ? 1 : 0;
      return sortDir === "asc" ? r : -r;
    });
    const rows = sorted.slice(0, STX_ROWS);

    const headerDefs = selectedDefs.map((s) => ({
      key: s.key, label: s.label,
      active: s.key === sortKey,
    }));
    const gridCols = ["44px", "minmax(150px,1.4fr)", "44px", "96px", "54px"]
      .concat(selectedDefs.map((s) => s.w + "px")).join(" ");

    const leader = sorted[0] || null;
    const sortLabel = (stxDef(mode, sortKey) || {}).label || "";

    return { selectedDefs, rows, headerDefs, gridCols, leader, sortLabel };
  }, [data, mode, selected, sortKey]);

  if (err) return <div className="hp-placeholder hp-placeholder--tall">Couldn't load stat leaders.</div>;
  if (!built) return <div className="hp-placeholder hp-placeholder--tall">Loading stat leaders…</div>;

  const { selectedDefs, rows, headerDefs, gridCols, leader, sortLabel } = built;
  const leagueName = (league || "NCAA").toUpperCase();
  const chips = STX_MASTER.filter((s) => s.group === mode);
  const atCap = Object.keys(selected).length >= STX_MAX;
  const heroColor = leader ? leader.color : null;
  const heroBg = leader
    ? `linear-gradient(108deg, ${stxRgba(heroColor, 0.85)} 0%, ${stxRgba(heroColor, 0.32)} 44%, var(--bbx-panel) 100%)`
    : "var(--bbx-panel)";
  const cell = (p, key) => (p[key] == null || p[key] === "" ? "—" : String(p[key]));

  return (
    <div className="bbx stx">
      {/* (1) Title / eyebrow */}
      <div className="stx-head">
        <div className="bbx-eyebrow stx-eyebrow">LEADERS · {leagueName} · 2026 SEASON</div>
        <div className="stx-head__row">
          <div className="stx-title">STAT LEADERS</div>
          <div className="stx-head__meta">{data.teams} TEAMS</div>
        </div>
      </div>

      {/* (2) Display Stats — Batter/Pitcher toggle then the chip selector */}
      <div className="stx-controls">
        <div className="stx-controls__top">
          <div className="segmented stx-modes" role="group" aria-label="Batter or pitcher">
            <button className={`segmented__btn stx-mode--bat ${mode === "B" ? "segmented__btn--active" : ""}`}
                    onClick={() => setModeReset("B")}>Batters</button>
            <button className={`segmented__btn stx-mode--pit ${mode === "P" ? "segmented__btn--active" : ""}`}
                    onClick={() => setModeReset("P")}>Pitchers</button>
          </div>
          <div className="stx-controls__label">Display Stats · click to add or remove columns</div>
          <div className="stx-controls__count">{selectedDefs.length}/{STX_MAX} SELECTED</div>
        </div>
        <div className="stx-chips">
          {chips.map((s) => {
            const on = !!selected[s.key];
            const disabled = !on && atCap;
            return (
              <button
                key={s.key}
                className={`stx-chip stx-chip--${s.group === "B" ? "bat" : "pit"} ${on ? "is-on" : ""} ${disabled ? "is-disabled" : ""}`}
                onClick={() => !disabled && toggleStat(s.key)}
                disabled={disabled}
              >{s.label}</button>
            );
          })}
        </div>
      </div>

      {/* (3) Leader hero — follows the sorted stat */}
      <div className="stx-hero" style={{ background: heroBg }}>
        {leader ? (
          <React.Fragment>
            <div className="stx-hero__id">
              <div className="stx-hero__eyebrow">★ {sortLabel} LEADER · {leader.team}</div>
              <div className="stx-hero__name">{leader.name}</div>
              <div className="stx-hero__meta">{[leader.pos, leader.team].filter(Boolean).join(" · ")}</div>
            </div>
            <div className="stx-hero__boxes">
              {STX_HERO[mode].map((k) => {
                const m = stxDef(mode, k);
                return (
                  <div className="stx-hero__box" key={k}>
                    <div className="stx-hero__box-label">{m.label}</div>
                    <div className="stx-hero__box-val">{cell(leader, k)}</div>
                  </div>
                );
              })}
            </div>
          </React.Fragment>
        ) : <div className="stx-hero__meta">No qualified players.</div>}
      </div>

      {/* (4) Table */}
      <div className="stx-table">
        <div className="stx-trow stx-trow--head" style={{ gridTemplateColumns: gridCols }}>
          <div>Rank</div>
          <div>Player</div>
          <div className="stx-num">No.</div>
          <div>Team</div>
          <div>Pos</div>
          {headerDefs.map((hd) => (
            <div key={hd.key} className={`stx-th ${hd.active ? "is-active" : ""}`}
                 onClick={() => setSort(hd.key)}>{hd.label}</div>
          ))}
        </div>
        {rows.map((p, i) => (
          <div className="stx-trow" key={(p.seo || "") + p.name + i} style={{ gridTemplateColumns: gridCols }}>
            <div className={`stx-rank ${i === 0 ? "is-top" : ""}`}>{String(i + 1).padStart(2, "0")}</div>
            <div className="stx-name">{p.name}</div>
            <div className="stx-num">{p.num || "—"}</div>
            <div className="stx-team" onClick={() => onTeamClick && onTeamClick(p.seo)} title={p.team}>
              <Monogram team={{ logo: p.logo, name: p.team, mark: p.abbr, color: p.color }} size={22} />
              <span className="stx-team__abbr">{p.abbr}</span>
            </div>
            <div className="stx-pos">{p.pos || "—"}</div>
            {selectedDefs.map((s) => (
              <div key={s.key} className={`stx-cell ${s.key === sortKey ? "is-active" : ""} ${p[s.key] == null ? "is-na" : ""}`}>
                {cell(p, s.key)}
              </div>
            ))}
          </div>
        ))}
        <div className="stx-foot">CLICK A COLUMN HEADER TO SORT BY IT · ADD COLUMNS ABOVE</div>
      </div>
    </div>
  );
};
