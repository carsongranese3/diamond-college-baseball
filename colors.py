"""Curated public team colors for the 16 SEC baseball programs.

Box scores carry real hex colors, but the standings/schedule views are built
from the scoreboard crawl (no colors there), so these seed the team band/accents.
Keyed by ncaa.com team seo slug.
"""

SEC_COLORS = {
    "texas":          {"color": "#BF5700", "ink": "#FFFFFF"},
    "tennessee":      {"color": "#FF8200", "ink": "#0F1820"},
    "arkansas":       {"color": "#9D2235", "ink": "#FFFFFF"},
    "lsu":            {"color": "#461D7C", "ink": "#FDD023"},
    "georgia":        {"color": "#BA0C2F", "ink": "#FFFFFF"},
    "alabama":        {"color": "#9E1B32", "ink": "#FFFFFF"},
    "auburn":         {"color": "#03244D", "ink": "#DD550C"},
    "florida":        {"color": "#0021A5", "ink": "#FA4616"},
    "texas-am":       {"color": "#500000", "ink": "#FFFFFF"},
    "ole-miss":       {"color": "#14213D", "ink": "#CE1126"},
    "mississippi-st": {"color": "#660000", "ink": "#FFFFFF"},
    "oklahoma":       {"color": "#841617", "ink": "#FFFFFF"},
    "south-carolina": {"color": "#73000A", "ink": "#FFFFFF"},
    "missouri":       {"color": "#1B1B1B", "ink": "#F1B82D"},
    "kentucky":       {"color": "#0033A0", "ink": "#FFFFFF"},
    "vanderbilt":     {"color": "#1B1B1B", "ink": "#C9B26C"},
}

DEFAULT = {"color": "#1B1B1B", "ink": "#FFFFFF"}


def for_seo(seo):
    return SEC_COLORS.get(seo, DEFAULT)
