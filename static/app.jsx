// Root app — manages view state (standings / team / game)

const App = () => {
  const [view, setView] = React.useState({ name: "standings" });

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

  const goTeam = (teamId) => setView({ name: "team", teamId });
  const goGame = (game, hostTeamId, origin) => setView({ name: "game", game, hostTeamId, origin });
  const goStandings = () => setView({ name: "standings" });
  const goScores = () => setView({ name: "scores" });
  const goCompare = () => setView({ name: "compare" });
  const goBracket = () => setView({ name: "bracket" });
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
  const section = view.name === "compare" ? "compare"
    : view.name === "bracket" || fromBracket ? "bracket"
    : view.name === "scores" || fromScores ? "scores"
    : "standings";

  return (
    <div className="app">
      <Topbar section={section} onHome={goStandings} onScores={goScores} onCompare={goCompare}
              onBracket={goBracket} theme={theme} onToggleTheme={toggleTheme} />
      <main className="container">
        {view.name === "standings" && <Standings onTeamClick={goTeam} />}
        {view.name === "scores" && (
          <Scores onGameClick={(g, hostTeamId) => goGame(g, hostTeamId, "scores")} />
        )}
        {view.name === "bracket" && (
          <Bracket onGameClick={(g, hostTeamId) => goGame(g, hostTeamId, "bracket")} />
        )}
        {view.name === "compare" && <Compare />}
        {view.name === "team" && (
          <TeamDetail
            teamId={view.teamId}
            onBack={goStandings}
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

const Topbar = ({ section, onHome, onScores, onCompare, onBracket, theme, onToggleTheme }) => {
  const link = (active) => `topbar__link ${active ? "topbar__link--active" : "muted"}`;
  return (
    <header className="topbar">
      <button className="topbar__brand" onClick={onHome}>
        <span className="topbar__mark">◆</span>
        <span className="topbar__title">DIAMOND<span className="topbar__title-thin">/SEC</span></span>
      </button>
      <nav className="topbar__nav">
        <a className={link(section === "standings")} onClick={onHome}>Standings</a>
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
