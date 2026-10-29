"""
Sack or Stick? — data pipeline.

Reads openfootball match results for Europe's top-5 leagues (data/raw/<season>/<league>.json),
then:
  1. Runs a chronological Elo rating per league (goal-margin aware, home advantage,
     season-to-season regression to the mean, promoted clubs enter at the level of
     the clubs they replace).
  2. Fits an ordered-logit model that turns a pre-match Elo gap into
     P(home win) / P(draw) / P(away win). Fitted ONLY on seasons up to 2018-19,
     evaluated out-of-sample on 2019-20 onward.
  3. Computes expected points (xPts) for every match from pre-match ratings.
  4. Runs the "midseason study": for every complete team-season, how well does each
     first-half signal (points, goal difference, Elo, points-above-expected) predict
     second-half points per game?
  5. Writes compact JS data files for the static dashboard in docs/.

Run:  python3 scripts/build_data.py
"""
import glob
import json
import math
import os
from collections import defaultdict

import numpy as np
from scipy.optimize import minimize

from names import canon

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "docs", "data")

LEAGUES = {
    "en.1": "Premier League",
    "es.1": "LaLiga",
    "de.1": "Bundesliga",
    "it.1": "Serie A",
    "fr.1": "Ligue 1",
}
TRAIN_LAST_SEASON = "2018-19"  # model is fitted on seasons <= this one

# Elo settings (chosen by a small grid search on training seasons, see tune())
BASE = 1500.0
K = 20.0
HFA = 60.0          # home advantage in Elo points, used in the Elo update
REGRESS = 0.25      # fraction pulled back to the league mean between seasons


# --------------------------------------------------------------------------- load
def ft_score(m):
    s = m.get("score")
    if isinstance(s, dict):
        return s.get("ft")
    if isinstance(s, list) and len(s) >= 2:
        return s[:2]
    return None


DISPLAY = {}
PRETTY = {
    "AFC Bournemouth": "Bournemouth", "Brighton & Hove Albion": "Brighton", "Tottenham Hotspur": "Tottenham",
    "Wolverhampton Wanderers": "Wolves", "Deportivo Alavés": "Alavés", "Club Atlético de Madrid": "Atlético Madrid",
    "FC Barcelona": "Barcelona", "RC Celta de Vigo": "Celta Vigo", "RC Deportivo La Coruña": "Deportivo La Coruña",
    "RCD Espanyol de Barcelona": "Espanyol", "Levante UD": "Levante", "CA Osasuna": "Osasuna",
    "Rayo Vallecano de Madrid": "Rayo Vallecano", "Real Betis Balompié": "Real Betis",
    "Real Racing Club de Santander": "Racing Santander", "Real Sociedad de Fútbol": "Real Sociedad",
    "FC Augsburg": "Augsburg", "Bayer 04 Leverkusen": "Leverkusen", "FC Bayern München": "Bayern München",
    "Borussia Mönchengladbach": "M'gladbach", "SV 07 Elversberg": "Elversberg", "SC Freiburg": "Freiburg",
    "TSG 1899 Hoffenheim": "Hoffenheim", "1. FSV Mainz 05": "Mainz 05", "SC Paderborn 07": "Paderborn",
    "FC Schalke 04": "Schalke 04", "SV Werder Bremen": "Werder Bremen", "1. FC Union Berlin": "Union Berlin",
    "Atalanta BC": "Atalanta", "Bologna FC 1909": "Bologna", "Cagliari Calcio": "Cagliari", "Como 1907": "Como",
    "ACF Fiorentina": "Fiorentina", "Frosinone Calcio": "Frosinone", "FC Internazionale Milano": "Inter",
    "SS Lazio": "Lazio", "US Lecce": "Lecce", "AC Milan": "Milan", "AC Monza": "Monza", "SSC Napoli": "Napoli",
    "Parma Calcio 1913": "Parma", "AS Roma": "Roma", "US Sassuolo Calcio": "Sassuolo", "Udinese Calcio": "Udinese",
    "AJ Auxerre": "Auxerre", "Angers SCO": "Angers", "ES Troyes": "Troyes", "Racing Club de Lens": "Lens",
    "FC Lorient": "Lorient", "AS Monaco": "Monaco", "OGC Nice": "Nice", "Olympique Lyonnais": "Lyon",
    "Olympique de Marseille": "Marseille", "Paris": "Paris FC", "Paris Saint-Germain": "PSG",
    "Stade Brestois 29": "Brest", "Stade Rennais FC 1901": "Rennes", "RC Strasbourg Alsace": "Strasbourg",
    "Hellas Verona": "Hellas Verona", "FC St. Pauli 1910": "St. Pauli", "SpVgg Greuther Fürth 1903": "Greuther Fürth", "SpVgg Greuther Fürth": "Greuther Fürth", "ES Troyes": "Troyes", "ESTAC Troyes": "Troyes", "UC Sampdoria": "Sampdoria", "FC Metz": "Metz", "FC Nantes": "Nantes",
    "Montpellier HSC": "Montpellier", "Stade de Reims": "Reims", "FC Girona": "Girona", "Girona FC": "Girona",
    "Getafe CF": "Getafe", "VfL Wolfsburg": "Wolfsburg", "VfL Bochum 1848": "Bochum", "1. FC Heidenheim 1846": "Heidenheim",
    "Holstein Kiel": "Holstein Kiel", "FC St. Pauli": "St. Pauli", "Empoli FC": "Empoli", "Venezia FC": "Venezia",
}


