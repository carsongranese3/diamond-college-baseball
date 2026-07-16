"""Read locally-saved stats.ncaa.org data from the 2026/<Team>/ folders.

The website normally pulls from ncaa.com (via ncaa.py). This module lets it
prefer the richer locally-saved data (real play-by-play, pitcher strikeouts,
stolen bases) when a team/game has been pulled with pull_game_stats.py, and
return None when it hasn't — so the caller can fall back to the API.

Game detail and team stats are produced in the same shapes as gamedetail.py
and stats.py so the rest of the app/frontend needs no special-casing.
"""

import datetime
import json
import os
import re

import ncaa
import phase
from boxutil import (babip, fip, fmt2, fmt3, fmt_pct, ip_to_outs, lob_pct,
                     outs_to_ip, per9, ratio, runs_created, secondary_avg,
                     team_leaders, to_int)
from colors import for_seo

DATA_ROOT = os.path.join(os.path.dirname(__file__), "2026")
_SF_DATALESS = 0x40000000  # macOS: file contents evicted to iCloud (won't read fast)


def _dataless(path):
    """True if the file's contents are offloaded to iCloud — reading would block
    on a slow download. Callers treat this like a missing file and move on."""
    try:
        return bool(os.stat(path).st_flags & _SF_DATALESS)
    except (OSError, AttributeError):
        return False


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


# Box-score "P" codes that are lineup roles, not fielding positions. We ignore
# these when a player has any real fielding position so the displayed spot is
# where they actually played (not where they happened to pinch-hit/run).
_PSEUDO_POS = {"PH", "PR", "OUT", "DP"}


def primary_position(code):
    """Reduce one game's raw 'P'-column code to a single position token.
    Splits compound codes ('PR/CF', '2B/3B', '/DH') and prefers a real fielding
    position over a pinch role within that game. Returns '' for an empty code."""
    toks = [t.strip().upper() for t in (code or "").split("/") if t.strip()]
    for t in toks:
        if t not in _PSEUDO_POS:
            return t
    return toks[0] if toks else ""


def most_played_position(counts, default=""):
    """Given {raw_code: games}, return the position a player played the most.
    Normalizes compound codes and drops pinch roles (PH/PR/...) whenever the
    player has at least one real fielding position. Ties resolve to the most
    games, then to the position seen first (insertion order of `counts`)."""
    agg = {}
    for code, n in counts.items():
        pos = primary_position(code)
        if pos:
            agg[pos] = agg.get(pos, 0) + n
    if not agg:
        return default
    real = {p: n for p, n in agg.items() if p not in _PSEUDO_POS}
    pool = real or agg
    return max(pool, key=lambda k: pool[k])


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-") or "opp"


def _clean_opp(name):
    """Strip the cruft stats.ncaa.org adds to neutral-site/tournament opponents,
    e.g. '#8 Mississippi St. @Hoover, AL (2026 SEC Baseball Championship)'
    -> 'Mississippi St.' (so it matches an SEC team and gets the right logo).
    Opponents come in three shapes:
      '#2 Wake Forest @Granville, WV (2026 NCAA ... Championship)'  (@venue + paren)
      '#4 Rider 2026 NCAA Division I Baseball Championship'         (bare event tag)
      '#3 Texas A&M'                                                (just a rank)"""
    s = re.sub(r"\s*@.*$", "", name or "")     # drop "@Venue, ST (Event)" onward
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s)      # drop a trailing "(...)" if no @
    # Drop a trailing event tag with no @/parens, e.g. "... 2026 NCAA ...
    # Championship" or "... 2026 SEC Baseball Tournament" — cut from the year on.
    s = re.sub(r"\s+\d{4}\s+(?:NCAA|SEC)\b.*$", "", s)
    s = re.sub(r"^#\d+\s+", "", s)              # drop a leading rank like "#8 "
    return s.strip()


def _phase(raw_opponent, iso=None):
    """The round label for a game (delegates to phase.game_phase): 'regular', or a
    postseason round (SEC Tournament / NCAA Regional / Super Regional / CWS)
    resolved from the event text stats.ncaa.org appends + the game's date."""
    return phase.game_phase(raw_opponent, iso)


def _iso(mmddyyyy):
    # re.match (not strptime) so a doubleheader suffix like "02/14/2026(1)" parses.
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", mmddyyyy or "")
    return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else (mmddyyyy or "")


def _fmt_date(mmddyyyy):
    """'05/16/2026' (or '05/16/2026(1)') -> 'May 16'."""
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", mmddyyyy or "")
    if not m:
        return mmddyyyy or ""
    try:
        dt = datetime.date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
        return dt.strftime("%b ") + str(dt.day)
    except ValueError:
        return mmddyyyy or ""


def _is_team_dir(path):
    """A team folder holds the per-team data files; a conference folder holds team
    folders. Used to tell the two layout levels apart so both <year>/<Team>/ and
    <year>/<Conference>/<Team>/ resolve."""
    return (os.path.exists(os.path.join(path, "schedule.json"))
            or os.path.isdir(os.path.join(path, "schedule"))
            or os.path.isdir(os.path.join(path, "stats")))


def _find_dir(seo, name, root=None):
    """Locate a team's folder by matching its seo or display name, under either the
    flat <root>/<Team>/ layout or the conference-nested <root>/<Conference>/<Team>/
    one. Defaults to the current-season root (DATA_ROOT)."""
    root = root or DATA_ROOT
    if not os.path.isdir(root):
        return None
    targets = {_norm(seo), _norm(name)}
    targets.discard("")
    if not targets:
        return None
    for d in os.listdir(root):
        full = os.path.join(root, d)
        if not os.path.isdir(full):
            continue
        if _norm(d) in targets:
            return full                       # flat: <root>/<Team>
        if not _is_team_dir(full):            # conference folder — look one level in
            for sub in os.listdir(full):
                subfull = os.path.join(full, sub)
                if os.path.isdir(subfull) and _norm(sub) in targets:
                    return subfull            # nested: <root>/<Conf>/<Team>
    return None


def team_dirs(root=None):
    """[(label, path)] for every team folder under root, descending one conference
    level for the <root>/<Conference>/<Team>/ layout (and still handling a flat
    <root>/<Team>/ one). `label` is the team folder name. Used by the build scripts
    to enumerate teams without assuming a flat layout."""
    root = root or DATA_ROOT
    if not os.path.isdir(root):
        return []
    out = []
    for d in sorted(os.listdir(root)):
        full = os.path.join(root, d)
        if not os.path.isdir(full):
            continue
        if _is_team_dir(full):
            out.append((d, full))
        else:                                 # conference folder
            for sub in sorted(os.listdir(full)):
                subfull = os.path.join(full, sub)
                if os.path.isdir(subfull) and _is_team_dir(subfull):
                    out.append((sub, subfull))
    return out


def _year_roots():
    """[(year:int, path)] for each sibling 4-digit-year data folder, newest first.
    Lets player histories span seasons as 2025/, 2024/, … are added later."""
    base = os.path.dirname(DATA_ROOT)
    roots = []
    for d in os.listdir(base):
        full = os.path.join(base, d)
        if re.fullmatch(r"\d{4}", d) and os.path.isdir(full):
            roots.append((int(d), full))
    return sorted(roots, reverse=True)


def _load(game_dir):
    out = {}
    for key, fname in (("box", "boxscore.json"), ("players", "player_stats.json"),
                       ("plays", "play_by_play.json")):
        path = os.path.join(game_dir, fname)
        if not os.path.exists(path) or _dataless(path):
            return None  # iCloud-offloaded games are skipped, not stalled on
        try:
            with open(path, encoding="utf-8") as fh:
                out[key] = json.load(fh)
        except (json.JSONDecodeError, OSError):
            return None
    return out


