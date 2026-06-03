// Site homepage — season-aware "front page" (design B · "Scoreboard").
// Renders inside the existing app shell (Topbar + .container), so there's no
// SiteHeader here. Wired to real window.TEAMS / window.SCHEDULES; postseason-only
// decoration with no real source yet (national seeds, host sites, conference stat
// leaders) is shown as labeled placeholders to wire up later.

/* ---------- shared adapters (also used by the team Home tab) ---------- */

// SEC teams sorted by conference win pct (matches the Standings default order).
function hpSecTeams() {
  const arr = [...(window.TEAMS || [])];
  arr.sort((a, b) => {
    const ap = a.confW / Math.max(a.confW + a.confL, 1);
    const bp = b.confW / Math.max(b.confW + b.confL, 1);
    return bp - ap || b.confW - a.confW;
  });
  return arr;
}
function hpPct(t) { return t.confW / Math.max(t.confW + t.confL, 1); }
function hpFmtPct(p) { return p.toFixed(3).replace(/^0/, ""); }
// "W6" / "L2" / "—"  ->  { t:'W', n:6 } | null
function hpStreak(s) {
  if (!s || s === "—") return null;
  return { t: s[0], n: parseInt(s.slice(1), 10) || "" };
}
function hpTeamColor(id) {
  const t = (window.TEAM_BY_ID || {})[id];
  return (t && t.color) || "var(--faint)";
}
function hpFmtDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString();
}

// 'regular' | 'postseason' — derived from the schedules. Postseason once any
// upcoming game is flagged non-regular, or once the season is fully played out.
// Coarse regular/postseason flag, from the server-resolved season phase
// (window.SEASON_PHASE, set by bootstrap.js). Used by the homepage and the team
// "This Week" header.
function hpPhase() {
  const p = window.SEASON_PHASE && window.SEASON_PHASE.phase;
  return p && p !== "regular" ? "postseason" : "regular";
}

// Marquee: each SEC team's next home game (dedupes SEC-vs-SEC under the host),
// ranked so the best matchups float to the top.
function hpMarquee(limit) {
  const sch = window.SCHEDULES || {};
  const byId = window.TEAM_BY_ID || {};
  const cards = [];
  for (const teamId in sch) {
    const host = byId[teamId];
    if (!host) continue;
    const next = (sch[teamId] || []).find((g) => !g.result && g.home);
    if (!next) continue;
    cards.push({ host, opp: next.opp, date: next.date, time: next.time, phase: next.phase, gid: next.id });
  }
  cards.sort((a, b) => {
    const ar = Math.min(a.host.rank || 99, (a.opp && a.opp.rank) || 99);
    const br = Math.min(b.host.rank || 99, (b.opp && b.opp.rank) || 99);
    return ar - br;
  });
  return limit ? cards.slice(0, limit) : cards;
}

/* ---------- shared presentational atoms ---------- */

// Team crest — the real logo (Monogram falls back to a colored initials chip
// when a school has no logo, or its image fails to load).
function HPLogo({ team, size = 22 }) {
  return team ? <Monogram team={team} size={size} /> : null;
}

// Eyebrow with a leading rule, matching the design's SectionLabel.
function HPLabel({ children, color }) {
  return (
    <div className="hp-label" style={color ? { color } : null}>
      <span className="hp-label__rule" />
      <span className="hp-eyebrow" style={color ? { color } : null}>{children}</span>
    </div>
  );
}

function HPStreak({ streak }) {
  const s = hpStreak(streak);
  if (!s) return null;
  return <span className={"chip " + (s.t === "W" ? "chip-w" : "chip-l")}>{s.t}{s.n}</span>;
}

