"""Curated public team colors for the Power-4 baseball programs (SEC/ACC/Big Ten/
Big 12).

Box scores carry real hex colors, but the standings/schedule/home views are built
from the scoreboard crawl (no colors there), so these seed the team band/accents.
Keyed by ncaa.com team seo slug. {color} is the band/primary; {ink} is a contrasting
accent (logo-failed monogram text, gradients, the home hero).
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

ACC_COLORS = {
    "boston-college":    {"color": "#98002E", "ink": "#B29D6C"},
    "california":        {"color": "#003262", "ink": "#FDB515"},
    "clemson":           {"color": "#F56600", "ink": "#522D80"},
    "duke":              {"color": "#00539B", "ink": "#FFFFFF"},
    "florida-st":        {"color": "#782F40", "ink": "#CEB888"},
    "georgia-tech":      {"color": "#003057", "ink": "#B3A369"},
    "louisville":        {"color": "#AD0000", "ink": "#FFFFFF"},
    "miami-fl":          {"color": "#F47321", "ink": "#005030"},
    "north-carolina":    {"color": "#4B9CD3", "ink": "#13294B"},
    "north-carolina-st": {"color": "#CC0000", "ink": "#FFFFFF"},
    "notre-dame":        {"color": "#0C2340", "ink": "#C99700"},
    "pittsburgh":        {"color": "#003594", "ink": "#FFB81C"},
    "stanford":          {"color": "#8C1515", "ink": "#FFFFFF"},
    "virginia":          {"color": "#232D4B", "ink": "#E57200"},
    "virginia-tech":     {"color": "#630031", "ink": "#CF4420"},
    "wake-forest":       {"color": "#9E7E38", "ink": "#000000"},
}

BIG_TEN_COLORS = {
    "illinois":            {"color": "#E84A27", "ink": "#13294B"},
    "indiana":             {"color": "#990000", "ink": "#FFFFFF"},
    "iowa":                {"color": "#FFCD00", "ink": "#000000"},
    "maryland":            {"color": "#E03A3E", "ink": "#FFD520"},
    "michigan":            {"color": "#00274C", "ink": "#FFCB05"},
    "michigan-st":         {"color": "#18453B", "ink": "#FFFFFF"},
    "minnesota":           {"color": "#7A0019", "ink": "#FFCC33"},
    "nebraska":            {"color": "#E41C38", "ink": "#FFFFFF"},
    "northwestern":        {"color": "#4E2A84", "ink": "#FFFFFF"},
    "ohio-st":             {"color": "#BB0000", "ink": "#FFFFFF"},
    "oregon":              {"color": "#154733", "ink": "#FEE123"},
    "penn-st":             {"color": "#041E42", "ink": "#FFFFFF"},
    "purdue":              {"color": "#CFB991", "ink": "#000000"},
    "rutgers":             {"color": "#CC0033", "ink": "#FFFFFF"},
    "southern-california": {"color": "#990000", "ink": "#FFC72C"},
    "ucla":                {"color": "#2774AE", "ink": "#FFD100"},
    "washington":          {"color": "#4B2E83", "ink": "#B7A57A"},
}

BIG_12_COLORS = {
    "arizona":       {"color": "#0C234B", "ink": "#AB0520"},
    "arizona-st":    {"color": "#8C1D40", "ink": "#FFC627"},
    "baylor":        {"color": "#154734", "ink": "#FFB81C"},
    "byu":           {"color": "#002E5D", "ink": "#FFFFFF"},
    "cincinnati":    {"color": "#E00122", "ink": "#000000"},
    "houston":       {"color": "#C8102E", "ink": "#FFFFFF"},
    "kansas":        {"color": "#0051BA", "ink": "#E8000D"},
    "kansas-st":     {"color": "#512888", "ink": "#FFFFFF"},
    "oklahoma-st":   {"color": "#FF6600", "ink": "#000000"},
    "tcu":           {"color": "#4D1979", "ink": "#FFFFFF"},
    "texas-tech":    {"color": "#CC0000", "ink": "#000000"},
    "ucf":           {"color": "#BA9B37", "ink": "#000000"},
    "utah":          {"color": "#CC0000", "ink": "#FFFFFF"},
    "west-virginia": {"color": "#002855", "ink": "#EAAA00"},
}

TEAM_COLORS = {**SEC_COLORS, **ACC_COLORS, **BIG_TEN_COLORS, **BIG_12_COLORS}

DEFAULT = {"color": "#1B1B1B", "ink": "#FFFFFF"}


def for_seo(seo):
    return TEAM_COLORS.get(seo, DEFAULT)
