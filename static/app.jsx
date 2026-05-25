// Root app — manages view state (standings / team / game)

const App = () => {
  const [view, setView] = React.useState({ name: "standings" });

  // simple scroll-to-top on view change
  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

  const goTeam = (teamId) => setView({ name: "team", teamId });
  const goGame = (game, hostTeamId, origin) => setView({ name: "game", game, hostTeamId, origin });
  const goStandings = () => setView({ name: "standings" });
  const goScores = () => setView({ name: "scores" });
  // origin describes where to return (a "team" or "game" view) so Back works.
  const goPlayer = (seo, playerName, origin) =>
    setView({ name: "player", seo, playerName, origin });

  // Which top-nav section the current view belongs to (detail views inherit the
  // section they were opened from, so the right tab stays highlighted).
  const fromScores =
    (view.name === "game" && view.origin === "scores") ||
    (view.name === "player" && view.origin && view.origin.view === "game" &&
      view.origin.gameOrigin === "scores");
  const section = view.name === "scores" || fromScores ? "scores" : "standings";

  return (
    <div className="app">
      <Topbar section={section} onHome={goStandings} onScores={goScores} />
      <main className="container">
        {view.name === "standings" && <Standings onTeamClick={goTeam} />}
        {view.name === "scores" && (
          <Scores onGameClick={(g, hostTeamId) => goGame(g, hostTeamId, "scores")} />
        )}
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
            onBack={view.origin === "scores" ? goScores : () => goTeam(view.hostTeamId)}
            backLabel={view.origin === "scores" ? "Scores" : null}
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

const Topbar = ({ section, onHome, onScores }) => {
  const scoresActive = section === "scores";
  return (
    <header className="topbar">
      <button className="topbar__brand" onClick={onHome}>
        <span className="topbar__mark">◆</span>
        <span className="topbar__title">DIAMOND<span className="topbar__title-thin">/SEC</span></span>
      </button>
      <nav className="topbar__nav">
        <a className={`topbar__link ${scoresActive ? "muted" : "topbar__link--active"}`} onClick={onHome}>Standings</a>
        <a className={`topbar__link ${scoresActive ? "topbar__link--active" : "muted"}`} onClick={onScores}>Scores</a>
      </nav>
      <div className="topbar__date mono">2026 SEASON · NCAA.COM</div>
    </header>
  );
};

window.__bootstrapReady.then(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
});
