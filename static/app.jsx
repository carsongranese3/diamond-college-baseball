// Root app — manages view state (standings / team / game)

// Map every view to a real URL so each has its own shareable, refreshable link
// and the browser back/forward buttons work. Game/player views carry an in-app
// `origin` for the Back button, but the URL only needs the bits to rebuild them.
// Scores date <-> URL slug. ISO "2026-05-31" <-> "053126" (MMDDYY).
function isoToMMDDYY(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? m[2] + m[3] + m[1].slice(2) : null;
}
function mmddyyToIso(slug) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(slug || "");
  return m ? `20${m[3]}-${m[1]}-${m[2]}` : null;
}

// Build a "?a=1&b=2" query string from a plain object, dropping empty values so
// only the non-default options appear in the URL.
function buildQuery(params) {
  const q = Object.keys(params)
    .filter((k) => params[k] != null && params[k] !== "")
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
    .join("&");
  return q ? "?" + q : "";
}

function pathForView(view) {
  switch (view.name) {
    case "home": return "/";
    case "standings": return "/standings";
    case "scores": {
      const slug = isoToMMDDYY(view.scoresDate);
      return slug ? "/scores/" + slug : "/scores";
    }
    case "bracket": return "/postseason/" + (view.bracketTab || "sec");
    case "compare": {
      // mode + the two selections (team ids, or "teamId:Name" player keys) +
      // the active stat tab — all in the query so a matchup is shareable.
      const mode = view.cmpMode === "players" ? "players" : "teams";
      const params = {};
      if (mode === "players") params.mode = "players";
      if (view.cmpA) params.a = view.cmpA;
      if (view.cmpB) params.b = view.cmpB;
      if (mode === "teams" && view.cmpTab && view.cmpTab !== "standings") params.tab = view.cmpTab;
      return "/compare" + buildQuery(params);
    }
    case "team": {
      // Every team tab gets its own segment, including schedule.
      const tab = view.teamTab || "home";
      const base = "/team/" + encodeURIComponent(view.teamId) + "/" + tab;
      if (tab !== "stats") return base;
      // Stats sub-options (Team/Players, Batting/Pitching, Basic/Advanced) ride
      // in the query so each stat view is its own link. Only emit non-defaults.
      const params = {};
      if (view.statMode === "players") {
        params.mode = "players";
        if (view.statView === "pitching") params.view = "pitching";
        if (view.statLevel === "advanced") params.level = "advanced";
      }
      return base + buildQuery(params);
    }
    case "player":
      // Drop spaces from the name in the URL (AidenRobbins). The backend matches
      // names normalized (alphanumerics only), so the space-less form still works.
      return "/player/" + encodeURIComponent(view.seo) +
             "/" + encodeURIComponent((view.playerName || "").replace(/\s+/g, ""));
    case "game":
      // Clean /game/<id> — the host team is resolved from the id on load.
      return "/game/" + encodeURIComponent((view.game && view.game.id) || "");
    default: return null;
  }
}

// Resolve a game id to {hostTeamId, game} by scanning every team's schedule.
// An SEC-vs-SEC game appears under both teams; prefer the team hosting it (its
// own page), else just the first match. Either resolves to the same saved game
// server-side (matched by team + date + host runs), so the choice is cosmetic.
function _resolveGameId(gameId) {
  const sched = window.SCHEDULES || {};
  let fallback = null;
  for (const teamId in sched) {
    for (const g of sched[teamId]) {
      if (String(g.id) === String(gameId)) {
        if (g.home) return { hostTeamId: teamId, game: g };
        if (!fallback) fallback = { hostTeamId: teamId, game: g };
      }
    }
  }
  return fallback;
}

