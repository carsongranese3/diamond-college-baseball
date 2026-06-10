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

// A weekend series = the first run of >=2 consecutive games vs the same opponent
// in a team's upcoming schedule (so midweek single games are skipped).
function _nextWeekendSeries(upcoming) {
  let run = [];
  for (const g of upcoming) {
    if (run.length && run[0].opp && g.opp && run[0].opp.id === g.opp.id) run.push(g);
    else { if (run.length >= 2) return run; run = [g]; }
  }
  return run.length >= 2 ? run : null;
}

function _isoAddDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Regular-season marquee: the highest-seeded SEC weekend series of the coming
// week. If no SEC-vs-SEC games fall that week, feature the 4 highest-ranked SEC
// teams' weekend matchups instead. Always weekend series, never midweek games.
function hpMarquee() {
  const sch = window.SCHEDULES || {};
  const byId = window.TEAM_BY_ID || {};
  const series = [];
  for (const seo in sch) {
    const host = byId[seo];
    if (!host) continue;
    const wk = _nextWeekendSeries((sch[seo] || []).filter((g) => !g.result));
    if (wk) series.push({ host, opp: wk[0].opp, home: wk[0].home, iso: wk[0].iso,
                          date: wk[0].date, time: wk[0].time, phase: wk[0].phase, gid: wk[0].id });
  }
  if (!series.length) return [];
  // "This week" = the soonest weekend (everything within ~4 days of the earliest).
  const weekStart = series.map((s) => s.iso).filter(Boolean).sort()[0];
  const weekEnd = _isoAddDays(weekStart, 4);
  const week = series.filter((s) => s.iso && s.iso >= weekStart && s.iso <= weekEnd);
  const card = (s) => ({ host: s.host, opp: s.opp, home: s.home, date: s.date, time: s.time, phase: s.phase, gid: s.gid });
  // Non-ranked teams weigh 50, so matchups between two ranked teams rank highest.
  const seed = (s) => (s.host.rank || 50) + ((s.opp && s.opp.rank) || 50);  // lower = higher-seeded
  // The top 4 SEC games this week, no matter the round: SEC-vs-SEC matchups are
  // deduped to the home side; everything else is each team's own weekend series.
  return week
    .filter((s) => !(s.opp && s.opp.conf && !s.home))   // drop the away half of SEC-vs-SEC dups
    .sort((a, b) => seed(a) - seed(b))
    .slice(0, 4)
    .map(card);
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
  const hostRow = <Row team={host} id={host.id} name={host.name} rank={host.rank} />;
  const oppRow = (
    <Row
      team={opp}
      id={oppKnown ? oppId : null}
      name={opp ? opp.name : "TBD"}
      rank={opp && opp.rank}
      dim
    />
  );
  return (
    <div className={"hp-card" + (post ? " hp-card--post" : "")}>
      <div className="hp-card__top">
        <span className="hp-eyebrow">{post ? "Super Regional" : (opp && opp.conf ? "SEC Series" : "Series")}</span>
        <span className="mono hp-faint">{card.date}{card.time ? " · " + card.time : ""}</span>
      </div>
      {/* Home team beneath the visitor. */}
      {card.home
        ? <React.Fragment>{oppRow}{hostRow}</React.Fragment>
        : <React.Fragment>{hostRow}{oppRow}</React.Fragment>}
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
  // Home team (the host) beneath the visitor. The host carries home:true; fall
  // back to the bracket's top/bottom order if neither is flagged (TBD matchups).
  const hasHome = (sr.top && sr.top.home) || (sr.bottom && sr.bottom.home);
  const homeIsTop = sr.top && sr.top.home;
  const awayT = homeIsTop ? sr.bottom : sr.top;
  const homeT = homeIsTop ? sr.top : sr.bottom;
  return (
    <div className="hp-card hp-card--post">
      <div className="hp-card__top"><span className="hp-eyebrow">Super Regional</span></div>
      {hasHome
        ? <React.Fragment><Row t={awayT} dim /><Row t={homeT} /></React.Fragment>
        : <React.Fragment><Row t={sr.top} /><Row t={sr.bottom} dim /></React.Fragment>}
    </div>
  );
}

// Conference leaders — three categories (AVG / HR / ERA), each with the leader
// (big) and two runners-up. Data from /api/conference-leaders.
function HPConfLeaders({ data }) {
  const [view, setView] = React.useState("batting");
  const teamObj = (p) => (window.TEAM_BY_ID || {})[p.team] || null;
  const cats = view === "pitching" ? ["era", "k", "wins"] : ["avg", "rbi", "hr"];
  return (
    <div>
      <div className="hp-cl-head">
        <HPLabel>Conference Leaders</HPLabel>
        <div className="hp-cl-toggle">
          {[["batting", "Batters"], ["pitching", "Pitchers"]].map(([v, lbl]) => (
            <button key={v} className={"hp-cl-toggle__btn" + (view === v ? " hp-cl-toggle__btn--on" : "")}
                    onClick={() => setView(v)}>{lbl}</button>
          ))}
        </div>
      </div>
      <div className="hp-cl">
        {cats.map((key) => {
          const cat = data[key];
          if (!cat) return null;
          return (
            <div key={key} className="hp-cl__cat">
              <div className="hp-cl__statname">{cat.label}</div>
              {cat.list && cat.list.length ? (
                <div className="hp-cl__list">
                  {cat.list.slice(0, 3).map((p, i) => (
                    <div key={i} className="hp-cl__row">
                      <span className="mono hp-faint hp-cl__rank">{i + 1}</span>
                      <HPLogo team={teamObj(p)} size={16} />
                      <span className="hp-cl__rname">{p.player}</span>
                      <span className="mono hp-faint hp-cl__rpos">{p.pos}</span>
                      <span className="mono hp-cl__rval">{p.value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="hp-cl__empty mono hp-faint">—</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- composed homepage ---------- */

// Masthead eyebrow copy per season phase (one entry for each of the 7 phases).
const HP_EYEBROW = {
  regular: "2026 SEC Season",
  sec_tournament: "2026 SEC Tournament",
  regionals: "2026 NCAA Regionals",
  super_regionals: "2026 NCAA Super Regionals",
  cws: "2026 College World Series",
  cws_finals: "2026 CWS Finals",
  offseason: "2026 Season — Final",
};
// Active postseason — every phase that is "win or go home" (excludes offseason).
const HP_POST_PHASES = new Set([
  "sec_tournament", "regionals", "super_regionals", "cws", "cws_finals",
]);

const Home = ({ onTeam, onNav }) => {
  const sp = window.SEASON_PHASE || { phase: "regular", label: "Regular Season" };
  const post = HP_POST_PHASES.has(sp.phase);
  const offseason = sp.phase === "offseason";
  const final = post || offseason;               // season-done → "Final" standings
  const eyebrow = HP_EYEBROW[sp.phase] || HP_EYEBROW.regular;
  const marquee = hpMarquee();
  const supers = window.SUPER_REGIONALS || [];
  const showSupers = post && supers.length > 0;
  const [confLeaders, setConfLeaders] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    window.fetchConferenceLeaders().then((d) => live && setConfLeaders(d)).catch(() => {});
    return () => { live = false; };
  }, []);
  return (
    <div className="hp">
      {/* masthead */}
      <div className="hp-masthead">
        <div>
          <HPLabel>{eyebrow}</HPLabel>
          <h1 className="hp-title">
            {offseason ? "Final Standings" : post ? sp.label : "This Week in the SEC"}
          </h1>
        </div>
        <div className="hp-masthead__meta mono">
          <div>{offseason ? "Season complete"
            : post ? "Win or go home"
            : (window.TEAMS ? window.TEAMS.length + " teams" : "")}</div>
          <div className="hp-faint">Updated {hpFmtDate(window.SEASON_UPDATED)}</div>
        </div>
      </div>

      {/* hero: marquee grid — skipped in the offseason (lead straight into the
          final standings below) */}
      {!offseason && (
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
      )}

      {/* lower split: standings + leaders */}
      <section className="hp-split">
        <div>
          <div className="hp-split__head">
            <HPLabel>{final ? "Final SEC Standings" : "SEC Standings"}</HPLabel>
            <button className="bare-btn hp-link" onClick={() => onNav && onNav("standings")}>Full table &rarr;</button>
          </div>
          <HPStandings n={10} onTeam={onTeam} />
        </div>
        <div className="hp-split__rule" />
        <div>
          {confLeaders
            ? <HPConfLeaders data={confLeaders} />
            : (
              <>
                <HPLabel>Conference Leaders</HPLabel>
                <div className="hp-placeholder hp-placeholder--tall">Loading conference leaders…</div>
              </>
            )}
        </div>
      </section>
    </div>
  );
};

window.Home = Home;