def short(key):
    name = DISPLAY.get(key, key)
    for suf in (" FC", " CF", " AFC", " SC", " SSC", " AC", " CFC", " OSC"):
        if name.endswith(suf):
            name = name[: -len(suf)]
    name = name.strip()
    return PRETTY.get(name, name)


def load_league(lg):
    seasons = []
    for sdir in sorted(os.listdir(RAW)):
        p = os.path.join(RAW, sdir, f"{lg}.json")
        if not os.path.exists(p):
            continue
        raw = json.load(open(p, encoding="utf-8"))["matches"]
        matches = []
        for m in raw:
            if m.get("status") in ("cancelled", "canceled"):
                continue
            rnd = m.get("round", "")
            md = int(rnd.split()[-1]) if rnd.split() and rnd.split()[-1].isdigit() else None
            sc = ft_score(m)
            for t in (m["team1"], m["team2"]):
                DISPLAY[canon(t)] = t  # later seasons overwrite: latest official name wins
            matches.append({
                "md": md,
                "date": m.get("date"),
                "h": canon(m["team1"]),
                "a": canon(m["team2"]),
                "hg": sc[0] if sc else None,
                "ag": sc[1] if sc else None,
            })
        matches.sort(key=lambda x: (x["date"] or "9999", x["md"] or 0))
        seasons.append({"season": sdir, "matches": matches})
    return seasons


# --------------------------------------------------------------------------- elo
def run_elo(seasons, k=K, hfa=HFA, regress=REGRESS):
    """Annotates every match with pre-match ratings (rh, ra) and post-match ratings."""
    ratings = {}
    for si, s in enumerate(seasons):
        teams = set()
        for m in s["matches"]:
            teams.add(m["h"]); teams.add(m["a"])
        if si == 0:
            ratings = {t: BASE for t in teams}
        else:
            stayed = [t for t in teams if t in ratings]
            leaving = [r for t, r in ratings.items() if t not in teams]
            mean = np.mean(list(ratings.values()))
            # regress survivors to the mean
            new = {t: ratings[t] + regress * (mean - ratings[t]) for t in stayed}
            # promoted clubs enter at the (regressed) average of the clubs they replace
            entry = (np.mean(leaving) + regress * (mean - np.mean(leaving))) if leaving else mean - 100
            for t in teams:
                if t not in new:
                    new[t] = entry
            ratings = new
        s["start_ratings"] = dict(ratings)
        for m in s["matches"]:
            rh, ra = ratings[m["h"]], ratings[m["a"]]
            m["rh"], m["ra"] = rh, ra
            if m["hg"] is None:
                continue
            exp_h = 1.0 / (1.0 + 10 ** (-(rh + hfa - ra) / 400.0))
            res = 1.0 if m["hg"] > m["ag"] else (0.5 if m["hg"] == m["ag"] else 0.0)
            margin = abs(m["hg"] - m["ag"])
            mult = 1.0 if margin <= 1 else (1.5 if margin == 2 else (11 + margin) / 8.0)
            delta = k * mult * (res - exp_h)
            ratings[m["h"]] = rh + delta
            ratings[m["a"]] = ra - delta
            m["rh2"], m["ra2"] = ratings[m["h"]], ratings[m["a"]]
    return seasons


