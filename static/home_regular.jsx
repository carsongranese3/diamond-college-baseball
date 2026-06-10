// home_regular.jsx — regular-season homepage ("Broadcast Bold").
// Theme-aware via .bbx CSS classes (dark = broadcast look, light = adapted). Wired
// to real data: window.TEAMS / SCHEDULES / TEAM_BY_ID, /api/conference-leaders,
// /api/player-of-week. Reuses home.jsx atoms (HPLogo, hpSecTeams, hpStreak,
// hpMarquee, hpFmtDate). The page ends at the Conference Leaders showcase.

function bbxAbbr(t) {
  return (t && (t.mark || (t.name || "").slice(0, 3).toUpperCase())) || "—";
}
function bbxRec(t) {
  return t && t.ovrW != null ? `${t.ovrW}–${t.ovrL}` : "";
}

/* ---------- live scores ticker ---------- */
// Games on the effective "today" (dev clock), deduped across home/away schedules;
// falls back to the most recent played date when today's slate is empty.
function bbxTickerGames() {
  const sch = window.SCHEDULES || {};
  const byId = window.TEAM_BY_ID || {};
  const all = [];
  for (const seo in sch) for (const g of sch[seo] || []) if (g.iso) all.push([seo, g]);
  const onDay = (d) => all.filter(([, g]) => g.iso === d);
  let day = (window.SEASON_CLOCK || {}).today || window.SEASON_UPDATED;
  if (!onDay(day).length) {
    const played = all.filter(([, g]) => g.result).map(([, g]) => g.iso).sort();
    day = played[played.length - 1] || day;
  }
  const seen = new Set();
  const rows = [];
  for (const [seo, g] of onDay(day)) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const me = byId[seo];
    const oppT = (g.opp && byId[g.opp.id]) || g.opp || null;
    const meScore = g.score ? g.score.us : null;
    const oppScore = g.score ? g.score.them : null;
    const home = g.home ? me : oppT, away = g.home ? oppT : me;
    const hs = g.home ? meScore : oppScore, as = g.home ? oppScore : meScore;
    rows.push({ id: g.id, home, away, hs, as, final: !!g.result,
                status: g.result ? "FINAL" : (g.time || "TBD"),
                game: g, hostId: seo });
  }
  return rows.slice(0, 9);
}

function BbxTicker({ onGame }) {
  const rows = bbxTickerGames();
  const Row = ({ t, score, lead }) => (
    <div className={"bbx-tk__line" + (lead ? " bbx-tk__line--lead" : "")}>
      <span className="bbx-tk__team"><HPLogo team={t} size={15} />{bbxAbbr(t)}</span>
      <span className="bbx-tk__sc">{score != null ? score : "–"}</span>
    </div>
  );
  return (
    <div className="bbx-ticker">
      <div className="bbx-ticker__label"><span className="bbx-pulse" />SCORES</div>
      <div className="bbx-ticker__rail">
        {rows.length ? rows.map((g) => {
          const homeLead = g.hs != null && g.as != null && g.hs >= g.as;
          // Only finals have a box score to open.
          const clickable = g.final && !!onGame;
          return (
            <button key={g.id} className={"bbx-tk" + (clickable ? " bbx-tk--click" : "")}
                    disabled={!clickable}
                    onClick={clickable ? () => onGame(g.game, g.hostId) : undefined}>
              <Row t={g.away} score={g.as} lead={!homeLead && g.as != null} />
              <Row t={g.home} score={g.hs} lead={homeLead && g.hs != null} />
              <span className={"bbx-tk__st" + (g.final ? "" : " bbx-tk__st--up")}>{g.status}</span>
            </button>
          );
        }) : <div className="bbx-tk bbx-faint" style={{ padding: "10px 16px" }}>No games on the board.</div>}
      </div>
    </div>
  );
}

/* ---------- game of the day ---------- */
function BbxHeroSide({ team, side, score, tag }) {
  const color = (team && team.color) || "#444";
  const dir = side === "home" ? "135deg" : "225deg";
  return (
    <div className={"bbx-hero__side bbx-hero__side--" + side}
         style={{ background: `linear-gradient(${dir}, ${color} 0%, rgba(0,0,0,0.72) 100%)` }}>
      <div className="bbx-hero__tag">{tag}</div>
      <div className="bbx-hero__name">{(team && (team.name || "").toUpperCase()) || "TBD"}</div>
      <div className="bbx-hero__rec">{bbxRec(team)}</div>
      <div className="bbx-hero__crest"><HPLogo team={team} size={116} /></div>
      <div className="bbx-hero__score">{score != null ? score : ""}</div>
    </div>
  );
}

