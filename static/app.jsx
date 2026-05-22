// Root app — manages view state (standings / team / game)

const App = () => {
  const [view, setView] = React.useState({ name: "standings" });

  // simple scroll-to-top on view change
  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

  const goTeam = (teamId) => setView({ name: "team", teamId });
  const goGame = (game, hostTeamId) => setView({ name: "game", game, hostTeamId });
  const goStandings = () => setView({ name: "standings" });

  return (
    <div className="app">
      <Topbar onHome={goStandings} />
      <main className="container">
        {view.name === "standings" && <Standings onTeamClick={goTeam} />}
        {view.name === "team" && (
          <TeamDetail
            teamId={view.teamId}
            onBack={goStandings}
            onGameClick={(g, hostTeamId) => goGame(g, hostTeamId || view.teamId)}
          />
        )}
        {view.name === "game" && (
          <GameDetail
            game={view.game}
            hostTeamId={view.hostTeamId}
            onBack={() => goTeam(view.hostTeamId)}
            onTeamClick={(id) => goTeam(id)}
          />
        )}
      </main>
      <footer className="footer">
        <span>An original editorial mockup — not affiliated with the SEC, NCAA, or any university.</span>
      </footer>
    </div>
  );
};

const Topbar = ({ onHome }) => (
  <header className="topbar">
    <button className="topbar__brand" onClick={onHome}>
      <span className="topbar__mark">◆</span>
      <span className="topbar__title">DIAMOND<span className="topbar__title-thin">/SEC</span></span>
    </button>
    <nav className="topbar__nav">
      <a className="topbar__link topbar__link--active" onClick={onHome}>Standings</a>
      <a className="topbar__link muted">Polls</a>
      <a className="topbar__link muted">Stats</a>
      <a className="topbar__link muted">Scores</a>
      <a className="topbar__link muted">Bracket</a>
    </nav>
    <div className="topbar__date mono">2026 SEASON · NCAA.COM</div>
  </header>
);

window.__bootstrapReady.then(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
});
