# CLAUDE.md: project context

## What this is
**Sack or Stick?** is a football analytics web dashboard built by Alvito Buana (Informatics, Telkom University) as a **solo** entry for the **AQX Sports Analytics Data Bowl 4.0** (Devpost: https://aqxanalyticsfour.devpost.com/). The entry also counts toward his *Visualisasi Data* course grade (UTS), so it must stay focused on data visualization.

It answers one question for a club board: *is the team genuinely worse, or just unlucky?* It separates underlying strength (Elo) from luck (points minus expected points) and turns that into a verdict: Stick / Caution / Genuine decline / Declining and unlucky / On track.

## Deadline and status (as of 2026-10-29)
- **Submission deadline: 31 Oct 2026, 11:59 PM PT = Sunday 1 Nov 2026, ~13:59 WIB.**
- Required: working prototype + **public GitHub repo** + short project description. Video optional.
- Done: data pipeline, dashboard, README, Devpost text (`DEVPOST.md`), MIT license.
- **To do:**
  1. Push this folder to `https://github.com/alvitobuana/sack-or-stick-football-analytics` (repo exists, currently empty). No `.git` here yet:
     ```bash
     git init && git add . && git commit -m "Sack or Stick? - AQX Sports Analytics Data Bowl 4.0"
     git branch -M main
     git remote add origin https://github.com/alvitobuana/sack-or-stick-football-analytics.git
     git push -u origin main
     ```
  2. Enable GitHub Pages: Settings → Pages → Deploy from a branch → `main` / `/docs`. Live URL: `https://alvitobuana.github.io/sack-or-stick-football-analytics/`
  3. On Devpost: Join hackathon → create project → paste text from `DEVPOST.md` → add repo + demo links → submit. Screenshot the "Submitted" status as proof for the lecturer.

## Structure
```
data/raw/<season>/<league>.json   openfootball match results, top-5 leagues, 2010-11 → 2026-27 (live season partial)
scripts/build_data.py             the whole pipeline (see below); writes docs/data/*.js
scripts/names.py                  canonical club names (source renamed clubs in 2020-21, and 2023-24 for Ligue 1)
docs/                             static dashboard, served by GitHub Pages
  index.html                      layout and copy
  app.js                          all client logic: verdict rule, Monte Carlo, D3 charts, table, controls
  style.css                       light/dark tokens (validated dataviz palette), layout
  vendor/d3.min.js                D3 v7.9.0, bundled locally (no CDN needed)
  data/meta.js                    model params, out-of-sample test, midseason study → window.SOS_META
  data/<league>.js                per-league match data → window.SOS_DATA[<league>]
README.md                         GitHub readme (English)
DEVPOST.md                        Devpost form text (English)
```
Leagues: `en.1` Premier League, `es.1` LaLiga, `de.1` Bundesliga, `it.1` Serie A, `fr.1` Ligue 1.

## Pipeline (`python scripts/build_data.py`, needs numpy + scipy, runs in ~10 s)
1. Load results, normalise names (`names.canon`), drop cancelled matches.
2. Chronological Elo per league: margin-of-victory multiplier, home edge in the update, summer regression to mean, promoted clubs enter at the regressed average of the clubs they replace. K / HFA / REGRESS chosen by grid search on seasons ≤ 2018-19 (currently K=12.5, HFA=20, REGRESS=0.15).
3. Ordered-logit model: pre-match Elo gap → P(H/D/A); fitted on seasons ≤ 2018-19, tested on 2019-20+.
4. xPts per match = 3·P(win) + P(draw).
5. Midseason study on complete seasons (first season of each league skipped as Elo burn-in).
6. Writes compact JS data files. Match row format: `[md, date, homeIdx, awayIdx, hg, ag, rhPre, raPre, rhPost?, raPost?]`.

## Headline numbers (keep README / DEVPOST / dashboard consistent if they change)
- 1,206 club-seasons; luckiest 10%: +0.52 → +0.00 pts/game; unluckiest 10%: −0.51 → +0.00.
- Luck persistence r = −0.007. R² for 2nd-half PPG: points 0.48, goal difference 0.51, Elo 0.58.
- Out-of-sample (12,688 matches): log loss 0.991 vs 1.076 baseline; Brier 0.591 vs 0.651.
- ~25,700 played matches in total.
- Demo anecdote: EPL 2025-26 at MD19, Wolves 3 pts from 18.1 xPts, projected 18 (12–25), finished 20.

## Dashboard behaviour (docs/app.js)
- First load: latest **complete** season of the Premier League at its halfway matchday, focused on the club whose results most misrepresent its strength. Later season changes default to the last played matchday.
- Everything is recomputed as of the selected matchday (no look-ahead). Monte Carlo: 5,000 sims of remaining fixtures with frozen as-of ratings.
- Verdict rule: luck/game threshold ±0.25, Elo change threshold ±30, "Too early to judge" under 6 games.
- Works from `file://` (data loaded via `<script>` tags, not fetch), so double-clicking `docs/index.html` is enough. Local server alternative: `python -m http.server -d docs 8000`.

## Conventions
- Charts follow the dataviz rules: single y-axis, thin marks, legend for 2+ series, text in ink tokens (never series color), hover tooltip on every chart, light + dark mode, no horizontal scroll at 390px.
- Keep the dashboard dependency-free apart from bundled D3; no build step.
- Talk to Alvito in casual Indonesian; project-facing text (README, Devpost, UI) stays in English.
