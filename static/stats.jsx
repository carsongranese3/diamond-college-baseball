// Stats view — league-wide Stat Leaders.
//
// A sortable player leaderboard with a Batter/Pitcher toggle AND a Basic/Advanced
// toggle: pick a view, choose which stat columns to show (chips, max 10), sort by
// any column, and the leader hero up top follows whatever you sort by. Data comes
// from /api/stat-leaders (the full counting line for every qualified player).
//
// The column sets + advanced-stat math are SHARED with the team page (team.jsx
// loads first): BATTING_ALL_CHIPS / BATTING_ADV_CHIPS / PITCHING_ALL_CHIPS /
// PITCHING_ADV_CHIPS give key+label, advBatting()/advPitching() derive the advanced
// metrics. Here we only add each stat's fixed sort direction + a column width.

// Stats where a LOWER value is better (so the leaderboard sorts ascending).
const STX_LOW_B = new Set(["k", "ks", "kl", "cs", "po", "kpct", "outpct", "abhr", "abrbi"]);
const STX_LOW_P = new Set([
  "l", "h", "r", "er", "ur", "bb", "ibb", "hbp", "wp", "bk", "hr", "1b", "2b", "3b", "xbh", "tb", "irs",
  "ld", "balls", "era", "ra9", "whip", "bb9", "hr9", "h9", "hbp9", "wp9", "fip",
  "dice", "bbpct", "ibbpct", "hbppct", "oppavg", "oppslg", "oppobp", "oppops", "oppiso",
  "babip", "hpct", "1bpct", "2bpct", "3bpct", "hrpct", "xbhpct",
  "ldpct", "hrfb", "ballpct", "irspct", "pip", "pbf",
]);
function stxCols(list, group) {
  const low = group === "B" ? STX_LOW_B : STX_LOW_P;
  return list.map((c) => ({
    key: c.k, label: c.label, group,
    better: low.has(c.k) ? "low" : "high",
    w: Math.max(48, 28 + c.label.length * 8),
  }));
}
// Column defs for each "<mode>-<level>" view, built from the shared team-page lists.
const STX_SETS = {
  "B-basic": stxCols(BATTING_ALL_CHIPS, "B"),
  "B-advanced": stxCols(BATTING_ADV_CHIPS, "B"),
  "P-basic": stxCols(PITCHING_ALL_CHIPS, "P"),
  "P-advanced": stxCols(PITCHING_ADV_CHIPS, "P"),
};
const stxDef = (cols, key) => cols.find((s) => s.key === key);
const _selOf = (arr) => Object.fromEntries(arr.map((k) => [k, true]));

const STX_MAX = 10;        // most stat columns selectable at once
const STX_ROWS = 25;       // players shown in the table (rank 1–25)

// Starting columns + sort + hero stat boxes for each "<mode>-<level>" view.
const STX_DEFAULTS = {
  // sel mirrors the team page's DEFAULT_COLS_BY_VIEW so both open on the same columns.
  "B-basic": { sel: ["g", "ab", "pa", "r", "h", "hr", "rbi", "bb", "k", "sb"], sort: "hr", hero: ["h", "hr", "rbi", "sb"] },
  "B-advanced": { sel: ["avg", "obp", "slg", "ops", "iso", "babip", "bbpct", "kpct", "seca", "rc"], sort: "avg", hero: ["avg", "obp", "slg", "ops"] },
  "P-basic": { sel: ["g", "gs", "w", "l", "sv", "ip", "h", "er", "bb", "k"], sort: "k", hero: ["w", "k", "sv", "ip"] },
  "P-advanced": { sel: ["era", "ra9", "whip", "k9", "bb9", "kbb", "fip", "kpct", "bbpct", "babip"], sort: "era", hero: ["era", "whip", "k9", "fip"] },
};