def _load_detailed(game_dir):
    """Optionally load play_by_play_detailed.json; returns parsed dict or None.
    A missing, iCloud-offloaded, or corrupt file returns None without raising —
    the caller treats it as absent and sets pbp=[]."""
    path = os.path.join(game_dir, "play_by_play_detailed.json")
    if not os.path.exists(path) or _dataless(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


def _ordinal(n):
    """Return ordinal suffix string for integer n (1->'1ST', 2->'2ND', …)."""
    if n == 1:
        return "1ST"
    if n == 2:
        return "2ND"
    if n == 3:
        return "3RD"
    if 11 <= (n % 100) <= 13:
        return f"{n}TH"
    last = n % 10
    if last == 1:
        return f"{n}ST"
    if last == 2:
        return f"{n}ND"
    if last == 3:
        return f"{n}RD"
    return f"{n}TH"


def _build_pbp(detailed):
    """Map play_by_play_detailed.json's plays list into grouped half-inning dicts.
    Returns [] when detailed is falsy or has no usable plays."""
    if not detailed:
        return []
    raw_plays = detailed.get("plays") or []
    if not raw_plays:
        return []

    halves = []
    current_inning_str = None
    current_half = None
    current_plays = []

    def _flush(inning_str, plays):
        """Build one half-inning group from accumulated plays."""
        # Parse "Top 1" / "Bottom 9" / "Bot 3" etc.
        parts = inning_str.split() if inning_str else []
        half_word = parts[0].lower() if parts else ""
        if half_word in ("top",):
            half = "top"
        elif half_word in ("bottom", "bot"):
            half = "bottom"
        else:
            half = half_word  # best-effort
        try:
            inn_num = int(parts[1]) if len(parts) > 1 else 0
        except (ValueError, IndexError):
            inn_num = 0
        label = f"{'TOP' if half == 'top' else 'BOT'} {_ordinal(inn_num)}" if inn_num else inning_str
        batting_side = "away" if half == "top" else "home"

        mapped = []
        total_runs = 0
        last_score = {"away": 0, "home": 0}
        for p in plays:
            try:
                ra = p.get("runners_after") or {}
                bases = {
                    "1B": ra.get("1B") is not None,
                    "2B": ra.get("2B") is not None,
                    "3B": ra.get("3B") is not None,
                }
                rs = p.get("runs_scored") or []
                p_runs = len(rs)
                total_runs += p_runs
                sc = p.get("score") or {"away": 0, "home": 0}
                last_score = {"away": to_int(sc.get("away")), "home": to_int(sc.get("home"))}
                mapped.append({
                    "batter": p.get("batter") or "",
                    "pitcher": p.get("pitcher") or "",
                    "outcome": p.get("outcome") or "—",
                    "count": p.get("count") or "",
                    "pitches": p.get("pitches") or "",
                    "outsAfter": to_int(p.get("outs_after")),
                    "bases": bases,
                    "runs": p_runs,
                    "rbi": bool(p.get("rbi")),
                    "score": last_score,
                    "description": p.get("description") or "",
                })
            except Exception:
                continue  # skip a malformed play rather than 500
        return {
            "half": half,
            "inning": inn_num,
            "label": label,
            "battingSide": batting_side,
            "plays": mapped,
            "scoreAfter": last_score,
            "runs": total_runs,
        }

    for play in raw_plays:
        try:
            inn_str = play.get("inning") or ""
        except Exception:
            continue
        if inn_str != current_inning_str:
            if current_inning_str is not None and current_plays:
                halves.append(_flush(current_inning_str, current_plays))
            current_inning_str = inn_str
            current_plays = []
        current_plays.append(play)

    if current_inning_str is not None and current_plays:
        halves.append(_flush(current_inning_str, current_plays))

    return halves


def _iter_games(team_dir):
    sched_dir = os.path.join(team_dir, "schedule")
    if not os.path.isdir(sched_dir):
        return
    for d in sorted(os.listdir(sched_dir)):
        full = os.path.join(sched_dir, d)
        if os.path.isdir(full):
            data = _load(full)
            if data:
                yield full, data


def _host_side(data, team_name):
    """Which side ('home'/'away') in this game's line score / player_stats belongs
    to team_name. box['home'] is unreliable for neutral-site (tournament) games,
    so match by name — the team, then the cleaned opponent — before falling back."""
    box = data.get("box", {})
    ls = box.get("line_score") or {}
    hn = _norm((ls.get("home") or {}).get("name"))
    an = _norm((ls.get("away") or {}).get("name"))
    tn = _norm(team_name)
    oppn = _norm(_clean_opp(box.get("opponent", "")))
    if tn and tn == hn:
        return "home"
    if tn and tn == an:
        return "away"
    if oppn and oppn == hn:
        return "away"
    if oppn and oppn == an:
        return "home"
    return "home" if box.get("home") else "away"


# ── Team season stats (built from the per-team stats/ season-total files) ────
def team_stats(seo, name):
    """Team season stats for the team page, built entirely from the team's
    stats/ files (stats/batting.json + stats/pitching.json — basic counting
    stats only; every rate/derived stat, plus W/L/SV, is computed here). Returns
    None when those files don't exist yet, so the caller falls back to the live
    API path. (Fielding isn't carried in the stats files yet, so it renders "—".)"""
    team_dir = _find_dir(seo, name)
    if not team_dir:
        return None
    stats_dir = os.path.join(team_dir, "stats")
    try:
        with open(os.path.join(stats_dir, "batting.json"), encoding="utf-8") as fh:
            bat_raw = json.load(fh).get("players") or []
        with open(os.path.join(stats_dir, "pitching.json"), encoding="utf-8") as fh:
            pit_raw = json.load(fh).get("players") or []
    except (OSError, ValueError):
        return None  # stats files not built yet -> caller falls back to the API path

    # Fielding is optional: older data has no fielding.json -> keep placeholders.
    try:
        with open(os.path.join(stats_dir, "fielding.json"), encoding="utf-8") as fh:
            fld_raw = json.load(fh).get("players") or []
    except (OSError, ValueError):
        fld_raw = []

    batters = []
    for b in bat_raw:
        ab, h, bb = to_int(b.get("ab")), to_int(b.get("h")), to_int(b.get("bb"))
        hbp, sf, tb = to_int(b.get("hbp")), to_int(b.get("sf")), to_int(b.get("tb"))
        sh = to_int(b.get("sh"))
        k, sb, cs, hr = to_int(b.get("so")), to_int(b.get("sb")), to_int(b.get("cs")), to_int(b.get("hr"))
        pa = to_int(b.get("pa")) or (ab + bb + hbp + sf)
        avg = h / ab if ab else 0.0
        obp = (h + bb + hbp) / (ab + bb + hbp + sf) if (ab + bb + hbp + sf) else 0.0
        slg = tb / ab if ab else 0.0
        batters.append({
            "name": b.get("name", ""), "pos": b.get("pos", ""), "num": b.get("num", ""),
            "g": to_int(b.get("g")), "ab": ab, "pa": pa, "r": to_int(b.get("r")),
            "h": h, "hr": hr, "rbi": to_int(b.get("rbi")), "bb": bb, "k": k, "sb": sb,
            "avg": fmt3(avg), "obp": fmt3(obp), "slg": fmt3(slg), "ops": fmt3(obp + slg),
            # Full counting line (so the team-page column picker can show any of them).
            "1b": to_int(b.get("1b")), "2b": to_int(b.get("2b")), "3b": to_int(b.get("3b")),
            "tb": tb, "ibb": to_int(b.get("ibb")), "hbp": hbp, "sf": sf, "sh": sh, "cs": cs,
            # Batted-ball types + PA outcomes from the play-by-play.
            "gb": to_int(b.get("gb")), "fb": to_int(b.get("fb")),
            "ld": to_int(b.get("ld")), "pu": to_int(b.get("pu")),
            "ks": to_int(b.get("ks")), "kl": to_int(b.get("kl")),
            "roe": to_int(b.get("roe")), "fc": to_int(b.get("fc")),
            "ci": to_int(b.get("ci")), "po": to_int(b.get("po")),
            "outs": (ab - h) + sf + sh,    # outs made at the plate
            # Advanced — all built from the stored counting stats.
            "bbpct": fmt_pct(bb / pa) if pa else "—",
            "kpct": fmt_pct(k / pa) if pa else "—",
            "babip": babip(h, hr, ab, k, sf),
            "secavg": secondary_avg(tb, h, bb, sb, cs, ab),
            "rc": runs_created(h, bb, tb, ab),
            "_tb": tb, "_hbp": hbp,
        })
    batters.sort(key=lambda x: x["ab"], reverse=True)

    pitchers = []
    for p in pit_raw:
        outs = to_int(p.get("outs"))
        ipnum = outs / 3 if outs else 0.0
        h, r, er = to_int(p.get("h")), to_int(p.get("r")), to_int(p.get("er"))
        bb, k, bf = to_int(p.get("bb")), to_int(p.get("so")), to_int(p.get("bf"))
        hra, hbp = to_int(p.get("hr_a")), to_int(p.get("hb"))
        era = (er * 9 / ipnum) if ipnum else 0.0
        whip = ((bb + h) / ipnum) if ipnum else 0.0
        kbb_pct = ((k - bb) / bf) if bf else None
        pitchers.append({
            "name": p.get("name", ""), "pos": p.get("pos", "P"), "num": p.get("num", ""),
            "g": to_int(p.get("g")), "gs": to_int(p.get("gs")),
            # W / L / SV now come straight from the stats file.
            "w": to_int(p.get("w")), "l": to_int(p.get("l")), "sv": to_int(p.get("s")),
            "ip": p.get("ip") or outs_to_ip(outs),
            "h": h, "r": r, "er": er, "bb": bb, "k": k,
            "ks": to_int(p.get("ks")), "kl": to_int(p.get("kl")),
            # Full counting line for the column picker: outs, unearned runs, inherited
            # runners, batted-ball types, GIDP, pitch counts, and the allowed-hit line.
            "outs": outs, "ur": r - er, "bf": bf,
            "ibb": to_int(p.get("ibb")), "hbp": hbp, "wp": to_int(p.get("wp")),
            "bk": to_int(p.get("bk")), "hr": hra,
            "2b": to_int(p.get("2b_a")), "3b": to_int(p.get("3b_a")),
            "ir": to_int(p.get("ir")), "irs": to_int(p.get("irs")),
            "gb": to_int(p.get("gb")), "fb": to_int(p.get("fb")),
            "ld": to_int(p.get("ld")), "pu": to_int(p.get("pu")),
            "gidp": to_int(p.get("gidp")),
            "pt": to_int(p.get("pt")), "strikes": to_int(p.get("strikes")),
            "balls": to_int(p.get("balls")),
            "era": fmt2(era), "whip": fmt2(whip),
            "k9": per9(k, outs), "bb9": per9(bb, outs), "hr9": per9(hra, outs),
            "kbb": ratio(k, bb), "fip": fip(hra, bb, hbp, k, outs),
            "kbbpct": fmt_pct(kbb_pct) if kbb_pct is not None else "—",
            "lobpct": lob_pct(h, bb, hbp, r, hra),
            "_outs": outs, "_hra": hra,
        })
    pitchers.sort(key=lambda x: x["_outs"], reverse=True)

    if not batters and not pitchers:
        return None

    tab = sum(b["ab"] for b in batters)
    th = sum(b["h"] for b in batters)
    tbb = sum(b["bb"] for b in batters)
    thbp = sum(b["_hbp"] for b in batters)
    ttb = sum(b["_tb"] for b in batters)
    p_outs = sum(p["_outs"] for p in pitchers)
    p_ipnum = p_outs / 3 if p_outs else 0.0
    p_er = sum(p["er"] for p in pitchers)
    p_h = sum(p["h"] for p in pitchers)
    p_bb = sum(p["bb"] for p in pitchers)
    p_k = sum(p["k"] for p in pitchers)
    p_hra = sum(p["_hra"] for p in pitchers)
    total_sv = sum(p["sv"] for p in pitchers)
    # Opponent batting average against the staff — H / (BF − BB − HBP).
    p_bf = sum(p["bf"] for p in pitchers)
    p_hbp = sum(p["hbp"] for p in pitchers)
    p_ab = p_bf - p_bb - p_hbp
    team_oba = fmt3(p_h / p_ab) if p_ab > 0 else "—"

    _qual = [b for b in batters if b["ab"] >= max(20, tab // 80)]
    avg_l = max(_qual, key=lambda r: float(r["avg"] or 0), default=None)
    obp_l = max(_qual, key=lambda r: float(r["obp"] or 0), default=None)
    rbi_l = max(batters, key=lambda r: r["rbi"], default=None)
    hr_l = max(batters, key=lambda r: r["hr"], default=None)
    # ERA leader: lowest ERA among pitchers with enough innings (60 outs = 20 IP).
    era_l = min((p for p in pitchers if p["_outs"] >= 60),
                key=lambda r: float(r["era"] or 99), default=None)
    k_l = max(pitchers, key=lambda r: r["k"], default=None)
    # Wins and saves leaders are now available from the stats data.
    sv_l = max((p for p in pitchers if p["sv"] > 0), key=lambda r: r["sv"], default=None)
    w_l = max((p for p in pitchers if p["w"] > 0), key=lambda r: r["w"], default=None)
    leaders = team_leaders(avg_l, obp_l, rbi_l, hr_l, era_l,
                           k_l if (k_l and k_l["k"] > 0) else None, sv_l, w_l)

    for b in batters:
        b.pop("_tb", None); b.pop("_hbp", None)
    for p in pitchers:
        p.pop("_outs", None); p.pop("_hra", None)

    # Fielding: per-player rows (with computed fielding %) + team totals. Team
    # double plays come from staff GIDP induced, NOT the sum of per-player DP
    # (one double play credits several fielders, so summing IDP overcounts).
    fielders = []
    f_po = f_a = f_e = f_tp = f_pb = f_sba = f_csb = 0
    for fr in fld_raw:
        # `pos` is a list of per-position stat lines; add fielding % to each and
        # roll them up into the player's overall totals.
        positions = []
        t_po = t_a = t_e = t_g = 0
        for ent in fr.get("pos") or []:
            po, a, e = to_int(ent.get("po")), to_int(ent.get("a")), to_int(ent.get("e"))
            ch = po + a + e
            f_po += po; f_a += a; f_e += e
            f_tp += to_int(ent.get("tp")); f_pb += to_int(ent.get("pb"))
            f_sba += to_int(ent.get("sba")); f_csb += to_int(ent.get("csb"))
            t_po += po; t_a += a; t_e += e; t_g += to_int(ent.get("g"))
            entd = {
                "pos": ent.get("pos", ""), "g": to_int(ent.get("g")),
                "po": po, "a": a, "e": e, "tc": to_int(ent.get("tc")) or ch,
                "dp": to_int(ent.get("dp")), "tp": to_int(ent.get("tp")),
                "fpct": fmt3((po + a) / ch) if ch else "—",
            }
            if ent.get("pos") == "C":  # catcher-only stats
                entd.update(ci=to_int(ent.get("ci")), pb=to_int(ent.get("pb")),
                            sba=to_int(ent.get("sba")), csb=to_int(ent.get("csb")))
            elif ent.get("pos") in ("LF", "CF", "RF", "OF"):  # outfield assists
                entd["ofa"] = to_int(ent.get("ofa"))
            positions.append(entd)
        t_ch = t_po + t_a + t_e
        fielders.append({
            "name": fr.get("name", ""), "num": fr.get("num", ""),
            "pos": positions[0]["pos"] if positions else "",  # primary, for convenience
            "g": t_g, "tc": t_ch, "po": t_po, "a": t_a, "e": t_e,
            "fpct": fmt3((t_po + t_a) / t_ch) if t_ch else "—",
            "positions": positions,
        })
    fielders.sort(key=lambda x: x["tc"], reverse=True)
    team_chances = f_po + f_a + f_e
    team_fpct = fmt3((f_po + f_a) / team_chances) if team_chances else "—"
    team_dp = sum(to_int(p.get("gidp")) for p in pit_raw)

    games = max([b["g"] for b in batters] + [p["g"] for p in pitchers] + [0])
    b_avg = th / tab if tab else 0.0
    b_obp = (th + tbb + thbp) / (tab + tbb + thbp) if (tab + tbb + thbp) else 0.0
    b_slg = ttb / tab if tab else 0.0

    return {
        "_games": games, "_source": "local-stats",
        "batting": {"avg": fmt3(b_avg), "obp": fmt3(b_obp), "slg": fmt3(b_slg),
                    "hr": sum(b["hr"] for b in batters),
                    "rbi": sum(b["rbi"] for b in batters), "sb": sum(b["sb"] for b in batters),
                    "runs": sum(b["r"] for b in batters), "h": th},
        "pitching": {"era": fmt2((p_er * 9 / p_ipnum) if p_ipnum else 0.0),
                     "whip": fmt2(((p_bb + p_h) / p_ipnum) if p_ipnum else 0.0),
                     "k": p_k, "bb": p_bb, "sv": total_sv, "ip": outs_to_ip(p_outs),
                     "hr_a": p_hra, "oba": team_oba},
        "fielding": ({"pct": team_fpct, "fp": team_fpct,
                      "po": f_po, "a": f_a, "e": f_e, "tc": team_chances,
                      "dp": team_dp, "tp": f_tp,
                      "pb": f_pb, "sba": f_sba, "csb": f_csb}
                     if fielders else
                     {k: "—" for k in ("pct", "fp", "po", "a", "e", "tc",
                                       "dp", "tp", "pb", "sba", "csb")}),
        "leaders": leaders,
        "roster": {"batters": batters, "pitchers": pitchers, "fielders": fielders},
    }


# ── Single game detail (line score + box + play-by-play) ─────────────────────
def _side(name, seo, ls):
    col = for_seo(seo)
    return {
        "name": name, "seo": seo,
        "mark": (("".join(w[0] for w in name.split()) or name)[:4]).upper(),
        "logo": ncaa.logo_url(seo) if seo else "",
        "color": col["color"], "ink": col["ink"],
        "innings": ls.get("innings", []),
        "r": to_int(ls.get("r")), "h": to_int(ls.get("h")), "e": to_int(ls.get("e")),
    }


def _is_totals_row(row, team_name):
    """The box score ends with a team-totals row whose Name is the school name.
    Detect it so it isn't shown as a 'player'. Matches the row's Name against the
    team name (normalized); falls back to a no-jersey-#/no-position row only when
    no team name was supplied."""
    nm = _norm(row.get("Name"))
    if team_name:
        return bool(nm) and nm == _norm(_clean_opp(team_name))
    return not (row.get("#") or "").strip() and not (row.get("P") or "").strip()


def _box_rows_bat(rows, team_name=""):
    out = []
    for row in rows or []:
        if _is_totals_row(row, team_name):
            continue
        ab = to_int(row.get("AB"))
        out.append({
            "name": row.get("Name", ""), "pos": row.get("P", ""),
            "ab": ab, "r": to_int(row.get("R")), "h": to_int(row.get("H")),
            "rbi": to_int(row.get("RBI")), "bb": to_int(row.get("BB")),
            "k": to_int(row.get("K")),
            "avg": fmt3(to_int(row.get("H")) / ab) if ab else "",
        })
    return out


def _box_rows_pit(rows, team_name=""):
    out = []
    for row in rows or []:
        if _is_totals_row(row, team_name):
            continue
        outs = ip_to_outs(row.get("IP"))
        er = to_int(row.get("ER"))
        out.append({
            "name": row.get("Name", ""), "ip": str(row.get("IP", "")),
            "h": to_int(row.get("H")), "r": to_int(row.get("R")), "er": er,
            "bb": to_int(row.get("BB")), "k": to_int(row.get("SO")),
            "era": fmt2(er * 9 / (outs / 3)) if outs else "—", "dec": "—",
        })
    return out


_DEC_LETTER = {"win": "W", "loss": "L", "save": "S"}


def _match_pitcher(rows, dec_name):
    """The pitcher row matching a decision's name — exact normalized full name,
    then last-name fallback (the box rows and the decision use the same First Last
    form, but the fallback guards small spelling differences)."""
    target = _norm(dec_name)
    if not target:
        return None
    for r in rows:
        if _norm(r.get("name")) == target:
            return r
    last = _last(dec_name)
    for r in rows:
        if last and _last(r.get("name")) == last:
            return r
    return None


def _last(full):
    parts = (full or "").replace(",", " ").split()
    return re.sub(r"[^a-z]", "", parts[-1].lower()) if parts else ""


def _apply_decisions(pitchers, decisions):
    """Stamp W / L / S onto the matching pitcher row's `dec`, using each decision's
    side (away/home) and name. A pitcher with two decisions gets them joined."""
    for key, dec in (decisions or {}).items():
        if not dec:
            continue
        row = _match_pitcher(pitchers.get(dec.get("side")) or [], dec.get("name"))
        if not row:
            continue
        letter = _DEC_LETTER.get(key, "")
        cur = row.get("dec")
        row["dec"] = letter if cur in (None, "", "—") else f"{cur},{letter}"


def game(seo, name, iso, host_runs=None, opp_seo=None):
    """Game detail from the local folder matching (team, date[, host runs]).

    opp_seo is the opponent's ncaa.com slug (from the schedule) — used for the
    opponent logo, since the stats.ncaa.org opponent NAME often slugs to a
    different value (e.g. "Lamar University" vs "lamar") and would 404.
    """
    team_dir = _find_dir(seo, name)
    if not team_dir:
        return None
    want_runs = to_int(host_runs, None) if host_runs not in (None, "") else None

    for _dir, data in _iter_games(team_dir):
        box = data["box"]
        if _iso(box.get("date")) != iso:
            continue
        # Which line_score slot is THIS team — matched by name, since the saved
        # box["home"] flag can disagree with the line_score's home/away slots
        # for neutral-site games (the flag and the slots come from different
        # fields and aren't always consistent).
        host_side = _host_side(data, name)
        ls = box.get("line_score") or {}
        if want_runs is not None and to_int((ls.get(host_side) or {}).get("r")) != want_runs:
            continue  # doubleheader: disambiguate by the host team's run total

        opp_name = box.get("opponent", "")
        opp = opp_seo or _slug(opp_name)  # prefer the ncaa.com slug for the logo
        if host_side == "home":
            home_seo, away_seo = seo, opp
        else:
            home_seo, away_seo = opp, seo

        away_ls = ls.get("away") or {}
        home_ls = ls.get("home") or {}
        away = _side(away_ls.get("name", opp_name), away_seo, away_ls)
        home = _side(home_ls.get("name", name), home_seo, home_ls)
        players = data["players"]
        info = box.get("info") or {}
        decisions = box.get("decisions") or {}
        pitchers = {
            "away": _box_rows_pit((players.get("away") or {}).get("pitching"), away["name"]),
            "home": _box_rows_pit((players.get("home") or {}).get("pitching"), home["name"]),
        }
        _apply_decisions(pitchers, decisions)
        return {
            "venue": info.get("venue") or "",
            "location": info.get("location"),
            "attendance": info.get("attendance"),
            "gameDate": info.get("date"),
            "time": info.get("time"),
            "weather": None, "duration": "Final",
            "info": info, "decisions": decisions,
            "homeTeam": home_seo, "awayTeam": away_seo,
            "winner": "home" if home["r"] > away["r"] else (
                "away" if away["r"] > home["r"] else None),
            "line": {"away": away, "home": home},
            "batters": {"away": _box_rows_bat((players.get("away") or {}).get("batting"), away["name"]),
                        "home": _box_rows_bat((players.get("home") or {}).get("batting"), home["name"])},
            "pitchers": pitchers,
            "plays": data["plays"] or [],
            "pbp": _build_pbp(_load_detailed(_dir)),
            "notes": [],
            "_source": "local",
        }
    return None


# ── Per-team schedules (built entirely from the saved games) ─────────────────
# Loose box-score opponent names that don't normalize to a team's seo or display
# name. `_norm(loose name) -> canonical seo`. e.g. box scores call Miami (FL) just
# "Miami", but its seo is "miami-fl". Applied conference-scoped (see schedules()),
# so the alias only resolves when the canonical team is in that conference.
_OPP_ALIASES = {"miami": "miami-fl"}


def schedules(teams):
    """{seo: [games]} built from the local 2026/ folders, in the same shape
    season.build_season produces — so the Scores view and team schedule lists
    render unchanged. `teams` (the API-built list) supplies opponent seo/rank/logo
    for conference opponents; rankings and logos still come from the API.
    """
    # Normalized seo/name -> team, so a game's opponent can be matched to a
    # conference team (for its real logo slug, rank, and the conference flag).
    lookup, by_seo = {}, {}
    for t in teams:
        by_seo[_norm(t["id"])] = t
        for key in (_norm(t["id"]), _norm(t["name"])):
            if key:
                lookup[key] = t
    # Loose-name aliases -> the canonical team, but only when that team is in this
    # conference's list — so Miami counts as a conference opponent for the ACC yet
    # stays non-conference for a non-ACC schedule.
    for _loose, _canon in _OPP_ALIASES.items():
        _t = by_seo.get(_norm(_canon))
        if _t:
            lookup.setdefault(_loose, _t)

    out = {}
    for t in teams:
        seo, name = t["id"], t["name"]
        out[seo] = []
        team_dir = _find_dir(seo, name)
        if not team_dir:
            continue
        games = []
        for _dir, data in _iter_games(team_dir):
            box = data["box"]
            ls = box.get("line_score") or {}
            opp_name = _clean_opp(box.get("opponent", ""))
            opp_t = lookup.get(_norm(opp_name))
            # Canonical seo via alias even when the opponent isn't in THIS conference,
            # so an out-of-conference Miami still resolves to its real team/logo
            # globally (conf stays False — see below — since it's not a league game).
            opp_id = (opp_t["id"] if opp_t else
                      _OPP_ALIASES.get(_norm(opp_name)) or _slug(opp_name))
            host = _host_side(data, name)
            other = "away" if host == "home" else "home"
            us = to_int((ls.get(host) or {}).get("r"), None)
            them = to_int((ls.get(other) or {}).get("r"), None)
            res = (box.get("result") or "").strip()[:1].upper()
            games.append({
                "id": box.get("contest_id"),
                "date": _fmt_date(box.get("date")),
                "iso": _iso(box.get("date")),
                "opp": {
                    "id": opp_id,
                    "name": opp_t["name"] if opp_t else opp_name,
                    "mark": (opp_t["mark"] if opp_t else
                             (re.sub(r"[^A-Z0-9]", "", "".join(w[:1] for w in opp_name.split()).upper()) or opp_name.upper())[:4]),
                    "logo": ncaa.logo_url(opp_id),
                    "rank": opp_t["rank"] if opp_t else None,
                    "conf": opp_t is not None,
                },
                "home": host == "home",
                "score": ({"us": us, "them": them}
                          if us is not None and them is not None else None),
                "result": res if res in ("W", "L") else None,
                "time": None,
                "phase": _phase(box.get("opponent", ""), _iso(box.get("date"))),
            })
        games.sort(key=lambda g: g["iso"])
        out[seo] = games
    return out


def regular_season_records(schedules):
    """{seo: {confW, confL, ovrW, ovrL, streak}} computed from regular-season
    games only — SEC and NCAA tournament games (phase != 'regular') are excluded,
    so the standings reflect the conference regular season, not postseason play.
    `schedules` is the dict produced by schedules() above (each game carries its
    phase, result, and opponent conf flag)."""
    out = {}
    for seo, games in schedules.items():
        cw = cl = ow = ol = 0
        seq = []
        for g in sorted(games, key=lambda x: x.get("iso") or ""):
            if g.get("phase") != "regular" or g.get("result") not in ("W", "L"):
                continue
            seq.append(g["result"])
            if g["result"] == "W":
                ow += 1
                cw += 1 if g["opp"]["conf"] else 0
            else:
                ol += 1
                cl += 1 if g["opp"]["conf"] else 0
        streak = "—"
        if seq:
            last = seq[-1]
            n = 0
            for r in reversed(seq):
                if r != last:
                    break
                n += 1
            streak = f"{last}{n}"
        out[seo] = {"confW": cw, "confL": cl, "ovrW": ow, "ovrL": ol, "streak": streak}
    return out


def weekly_records(teams):
    """{seo: [week rows]} read from each team's records.json (precomputed by
    scripts/build_records.py). Each row is a cumulative weekly snapshot:
    {n, start, end, ovrW, ovrL, confW, confL}. Teams without a records.json are
    omitted. The team's folder is located the same way as everywhere else, via
    _find_dir, so the keys are seos that match the API team list."""
    out = {}
    for t in teams:
        team_dir = _find_dir(t["id"], t["name"])
        if not team_dir:
            continue
        path = os.path.join(team_dir, "records.json")
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                out[t["id"]] = json.load(fh).get("weeks") or []
        except (OSError, ValueError):
            continue
    return out


def week_player_lines(teams, start_iso, end_iso):
    """Aggregate each team's OWN players' batting & pitching counting stats across
    that team's games dated in [start_iso, end_iso] (inclusive). Returns
    {seo: {"name", "batting": {player: counts}, "pitching": {player: counts}}}.
    Only the team's side of each game is counted, so a game isn't double-counted
    from both teams' folders. Used to pick a Player of the Week from a single week.
    """
    BAT = (("AB", "ab"), ("H", "h"), ("BB", "bb"), ("HBP", "hbp"), ("TB", "tb"),
           ("HR", "hr"), ("RBI", "rbi"), ("R", "r"), ("K", "k"))
    PIT = (("H", "h"), ("R", "r"), ("ER", "er"), ("BB", "bb"), ("SO", "k"),
           ("HR-A", "hr"), ("HB", "hbp"))
    out = {}
    for t in teams:
        seo, name = t["id"], t["name"]
        team_dir = _find_dir(seo, name)
        if not team_dir:
            continue
        bat, pit = {}, {}
        for _dir, data in _iter_games(team_dir):
            iso = _iso((data.get("box") or {}).get("date"))
            if not iso or iso < start_iso or iso > end_iso:
                continue
            rows = (data.get("players") or {}).get(_host_side(data, name)) or {}
            for r in rows.get("batting") or []:
                pname = (r.get("Name") or "").strip()
                if not pname:
                    continue
                acc = bat.setdefault(pname, {"pos": r.get("P", ""),
                                             **{d: 0 for _s, d in BAT}})
                for src, dst in BAT:
                    acc[dst] += to_int(r.get(src))
            for r in rows.get("pitching") or []:
                pname = (r.get("Name") or "").strip()
                if not pname:
                    continue
                acc = pit.setdefault(pname, {"outs": 0, **{d: 0 for _s, d in PIT}})
                acc["outs"] += ip_to_outs(r.get("IP"))
                for src, dst in PIT:
                    acc[dst] += to_int(r.get(src))
        out[seo] = {"name": name, "batting": bat, "pitching": pit}
    return out


# ── Per-player career (per-season totals + game-by-game log) ─────────────────
def _bat_game_line(row):
    ab, h = to_int(row.get("AB")), to_int(row.get("H"))
    return {"ab": ab, "r": to_int(row.get("R")), "h": h, "rbi": to_int(row.get("RBI")),
            "bb": to_int(row.get("BB")), "k": to_int(row.get("K")),
            "2b": to_int(row.get("2B")), "3b": to_int(row.get("3B")),
            "hr": to_int(row.get("HR")), "sb": to_int(row.get("SB")),
            "avg": fmt3(h / ab) if ab else ""}


def _pit_game_line(row):
    outs, er = ip_to_outs(row.get("IP")), to_int(row.get("ER"))
    return {"ip": str(row.get("IP", "")), "h": to_int(row.get("H")),
            "r": to_int(row.get("R")), "er": er, "bb": to_int(row.get("BB")),
            "k": to_int(row.get("SO")),
            "era": fmt2(er * 9 / (outs / 3)) if outs else ""}


def player(seo, name, player_name):
    """Per-season batting/pitching totals + a game-by-game log for one player,
    across every saved season. Players are matched by name (jersey #s change
    year to year). Returns None if the player has no saved games.
    """
    pnorm = _norm(player_name)
    if not pnorm:
        return None
    disp = {"name": player_name, "num": "", "pos": ""}
    seasons = []

    for year, root in _year_roots():
        team_dir = _find_dir(seo, name, root)
        if not team_dir:
            continue
        b = {k: 0 for k in ("g", "ab", "r", "h", "2b", "3b", "hr", "rbi",
                            "bb", "k", "hbp", "sf", "sb")}
        p = {k: 0 for k in ("g", "outs", "h", "r", "er", "bb", "k", "bf", "hb")}
        games = []
        for _dir, data in _iter_games(team_dir):
            side = (data.get("players") or {}).get(_host_side(data, name)) or {}
            brow = next((r for r in side.get("batting", [])
                         if _norm(r.get("Name")) == pnorm), None)
            prow = next((r for r in side.get("pitching", [])
                         if _norm(r.get("Name")) == pnorm), None)
            if not (brow or prow):
                continue
            row0 = brow or prow
            disp["name"] = row0.get("Name") or disp["name"]
            disp["num"] = row0.get("#") or disp["num"]
            disp["pos"] = (brow.get("P") if brow else None) or disp["pos"] \
                or (prow.get("P") if prow else "")
            box = data["box"]
            host = _host_side(data, name)
            games.append({
                "iso": _iso(box.get("date")), "date": _fmt_date(box.get("date")),
                "opp": _clean_opp(box.get("opponent", "")), "home": host == "home",
                "result": (box.get("result") or "").strip()[:1].upper(),
                "bat": _bat_game_line(brow) if brow else None,
                "pit": _pit_game_line(prow) if prow else None,
            })
            if brow and (to_int(brow.get("AB")) or to_int(brow.get("BB"))):
                b["g"] += 1
                for src, dst in (("AB", "ab"), ("R", "r"), ("H", "h"), ("2B", "2b"),
                                 ("3B", "3b"), ("HR", "hr"), ("RBI", "rbi"),
                                 ("BB", "bb"), ("K", "k"), ("HBP", "hbp"),
                                 ("SF", "sf"), ("SB", "sb")):
                    b[dst] += to_int(brow.get(src))
            if prow and ip_to_outs(prow.get("IP")):
                p["g"] += 1
                p["outs"] += ip_to_outs(prow.get("IP"))
                for src, dst in (("H", "h"), ("R", "r"), ("ER", "er"),
                                 ("BB", "bb"), ("SO", "k"), ("BF", "bf"), ("HB", "hb")):
                    p[dst] += to_int(prow.get(src))

        if not games:
            continue
        games.sort(key=lambda g: g["iso"])

        batting = None
        if b["g"]:
            ab, h, bb, hbp, sf = b["ab"], b["h"], b["bb"], b["hbp"], b["sf"]
            tb = h + b["2b"] + 2 * b["3b"] + 3 * b["hr"]
            obp_d = ab + bb + hbp + sf
            obp = (h + bb + hbp) / obp_d if obp_d else 0.0
            slg = tb / ab if ab else 0.0
            batting = {"g": b["g"], "ab": ab, "r": b["r"], "h": h, "2b": b["2b"],
                       "3b": b["3b"], "hr": b["hr"], "rbi": b["rbi"], "bb": bb,
                       "k": b["k"], "sb": b["sb"], "avg": fmt3(h / ab if ab else 0),
                       "obp": fmt3(obp), "slg": fmt3(slg), "ops": fmt3(obp + slg)}
        pitching = None
        if p["g"]:
            ipnum = p["outs"] / 3 if p["outs"] else 0.0
            p_ab = p["bf"] - p["bb"] - p["hb"]
            pitching = {"g": p["g"], "ip": outs_to_ip(p["outs"]), "h": p["h"],
                        "r": p["r"], "er": p["er"], "bb": p["bb"], "k": p["k"],
                        "era": fmt2(p["er"] * 9 / ipnum) if ipnum else "—",
                        "whip": fmt2((p["bb"] + p["h"]) / ipnum) if ipnum else "—",
                        "oba": fmt3(p["h"] / p_ab) if p_ab > 0 else "—"}

        seasons.append({"year": year, "batting": batting,
                        "pitching": pitching, "games": games})

    if not seasons:
        return None
    return {"name": disp["name"], "num": disp["num"], "pos": disp["pos"],
            "team": name, "teamId": seo, "seasons": seasons}


# ── Roster file (built by build_roster.py) ───────────────────────────────────
# ── Team situational batting splits (from play_by_play_detailed.json) ─────────

_SPLITS_SUFFIX = {"jr", "sr", "ii", "iii", "iv", "v"}


def _splits_last_key(full):
    """Roster full name ('Carson Tinney', 'Anthony Pack Jr.') -> (last, first-init).
    Strips name suffixes so 'Pack Jr.' and 'Pack' resolve to the same last key."""
    toks = re.sub(r"[.,]", " ", full or "").split()
    if not toks:
        return None, ""
    fi = toks[0][0].lower()
    while len(toks) > 1 and toks[-1].lower() in _SPLITS_SUFFIX:
        toks.pop()
    return toks[-1].lower(), fi


def _splits_pbp_keys(name):
    """Candidate (last, first-init) interpretations of a PBP batter string.

    PBP batter fields come in several forms — 'Tinney', 'Pack Jr., Anthony',
    'Galloway, R.', 'Duplantier J'. We return every plausible reading; the caller
    keeps a play only if one of them matches a real roster surname, so garbage
    batter values (first-name-only fragments, a whole leaked play description) and
    opponent names simply never match and are dropped."""
    name = (name or "").strip()
    out = []
    if "," in name:                              # "Last, First" / "Last, F."
        last, rest = name.split(",", 1)
        ltoks = re.sub(r"[.]", " ", last).split()
        while len(ltoks) > 1 and ltoks[-1].lower() in _SPLITS_SUFFIX:
            ltoks.pop()
        if ltoks:
            out.append((ltoks[-1].lower(),
                        rest.strip()[:1].lower() if rest.strip() else ""))
        return out
    toks = re.sub(r"[.]", " ", name).split()
    while len(toks) > 1 and toks[-1].lower() in _SPLITS_SUFFIX:
        toks.pop()
    if not toks:
        return out
    if len(toks) == 1:
        out.append((toks[0].lower(), ""))
    else:
        # 'Duplantier J' -> surname is the FIRST token, 'J' a first-initial.
        if len(toks[-1]) == 1:
            out.append((toks[0].lower(), toks[-1][0].lower()))
        # 'Anthony Pack' -> surname is the LAST token (First Last).
        out.append((toks[-1].lower(), toks[0][0].lower()))
    return out


def _splits_resolve(batter_pbp, by_last):
    """Roster norm-key for a PBP batter, or None when the batter isn't on the
    batting roster (so the play is dropped rather than inventing a player)."""
    for lk, fi in _splits_pbp_keys(batter_pbp):
        cands = by_last.get(lk)
        if not cands:
            continue
        if len(cands) == 1:
            return cands[0][0]
        return next((nk for nk, f in cands if f and f == fi), cands[0][0])
    return None


# Outcome -> XBH column to increment (also scores H + AB).
_SPLITS_HIT = {"Single": "1B", "Double": "2B", "Triple": "3B", "Home run": "HR"}

# Outcomes that score a walk (BB; not AB).
_SPLITS_WALK = {"Walk", "Intentional walk"}

# Outcomes that cost an AB but not a hit (outs + reached without a hit).
_SPLITS_AB_OUT = {
    "Groundout", "Flyout", "Lineout", "Pop out", "Foul out", "Infield fly",
    "Grounded into double play",
    "Reached on error", "Fielder's choice", "Catcher interference",
}

# Outcomes where the batter put the ball in play off the bat (used for the
# pitching side's "s" contact-pitch bonus below) — same as _SPLITS_AB_OUT
# minus Catcher interference, which isn't a batted ball.
_SPLITS_CONTACT_OUT = _SPLITS_AB_OUT - {"Catcher interference"}

# A PBP name token as it appears in narrative baserunning/description text
# ("Willits, J.", "Gambill,Trey", "Brendan Brock", "GRINDLINGER", "L.
# Lawrence") — mirrors the variety of stylings _splits_pbp_keys() already
# knows how to read, just anchored for scanning raw sentence text instead of
# a single isolated batter field.
_SPLITS_NAME_RE = r"[A-Z][A-Za-z']*\.?(?:,\s*[A-Za-z]+\.?)?(?:\s[A-Z][A-Za-z.']*\.?)?"

# "<runner> stole second/third/home[ base]." — a stolen base. Matched
# independently of this play's own top-level `outcome` classification: it
# fires whether the play IS a standalone "Stolen base" event or the clause is
# embedded alongside the batter's own PA (e.g. a strikeout with a runner
# thrown in/safe on the same pitch — stats.ncaa.org's PBP often folds both
# into one play's description).
_SPLITS_STOLE_RE = re.compile(rf"({_SPLITS_NAME_RE})\s+stole\s+(?:second|third|home)\b")

# "<runner> out at <base> ..., caught stealing." / "<runner> out caught
# stealing at <base>, ...". Requires "caught stealing" to land before the next
# clause boundary (period/semicolon) so it can't reach across an unrelated
# out earlier in a multi-event play description.
_SPLITS_CS_RE = re.compile(
    rf"({_SPLITS_NAME_RE})\s+out\s+(?:at\s+\w+[^.;]*?caught stealing"
    rf"|caught stealing\s+at\s+\w+)"
)


def _splits_new_bat_cell():
    """Fresh all-zero situational cell for one batter/(mask,outs) combination.
    Shared by the per-PA cell-creation path and the SB/CS runner-crediting
    path below (a runner can pick up a cell here before ever batting in it)."""
    return {
        "PA": 0, "AB": 0, "H": 0, "1B": 0, "2B": 0, "3B": 0,
        "HR": 0, "RBI": 0, "BB": 0, "SO": 0,
        "HBP": 0, "IBB": 0, "ROE": 0, "FC": 0,
        "GB": 0, "FB": 0, "LD": 0, "PU": 0,
        "KS": 0, "KL": 0,
        "SF": 0, "SH": 0, "SB": 0, "CS": 0,
    }


def _splits_new_pitch_cell():
    """Fresh all-zero situational cell for one pitcher/(mask,outs) combination.
    Shared by the per-PA cell-creation path and the wp/bk runner-event path
    below (those can post to a cell before the pitcher ever faces a batter in
    it)."""
    return {
        "bf": 0, "ab": 0, "h": 0, "bb": 0, "so": 0,
        "hr": 0, "outs": 0, "r": 0,
        "1B": 0, "2B": 0, "3B": 0,
        "gb": 0, "fb": 0, "ld": 0, "pu": 0,
        "hbp": 0,
        "b": 0, "s": 0,
        "wp": 0, "bk": 0,
        "er": 0,
    }


def team_splits(seo, name):
    """Situational batting splits per batter, aggregated from all saved detailed
    PBP files. Returns the contract dict or None if the team folder is missing."""
    team_dir = _find_dir(seo, name)
    if not team_dir:
        return None

    col = for_seo(seo)

    # Load batting stats for roster identity and season OPS baseline.
    stats_dir = os.path.join(team_dir, "stats")
    try:
        with open(os.path.join(stats_dir, "batting.json"), encoding="utf-8") as fh:
            bat_raw = json.load(fh).get("players") or []
    except (OSError, ValueError):
        bat_raw = []

    # Load pitching stats for pitcher-roster identity (mirrors bat_raw above).
    try:
        with open(os.path.join(stats_dir, "pitching.json"), encoding="utf-8") as fh:
            pitch_raw = json.load(fh).get("players") or []
    except (OSError, ValueError):
        pitch_raw = []

    tab = sum(to_int(b.get("ab")) for b in bat_raw)
    th  = sum(to_int(b.get("h"))  for b in bat_raw)
    tbb = sum(to_int(b.get("bb")) for b in bat_raw)
    ttb = sum(to_int(b.get("tb")) for b in bat_raw)
    if tab and (tab + tbb):
        s_obp = (th + tbb) / (tab + tbb)   # simplified OBP per design.md contract
        s_slg = ttb / tab
        s_ops = round(s_obp + s_slg, 6)
    else:
        s_ops = 0.0

    # Roster: norm-key -> {num, name, pos, cells}. Seeded from stats/batting.json.
    roster = {}
    by_last = {}  # last-name -> [(norm-key, first-init)] for PBP name resolution
    for b in bat_raw:
        pname = (b.get("name") or "").strip()
        if not pname:
            continue
        nkey = _norm(pname)
        roster[nkey] = {
            "num": b.get("num", ""), "name": pname,
            "pos": b.get("pos", ""), "cells": {},
        }
        lk, fi = _splits_last_key(pname)
        if lk:
            by_last.setdefault(lk, []).append((nkey, fi))

    # Pitcher roster: norm-key -> {num, name, pos, cells}. Seeded from
    # stats/pitching.json (analogous to the batting roster above).
    pitch_roster = {}
    by_last_pitch = {}  # last-name -> [(norm-key, first-init)] for PBP resolution
    for p in pitch_raw:
        pname = (p.get("name") or "").strip()
        if not pname:
            continue
        nkey = _norm(pname)
        pitch_roster[nkey] = {
            "num": p.get("num", ""), "name": pname,
            "pos": p.get("pos", ""), "cells": {},
        }
        lk, fi = _splits_last_key(pname)
        if lk:
            by_last_pitch.setdefault(lk, []).append((nkey, fi))

    games_total = 0
    games_with_pbp = 0

    for game_dir, data in _iter_games(team_dir):
        games_total += 1
        detailed = _load_detailed(game_dir)
        plays = (detailed or {}).get("plays") or []
        if not plays:
            continue
        games_with_pbp += 1
        host_side = _host_side(data, name)

        for play in plays:
            try:
                # Batting side: "away" bats in the Top half, "home" in the Bottom.
                inn = play.get("inning") or ""
                bat_side = "away" if inn.lower().startswith("top") else "home"
                is_batting = bat_side == host_side  # else our team is pitching

                # runners_before -> base-state mask (bit0=1B, bit1=2B, bit2=3B).
                rb = play.get("runners_before")
                if rb is None:
                    continue
                mask = (
                    (1 if rb.get("1B") is not None else 0)
                    | (2 if rb.get("2B") is not None else 0)
                    | (4 if rb.get("3B") is not None else 0)
                )

                outs_before = play.get("outs_before")
                if outs_before is None:
                    continue
                try:
                    outs_int = int(outs_before)
                except (TypeError, ValueError):
                    continue
                if outs_int not in (0, 1, 2):
                    continue
                outs_str = str(outs_int)

                outcome = play.get("outcome") or "—"
                desc_text = play.get("description") or ""
                desc_low = desc_text.lower()

                # Baserunner steal / caught-stealing events, credited to the
                # RUNNER (parsed from the description), not the batter — not a
                # PA, so handled here regardless of this play's own outcome:
                # a steal/CS can be this play's sole event (outcome "Stolen
                # base"/"Caught stealing", batter blank) or embedded alongside
                # a separate batter's own PA (e.g. a strikeout with a runner
                # thrown out on the same pitch, one saved play). Runners are
                # resolved against the same batting roster as the batter
                # (`by_last`); unresolved names are dropped like any other
                # unresolved batter. Cell key is this play's own mask/outs
                # (the base/out state the steal attempt happened in).
                if is_batting:
                    cell_key = f"{mask}-{outs_str}"
                    for rm in _SPLITS_STOLE_RE.finditer(desc_text):
                        rkey = _splits_resolve(rm.group(1), by_last)
                        if rkey is None:
                            continue
                        rcells = roster[rkey]["cells"]
                        if cell_key not in rcells:
                            rcells[cell_key] = _splits_new_bat_cell()
                        rcells[cell_key]["SB"] += 1
                    for rm in _SPLITS_CS_RE.finditer(desc_text):
                        rkey = _splits_resolve(rm.group(1), by_last)
                        if rkey is None:
                            continue
                        rcells = roster[rkey]["cells"]
                        if cell_key not in rcells:
                            rcells[cell_key] = _splits_new_bat_cell()
                        rcells[cell_key]["CS"] += 1

                # Wild pitch / balk: credited to the CURRENT PITCHER, while our
                # team is pitching (`is_batting` False since these happen
                # during the opponent's batting half). Not a PA. Counted from
                # the description text (not the play's own `outcome`) because
                # a wild pitch/balk is frequently embedded alongside a
                # different, unrelated batter outcome in the same saved play
                # (a strikeout/walk/etc. on the same pitch a runner advanced) —
                # `outcome` only ever reflects ONE of those, so gating on it
                # would silently drop most wild pitches/balks. Presence, not
                # `.count()`: a single wild pitch/balk that moves TWO runners
                # is narrated once per runner ("X advanced to second on a wild
                # pitch Y advanced to third on a wild pitch.") — that's one
                # physical event, not two, and `.count()` would double it
                # (verified: presence-based counting landed at 40/39 wp and
                # 4/4 bk against Oklahoma's season total; `.count()` over-shot
                # to 50/6).
                if not is_batting:
                    wp_n = 1 if "wild pitch" in desc_low else 0
                    bk_n = 1 if "balk" in desc_low else 0
                    if wp_n or bk_n:
                        pitcher_pbp = (play.get("pitcher") or "").strip()
                        pkey = _splits_resolve(pitcher_pbp, by_last_pitch) if pitcher_pbp else None
                        if pkey is not None:
                            cell_key = f"{mask}-{outs_str}"
                            pcells = pitch_roster[pkey]["cells"]
                            if cell_key not in pcells:
                                pcells[cell_key] = _splits_new_pitch_cell()
                            pcells[cell_key]["wp"] += wp_n
                            pcells[cell_key]["bk"] += bk_n

                # Runs allowed (r/er): credited to the CURRENT PITCHER for
                # EVERY play with a run scored while we're pitching, PA or
                # not — placed here, before the PA skip filter, specifically
                # so it also catches runs that score on a non-PA play (Wild
                # pitch, Passed ball, Stolen base, Balk, a runner advancing on
                # an error): those plays' `outcome` isn't a recognized PA type,
                # so they'd otherwise be dropped by the skip filter below
                # before ever reaching the PA-path r/er accumulation — which
                # is why r/er previously undercounted the season total by
                # ~35% even though this same mechanism is already used for
                # wp/bk above. `er` is best-effort: `max(0, runs_scored count
                # - "unearned" mentions in the description)`. This is the ONLY
                # place r/er are counted now — the PA path below no longer
                # touches them, so a play is never double-counted.
                if not is_batting:
                    runs_n = len(play.get("runs_scored") or [])
                    if runs_n:
                        pitcher_pbp = (play.get("pitcher") or "").strip()
                        pkey = _splits_resolve(pitcher_pbp, by_last_pitch) if pitcher_pbp else None
                        if pkey is not None:
                            cell_key = f"{mask}-{outs_str}"
                            pcells = pitch_roster[pkey]["cells"]
                            if cell_key not in pcells:
                                pcells[cell_key] = _splits_new_pitch_cell()
                            pcells[cell_key]["r"]  += runs_n
                            unearned_n = desc_low.count("unearned")
                            pcells[cell_key]["er"] += max(0, runs_n - unearned_n)

                # Classify: skip non-PA runner events and unknown outcomes.
                xbh = _SPLITS_HIT.get(outcome)
                if (xbh is None
                        and outcome not in _SPLITS_WALK
                        and outcome != "Hit by pitch"
                        and not outcome.startswith("Strikeout")
                        and outcome not in _SPLITS_AB_OUT):
                    continue  # "—", Wild pitch, Passed ball, Stolen base, etc.

                if is_batting:
                    # Resolve batter to a roster player; drop plays whose batter
                    # isn't on the batting roster (variant garbage / opponents) so
                    # the Situational player list mirrors the player-stats batters.
                    batter_pbp = (play.get("batter") or "").strip()
                    if not batter_pbp:
                        continue
                    nkey = _splits_resolve(batter_pbp, by_last)
                    if nkey is None:
                        continue

                    cell_key = f"{mask}-{outs_str}"
                    cells = roster[nkey]["cells"]
                    if cell_key not in cells:
                        cells[cell_key] = _splits_new_bat_cell()
                    cell = cells[cell_key]
                    cell["PA"] += 1
                    cell["RBI"] += len(play.get("runs_scored") or [])

                    if xbh:                                # Single/Double/Triple/HR
                        cell["H"]  += 1
                        cell[xbh]  += 1
                        cell["AB"] += 1
                    elif outcome in _SPLITS_WALK:          # Walk / Intentional walk
                        cell["BB"] += 1
                        if outcome == "Intentional walk":
                            cell["IBB"] += 1
                    elif outcome == "Hit by pitch":        # PA only
                        cell["HBP"] += 1
                    elif outcome.startswith("Strikeout"):  # Strikeout (swinging/looking)
                        cell["SO"] += 1
                        cell["AB"] += 1
                        if outcome == "Strikeout (swinging)":
                            cell["KS"] += 1
                        elif outcome == "Strikeout (looking)":
                            cell["KL"] += 1
                        # generic "Strikeout" (no type) stays SO-only, not KS/KL.
                    else:                                  # _SPLITS_AB_OUT
                        cell["AB"] += 1
                        if outcome == "Reached on error":
                            cell["ROE"] += 1
                        elif outcome == "Fielder's choice":
                            cell["FC"] += 1
                        # Batted-ball type on outs only (hits carry no ball-type
                        # tag in the PBP source, so this is outs-only by design).
                        if outcome in ("Groundout", "Grounded into double play"):
                            cell["GB"] += 1
                        elif outcome == "Flyout":
                            cell["FB"] += 1
                        elif outcome == "Lineout":
                            cell["LD"] += 1
                        elif outcome in ("Pop out", "Infield fly"):
                            cell["PU"] += 1
                        # "Foul out" -> ambiguous ball type, left uncounted.

                    # Sacrifice fly / sacrifice bunt: purely additive counters,
                    # detected from the free-text description and layered on
                    # TOP OF (never instead of) the normal AB/GB/FB/LD/PU
                    # counting above — a sac fly still counts as a normal
                    # Flyout (AB+FB) and a sac bunt as a normal Groundout
                    # (AB+GB), matching every other team's uniform AB
                    # accounting. Kept in the data for reference but NOT
                    # surfaced in the frontend: detection from the description
                    # text is unreliable (see docs/data-shapes.md) and badly
                    # undercounts for most teams, so these two fields must
                    # never change PA/AB/GB/FB/LD/PU. A "sacrifice bunt"
                    # mention that also says "fielder's choice" means the
                    # batter reached base safely (not a true sacrifice), so
                    # that case is excluded.
                    if "sacrifice fly" in desc_low:
                        cell["SF"] += 1
                    elif ("sacrifice bunt" in desc_low
                            and "fielder's choice" not in desc_low):
                        cell["SH"] += 1
                else:
                    # Pitching side: resolve the play's pitcher to our pitching
                    # roster; drop plays whose pitcher isn't a roster pitcher
                    # (variant garbage / opponent's own pitcher never applies here
                    # since these are plays where WE are pitching).
                    pitcher_pbp = (play.get("pitcher") or "").strip()
                    if not pitcher_pbp:
                        continue
                    pkey = _splits_resolve(pitcher_pbp, by_last_pitch)
                    if pkey is None:
                        continue

                    outs_after = play.get("outs_after")
                    try:
                        outs_delta = int(outs_after) - outs_int
                    except (TypeError, ValueError):
                        outs_delta = 0
                    if outs_delta < 0:
                        outs_delta = 0

                    cell_key = f"{mask}-{outs_str}"
                    cells = pitch_roster[pkey]["cells"]
                    if cell_key not in cells:
                        cells[cell_key] = _splits_new_pitch_cell()
                    cell = cells[cell_key]
                    cell["bf"]   += 1
                    cell["outs"] += outs_delta
                    # r/er are NOT counted here — see the all-plays block
                    # above (before the skip filter), which is the single
                    # place they're accumulated so a play is never
                    # double-counted.

                    # Pitch-count breakdown from the play's `pitches` sequence
                    # (e.g. "BKKFK"). B = ball. K/F/S = called/foul/swinging
                    # strike, already in the sequence. A ball put in play isn't
                    # itself a pitch-sequence letter, so a contact PA (hit or
                    # batted-ball out) gets +1 strike for the contact pitch.
                    # We don't store total pitches (PT) — just b/s.
                    pitches_seq = play.get("pitches") or ""
                    cell["b"] += pitches_seq.count("B")
                    cell["s"] += (pitches_seq.count("K") + pitches_seq.count("F")
                                  + pitches_seq.count("S"))
                    if xbh or outcome in _SPLITS_CONTACT_OUT:
                        cell["s"] += 1

                    if xbh:                                # Single/Double/Triple/HR
                        cell["h"]  += 1
                        cell["ab"] += 1
                        if xbh == "HR":
                            cell["hr"] += 1
                        elif xbh in ("1B", "2B", "3B"):
                            cell[xbh] += 1
                    elif outcome in _SPLITS_WALK:          # Walk / Intentional walk
                        cell["bb"] += 1
                    elif outcome == "Hit by pitch":        # BF only
                        cell["hbp"] += 1
                    elif outcome.startswith("Strikeout"):  # Strikeout (swinging/looking)
                        cell["so"] += 1
                        cell["ab"] += 1
                    else:                                  # _SPLITS_AB_OUT
                        cell["ab"] += 1
                        # Batted-ball type on outs only (same outs-only caveat
                        # as the batting side's GB/FB/LD/PU — hits carry no
                        # ball-type tag in the PBP source).
                        if outcome in ("Groundout", "Grounded into double play"):
                            cell["gb"] += 1
                        elif outcome == "Flyout":
                            cell["fb"] += 1
                        elif outcome == "Lineout":
                            cell["ld"] += 1
                        elif outcome in ("Pop out", "Infield fly"):
                            cell["pu"] += 1
                        # "Foul out" -> ambiguous ball type, left uncounted.
            except Exception:
                continue  # never raise on a malformed play

    players_out = [
        {"num": pr["num"], "name": pr["name"], "pos": pr["pos"], "cells": pr["cells"]}
        for pr in roster.values()
        if pr["cells"]
    ]
    pitchers_out = [
        {"num": pr["num"], "name": pr["name"], "pos": pr["pos"], "cells": pr["cells"]}
        for pr in pitch_roster.values()
        if pr["cells"]
    ]

    return {
        "seo": seo,
        "name": name,
        "color": col["color"],
        "ink":   col["ink"],
        "gamesTotal":    games_total,
        "gamesWithPbp":  games_with_pbp,
        "season": {"ab": tab, "h": th, "bb": tbb, "tb": ttb, "ops": s_ops},
        "players": players_out,
        "pitchers": pitchers_out,
    }


def read_roster(seo, team_name):
    """Return the team's roster as a list of {num, name, pos, role, g} parsed
    from 2026/<Team>/roster.txt (generated by build_roster.py). Returns None if
    the file is missing or iCloud-offloaded; comment lines (starting with `#`)
    and blank lines are skipped."""
    team_dir = _find_dir(seo, team_name)
    if not team_dir:
        return None
    path = os.path.join(team_dir, "roster.txt")
    if not os.path.exists(path) or _dataless(path):
        return None
    players = []
    try:
        with open(path, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("|")
                if len(parts) < 5:
                    continue
                g = parts[4]
                try:
                    g = int(g)
                except ValueError:
                    pass
                players.append({
                    "num": parts[0], "name": parts[1], "pos": parts[2],
                    "role": parts[3], "g": g,
                })
    except OSError:
        return None
    return players
