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
