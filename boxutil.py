"""Shared box-score helpers (innings-pitched math, name/number formatting)."""


def ip_to_outs(ip):
    """Baseball IP notation -> outs. '6.1' -> 19, '78.0' -> 234, '7' -> 21."""
    try:
        s = str(ip).strip()
        if "." in s:
            whole, frac = s.split(".", 1)
            return int(whole) * 3 + int(frac[0])
        return int(s) * 3
    except (ValueError, IndexError):
        return 0


def outs_to_ip(outs):
    return f"{outs // 3}.{outs % 3}"


def to_int(v, default=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def to_float(v, default=0.0):
    try:
        return float(str(v).strip().rstrip("%"))
    except (TypeError, ValueError):
        return default


def fmt3(x):
    """0.374 -> '.374', 1.143 -> '1.143' (NCAA-style, no leading zero)."""
    s = f"{x:.3f}"
    return s[1:] if s.startswith("0") else s


def fmt2(x):
    return f"{x:.2f}"


def fmt_pct(x):
    """Rate as a percentage string, e.g. 0.123 -> '12.3%'."""
    return f"{x * 100:.1f}%"


# ── Advanced sabermetrics (computed from raw season totals) ──────────────────
# Each returns "—" when its inputs are missing/zero, so the UI can show a blank.
def babip(h, hr, ab, k, sf):
    denom = ab - k - hr + sf
    return fmt3((h - hr) / denom) if denom > 0 else "—"


def secondary_avg(tb, h, bb, sb, cs, ab):
    return fmt3((tb - h + bb + sb - cs) / ab) if ab > 0 else "—"


def runs_created(h, bb, tb, ab):
    denom = ab + bb
    return fmt2((h + bb) * tb / denom) if denom > 0 else "—"


def per9(stat, outs):
    return fmt2(stat * 27 / outs) if outs > 0 else "—"


def ratio(num, den):
    return fmt2(num / den) if den > 0 else "—"


def fip(hr, bb, hbp, k, outs, constant=3.10):
    ip = outs / 3
    return fmt2((13 * hr + 3 * (bb + hbp) - 2 * k) / ip + constant) if ip > 0 else "—"


def lob_pct(h, bb, hbp, r, hr):
    denom = h + bb + hbp - 1.4 * hr
    return fmt_pct((h + bb + hbp - r) / denom) if denom > 0 else "—"


def player_name(p):
    first = (p.get("firstName") or "").strip()
    last = (p.get("lastName") or "").strip()
    if first and last:
        return f"{last}, {first[0]}."
    return last or first or "—"


def find_team_entry(box, seo):
    """Return (teamId, team_meta) for the side matching seo in a boxscore."""
    for t in box.get("teams", []):
        if t.get("seoname") == seo:
            return str(t.get("teamId")), t
    return None, None
