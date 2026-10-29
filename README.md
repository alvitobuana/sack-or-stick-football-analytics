# Sack or Stick? ⚽

**A board-room dashboard that separates genuine decline from bad luck, before a football club makes a costly managerial decision.**

Built for the **AQX Sports Analytics Data Bowl 4.0** by Alvito Buana (Telkom University, Indonesia).

👉 **Live demo:** https://alvitobuana.github.io/sack-or-stick-football-analytics/

---

## The problem

Every season, clubs sack managers after a bad run of results. A mid-season sacking is expensive (compensation, a new staff, a new transfer plan) and often unnecessary: a league table mixes **how good a team is** with **how lucky it has been**, and boards rarely separate the two.

Sack or Stick? gives a sporting director one question answered with evidence: *is my team genuinely worse, or just unlucky?*

## Key findings

From **1,206 complete club-seasons** across the Premier League, LaLiga, Bundesliga, Serie A and Ligue 1 (2011–2026), split at the halfway mark:

| Finding | Result |
|---|---|
| Luckiest 10% of teams (first half) | **+0.52** pts/game above expectation → **+0.00** in the second half |
| Unluckiest 10% of teams (first half) | **−0.51** pts/game below expectation → **+0.00** in the second half |
| Correlation of luck, 1st half vs 2nd half | **r = −0.007** (luck does not persist) |
| Second-half points explained by first-half **points** | R² = 0.48 |
| … by first-half **goal difference** | R² = 0.51 |
| … by midseason **Elo rating** | **R² = 0.58** (best signal) |

**Practical takeaway:** a board should judge a manager on underlying strength (Elo), not on points. A team that is losing while its strength holds steady should usually be backed. The results come back.

## What the dashboard does

- **Verdict card:** a transparent rule turns two numbers, luck (points − expected points) and strength change (Elo now − Elo at season start), into a call: *Stick*, *Caution: results are flattering*, *Genuine decline*, *Declining and unlucky*, or *On track*.
- **Time machine:** pick any league, any season since 2011-12 and any matchday. Everything is recomputed using only information available at that point, so you can replay a past season and check whether the verdict was right.
- **Luck map:** actual vs expected points for every club.
- **Game-by-game trajectory:** cumulative points vs cumulative xPts, and the Elo curve.
- **Season projection:** 5,000 Monte Carlo simulations of the remaining fixtures → projected points, 80% range, top-4 and relegation probabilities.
- **Luck-adjusted table:** sortable standings with xPts, luck, Elo and projections.
- **Evidence section:** the midseason study and an out-of-sample calibration check.

## Method

1. **Data:** every result from [openfootball/football.json](https://github.com/openfootball/football.json) (public domain) for the top-5 leagues, 2010-11 to the live 2026-27 season (~25,700 matches). Club names are normalised across a source naming change in 2020-21.
2. **Elo ratings:** chronological, per league, with a margin-of-victory multiplier and home advantage. Ratings regress toward the league mean each summer; promoted clubs start at the level of the clubs they replace. K, home edge and regression were tuned by grid search on **2011–2019 only**.
3. **Expected points:** an ordered-logit model maps the pre-match Elo gap to P(home win), P(draw), P(away win). xPts = 3·P(win) + P(draw). Fitted on seasons up to 2018-19.
4. **Out-of-sample test** on 12,688 matches from 2019-20 onward: log loss **0.991** vs 1.076 for a no-skill baseline; Brier score **0.591** vs 0.651. Calibration is shown in the dashboard.
5. **Projection:** Monte Carlo of remaining fixtures with ratings frozen at the selected matchday (no look-ahead).

**Limitations:** Elo and xPts here are built from results, not shot data (xG), so they cannot see chance quality; injuries, transfers and fixture congestion are not modelled. The verdict is a structured second opinion, not an automated decision.

## Project structure

```
sack-or-stick/
├── data/raw/            # openfootball JSON (top-5 leagues, 2010-11 → 2026-27)
├── scripts/
│   ├── build_data.py    # Elo, outcome model, xPts, midseason study → docs/data/*.js
│   └── names.py         # club-name normalisation
└── docs/                # the static dashboard (served by GitHub Pages)
    ├── index.html
    ├── app.js           # verdict logic, Monte Carlo, D3 charts
    ├── style.css
    ├── vendor/d3.min.js # D3 v7 (ISC licence)
    └── data/            # generated data files
```

## Run it yourself

```bash
# 1. (optional) refresh the raw data
git clone --depth 1 https://github.com/openfootball/football.json.git /tmp/fj
# copy <season>/{en,es,de,it,fr}.1.json into data/raw/<season>/

# 2. rebuild the analysis (Python 3.10+, numpy, scipy)
pip install numpy scipy
python scripts/build_data.py

# 3. open the dashboard
#    double-click docs/index.html, or:
python -m http.server -d docs 8000   # then visit http://localhost:8000
```

No build step and no server code: the dashboard is plain HTML, CSS and JavaScript.

## Deploy on GitHub Pages

Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs`**. The site appears at `https://<username>.github.io/sack-or-stick/` within a minute or two.

## License

Code: MIT (see `LICENSE`). Match data: openfootball, public domain. D3: ISC.
