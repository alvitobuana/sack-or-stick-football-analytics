"""Canonical club names: the source changed naming style in 2020-21 (2023-24 for Ligue 1)."""
import re
import unicodedata

STOP = {"fc", "afc", "cf", "ac", "sc", "ssc", "as", "bc", "us", "uc", "ss", "cfc", "acf", "rc",
        "cd", "sd", "rcd", "ud", "ca", "club", "de", "del", "calcio", "1909", "1913", "1907",
        "1901", "1899", "1846", "1848", "1910", "1903", "1919", "1904", "04", "05", "07", "96", "sv", "tsg", "vfl",
        "osc", "ogc", "sco", "estac", "fútbol", "futbol", "balompie", "balompié", "ferrara", "2013", "alsace"}
ALIAS = {
    "inter": "internazionale milano", "es troyes": "troyes", "deportivo alaves": "alaves", "lazio roma": "lazio",
    "atletico madrid": "atletico madrid", "club atletico madrid": "atletico madrid",
    "espanyol barcelona": "espanyol", "real sociedad": "real sociedad",
    "bor monchengladbach": "borussia monchengladbach",
    "bayern munchen": "bayern munchen", "olympique marseille": "olympique marseille",
    "racing lens": "lens", "lens": "lens", "stade rennais": "stade rennais",
    "celta vigo": "celta", "1 fc koln": "koln", "1 fsv mainz": "mainz",
}


def canon(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " ").replace(".", " ").replace("-", " ")
    toks = [t for t in re.split(r"\s+", s) if t and t not in STOP]
    key = " ".join(toks)
    return ALIAS.get(key, key)
