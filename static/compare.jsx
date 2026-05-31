// Compare view — head-to-head team vs team / player vs player.
// "Versus" hero + horizontal split bars. All numbers come from the same
// endpoints the rest of the app uses (fetchTeam / fetchRoster / fetchPlayer);
// nothing here is fabricated, and a value the data doesn't carry shows "—".

(function () {
  const { useState, useEffect, useRef } = React;

  // ── number helpers ─────────────────────────────────────────────────────────
  const cnum = (v) => {
    if (v == null) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (s === "" || s === "—") return null;
    const f = parseFloat(s);
    return Number.isFinite(f) ? f : null;
  };
  // Baseball IP notation ("510.1" = 510 + 1/3) -> decimal innings.
  const ipDecimal = (v) => {
    const f = cnum(v);
    if (f == null) return null;
    const whole = Math.trunc(f);
    const frac = Math.round((f - whole) * 10);
    return whole + (frac === 1 ? 1 / 3 : frac === 2 ? 2 / 3 : 0);
  };
  const fmt3 = (x) => {
    const s = x.toFixed(3);
    return s.startsWith("0") ? s.slice(1) : s;
  };

  // Each accessor returns { val, disp }: val drives bars/winner (or null when
  // the stat isn't available), disp is what the row prints.
  const rate = (v) => ({ val: cnum(v), disp: v == null || v === "—" ? "—" : String(v) });
  const int = rate;
  const ops = (obp, slg) => {
    const a = cnum(obp), b = cnum(slg);
    if (a == null || b == null) return { val: null, disp: "—" };
    return { val: a + b, disp: fmt3(a + b) };
  };
  const per9 = (n, ip) => {
    const c = cnum(n), d = ipDecimal(ip);
    if (c == null || d == null || d === 0) return { val: null, disp: "—" };
    const v = (c * 9) / d;
    return { val: v, disp: v.toFixed(1) };
  };

  // dir = +1 when higher is better, -1 when lower is better.
  const decide = (a, b, dir) => {
    if (a == null || b == null || a === b) return 0;
    return (a > b ? 1 : -1) * dir; // 1 => A better, -1 => B better
  };
  const shares = (a, b, dir) => {
    if (a == null || b == null) return [50, 50];
    if (dir === 1) {
      const tot = a + b;
      if (tot <= 0) return [50, 50];
      const sa = (a / tot) * 100;
      return [sa, 100 - sa];
    }
    const ra = 1 / Math.max(a, 1e-4), rb = 1 / Math.max(b, 1e-4);
    const sa = (ra / (ra + rb)) * 100;
    return [sa, 100 - sa];
  };

  // ── stat group definitions (teams) ──────────────────────────────────────────
  // Standings reads the team object (t); the rest read the fetched stats (s).
  const TEAM_GROUPS = [
    { id: "standings", num: "01", title: "Standings", stats: [
      { label: "Wins", dir: 1, get: (t) => int(t.ovrW) },
      { label: "Losses", dir: -1, get: (t) => int(t.ovrL) },
      { label: "Conf Wins", dir: 1, get: (t) => int(t.confW) },
      { label: "Natl Rank", dir: -1, get: (t) => ({ val: cnum(t.rank), disp: t.rank != null ? `#${t.rank}` : "—" }) },
      { label: "RPI", dir: -1, get: (t) => ({ val: cnum(t.rpi), disp: t.rpi != null ? `#${t.rpi}` : "—" }) },
    ] },
    { id: "batting", num: "02", title: "Batting", stats: [
      { label: "AVG", dir: 1, get: (t, s) => rate(s.batting.avg) },
      { label: "OBP", dir: 1, get: (t, s) => rate(s.batting.obp) },
      { label: "SLG", dir: 1, get: (t, s) => rate(s.batting.slg) },
      { label: "OPS", dir: 1, get: (t, s) => ops(s.batting.obp, s.batting.slg) },
      { label: "Home Runs", dir: 1, get: (t, s) => int(s.batting.hr) },
      { label: "RBI", dir: 1, get: (t, s) => int(s.batting.rbi) },
      { label: "Runs", dir: 1, get: (t, s) => int(s.batting.runs) },
      { label: "Stolen Bases", dir: 1, get: (t, s) => int(s.batting.sb) },
    ] },
    { id: "pitching", num: "03", title: "Pitching", stats: [
      { label: "ERA", dir: -1, get: (t, s) => rate(s.pitching.era) },
      { label: "WHIP", dir: -1, get: (t, s) => rate(s.pitching.whip) },
      { label: "Strikeouts", dir: 1, get: (t, s) => int(s.pitching.k) },
      { label: "K / 9", dir: 1, get: (t, s) => per9(s.pitching.k, s.pitching.ip) },
      { label: "Walks", dir: -1, get: (t, s) => int(s.pitching.bb) },
      { label: "BB / 9", dir: -1, get: (t, s) => per9(s.pitching.bb, s.pitching.ip) },
      { label: "Innings", dir: 1, get: (t, s) => ({ val: ipDecimal(s.pitching.ip), disp: s.pitching.ip == null ? "—" : String(s.pitching.ip) }) },
    ] },
    { id: "fielding", num: "04", title: "Fielding", stats: [
      { label: "Fielding %", dir: 1, get: (t, s) => rate(s.fielding.pct) },
      { label: "Errors", dir: -1, get: (t, s) => int(s.fielding.e) },
      { label: "Double Plays", dir: 1, get: (t, s) => int(s.fielding.dp) },
    ] },
  ];

  // ── stat definitions (players) ──────────────────────────────────────────────
  const PLAYER_BAT = [
    { k: "avg", label: "AVG", dir: 1 }, { k: "obp", label: "OBP", dir: 1 },
    { k: "slg", label: "SLG", dir: 1 }, { k: "ops", label: "OPS", dir: 1 },
    { k: "hr", label: "Home Runs", dir: 1 }, { k: "rbi", label: "RBI", dir: 1 },
    { k: "r", label: "Runs", dir: 1 }, { k: "h", label: "Hits", dir: 1 },
    { k: "bb", label: "Walks", dir: 1 }, { k: "k", label: "Strikeouts", dir: -1 },
    { k: "sb", label: "Stolen Bases", dir: 1 },
  ];
  const PLAYER_PIT = [
    { k: "era", label: "ERA", dir: -1 }, { k: "whip", label: "WHIP", dir: -1 },
    { k: "k", label: "Strikeouts", dir: 1 }, { k: "k9", label: "K / 9", dir: 1 },
    { k: "bb", label: "Walks", dir: -1 }, { k: "bb9", label: "BB / 9", dir: -1 },
    { k: "ip", label: "Innings", dir: 1 },
  ];
  const pstat = (block, st) => {
    if (st.k === "k9") return per9(block.k, block.ip);
    if (st.k === "bb9") return per9(block.bb, block.ip);
    if (st.k === "ip") return { val: ipDecimal(block.ip), disp: block.ip == null ? "—" : String(block.ip) };
    return rate(block[st.k]);
  };

  // ── bars ─────────────────────────────────────────────────────────────────--
  function StatRow({ label, valA, valB, dispA, dispB, dir, colorA, colorB }) {
    const w = decide(valA, valB, dir);
    const [sa, sb] = shares(valA, valB, dir);
    return (
      <div className="cmp-row">
        <div className={"cmp-rowval left mono" + (w === 1 ? " winner" : "")}>{dispA}</div>
        <div className="cmp-barwrap">
          <div className="cmp-bartrack">
            <div className={"cmp-bar left" + (w === 1 ? " winner" : "")} style={{ width: sa + "%", background: colorA }} />
            <div className={"cmp-bar right" + (w === -1 ? " winner" : "")} style={{ width: sb + "%", background: colorB }} />
          </div>
          <div className="cmp-rowlabel">{label}</div>
        </div>
        <div className={"cmp-rowval right mono" + (w === -1 ? " winner" : "")}>{dispB}</div>
      </div>
    );
  }

  function StatBars({ title, num, rows, left, right }) {
    return (
      <section className="cmp-group">
        <div className="cmp-group__head">
          <span className="cmp-group__num mono">{num}</span>
          <span className="cmp-group__title">{title}</span>
        </div>
        <div className="cmp-labels">
          <span className="cmp-lbl"><i className="cmp-dot" style={{ background: left.color }} />{left.mark || left.name}</span>
          <span />
          <span className="cmp-lbl right">{right.mark || right.name}<i className="cmp-dot" style={{ background: right.color }} /></span>
        </div>
        {rows.map((r) => (
          <StatRow key={r.label} {...r} colorA={left.color} colorB={right.color} />
        ))}
      </section>
    );
  }

  // ── versus hero ──────────────────────────────────────────────────────────--
  function HeroHalf({ side, team, name, sub, kicker }) {
    return (
      <div className={"cmp-hero__half " + side} style={{ "--c": team.color }}>
        <div className="cmp-hero__stripes" />
        <div className="cmp-hero__content">
          <div className="cmp-logo"><Monogram team={team} size={64} /></div>
          <div className="cmp-hero__meta">
            {kicker && <div className="cmp-hero__kicker mono">{kicker}</div>}
            <div className="cmp-hero__name">{name}</div>
            {sub && <div className="cmp-hero__sub mono">{sub}</div>}
          </div>
        </div>
      </div>
    );
  }

  function VersusHero({ left, right, onSwap }) {
    return (
      <div className="cmp-hero">
        <HeroHalf side="left" {...left} />
        <HeroHalf side="right" {...right} />
        <div className="cmp-vs">
          <button className="cmp-vs__swap" onClick={onSwap} title="Swap sides">⇄</button>
          <div className="cmp-vs__text">VS</div>
        </div>
      </div>
    );
  }

  // ── numbered stat tabs (teams) ──────────────────────────────────────────────
  function StatTabs({ groups, active, onChange, colorA, colorB }) {
    return (
      <div className="cmp-tabs" style={{ "--ta": colorA, "--tb": colorB }}>
        {groups.map((g) => (
          <button
            key={g.id}
            className={"cmp-tab" + (active === g.id ? " active" : "")}
            onClick={() => onChange(g.id)}
          >
            <span className="cmp-tab__num mono">{g.num}</span>
            <span className="cmp-tab__label">{g.title}</span>
          </button>
        ))}
      </div>
    );
  }

  // ── pickers ──────────────────────────────────────────────────────────────--
  function Dropdown({ value, sub, color, placeholder, children, mini }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
      const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener("mousedown", onDoc);
      return () => document.removeEventListener("mousedown", onDoc);
    }, []);
    return (
      <div ref={ref} className={"cmp-picker" + (mini ? " cmp-picker--mini" : "")}>
        <button className="cmp-picker__btn" onClick={() => setOpen((o) => !o)} style={{ "--c": color }}>
          <span className="cmp-picker__bar" />
          <span className="cmp-picker__value">{value || placeholder}</span>
          {sub && <span className="cmp-picker__sub">{sub}</span>}
          <span className="cmp-picker__caret">▾</span>
        </button>
        {open && <div className="cmp-picker__pop">{children(() => setOpen(false))}</div>}
      </div>
    );
  }

  // Compact team selector — used per side in Players mode to switch which
  // team's players the picker below it lists.
  function TeamSelectMini({ teams, value, onChange, color }) {
    const [q, setQ] = useState("");
    const filtered = teams.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
    return (
      <Dropdown mini value={value ? value.name : null} color={color} placeholder="Team">
        {(close) => (
          <React.Fragment>
            <input autoFocus className="cmp-picker__search" value={q}
              onChange={(e) => setQ(e.target.value)} placeholder="Search teams…" />
            <div className="cmp-picker__list">
              {filtered.map((t) => (
                <button key={t.id} className="cmp-picker__item"
                  onClick={() => { onChange(t); setQ(""); close(); }}>
                  <span className="cmp-picker__swatch" style={{ background: t.color }} />
                  <span className="cmp-picker__iname">{t.name}</span>
                </button>
              ))}
              {filtered.length === 0 && <div className="cmp-picker__empty">No teams match</div>}
            </div>
          </React.Fragment>
        )}
      </Dropdown>
    );
  }

  function TeamPicker({ teams, value, onChange, color }) {
    const [q, setQ] = useState("");
    const filtered = teams.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
    return (
      <Dropdown value={value.name} sub={`${value.ovrW}–${value.ovrL}`} color={color} placeholder="Select team">
        {(close) => (
          <React.Fragment>
            <input autoFocus className="cmp-picker__search" value={q}
              onChange={(e) => setQ(e.target.value)} placeholder="Search teams…" />
            <div className="cmp-picker__list">
              {filtered.map((t) => (
                <button key={t.id} className="cmp-picker__item"
                  onClick={() => { onChange(t); setQ(""); close(); }}>
                  <span className="cmp-picker__swatch" style={{ background: t.color }} />
                  <span className="cmp-picker__iname">{t.name}</span>
                  <span className="cmp-picker__imeta mono">{t.ovrW}–{t.ovrL}</span>
                </button>
              ))}
              {filtered.length === 0 && <div className="cmp-picker__empty">No teams match</div>}
            </div>
          </React.Fragment>
        )}
      </Dropdown>
    );
  }

  function PlayerPicker({ players, value, onChange, color }) {
    const [q, setQ] = useState("");
    const filtered = players.filter((p) => {
      const hay = `${p.name} ${p.pos} ${p.teamName}`.toLowerCase();
      return hay.includes(q.toLowerCase());
    }).slice(0, 60);
    return (
      <Dropdown value={value ? value.name : null} sub={value ? `${value.pos} · ${value.teamName}` : null}
        color={color} placeholder="Select player">
        {(close) => (
          <React.Fragment>
            <input autoFocus className="cmp-picker__search" value={q}
              onChange={(e) => setQ(e.target.value)} placeholder="Search players…" />
            <div className="cmp-picker__list">
              {filtered.map((p) => (
                <button key={p.teamId + "::" + p.name} className="cmp-picker__item"
                  onClick={() => { onChange(p); setQ(""); close(); }}>
                  <span className="cmp-picker__swatch" style={{ background: (window.TEAM_BY_ID[p.teamId] || {}).color }} />
                  <span className="cmp-picker__iname">{p.name}</span>
                  <span className="cmp-picker__imeta">{p.pos} · {p.teamName}</span>
                </button>
              ))}
              {filtered.length === 0 && <div className="cmp-picker__empty">No players match</div>}
            </div>
          </React.Fragment>
        )}
      </Dropdown>
    );
  }

  // ── team comparison ──────────────────────────────────────────────────────--
  function TeamCompare({ aId, bId, onSwap }) {
    const a = window.TEAM_BY_ID[aId], b = window.TEAM_BY_ID[bId];
    const [sa, setSa] = useState(null), [sb, setSb] = useState(null);
    const [err, setErr] = useState(null);
    const [tab, setTab] = useState("standings");

    useEffect(() => { setSa(null); window.fetchTeam(aId).then(setSa).catch((e) => setErr(e.message)); }, [aId]);
    useEffect(() => { setSb(null); window.fetchTeam(bId).then(setSb).catch((e) => setErr(e.message)); }, [bId]);

    const group = TEAM_GROUPS.find((g) => g.id === tab);
    const needStats = tab !== "standings";
    const ready = !needStats || (sa && sb);

    let body;
    if (err) body = <div className="loading-block">Could not load team stats — {err}</div>;
    else if (!ready) body = <div className="loading-block">Crawling box scores for season stats… first load can take a moment.</div>;
    else {
      const rows = group.stats.map((st) => {
        const ga = st.get(a, sa), gb = st.get(b, sb);
        return { label: st.label.toUpperCase(), dir: st.dir, valA: ga.val, valB: gb.val, dispA: ga.disp, dispB: gb.disp };
      });
      body = <StatBars title={group.title} num={group.num} rows={rows} left={a} right={b} />;
    }

    return (
      <React.Fragment>
        <VersusHero
          left={{ team: a, name: a.name, sub: `${a.ovrW}–${a.ovrL}${a.rank != null ? ` · #${a.rank}` : ""}` }}
          right={{ team: b, name: b.name, sub: `${b.ovrW}–${b.ovrL}${b.rank != null ? ` · #${b.rank}` : ""}` }}
          onSwap={onSwap}
        />
        <StatTabs groups={TEAM_GROUPS} active={tab} onChange={setTab} colorA={a.color} colorB={b.color} />
        <div className="cmp-sections">{body}</div>
      </React.Fragment>
    );
  }

  // ── player comparison ────────────────────────────────────────────────────--
  const latestSeason = (data) => (data && data.seasons && data.seasons[0]) || null;

  function PlayerCompare({ a, b, onSwap }) {
    const ta = window.TEAM_BY_ID[a.teamId], tb = window.TEAM_BY_ID[b.teamId];
    const [da, setDa] = useState(null), [db, setDb] = useState(null);

    useEffect(() => { setDa(null); window.fetchPlayer(a.teamId, a.name).then(setDa).catch(() => setDa(false)); }, [a.teamId, a.name]);
    useEffect(() => { setDb(null); window.fetchPlayer(b.teamId, b.name).then(setDb).catch(() => setDb(false)); }, [b.teamId, b.name]);

    const hero = (
      <VersusHero
        left={{ team: ta, name: a.name, kicker: a.num ? `#${a.num}` : null, sub: `${a.pos || "—"} · ${ta.name}` }}
        right={{ team: tb, name: b.name, kicker: b.num ? `#${b.num}` : null, sub: `${b.pos || "—"} · ${tb.name}` }}
        onSwap={onSwap}
      />
    );

    let body;
    if (da === null || db === null) {
      body = <div className="loading-block">Loading players…</div>;
    } else if (da === false || db === false) {
      body = <div className="loading-block">No saved game data for one of these players.</div>;
    } else {
      const seaA = latestSeason(da), seaB = latestSeason(db);
      const batBoth = seaA && seaA.batting && seaB && seaB.batting;
      const pitBoth = seaA && seaA.pitching && seaB && seaB.pitching;
      if (!batBoth && !pitBoth) {
        body = (
          <div className="cmp-mismatch">
            <div className="cmp-mismatch__title">Can’t compare these two</div>
            <div className="cmp-mismatch__sub">
              {a.name} and {b.name} don’t share a statline — pick two batters or two pitchers
              to see head-to-head numbers.
            </div>
          </div>
        );
      } else {
        const set = batBoth ? PLAYER_BAT : PLAYER_PIT;
        const blockA = batBoth ? seaA.batting : seaA.pitching;
        const blockB = batBoth ? seaB.batting : seaB.pitching;
        const rows = set.map((st) => {
          const ga = pstat(blockA, st), gb = pstat(blockB, st);
          return { label: st.label.toUpperCase(), dir: st.dir, valA: ga.val, valB: gb.val, dispA: ga.disp, dispB: gb.disp };
        });
        body = (
          <StatBars
            title={(batBoth ? "Batting" : "Pitching") + " Statline"}
            num="01"
            rows={rows}
            left={{ color: ta.color, name: a.name.split(",")[0] }}
            right={{ color: tb.color, name: b.name.split(",")[0] }}
          />
        );
      }
    }

    return (
      <React.Fragment>
        {hero}
        <div className="cmp-sections">{body}</div>
      </React.Fragment>
    );
  }

  // ── root ─────────────────────────────────────────────────────────────────--
  const Compare = () => {
    const teams = window.TEAMS;
    const [mode, setMode] = useState("teams");
    const [aId, setAId] = useState(teams[0].id);
    const [bId, setBId] = useState(teams[1] ? teams[1].id : teams[0].id);

    const [players, setPlayers] = useState(null);
    const [pErr, setPErr] = useState(null);
    const [pa, setPa] = useState(null);
    const [pb, setPb] = useState(null);
    const [ptA, setPtA] = useState(null); // team filtering side A's player list
    const [ptB, setPtB] = useState(null);

    // Lazily load every team's roster the first time Players mode is opened,
    // and flatten into one searchable list.
    useEffect(() => {
      if (mode !== "players" || players || pErr) return;
      Promise.all(teams.map((t) =>
        window.fetchRoster(t.id).then(
          (list) => list.map((p) => ({ ...p, teamId: t.id, teamName: t.name })),
          () => []
        )
      )).then((lists) => {
        const flat = [].concat(...lists);
        setPlayers(flat);
        // Seed with a batter from each of the two top teams so the default
        // matchup has two distinct team colors (a same-team default makes the
        // split bars hard to read).
        const firstBatter = (tid) => flat.find((p) => p.teamId === tid && p.role !== "Pitcher");
        const bats = flat.filter((p) => p.role !== "Pitcher");
        const p1 = (teams[0] && firstBatter(teams[0].id)) || bats[0] || flat[0];
        const p2 = (teams[1] && firstBatter(teams[1].id)) || bats.find((p) => p !== p1) || flat[1];
        if (p1 && p2) { setPa(p1); setPb(p2); setPtA(p1.teamId); setPtB(p2.teamId); }
      }).catch((e) => setPErr(e.message));
    }, [mode, players, pErr]);

    const swapTeams = () => { setAId(bId); setBId(aId); };
    const swapPlayers = () => {
      setPa(pb); setPb(pa); setPtA(ptB); setPtB(ptA);
    };

    // Switching a side's team auto-selects that team's first batter (else any
    // player) so the side never ends up empty.
    const firstOf = (tid) => {
      const list = (players || []).filter((p) => p.teamId === tid);
      return list.find((p) => p.role !== "Pitcher") || list[0] || null;
    };
    const setSideTeam = (side, t) => {
      if (side === "A") { setPtA(t.id); setPa(firstOf(t.id)); }
      else { setPtB(t.id); setPb(firstOf(t.id)); }
    };

    const colorA = mode === "teams" ? window.TEAM_BY_ID[aId].color
      : (ptA && (window.TEAM_BY_ID[ptA] || {}).color);
    const colorB = mode === "teams" ? window.TEAM_BY_ID[bId].color
      : (ptB && (window.TEAM_BY_ID[ptB] || {}).color);

    return (
      <div className="cmp">
        <header className="cmp-top">
          <Eyebrow>2026 Season · Head-to-Head</Eyebrow>
          <h1 className="display">Compare</h1>
          <div className="cmp-modes">
            <button className={"cmp-mode" + (mode === "teams" ? " active" : "")} onClick={() => setMode("teams")}>Teams</button>
            <button className={"cmp-mode" + (mode === "players" ? " active" : "")} onClick={() => setMode("players")}>Players</button>
          </div>
        </header>

        <div className="cmp-pickers">
          {mode === "teams" ? (
            <React.Fragment>
              <TeamPicker teams={teams} value={window.TEAM_BY_ID[aId]} onChange={(t) => setAId(t.id)} color={colorA} />
              <button className="cmp-swap" onClick={swapTeams} title="Swap">⇄</button>
              <TeamPicker teams={teams} value={window.TEAM_BY_ID[bId]} onChange={(t) => setBId(t.id)} color={colorB} />
            </React.Fragment>
          ) : !players ? (
            <div className="loading-block" style={{ gridColumn: "1 / -1" }}>
              {pErr ? `Could not load rosters — ${pErr}` : "Loading rosters…"}
            </div>
          ) : (
            <React.Fragment>
              <div className="cmp-side">
                <TeamSelectMini teams={teams} value={window.TEAM_BY_ID[ptA]} onChange={(t) => setSideTeam("A", t)} color={colorA} />
                <PlayerPicker players={players.filter((p) => p.teamId === ptA)} value={pa} onChange={setPa} color={colorA} />
              </div>
              <button className="cmp-swap" onClick={swapPlayers} title="Swap">⇄</button>
              <div className="cmp-side">
                <TeamSelectMini teams={teams} value={window.TEAM_BY_ID[ptB]} onChange={(t) => setSideTeam("B", t)} color={colorB} />
                <PlayerPicker players={players.filter((p) => p.teamId === ptB)} value={pb} onChange={setPb} color={colorB} />
              </div>
            </React.Fragment>
          )}
        </div>

        {mode === "teams" ? (
          <TeamCompare aId={aId} bId={bId} onSwap={swapTeams} />
        ) : pa && pb ? (
          <PlayerCompare a={pa} b={pb} onSwap={swapPlayers} />
        ) : null}
      </div>
    );
  };

  window.Compare = Compare;
})();
