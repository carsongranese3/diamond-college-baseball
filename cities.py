"""Host cities for NCAA tournament sites, keyed by ncaa.com seoname.

NCAA Regionals and Super Regionals are named for the host's CITY, not the host
school — e.g. Texas hosting in Austin is the "Austin Regional", not the "Texas
Regional". Regionals are hosted by the 16 national seeds and Super Regionals by
the higher seed of each pairing, so this covers the realistic hosts (plus the
rest of the SEC for re-seeds / future seasons). Unknown hosts fall back to the
school name so nothing ever renders blank.
"""

CITY_BY_SEO = {
    # 2026 regional hosts (the 16 national seeds)
    "ucla": "Los Angeles",
    "west-virginia": "Morgantown",
    "southern-miss": "Hattiesburg",
    "florida": "Gainesville",
    "north-carolina": "Chapel Hill",
    "texas-am": "College Station",
    "nebraska": "Lincoln",
    "auburn": "Auburn",
    "georgia-tech": "Atlanta",
    "kansas": "Lawrence",
    "florida-st": "Tallahassee",
    "alabama": "Tuscaloosa",
    "texas": "Austin",
    "oregon": "Eugene",
    "mississippi-st": "Starkville",
    "georgia": "Athens",
    # rest of the SEC (so a re-seed / different season still names by city)
    "arkansas": "Fayetteville",
    "lsu": "Baton Rouge",
    "tennessee": "Knoxville",
    "vanderbilt": "Nashville",
    "kentucky": "Lexington",
    "missouri": "Columbia",
    "south-carolina": "Columbia",
    "oklahoma": "Norman",
    "ole-miss": "Oxford",
    # other 2026 hosts / common tournament hosts (campus city)
    "troy": "Troy",
    "ualr": "Little Rock",
    "southern-california": "Los Angeles",
}


def city_for(seo, fallback=None):
    """Host city for a school's seoname, or `fallback` (then the seo itself)."""
    return CITY_BY_SEO.get((seo or "").lower()) or fallback or (seo or "")
