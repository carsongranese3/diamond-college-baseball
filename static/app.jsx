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

function pathForView(view) {
  switch (view.name) {
    case "home": return "/";
    case "standings": return "/standings";
    case "scores": {
      const slug = isoToMMDDYY(view.scoresDate);
      return slug ? "/scores/" + slug : "/scores";
    }
    case "bracket": return "/postseason/" + (view.bracketTab || "sec");
    case "compare": return "/compare";
    case "team":
      // Every team tab gets its own segment, including schedule.
      return "/team/" + encodeURIComponent(view.teamId) +
             "/" + (view.teamTab || "home");
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

function viewForPath(pathname) {
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
  if (p === "/compare") return { name: "compare" };
  if (p.startsWith("/team/")) {
    const rest = p.slice("/team/".length).split("/");
    const teamId = decodeURIComponent(rest[0]);
    const teamTab = ["home", "schedule", "roster", "stats"].includes(rest[1]) ? rest[1] : "home";
    return { name: "team", teamId, teamTab };
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
  const [view, setView] = React.useState(() => viewForPath(window.location.pathname));

  // Keep the URL in sync with the view (push a history entry when the path
  // changes), and restore the view when the user hits back/forward.
  React.useEffect(() => {
    const path = pathForView(view);
    if (path && path !== window.location.pathname) {
      window.history.pushState({}, "", path);
    }
  }, [view]);
  React.useEffect(() => {
    const onPop = () => setView(viewForPath(window.location.pathname));
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
        {view.name === "home" && <Home onTeam={goTeam} onNav={goNav} />}
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
        {view.name === "compare" && <Compare />}
        {view.name === "team" && (
          <TeamDetail
            key={view.teamId}
            teamId={view.teamId}
            initialTab={view.teamTab || "home"}
            onTabChange={(t) => setView((v) => ({ ...v, teamTab: t }))}
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