# --------------------------------------------------------------------------- ordered logit
def sig(x):
    return 1.0 / (1.0 + np.exp(-x))


def probs(d, beta, c1, c2):
    """d = (Rh - Ra)/400. Returns (pH, pD, pA)."""
    pa = sig(c1 - beta * d)
    pad = sig(c2 - beta * d)
    return 1 - pad, pad - pa, pa


def collect(all_leagues, pred):
    d, y = [], []
    for seasons in all_leagues.values():
        for s in seasons:
            if not pred(s["season"]):
                continue
            for m in s["matches"]:
                if m["hg"] is None:
                    continue
                d.append((m["rh"] - m["ra"]) / 400.0)
                y.append(0 if m["hg"] > m["ag"] else (1 if m["hg"] == m["ag"] else 2))
    return np.array(d), np.array(y)


def nll(params, d, y):
    beta, c1, gap = params
    c2 = c1 + abs(gap)
    ph, pd, pa = probs(d, beta, c1, c2)
    p = np.choose(y, [ph, pd, pa])
    return -np.mean(np.log(np.clip(p, 1e-12, 1)))


def fit_ologit(d, y):
    r = minimize(nll, x0=[2.0, -1.0, 1.0], args=(d, y), method="Nelder-Mead",
                 options={"xatol": 1e-6, "fatol": 1e-9, "maxiter": 5000})
    beta, c1, gap = r.x
    return float(beta), float(c1), float(c1 + abs(gap))


def evaluate(d, y, params):
    ph, pd, pa = probs(d, *params)
    P = np.vstack([ph, pd, pa]).T
    Y = np.eye(3)[y]
    logloss = -np.mean(np.log(np.clip(P[np.arange(len(y)), y], 1e-12, 1)))
    brier = np.mean(np.sum((P - Y) ** 2, axis=1))
    # baseline: training-set outcome frequencies for every match
    return logloss, brier


def tune(all_raw):
    """Small grid search for K / HFA / REGRESS on training seasons only."""
    best = None
    for k in (10, 12.5, 15, 20):
        for hfa in (20, 30, 40, 60):
            for reg in (0.05, 0.1, 0.15, 0.25):
                leagues = {lg: run_elo(json.loads(json.dumps(s)), k, hfa, reg) for lg, s in all_raw.items()}
                # skip the first season of each league (burn-in)
                firsts = {lg: s[0]["season"] for lg, s in all_raw.items()}
                d, y = [], []
                for lg, seasons in leagues.items():
                    for s in seasons[1:]:
                        if s["season"] > TRAIN_LAST_SEASON:
                            continue
                        for m in s["matches"]:
                            if m["hg"] is None:
                                continue
                            d.append((m["rh"] - m["ra"]) / 400.0)
                            y.append(0 if m["hg"] > m["ag"] else (1 if m["hg"] == m["ag"] else 2))
                d, y = np.array(d), np.array(y)
                p = fit_ologit(d, y)
                ll, _ = evaluate(d, y, p)
                if best is None or ll < best[0]:
                    best = (ll, k, hfa, reg)
    return best