function viewForPath(pathname, search) {
  const sp = new URLSearchParams(search || "");
  const p = (pathname || "/").replace(/\/+$/, "") || "/";
  if (p === "/" || p === "/home") return { name: "home" };
  if (p === "/scores" || p.startsWith("/scores/")) {
    const slug = p.slice("/scores".length).replace(/^\//, "");
    return { name: "scores", scoresDate: mmddyyToIso(slug) || null };
  }
  if (p === "/postseason" || p.startsWith("/postseason/")) {
    const seg = p.slice("/postseason".length).replace(/^\//, "");
    return { name: "bracket", bracketTab: seg === "ncaa" ? "ncaa" : "sec" };
  }
  if (p === "/compare") {
    return {
      name: "compare",
      cmpMode: sp.get("mode") === "players" ? "players" : "teams",
      cmpA: sp.get("a") || null,
      cmpB: sp.get("b") || null,
      cmpTab: sp.get("tab") || null,
    };
  }
  if (p.startsWith("/team/")) {
    const rest = p.slice("/team/".length).split("/");
    const teamId = decodeURIComponent(rest[0]);
    const teamTab = ["home", "schedule", "roster", "stats"].includes(rest[1]) ? rest[1] : "home";
    const v = { name: "team", teamId, teamTab };
    if (teamTab === "stats") {
      v.statMode = sp.get("mode") === "players" ? "players" : "team";
      v.statView = sp.get("view") === "pitching" ? "pitching" : "batting";
      v.statLevel = sp.get("level") === "advanced" ? "advanced" : "basic";
    }
    return v;
  }
  if (p.startsWith("/player/")) {
    const rest = p.slice("/player/".length).split("/");
    if (rest.length >= 2) {
      return { name: "player", seo: decodeURIComponent(rest[0]),
               playerName: decodeURIComponent(rest.slice(1).join("/")) };
    }
  }
  if (p.startsWith("/game/")) {
    // Support both the clean /game/<id> and the legacy /game/<team>/<id>.
    const rest = p.slice("/game/".length).split("/");
    const gameId = decodeURIComponent(rest[rest.length - 1]);
    const hit = _resolveGameId(gameId);
    if (hit) return { name: "game", game: hit.game, hostTeamId: hit.hostTeamId };
    // Id not found (e.g. a legacy team-prefixed link) — fall back to the team.
    if (rest.length >= 2) return { name: "team", teamId: decodeURIComponent(rest[0]) };
    return { name: "standings" };
  }
  return { name: "standings" };
}

const App = () => {
  const [view, setView] = React.useState(
    () => viewForPath(window.location.pathname, window.location.search)
  );

  // Keep the URL in sync with the view (push a history entry when the path
  // changes), and restore the view when the user hits back/forward. The very
  // first sync uses replaceState so default options filled in on load don't add
  // a spurious history entry; later changes push so back/forward works.
  const firstSync = React.useRef(true);
  React.useEffect(() => {
    const path = pathForView(view);
    const current = window.location.pathname + window.location.search;
    if (path && path !== current) {
      if (firstSync.current) window.history.replaceState({}, "", path);
      else window.history.pushState({}, "", path);
    }
    firstSync.current = false;
  }, [view]);
  React.useEffect(() => {
    const onPop = () =>
      setView(viewForPath(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Dark mode: initialized from the data-theme set by the inline script in
  // index.html (which reads localStorage before paint to avoid a flash).
  const [theme, setTheme] = React.useState(
    () => document.documentElement.dataset.theme || "light"
  );
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("theme", theme); } catch (e) {}
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  // simple scroll-to-top on view change
  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

  const goHome = () => setView({ name: "home" });
  const goTeam = (teamId) => setView({ name: "team", teamId, teamTab: "home" });
  const goGame = (game, hostTeamId, origin) => setView({ name: "game", game, hostTeamId, origin });
  const goStandings = () => setView({ name: "standings" });
  const goScores = () => setView({ name: "scores" });
  const goCompare = () => setView({ name: "compare" });
  const goBracket = () => setView({ name: "bracket", bracketTab: "sec" });
  // Section keys the homepage can link to (e.g. "Full table" -> standings).
  const goNav = (key) =>
    key === "scores" ? goScores()
    : key === "compare" ? goCompare()
    : key === "postseason" || key === "bracket" ? goBracket()
    : key === "standings" ? goStandings()
    : goHome();
  // origin describes where to return (a "team" or "game" view) so Back works.
  const goPlayer = (seo, playerName, origin) =>
    setView({ name: "player", seo, playerName, origin });

  // Which top-nav section the current view belongs to (detail views inherit the
  // section they were opened from, so the right tab stays highlighted).
  const fromScores =
    (view.name === "game" && view.origin === "scores") ||
    (view.name === "player" && view.origin && view.origin.view === "game" &&
      view.origin.gameOrigin === "scores");
  const fromBracket =
    (view.name === "game" && view.origin === "bracket");
  const section = view.name === "home" ? "home"
    : view.name === "compare" ? "compare"
    : view.name === "bracket" || fromBracket ? "bracket"
    : view.name === "scores" || fromScores ? "scores"
    : view.name === "standings" ? "standings"
    : "";

  return (
    <div className="app">
      <Topbar section={section} onHome={goHome} onStandings={goStandings} onScores={goScores}
              onCompare={goCompare} onBracket={goBracket} theme={theme} onToggleTheme={toggleTheme} />
      <main className="container">
        {view.name === "home" && (
          (window.SEASON_PHASE && window.SEASON_PHASE.phase === "regular")
            ? <HomeRegular onTeam={goTeam} onNav={goNav} />
            : <Home onTeam={goTeam} onNav={goNav} />
        )}
        {view.name === "standings" && <Standings onTeamClick={goTeam} />}
        {view.name === "scores" && (
          <Scores
            initialDate={view.scoresDate || null}
            onDateChange={(iso) => setView((v) => v.name === "scores" ? { ...v, scoresDate: iso } : v)}
            onGameClick={(g, hostTeamId) => goGame(g, hostTeamId, "scores")}
          />
        )}
        {view.name === "bracket" && (
          <Bracket
            initialTab={view.bracketTab || "sec"}
            onTabChange={(t) => setView((v) => ({ ...v, bracketTab: t }))}
            onGameClick={(g, hostTeamId) => goGame(g, hostTeamId, "bracket")}
          />
        )}
        {view.name === "compare" && (
          <Compare
            initialMode={view.cmpMode || "teams"}
            initialA={view.cmpA}
            initialB={view.cmpB}
            initialTab={view.cmpTab}
            onChange={(patch) =>
              setView((v) => v.name === "compare" ? { ...v, ...patch } : v)}
          />
        )}
        {view.name === "team" && (
          <TeamDetail
            key={view.teamId}
            teamId={view.teamId}
            initialTab={view.teamTab || "home"}
            initialStatMode={view.statMode || "team"}
            initialStatView={view.statView || "batting"}
            initialStatLevel={view.statLevel || "basic"}
            onTabChange={(t) => setView((v) => ({ ...v, teamTab: t }))}
            onStatChange={(patch) =>
              setView((v) => v.name === "team" ? { ...v, ...patch } : v)}
            onBack={goStandings}
            onTeam={goTeam}
            onGameClick={(g, hostTeamId) => goGame(g, hostTeamId || view.teamId, "team")}
            onPlayerClick={(playerName) =>
              goPlayer(view.teamId, playerName, { view: "team", teamId: view.teamId })}
          />
        )}
        {view.name === "game" && (
          <GameDetail
            game={view.game}
            hostTeamId={view.hostTeamId}
            onBack={view.origin === "scores" ? goScores
                    : view.origin === "bracket" ? goBracket
                    : () => goTeam(view.hostTeamId)}
            backLabel={view.origin === "scores" ? "Scores"
                       : view.origin === "bracket" ? "Postseason" : null}
            onTeamClick={(id) => goTeam(id)}
            onPlayerClick={(sideSeo, playerName) =>
              goPlayer(sideSeo, playerName, {
                view: "game", game: view.game,
                hostTeamId: view.hostTeamId, gameOrigin: view.origin,
              })}
          />
        )}
        {view.name === "player" && (
          <PlayerDetail
            seo={view.seo}
            playerName={view.playerName}
            backLabel={view.origin && view.origin.view === "game" ? "Box score" : null}
            onBack={() => {
              const o = view.origin || {};
              if (o.view === "game") {
                setView({ name: "game", game: o.game, hostTeamId: o.hostTeamId, origin: o.gameOrigin });
              } else if (o.view === "team") {
                goTeam(o.teamId);
              } else {
                goStandings();
              }
            }}
          />
        )}
      </main>
      <footer className="footer">
        <span>An original editorial mockup — not affiliated with the SEC, NCAA, or any university.</span>
      </footer>
      <DevClock />
    </div>
  );
};

// Test-only "time machine": set the effective date and the whole site behaves as
// though it's that day (phase, played vs upcoming games, standings, This Week…).
const DevClock = () => {
  const clk = window.SEASON_CLOCK || {};
  const [date, setDate] = React.useState(clk.date || clk.today || "");
  const go = (qs) =>
    fetch("/api/dev/clock?" + qs)
      .then(() => window.location.reload())
      .catch(() => window.location.reload());
  return (
    <div className={`devclock ${clk.test ? "devclock--active" : ""}`}>
      <span className="devclock__label mono">{clk.test ? "TEST" : "LIVE"}</span>
      <input type="date" className="devclock__input mono" value={date}
             min="2026-02-13" max="2026-06-30"
             onChange={(e) => setDate(e.target.value)} />
      <button className="devclock__btn mono"
              onClick={() => go("test=1&date=" + encodeURIComponent(date))}>Set</button>
      {clk.test && (
        <button className="devclock__btn devclock__btn--reset mono" onClick={() => go("test=0")}>Off</button>
      )}
    </div>
  );
};

const Topbar = ({ section, onHome, onStandings, onScores, onCompare, onBracket, theme, onToggleTheme }) => {
  const link = (active) => `topbar__link ${active ? "topbar__link--active" : "muted"}`;
  return (
    <header className="topbar">
      <button className="topbar__brand" onClick={onHome}>
        <span className="topbar__mark">◆</span>
        <span className="topbar__title">DIAMOND<span className="topbar__title-thin">/SEC</span></span>
      </button>
      <nav className="topbar__nav">
        <a className={link(section === "home")} onClick={onHome}>Home</a>
        <a className={link(section === "standings")} onClick={onStandings}>Standings</a>
        <a className={link(section === "scores")} onClick={onScores}>Scores</a>
        <a className={link(section === "bracket")} onClick={onBracket}>Postseason</a>
        <a className={link(section === "compare")} onClick={onCompare}>Compare</a>
      </nav>
      <div className="topbar__right">
        <div className="topbar__date mono">2026 SEASON · NCAA.COM</div>
        <button
          className="topbar__theme"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle dark mode"
        >{theme === "dark" ? "☀" : "☾"}</button>
      </div>
    </header>
  );
};

window.__bootstrapReady.then(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
});