function BbxGameOfDay({ onTeam }) {
  const card = (typeof hpMarquee === "function" ? hpMarquee() : [])[0];
  if (!card) return null;
  const byId = window.TEAM_BY_ID || {};
  const host = card.host;
  const opp = (card.opp && byId[card.opp.id]) || card.opp || null;
  const homeTeam = card.home ? host : opp, awayTeam = card.home ? opp : host;
  const phaseLabel = (card.phase && card.phase !== "regular") ? card.phase : "SEC MATCHUP";
  return (
    <div className="bbx-section">
      <div className="bbx-eyebrow-row">
        <span className="bbx-eyebrow bbx-gold">★ SERIES OF THE WEEK</span>
        <span className="bbx-rule" />
        <span className="bbx-eyebrow bbx-faint">{phaseLabel.toUpperCase()}</span>
      </div>
      <div className="bbx-hero">
        <BbxHeroSide team={homeTeam} side="home" tag="HOME" />
        <BbxHeroSide team={awayTeam} side="away" tag="AWAY" />
        <div className="bbx-hero__vs"><span className="bbx-hero__vstxt">VS</span></div>
      </div>
    </div>
  );
}

/* ---------- player of the week (batter ⇄ pitcher) ---------- */
function bbxWeekLabel(w) {
  if (!w || !w.start || !w.end) return "";
  const f = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `WEEK OF ${f(w.start)} – ${f(w.end)}`;
}
function BbxPlayerOfWeek({ onTeam }) {
  const [data, setData] = React.useState(null);
  const [side, setSide] = React.useState("batter");
  React.useEffect(() => {
    let live = true;
    window.fetchPlayerOfWeek().then((d) => live && setData(d)).catch(() => {});
    return () => { live = false; };
  }, []);
  const p = data && data[side];
  const team = p && (window.TEAM_BY_ID || {})[p.team];
  return (
    <div className="bbx-panel bbx-potw">
      <div className="bbx-panel__head">
        <span className="bbx-eyebrow bbx-gold">◆ PLAYER OF THE WEEK</span>
        <div className="bbx-seg bbx-seg--sm">
          {["batter", "pitcher"].map((s) => (
            <button key={s} className={"bbx-seg__btn" + (side === s ? " bbx-seg__btn--on" : "")}
                    onClick={() => setSide(s)}>{s === "batter" ? "BATTER" : "PITCHER"}</button>
          ))}
        </div>
      </div>
      {!data ? <div className="bbx-faint bbx-pad">Loading…</div>
       : !p ? <div className="bbx-faint bbx-pad">No qualifying {side} last week.</div>
       : (
        <div className="bbx-potw__body">
          <div className="bbx-potw__cutout"><span>PLAYER<br />CUTOUT</span></div>
          <div className="bbx-potw__main">
            <button className="bbx-potw__teamline" onClick={() => team && onTeam && onTeam(p.team)}>
              <HPLogo team={team} size={18} />
              <span>{(p.teamName || "").toUpperCase()} · {p.pos}</span>
            </button>
            <div className="bbx-potw__name">{(p.player || "").toUpperCase()}</div>
            <div className="bbx-potw__wk">{bbxWeekLabel(data.window)}</div>
            <div className="bbx-statgrid">
              {p.basic.map((s) => (
                <div key={s.label} className="bbx-stat">
                  <div className="bbx-stat__n">{s.value}</div>
                  <div className="bbx-stat__l">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="bbx-potw__advlabel">ADVANCED</div>
            <div className="bbx-statgrid">
              {p.adv.map((s) => (
                <div key={s.label} className="bbx-stat bbx-stat--adv">
                  <div className="bbx-stat__n bbx-gold">{s.value}</div>
                  <div className="bbx-stat__l">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
       )}
    </div>
  );
}

/* ---------- hot / cold ---------- */
function BbxHotCold({ onTeam }) {
  const teams = hpSecTeams();
  const withStreak = teams.map((t) => ({ t, s: hpStreak(t.streak) })).filter((x) => x.s);
  const hot = withStreak.filter((x) => x.s.t === "W").sort((a, b) => b.s.n - a.s.n).slice(0, 3);
  const cold = withStreak.filter((x) => x.s.t === "L").sort((a, b) => b.s.n - a.s.n).slice(0, 3);
  const rows = [...hot, ...cold];
  return (
    <div className="bbx-panel bbx-pad2">
      <div className="bbx-eyebrow bbx-mb">🔥 HOT / COLD ❄️</div>
      {rows.map(({ t, s }, i) => (
        <button key={t.id} className={"bbx-row" + (i < rows.length - 1 ? " bbx-row--div" : "")}
                onClick={() => onTeam && onTeam(t.id)}>
          <span className="bbx-row__team">
            <HPLogo team={t} size={22} />{t.name}
            <span className="bbx-row__emoji">{s.t === "W" ? "🔥" : "❄️"}</span>
          </span>
          <span className="bbx-row__r">
            <span className={"bbx-streak " + (s.t === "W" ? "bbx-hot" : "bbx-cold")}>{s.t}{s.n}</span>
            <span className={s.t === "W" ? "bbx-hot" : "bbx-cold"}>{s.t === "W" ? "▲" : "▼"}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------- SEC standings mini ---------- */
function BbxStandingsMini({ onTeam, onNav }) {
  const teams = hpSecTeams().slice(0, 6);
  return (
    <div className="bbx-panel bbx-pad2">
      <div className="bbx-eyebrow bbx-mb">SEC STANDINGS</div>
      {teams.map((t, i) => (
        <button key={t.id} className={"bbx-row" + (i < teams.length - 1 ? " bbx-row--div" : "")}
                onClick={() => onTeam && onTeam(t.id)}>
          <span className="bbx-rank">{i + 1}</span>
          <HPLogo team={t} size={20} />
          <span className="bbx-row__name">{t.name}</span>
          <span className="bbx-row__rec">{t.confW}–{t.confL}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- conference leaders showcase ---------- */
const BBX_LEADER_CATS = {
  bat: [["avg", false], ["hr", false], ["rbi", false], ["ops", true]],
  pit: [["era", false], ["k", false], ["whip", false], ["fip", true]],
};
function BbxLeaders({ onTeam }) {
  const [data, setData] = React.useState(null);
  const [side, setSide] = React.useState("bat");
  React.useEffect(() => {
    let live = true;
    window.fetchConferenceLeaders().then((d) => live && setData(d)).catch(() => {});
    return () => { live = false; };
  }, []);
  const byId = window.TEAM_BY_ID || {};
  const cats = BBX_LEADER_CATS[side];
  return (
    <div className="bbx-section">
      <div className="bbx-eyebrow-row">
        <span className="bbx-eyebrow bbx-gold">★ CONFERENCE LEADERS</span>
        <span className="bbx-rule" />
        <div className="bbx-seg">
          {[["bat", "BATTERS"], ["pit", "PITCHERS"]].map(([s, l]) => (
            <button key={s} className={"bbx-seg__btn" + (side === s ? " bbx-seg__btn--on" : "")}
                    onClick={() => setSide(s)}>{l}</button>
          ))}
        </div>
      </div>
      {!data ? <div className="bbx-faint bbx-pad">Loading conference leaders…</div> : (
        <div className="bbx-leadgrid">
          {cats.map(([key, adv]) => {
            const cat = data[key] || { label: key, unit: "", list: [] };
            const list = cat.list || [];
            const leader = list[0];
            const lt = leader && byId[leader.team];
            return (
              <div key={key} className="bbx-leadcard">
                <div className="bbx-leadcard__head">
                  <span className="bbx-leadcard__cat">{cat.label}</span>
                  {adv ? <span className="bbx-advtag">ADV</span>
                       : cat.unit ? <span className="bbx-faint bbx-leadcard__u">{cat.unit}</span> : null}
                </div>
                {leader && (
                  <button className="bbx-leadcard__hero" onClick={() => lt && onTeam && onTeam(leader.team)}>
                    <HPLogo team={lt || { name: leader.player }} size={42} />
                    <div className="bbx-leadcard__who">
                      <div className="bbx-gold bbx-leadcard__tag">● LEADER · {leader.abbr}</div>
                      <div className="bbx-leadcard__nm">{leader.player}</div>
                    </div>
                    <div className="bbx-leadcard__val">{leader.value}</div>
                  </button>
                )}
                <div className="bbx-leadcard__rest">
                  {list.slice(1, 3).map((r, i) => {
                    const rt = byId[r.team];
                    return (
                      <button key={i} className="bbx-row bbx-row--div bbx-leadcard__ru"
                              onClick={() => rt && onTeam && onTeam(r.team)}>
                        <span className="bbx-rank">{i + 2}</span>
                        <HPLogo team={rt || { name: r.player }} size={18} />
                        <span className="bbx-row__name">{r.player}</span>
                        <span className="bbx-row__rec">{r.value}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- composed regular-season homepage ---------- */
const HomeRegular = ({ onTeam, onNav, onGame }) => (
  <div className="bbx">
    <BbxTicker onGame={onGame} />
    <BbxGameOfDay onTeam={onTeam} />
    <div className="bbx-cols">
      <BbxPlayerOfWeek onTeam={onTeam} />
      <BbxHotCold onTeam={onTeam} />
      <BbxStandingsMini onTeam={onTeam} onNav={onNav} />
    </div>
    <BbxLeaders onTeam={onTeam} />
  </div>
);
window.HomeRegular = HomeRegular;