# --------------------------------------------------------------------------- main
def main():
    os.makedirs(OUT, exist_ok=True)
    raw = {lg: load_league(lg) for lg in LEAGUES}

    global K, HFA, REGRESS
    ll, K, HFA, REGRESS = tune(raw)
    print(f"Tuned Elo: K={K} HFA={HFA} REGRESS={REGRESS} (train logloss {ll:.4f})")

    leagues = {lg: run_elo(s, K, HFA, REGRESS) for lg, s in raw.items()}

    # ---- fit outcome model on training seasons (excluding burn-in season)
    first = {lg: s[0]["season"] for lg, s in leagues.items()}

    def is_train(season):
        return season <= TRAIN_LAST_SEASON

    d_tr, y_tr, d_te, y_te = [], [], [], []
    for lg, seasons in leagues.items():
        for s in seasons[1:]:
            for m in s["matches"]:
                if m["hg"] is None:
                    continue
                dd = (m["rh"] - m["ra"]) / 400.0
                yy = 0 if m["hg"] > m["ag"] else (1 if m["hg"] == m["ag"] else 2)
                (d_tr if is_train(s["season"]) else d_te).append(dd)
                (y_tr if is_train(s["season"]) else y_te).append(yy)
    d_tr, y_tr, d_te, y_te = map(np.array, (d_tr, y_tr, d_te, y_te))
    params = fit_ologit(d_tr, y_tr)
    beta, c1, c2 = params
    freq = np.bincount(y_tr, minlength=3) / len(y_tr)
    ll_te, br_te = evaluate(d_te, y_te, params)
    Pb = np.tile(freq, (len(y_te), 1))
    ll_base = -np.mean(np.log(Pb[np.arange(len(y_te)), y_te]))
    br_base = np.mean(np.sum((Pb - np.eye(3)[y_te]) ** 2, axis=1))
    print(f"Ordered logit beta={beta:.3f} c1={c1:.3f} c2={c2:.3f}")
    print(f"Test (2019-20+): logloss {ll_te:.4f} vs baseline {ll_base:.4f}; brier {br_te:.4f} vs {br_base:.4f}; n={len(y_te)}")

    # calibration on the test set: bin predicted home-win prob
    ph_te, pd_te, pa_te = probs(d_te, *params)
    calib = []
    edges = np.linspace(0, 1, 11)
    for i in range(10):
        msk = (ph_te >= edges[i]) & (ph_te < edges[i + 1])
        if msk.sum() >= 30:
            calib.append({"pred": round(float(ph_te[msk].mean()), 4),
                          "obs": round(float((y_te[msk] == 0).mean()), 4),
                          "n": int(msk.sum())})

    # ---- xPts per match
    for lg, seasons in leagues.items():
        for s in seasons:
            for m in s["matches"]:
                ph, pd, pa = probs((m["rh"] - m["ra"]) / 400.0, *params)
                m["ph"], m["pd"], m["pa"] = float(ph), float(pd), float(pa)

    # ---- midseason study (complete seasons, skip burn-in)
    rows = []
    for lg, seasons in leagues.items():
        for s in seasons[1:]:
            ms = s["matches"]
            if any(m["hg"] is None for m in ms):
                continue
            teams = sorted({m["h"] for m in ms} | {m["a"] for m in ms})
            n_games = 2 * (len(teams) - 1)
            if len(ms) != len(teams) * (len(teams) - 1):
                continue  # incomplete / truncated season (e.g. Ligue 1 2019-20)
            half = n_games // 2
            per = defaultdict(list)
            for m in ms:
                for t, home in ((m["h"], True), (m["a"], False)):
                    gf, ga = (m["hg"], m["ag"]) if home else (m["ag"], m["hg"])
                    pts = 3 if gf > ga else (1 if gf == ga else 0)
                    xp = (3 * m["ph"] + m["pd"]) if home else (3 * m["pa"] + m["pd"])
                    post = m["rh2"] if home else m["ra2"]
                    per[t].append((pts, xp, gf - ga, post))
            elo_mid_all = {t: per[t][half - 1][3] for t in teams}
            league_mean = np.mean(list(elo_mid_all.values()))
            for t in teams:
                g = per[t]
                if len(g) != n_games:
                    continue
                f, sH = g[:half], g[half:]
                rows.append({
                    "lg": lg, "season": s["season"], "team": t,
                    "pts1": sum(x[0] for x in f) / half,
                    "xp1": sum(x[1] for x in f) / half,
                    "gd1": sum(x[2] for x in f) / half,
                    "elo1": elo_mid_all[t] - league_mean,
                    "pts2": sum(x[0] for x in sH) / len(sH),
                    "xp2": sum(x[1] for x in sH) / len(sH),
                })
    print(f"Midseason study: {len(rows)} team-seasons")

    def r2(xkey):
        x = np.array([r[xkey] for r in rows]); y = np.array([r["pts2"] for r in rows])
        return float(np.corrcoef(x, y)[0, 1] ** 2)

    pae1 = np.array([r["pts1"] - r["xp1"] for r in rows])
    pae2 = np.array([r["pts2"] - r["xp2"] for r in rows])
    persistence = float(np.corrcoef(pae1, pae2)[0, 1])
    # "regression to the mean" of the luckiest/unluckiest
    order = np.argsort(pae1)
    q = len(rows) // 10
    unlucky, lucky = order[:q], order[-q:]
    study = {
        "n": len(rows),
        "r2": {
            "First-half points": r2("pts1"),
            "First-half goal difference": r2("gd1"),
            "Midseason Elo rating": r2("elo1"),
        },
        "pae_persistence_r": persistence,
        "lucky10": {"pae1": float(pae1[lucky].mean()), "pae2": float(pae2[lucky].mean())},
        "unlucky10": {"pae1": float(pae1[unlucky].mean()), "pae2": float(pae2[unlucky].mean())},
        # thin scatter for the chart: PAE first half vs second half
        "scatter": [[round(float(a), 3), round(float(b), 3)] for a, b in zip(pae1, pae2)],
    }
    for k_, v in study["r2"].items():
        print(f"  R² {k_}: {v:.3f}")
    print(f"  PAE persistence r = {persistence:.3f}")
    print(f"  Luckiest 10%: +{study['lucky10']['pae1']:.2f} -> {study['lucky10']['pae2']:+.2f} pts/game")
    print(f"  Unluckiest 10%: {study['unlucky10']['pae1']:.2f} -> {study['unlucky10']['pae2']:+.2f} pts/game")

    # ---- write data files for the dashboard
    meta = {
        "leagues": LEAGUES,
        "seasons": {lg: [s["season"] for s in seasons] for lg, seasons in leagues.items()},
        "model": {"beta": beta, "c1": c1, "c2": c2, "K": K, "HFA": HFA, "REGRESS": REGRESS,
                  "train_last": TRAIN_LAST_SEASON,
                  "test": {"n": int(len(y_te)), "logloss": ll_te, "logloss_base": ll_base,
                           "brier": br_te, "brier_base": br_base},
                  "calibration": calib},
        "study": study,
        "source": "openfootball/football.json (public domain)",
    }
    with open(os.path.join(OUT, "meta.js"), "w", encoding="utf-8") as fh:
        fh.write("window.SOS_META=" + json.dumps(meta, separators=(",", ":")) + ";\n")

    for lg, seasons in leagues.items():
        payload = {}
        for s in seasons:
            teams = sorted({m["h"] for m in s["matches"]} | {m["a"] for m in s["matches"]})
            idx = {t: i for i, t in enumerate(teams)}
            ms = []
            for m in s["matches"]:
                row = [m["md"] or 0, m["date"], idx[m["h"]], idx[m["a"]],
                       m["hg"], m["ag"], round(m["rh"], 1), round(m["ra"], 1)]
                if m["hg"] is not None:
                    row += [round(m["rh2"], 1), round(m["ra2"], 1)]
                ms.append(row)
            payload[s["season"]] = {
                "teams": [short(t) for t in teams],
                "start": [round(s["start_ratings"][t], 1) for t in teams],
                "m": ms,
            }
        with open(os.path.join(OUT, f"{lg}.js"), "w", encoding="utf-8") as fh:
            fh.write(f"(window.SOS_DATA=window.SOS_DATA||{{}})[{json.dumps(lg)}]="
                     + json.dumps(payload, separators=(",", ":")) + ";\n")
    print("Wrote", sorted(os.listdir(OUT)))


if __name__ == "__main__":
    main()
