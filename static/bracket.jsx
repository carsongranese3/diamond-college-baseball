// Bracket view — SEC Tournament (from local games) and the NCAA tournament
// (from the ncaa.com bracket API), rendered as a left/right bracket of regionals
// feeding super regionals.

const _bracketCache = {};
function fetchBracket(which) {
  if (!_bracketCache[which]) {
    _bracketCache[which] = fetch("/api/bracket/" + which)
      .then((r) => { if (!r.ok) throw new Error("bracket " + r.status); return r.json(); });
  }
  return _bracketCache[which];
}

// Any conference's tournament bracket, keyed + cached per league (label or seo).
const _confBracketCache = {};
function fetchConfBracket(league) {
  const key = league || window.CURRENT_LEAGUE || "sec";
  if (!_confBracketCache[key]) {
    _confBracketCache[key] = fetch("/api/bracket/conf/" + encodeURIComponent(key))
      .then((r) => { if (!r.ok) throw new Error("conf bracket " + r.status); return r.json(); });
  }
  return _confBracketCache[key];
}
window.fetchConfBracket = fetchConfBracket;

// One team row inside a game card. `t` is {seed, name, seo, score, logo} or null.
const BTeam = ({ t, win, lose }) => {
  if (!t || !t.name) {
    return (
      <div className="bteam bteam--tbd">
        <span className="bteam__name muted">TBD</span>
      </div>
    );
  }
  return (
    <div className={`bteam ${win ? "bteam--win" : ""} ${lose ? "bteam--lose" : ""}`}>
      {t.seed != null && <span className="bteam__seed">{t.seed}</span>}
      {t.logo
        ? <img className="bteam__logo" src={t.logo} alt=""
               onError={(e) => { e.target.style.visibility = "hidden"; }} />
        : <span className="bteam__logo" />}
      <span className="bteam__name">{t.name}</span>
      <span className="bteam__score mono">{t.score != null ? t.score : ""}</span>
    </div>
  );
};

// "06/05/2026" -> "2026-06-05" (the bracket feed's date format -> iso).
function bIso(d) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || "");
  return m ? `${m[3]}-${m[1]}-${m[2]}` : (d || "");
}
// Open a bracket game's box score. Prefers an SEC team as host so the richer saved
// data is used; /api/game falls back to the NCAA API when no game is saved.
function openBracketGame(onGameClick, g) {
  if (!onGameClick || !g || !g.id || !g.top || !g.bottom) return;
  const byId = window.TEAM_BY_ID || {};
  let host = g.top, other = g.bottom;
  if (!byId[g.top.seo] && byId[g.bottom.seo]) { host = g.bottom; other = g.top; }
  onGameClick({
    id: g.id, iso: bIso(g.date),
    score: { us: host.score, them: other.score },
    opp: { id: other.seo, name: other.name },
  }, host.seo);
}

const BGame = ({ g, onOpen, struck }) => {
  const topWin = g.top && (g.top.winner || (g.winner && g.top.seo === g.winner));
  const botWin = g.bottom && (g.bottom.winner || (g.winner && g.bottom.seo === g.winner));
  const decided = topWin || botWin;
  const topLose = decided && !topWin && g.top && g.top.name;
  const botLose = decided && !botWin && g.bottom && g.bottom.name;
  const live = g.state === "I" || g.state === "H";
  const clickable = !!onOpen && !struck;
  return (
    <div
      className={`bgame ${clickable ? "bgame--click" : ""} ${live ? "bgame--live" : ""} ${struck ? "bgame--struck" : ""}`}
      onClick={clickable ? () => onOpen(g) : undefined}
    >
      <BTeam t={g.top} win={topWin} lose={topLose} />
      <BTeam t={g.bottom} win={botWin} lose={botLose} />
      {live && <span className="bgame__tag bgame__tag--live">LIVE</span>}
      {g.ifNecessary && !live && <span className="bgame__tag">{struck ? "not needed" : "if nec."}</span>}
    </div>
  );
};

// A bye shown as a one-sided "game" — a single team box, no score.
const BByeCell = ({ team }) => (
  <div className="bgame bbye">
    <div className="bteam">
      {team.seed != null && <span className="bteam__seed">{team.seed}</span>}
      {team.logo
        ? <img className="bteam__logo" src={team.logo} alt=""
               onError={(e) => { e.target.style.visibility = "hidden"; }} />
        : <span className="bteam__logo" />}
      <span className="bteam__name">{team.name}</span>
    </div>
  </div>
);