// "#FF8200" -> "rgba(255,130,0,a)" for the leader-hero gradient.
function stxRgba(hex, a) {
  const h = (hex || "#444").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
// Numeric value for sorting. Rate stats arrive as strings (".327", "2.04", "34.2%")
// and IP as "109.1" — parseFloat orders them all fine. null/missing -> null (last).
function stxNum(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

const Stats = ({ league, onTeamClick }) => {
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [mode, setMode] = React.useState("B");
  const [level, setLevel] = React.useState("basic");
  const [selected, setSelected] = React.useState(_selOf(STX_DEFAULTS["B-basic"].sel));
  const [sortKey, setSortKey] = React.useState(STX_DEFAULTS["B-basic"].sort);
  // Sort direction is NOT user-toggleable: each stat always sorts so its best value
  // is on top (high-is-better -> descending, low-is-better like ERA/SO% -> ascending).

  React.useEffect(() => {
    let live = true;
    setData(null); setErr(null);
    window.fetchStatLeaders(league)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [league]);

  const viewKey = `${mode}-${level}`;
  const cols = STX_SETS[viewKey];

  // Switch view (Batter/Pitcher or Basic/Advanced): reset chips + sort to its defaults.
  const goView = (m, lv) => {
    if (m === mode && lv === level) return;
    const d = STX_DEFAULTS[`${m}-${lv}`];
    setMode(m); setLevel(lv);
    setSelected(_selOf(d.sel)); setSortKey(d.sort);
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
        const next = cols.filter((s) => sel[s.key])[0];
        if (next) setSortKey(next.key);
      }
      return sel;
    });
  };

  // Clicking a header just picks the stat to sort by — direction is fixed per stat.
  const setSort = (key) => setSortKey(key);

  const built = React.useMemo(() => {
    if (!data) return null;
    let pool = (mode === "B" ? data.batters : data.pitchers) || [];
    if (level === "advanced") {                  // derive the advanced metrics per player
      const fn = mode === "B" ? advBatting : advPitching;
      pool = pool.map((p) => ({ ...p, ...fn(p) }));
    }
    const selectedDefs = cols.filter((s) => selected[s.key]);

    // Direction is fixed by the stat: best value on top. Lower-is-better -> ascending.
    const sortDir = (stxDef(cols, sortKey) || {}).better === "low" ? "asc" : "desc";

    const sorted = [...pool].sort((x, y) => {
      const a = stxNum(x[sortKey]), b = stxNum(y[sortKey]);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      const r = a < b ? -1 : a > b ? 1 : 0;
      return sortDir === "asc" ? r : -r;
    });
    const rows = sorted.slice(0, STX_ROWS);

    const headerDefs = selectedDefs.map((s) => ({ key: s.key, label: s.label, active: s.key === sortKey }));
    // Fixed left block (rank, number, name, team, pos) — all fixed widths so team
    // and pos never shift as stat columns are added/removed.
    const gridCols = ["46px", "44px", "180px", "92px", "50px"]
      .concat(selectedDefs.map((s) => s.w + "px")).join(" ");

    const leader = sorted[0] || null;
    const sortLabel = (stxDef(cols, sortKey) || {}).label || "";
    return { selectedDefs, rows, headerDefs, gridCols, leader, sortLabel, hero: STX_DEFAULTS[viewKey].hero };
  }, [data, mode, level, selected, sortKey]);

  if (err) return <div className="hp-placeholder hp-placeholder--tall">Couldn't load stat leaders.</div>;
  if (!built) return <div className="hp-placeholder hp-placeholder--tall">Loading stat leaders…</div>;

  const { selectedDefs, rows, headerDefs, gridCols, leader, sortLabel, hero } = built;
  const leagueName = (league || "NCAA").toUpperCase();
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

      {/* (2) Display Stats — Batter/Pitcher + Basic/Advanced toggles, then the chips */}
      <div className="stx-controls">
        <div className="stx-controls__top">
          <div className="segmented stx-modes" role="group" aria-label="Batter or pitcher">
            <button className={`segmented__btn stx-mode--bat ${mode === "B" ? "segmented__btn--active" : ""}`}
                    onClick={() => goView("B", level)}>Batters</button>
            <button className={`segmented__btn stx-mode--pit ${mode === "P" ? "segmented__btn--active" : ""}`}
                    onClick={() => goView("P", level)}>Pitchers</button>
          </div>
          <div className={`segmented stx-levels stx-levels--${mode === "B" ? "bat" : "pit"}`} role="group" aria-label="Basic or advanced">
            <button className={`segmented__btn ${level === "basic" ? "segmented__btn--active" : ""}`}
                    onClick={() => goView(mode, "basic")}>Basic</button>
            <button className={`segmented__btn ${level === "advanced" ? "segmented__btn--active" : ""}`}
                    onClick={() => goView(mode, "advanced")}>Advanced</button>
          </div>
          <div className="stx-controls__count">{selectedDefs.length}/{STX_MAX} SELECTED</div>
        </div>
        <div className="stx-chips">
          {cols.map((s) => {
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
              {hero.map((k) => {
                const m = stxDef(cols, k);
                return (
                  <div className="stx-hero__box" key={k}>
                    <div className="stx-hero__box-label">{m ? m.label : k}</div>
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
          <div className="stx-num">No.</div>
          <div>Player</div>
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
            <div className="stx-num">{p.num || "—"}</div>
            <div className="stx-name">{p.name}</div>
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