// Compact top-N standings table (reused on the homepage).
function HPStandings({ n = 10, onTeam }) {
  const rows = hpSecTeams().slice(0, n);
  return (
    <div className="hp-standings">
      <div className="hp-standings__head">
        {["", "Team", "Conf", "Pct", "Strk"].map((h, i) => (
          <span key={i} className="hp-eyebrow" style={{ textAlign: i >= 2 ? "right" : "left" }}>{h}</span>
        ))}
      </div>
      {rows.map((t, i) => (
        <button key={t.id} className="bare-btn hp-standings__row" onClick={() => onTeam && onTeam(t.id)}>
          <span className="mono hp-faint">{String(i + 1).padStart(2, "0")}</span>
          <span className="hp-standings__team">
            <HPLogo team={t} size={24} />
            <span className="hp-standings__name">{t.name}</span>
            {t.rank && <span className="chip-rank">#{t.rank}</span>}
          </span>
          <span className="mono hp-r">{t.confW}&ndash;{t.confL}</span>
          <span className="mono hp-r hp-ink2">{hpFmtPct(hpPct(t))}</span>
          <span className="hp-r"><HPStreak streak={t.streak} /></span>
        </button>
      ))}
    </div>
  );
}

// One matchup card in the hero grid.
function HPMatchCard({ card, post, onTeam }) {
  const { host, opp } = card;
  const oppId = opp && opp.id;
  const oppKnown = oppId && (window.TEAM_BY_ID || {})[oppId];
  const Row = ({ team, id, name, rank, dim }) => (
    <button className="bare-btn hp-card__row" disabled={!id} onClick={() => id && onTeam && onTeam(id)}>
      <HPLogo team={team} size={20} />
      <span className={"hp-card__name" + (dim ? " hp-ink2" : "")}>{name}</span>
      {rank && <span className="chip-rank">#{rank}</span>}
    </button>
  );
  return (
    <div className={"hp-card" + (post ? " hp-card--post" : "")}>
      <div className="hp-card__top">
        <span className="hp-eyebrow">{post ? "Super Regional" : (opp && opp.conf ? "SEC Series" : "Home")}</span>
        <span className="mono hp-faint">{card.date}{card.time ? " · " + card.time : ""}</span>
      </div>
      <Row team={host} id={host.id} name={host.name} rank={host.rank} />
      <Row
        team={opp}
        id={oppKnown ? oppId : null}
        name={opp ? opp.name : "TBD"}
        rank={opp && opp.rank}
        dim
      />
    </div>
  );
}

// One super-regional matchup card for "The Field" — two teams + official national
// seeds (from the bracket). A TBD slot renders as a faint placeholder.
function HPSuperCard({ sr, onTeam }) {
  const Row = ({ t, dim }) => {
    const id = t && t.seo;
    const known = id && (window.TEAM_BY_ID || {})[id];
    const teamObj = t ? { id, logo: t.logo, name: t.name, mark: (t.name || "").slice(0, 4).toUpperCase() } : null;
    return (
      <button className="bare-btn hp-card__row" disabled={!known} onClick={() => known && onTeam && onTeam(id)}>
        <HPLogo team={teamObj} size={20} />
        <span className={"hp-card__name" + (dim ? " hp-ink2" : "")}>{t ? t.name : "TBD"}</span>
        {t && t.seed != null && <span className="chip-rank">#{t.seed}</span>}
      </button>
    );
  };
  return (
    <div className="hp-card hp-card--post">
      <div className="hp-card__top"><span className="hp-eyebrow">Super Regional</span></div>
      <Row t={sr.top} />
      <Row t={sr.bottom} dim />
    </div>
  );
}

/* ---------- composed homepage ---------- */

const Home = ({ onTeam, onNav }) => {
  const sp = window.SEASON_PHASE || { phase: "regular", label: "Regular Season" };
  const post = sp.phase !== "regular";
  const eyebrow = sp.phase === "sec_tournament" ? "2026 SEC Tournament"
    : post ? "2026 NCAA Tournament" : "2026 SEC Season";
  const marquee = hpMarquee(8);
  const supers = window.SUPER_REGIONALS || [];
  const showSupers = post && supers.length > 0;
  return (
    <div className="hp">
      {/* masthead */}
      <div className="hp-masthead">
        <div>
          <HPLabel>{eyebrow}</HPLabel>
          <h1 className="hp-title">{post ? sp.label : "This Week in the SEC"}</h1>
        </div>
        <div className="hp-masthead__meta mono">
          <div>{post ? "Win or go home" : (window.TEAMS ? window.TEAMS.length + " teams" : "")}</div>
          <div className="hp-faint">Updated {hpFmtDate(window.SEASON_UPDATED)}</div>
        </div>
      </div>

      {/* hero: marquee grid */}
      <section className="hp-hero">
        <HPLabel color="var(--gold)">{post ? "The Field" : "Around the Conference"}</HPLabel>
        {showSupers ? (
          <div className="hp-grid">
            {supers.map((sr) => <HPSuperCard key={sr.id} sr={sr} onTeam={onTeam} />)}
          </div>
        ) : marquee.length ? (
          <div className="hp-grid">
            {marquee.map((c) => <HPMatchCard key={c.gid} card={c} post={post} onTeam={onTeam} />)}
          </div>
        ) : (
          <div className="hp-placeholder">No upcoming games on the board.</div>
        )}
      </section>

      {/* lower split: standings + leaders */}
      <section className="hp-split">
        <div>
          <div className="hp-split__head">
            <HPLabel>{post ? "Final SEC Standings" : "SEC Standings"}</HPLabel>
            <button className="bare-btn hp-link" onClick={() => onNav && onNav("standings")}>Full table &rarr;</button>
          </div>
          <HPStandings n={10} onTeam={onTeam} />
        </div>
        <div className="hp-split__rule" />
        <div>
          <HPLabel>Conference Leaders</HPLabel>
          <div className="hp-placeholder hp-placeholder--tall">Conference stat leaders are coming soon.</div>
        </div>
      </section>
    </div>
  );
};

window.Home = Home;