// ── SEC: a true bracket tree of cells (games + bye boxes) ─────────────────────
const SecBracket = ({ data, onGameClick }) => {
  const roundsRef = React.useRef(null);
  const cellRefs = React.useRef({});
  const [paths, setPaths] = React.useState([]);
  const [dims, setDims] = React.useState({ w: 0, h: 0 });

  const openGame = (g) => {
    if (!onGameClick || !g.top || !g.bottom) return;
    onGameClick({
      id: g.id, iso: g.iso,
      score: { us: g.top.score, them: g.bottom.score },
      opp: { id: g.bottom.seo, name: g.bottom.name },
    }, g.top.seo);
  };

  const measure = React.useCallback(() => {
    const wrap = roundsRef.current;
    if (!wrap) return;
    const base = wrap.getBoundingClientRect();
    const rectOf = (id) => {
      const el = cellRefs.current[id];
      return el ? el.getBoundingClientRect() : null;
    };
    const segs = [];
    for (const r of data.rounds) {
      for (const c of r.cells) {
        if (c.type !== "game" || !c.children) continue;
        const gr = rectOf(c.id);
        if (!gr) continue;
        const gx = gr.left - base.left, top = gr.top - base.top, h = gr.height;
        const rowY = { top: top + h * 0.27, bottom: top + h * 0.73 };
        for (const key of ["top", "bottom"]) {
          const childId = c.children[key];
          if (childId == null) continue;
          const cr = rectOf(childId);
          if (!cr) continue;
          const fx = cr.right - base.left, fy = cr.top - base.top + cr.height / 2;
          const midX = (fx + gx) / 2;
          segs.push(`M ${fx} ${fy} H ${midX} V ${rowY[key]} H ${gx}`);
        }
      }
    }
    setDims({ w: wrap.scrollWidth, h: wrap.scrollHeight });
    setPaths(segs);
  }, [data]);

  React.useLayoutEffect(() => {
    measure();
    const t = setTimeout(measure, 300);
    const ro = new ResizeObserver(measure);
    if (roundsRef.current) ro.observe(roundsRef.current);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t); ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return (
    <div className="bracket-sec">
      <div className="brounds" ref={roundsRef}>
        <svg className="bconnect" width={dims.w} height={dims.h}>
          {paths.map((d, i) => <path key={i} d={d} />)}
        </svg>
        {data.rounds.map((r) => (
          <div className="bround" key={r.number}>
            <div className="bround__head">{r.title}</div>
            <div className="bround__games">
              {r.cells.map((c) => (
                <div className="bslot" key={c.id}
                     style={{ top: (3 + c.y * 94) + "%" }}
                     ref={(el) => { if (el) cellRefs.current[c.id] = el; }}>
                  {c.type === "game"
                    ? <BGame g={c} onOpen={c.id ? () => openGame(c) : undefined} />
                    : <BByeCell team={c.team} />}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── NCAA: regionals as 4-team pods; click one for its full bracket ────────────
// Double elimination: a team is out after 2 losses.
function _eliminated(group) {
  const losses = {};
  for (const g of group.games || []) {
    if (g.state !== "F") continue;
    for (const side of [g.top, g.bottom]) {
      if (side && side.seo && !side.winner) losses[side.seo] = (losses[side.seo] || 0) + 1;
    }
  }
  return losses;
}

const RegionalPod = ({ group, onClick }) => {
  const losses = _eliminated(group);
  const out = (t) => (losses[t.seo] || 0) >= 2;
  const alive = group.teams.filter((t) => !out(t));
  const champion = alive.length === 1 ? alive[0].seo : null;
  return (
    <div className="bpod bpod--click" onClick={onClick}>
      <div className="bpod__head">
        {group.seed != null && <span className="bpod__seed">#{group.seed}</span>}
        <span className="bpod__name">
          <span className="bpod__school">{group.city || group.label}</span>
          <span className="bpod__regional">Regional</span>
        </span>
        <span className="bpod__expand">View<br />bracket ›</span>
      </div>
      <div className="bpod__teams">
        {group.teams.map((t) => (
          <div key={t.seo}
               className={`bpod__team ${t.seo === champion ? "bpod__team--win" : ""} ${out(t) ? "bpod__team--out" : ""}`}>
            {t.rseed != null && <span className="bpod__rseed">{t.rseed}</span>}
            {t.logo
              ? <img className="bteam__logo" src={t.logo} alt=""
                     onError={(e) => { e.target.style.visibility = "hidden"; }} />
              : <span className="bteam__logo" />}
            <span className="bpod__tname">{t.name}</span>
            {t.seed != null && <span className="bpod__natseed">#{t.seed}</span>}
          </div>
        ))}
      </div>
    </div>
  );
};

// A 4-team regional is a fixed 7-game double-elimination bracket. Game order from
// the API is G1, G2, Winners Final, Elimination, Losers Final, Regional Final,
// If-Necessary. [col, y%] places each; feeders wire the standard double-elim tree
// (win = solid, loser-drop = dashed).
const DE_LAYOUT = [
  { col: 0, y: 14 }, { col: 0, y: 33 }, { col: 1, y: 23 },
  { col: 0, y: 72 }, { col: 1, y: 64 }, { col: 2, y: 43 }, { col: 3, y: 43 },
];
const DE_LABELS = ["Game 1", "Game 2", "Winners Final", "Elimination",
                   "Losers Final", "Regional Final", "If Necessary"];
const DE_FEEDERS = {
  2: [[0, "win"], [1, "win"]],
  3: [[0, "lose"], [1, "lose"]],
  4: [[3, "win"], [2, "lose"]],
  5: [[2, "win"], [4, "win"]],
  6: [[5, "win"]],
};

// A CWS half: a 4-team double-elim pod of super-regional winners (slots may be
// TBD until the supers finish). Same look as a regional pod, clickable for its
// full bracket.
const CwsPod = ({ group, onClick }) => {
  const losses = _eliminated(group);
  const out = (t) => (losses[t.seo] || 0) >= 2;
  const teams = group.teams || [];
  const slots = [0, 1, 2, 3].map((i) => teams[i] || null);
  return (
    <div className="bpod bpod--click bpod--cws" onClick={onClick}>
      <div className="bpod__head">
        <span className="bpod__name">{group.label}</span>
        <span className="bpod__expand">View<br />bracket ›</span>
      </div>
      <div className="bpod__teams">
        {slots.map((t, i) => (
          <div key={t ? t.seo : i}
               className={`bpod__team ${t && group.winner === t.seo ? "bpod__team--win" : ""} ${t && out(t) ? "bpod__team--out" : ""}`}>
            {t && t.logo
              ? <img className="bteam__logo" src={t.logo} alt=""
                     onError={(e) => { e.target.style.visibility = "hidden"; }} />
              : <span className="bteam__logo" />}
            <span className="bpod__tname">{t ? t.name : "TBD"}</span>
            {t && t.seed != null && <span className="bpod__natseed">#{t.seed}</span>}
          </div>
        ))}
      </div>
    </div>
  );
};

const RegionalBracket = ({ group, onGameClick }) => {
  const wrapRef = React.useRef(null);
  const cardRefs = React.useRef({});
  const [paths, setPaths] = React.useState([]);
  const [dims, setDims] = React.useState({ w: 0, h: 0 });
  const games = group.games || [];
  const decided = !!group.winner;   // a decided regional/pod -> its if-nec game isn't needed

  const measure = React.useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const base = wrap.getBoundingClientRect();
    const segs = [];
    for (const [tStr, feeders] of Object.entries(DE_FEEDERS)) {
      const tEl = cardRefs.current[+tStr];
      if (!tEl) continue;
      const tr = tEl.getBoundingClientRect();
      const tx = tr.left - base.left, ty = tr.top - base.top + tr.height / 2;
      for (const [fi, kind] of feeders) {
        const fEl = cardRefs.current[fi];
        if (!fEl) continue;
        const fr = fEl.getBoundingClientRect();
        const fx = fr.right - base.left, fy = fr.top - base.top + fr.height / 2;
        const midX = (fx + tx) / 2;
        segs.push({ d: `M ${fx} ${fy} H ${midX} V ${ty} H ${tx}`, kind });
      }
    }
    setDims({ w: wrap.scrollWidth, h: wrap.scrollHeight });
    setPaths(segs);
  }, [group]);

  React.useLayoutEffect(() => {
    measure();
    const t = setTimeout(measure, 200);
    window.addEventListener("resize", measure);
    return () => { clearTimeout(t); window.removeEventListener("resize", measure); };
  }, [measure]);

  return (
    <div className="rbracket" ref={wrapRef}>
      <svg className="bconnect" width={dims.w} height={dims.h}>
        {paths.map((p, i) =>
          <path key={i} d={p.d} className={p.kind === "lose" ? "rconn--lose" : ""} />)}
      </svg>
      {games.map((g, i) => {
        const pos = DE_LAYOUT[i];
        if (!pos) return null;
        return (
          <div key={g.id || i} className="rcard"
               style={{ left: pos.col * 25 + "%", top: pos.y + "%" }}
               ref={(el) => { if (el) cardRefs.current[i] = el; }}>
            <div className="rcard__label">{DE_LABELS[i]}</div>
            <BGame g={g} struck={g.ifNecessary && g.state === "P" && decided}
                   onOpen={onGameClick ? (gm) => openBracketGame(onGameClick, gm) : undefined} />
          </div>
        );
      })}
    </div>
  );
};

const RegionalModal = ({ group, onClose, onGameClick }) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="rmodal" onClick={onClose}>
      <div className="rmodal__box" onClick={(e) => e.stopPropagation()}>
        <div className="rmodal__head">
          <div className="rmodal__title">
            {group.seed != null && <span className="bpod__seed">#{group.seed}</span>}
            <span>{group.city || group.label} Regional</span>
          </div>
          <button className="rmodal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <RegionalBracket group={group} onGameClick={onGameClick} />
      </div>
    </div>
  );
};

// Super-regional detail: the matchup + the best-of-3 games, game by game. Opened
// by clicking a super-regional box (mirrors the regional modal).
const SuperModal = ({ pairing, onClose, onGameClick, title, bestOf }) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Host city = the higher seed of the two advancing teams (bracket.py's
  // host_city), which can differ from the top feeder regional if a seed is upset.
  const host0 = (pairing.regionals && pairing.regionals[0]) || null;
  const host = pairing.host_city || (host0 && (host0.city || host0.label)) || "";
  const sup = pairing.super || {};
  const decided = !!((sup.top && sup.top.winner) || (sup.bottom && sup.bottom.winner));
  const games = (pairing.games || []).slice().sort((a, b) => (a.pos || 0) - (b.pos || 0));
  return (
    <div className="rmodal" onClick={onClose}>
      <div className="rmodal__box rmodal__box--super" onClick={(e) => e.stopPropagation()}>
        <div className="rmodal__head">
          <div className="rmodal__title"><span>{title || ((host ? host + " " : "") + "Super Regional")}</span></div>
          <button className="rmodal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="smodal">
          <BGame g={pairing.super} />
          <div className="smodal__bestof mono">{bestOf || "Best-of-3 · winner advances to the College World Series"}</div>
          {games.length ? (
            <div className="smodal__games">
              {games.map((g, i) => (
                <div key={g.id || i} className="smodal__game">
                  <span className="smodal__glabel">Game {i + 1}</span>
                  <BGame g={g} struck={g.ifNecessary && g.state === "P" && decided}
                         onOpen={onGameClick ? (gm) => openBracketGame(onGameClick, gm) : undefined} />
                </div>
              ))}
            </div>
          ) : (
            <div className="smodal__empty muted">Series hasn't started yet.</div>
          )}
        </div>
      </div>
    </div>
  );
};

// One super-regional unit: its two feeder regionals + the super game box, wired
// with connector lines. `side` is "left" (pods left, super right) or "right".
const SuperUnit = ({ pairing, side, onPod, onSuper }) => {
  const ref = React.useRef(null);
  const podRefs = React.useRef([]);
  const superRef = React.useRef(null);
  const [paths, setPaths] = React.useState([]);
  const [dims, setDims] = React.useState({ w: 0, h: 0 });

  const measure = React.useCallback(() => {
    const wrap = ref.current, sup = superRef.current;
    if (!wrap || !sup) return;
    const base = wrap.getBoundingClientRect();
    const sr = sup.getBoundingClientRect();
    const sy = sr.top - base.top + sr.height / 2;
    const sx = (side === "left" ? sr.left : sr.right) - base.left;
    const segs = [];
    for (const slot of podRefs.current) {
      if (!slot) continue;
      // Measure the actual pod box (.bpod), not its full-width wrapper — the pod
      // is capped narrower, so the wrapper's edge would leave a gap to the line.
      const pod = slot.querySelector(".bpod") || slot;
      const pr = pod.getBoundingClientRect();
      const py = pr.top - base.top + pr.height / 2;
      const px = (side === "left" ? pr.right : pr.left) - base.left;
      const midX = (px + sx) / 2;
      segs.push(`M ${px} ${py} H ${midX} V ${sy} H ${sx}`);
    }
    setDims({ w: wrap.scrollWidth, h: wrap.scrollHeight });
    setPaths(segs);
  }, [side, pairing]);

  React.useLayoutEffect(() => {
    measure();
    const t = setTimeout(measure, 250);
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t); ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const pods = (
    <div className="sunit__pods">
      {pairing.regionals.map((g, i) => (
        <div className="sunit__pod" key={g.id}
             ref={(el) => { podRefs.current[i] = el; }}>
          <RegionalPod group={g} onClick={() => onPod(g)} />
        </div>
      ))}
    </div>
  );
  const superClickable = !!(pairing.super && (pairing.super.top || pairing.super.bottom));
  // Name it by host city once the matchup is set (both teams known); until then
  // the host isn't decided, so leave the generic label.
  const superDecided = !!(pairing.super && pairing.super.top && pairing.super.bottom);
  const superLabel = (superDecided && pairing.host_city)
    ? `${pairing.host_city} Super Regional` : "Super Regional";
  const superBox = (
    <div className="sunit__super">
      <div className="sunit__super-label">{superLabel}</div>
      {/* ref on the box itself (not the labeled container) so connector lines
          target the box's true center, not the label-shifted container center. */}
      <div ref={superRef}>
        <BGame g={pairing.super}
               onOpen={superClickable && onSuper ? () => onSuper(pairing) : undefined} />
      </div>
    </div>
  );

  return (
    <div className={`sunit sunit--${side}`} ref={ref}>
      <svg className="bconnect" width={dims.w} height={dims.h}>
        {paths.map((d, i) => <path key={i} d={d} />)}
      </svg>
      {side === "left" ? <>{pods}{superBox}</> : <>{superBox}{pods}</>}
    </div>
  );
};

const NcaaBracket = ({ data, onGameClick }) => {
  const [sel, setSel] = React.useState(null);
  const [selSuper, setSelSuper] = React.useState(null);
  const [selFinals, setSelFinals] = React.useState(null);
  const tree = data.tree || { left: [], right: [] };
  const center = data.center;
  const finalsClickable = !!(center && center.finals && (center.finals.top || center.finals.bottom));
  return (
    <div className="bracket-ncaa">
      <div className="ncaa-tree">
        <div className="ncaa-col">
          {tree.left.map((p) => (
            <SuperUnit key={p.id} pairing={p} side="left" onPod={setSel} onSuper={setSelSuper} />
          ))}
        </div>
        {center && (
          <div className="ncaa-center">
            <div className="ncaa-center__label">College World Series</div>
            <div className="ncaa-center__finals">
              <div className="sunit__super-label">National Championship</div>
              <BGame g={center.finals}
                     onOpen={finalsClickable ? () => setSelFinals(center.finals) : undefined} />
            </div>
            <div className="ncaa-cws">
              {["left", "right"].map((s) => center.halves[s] && (
                <div className="ncaa-cws__half" key={s}>
                  <div className="sunit__super-label">Omaha Bracket</div>
                  <CwsPod group={center.halves[s]} onClick={() => setSel(center.halves[s])} />
                </div>
              ))}
            </div>
            <div className="ncaa-center__note muted">Best-of-3 · score = series wins</div>
          </div>
        )}
        <div className="ncaa-col">
          {tree.right.map((p) => (
            <SuperUnit key={p.id} pairing={p} side="right" onPod={setSel} onSuper={setSelSuper} />
          ))}
        </div>
      </div>
      {sel && <RegionalModal group={sel} onClose={() => setSel(null)} onGameClick={onGameClick} />}
      {selSuper && <SuperModal pairing={selSuper} onClose={() => setSelSuper(null)} onGameClick={onGameClick} />}
      {selFinals && (
        <SuperModal
          pairing={{ super: selFinals, games: selFinals.games }}
          title="National Championship"
          bestOf="Best-of-3 · winner is the national champion"
          onClose={() => setSelFinals(null)}
          onGameClick={onGameClick}
        />
      )}
    </div>
  );
};

// ── Bracket view (a tab per conference + NCAA) ───────────────────────────────
// Slug for a tab/URL: each conference by its lowercased-hyphenated label, plus the
// fixed "ncaa" tab. Conference tabs come straight from window.LEAGUES (data-driven),
// so adding a conference's data adds its tab automatically.
function _bracketTabs() {
  const leagues = window.LEAGUES || ["NCAA"];
  const slug = (s) => s.toLowerCase().replace(/\s+/g, "-");
  const confs = leagues.filter((l) => l !== "NCAA")
    .map((l) => ({ key: slug(l), label: l, league: l, ncaa: false }));
  return confs.concat([{ key: "ncaa", label: "NCAA", league: "ncaa", ncaa: true }]);
}

const Bracket = ({ onGameClick, initialTab, onTabChange }) => {
  const tabs = _bracketTabs();
  const fallback = (tabs[0] && tabs[0].key) || "ncaa";
  const [tab, setTabState] = React.useState(initialTab || fallback);
  const [data, setData] = React.useState({});
  const [error, setError] = React.useState(null);

  // Follow the URL (back/forward, deep-link); changing tabs updates the URL.
  React.useEffect(() => { setTabState(initialTab || fallback); }, [initialTab]);
  const setTab = (t) => { setTabState(t); if (onTabChange) onTabChange(t); };

  const meta = tabs.find((t) => t.key === tab) || { key: tab, label: tab, league: tab, ncaa: tab === "ncaa" };
  React.useEffect(() => {
    if (data[tab]) return;
    let live = true;
    setError(null);
    const load = meta.ncaa ? fetchBracket("ncaa") : fetchConfBracket(meta.league);
    load
      .then((d) => { if (live) setData((s) => ({ ...s, [tab]: d })); })
      .catch(() => { if (live) setError("Couldn't load the bracket."); });
    return () => { live = false; };
  }, [tab]);

  const cur = data[tab];
  const title = meta.ncaa ? "NCAA Tournament" : ((cur && cur.title) || (meta.label + " Tournament"));
  return (
    <div className="bracket">
      <header className="bracket__header">
        <Eyebrow>2026 Postseason</Eyebrow>
        <h1 className="display">{title}</h1>
        <div className="bracket__tabs">
          {tabs.map((t) => (
            <button key={t.key} className={`btab ${tab === t.key ? "btab--on" : ""}`}
                    onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </header>

      {error && <div className="bracket__msg">{error}</div>}
      {!error && !cur && <div className="bracket__msg muted">Loading bracket…</div>}
      {!error && cur && !meta.ncaa && <SecBracket data={cur} onGameClick={onGameClick} />}
      {!error && cur && meta.ncaa && <NcaaBracket data={cur} onGameClick={onGameClick} />}
    </div>
  );
};

window.Bracket = Bracket;
// Reused by the team Home page's "This Week" super-regional card.
window.SuperModal = SuperModal;
window.fetchBracket = fetchBracket;
window.findSuperPairing = function (data, teamId) {
  const tree = (data && data.tree) || { left: [], right: [] };
  for (const side of ["left", "right"]) {
    for (const p of tree[side] || []) {
      const s = p.super || {};
      if ((s.top && s.top.seo === teamId) || (s.bottom && s.bottom.seo === teamId)) return p;
    }
  }
  return null;
};
// The Omaha (College World Series) half-bracket containing a team — one of the two
// 4-team double-elim pods. Matched by the half's GAMES (the reliable pod signal),
// not its `teams` list, which can be mis-assigned while supers are unsettled.
window.findCwsHalf = function (data, teamId) {
  const halves = (data && data.center && data.center.halves) || {};
  for (const side of ["left", "right"]) {
    const h = halves[side];
    if (!h) continue;
    if ((h.games || []).some((g) =>
        (g.top && g.top.seo === teamId) || (g.bottom && g.bottom.seo === teamId)))
      return h;
  }
  return null;
};
