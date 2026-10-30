/* Sack or Stick? — dashboard logic. Pure client-side; data comes from data/*.js */
(function () {
  "use strict";
  const META = window.SOS_META;
  const M = META.model;
  const SIMS = 5000;
  const fmt1 = d3.format(".1f");
  const fmtSigned = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±") + fmt1(Math.abs(v));
  const fmtSigned2 = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(2);
  const pct = (v) => (v < 0.005 ? "<1%" : v > 0.995 ? ">99%" : Math.round(v * 100) + "%");
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const state = { league: "en.1", season: null, md: null, team: null, sort: { key: "pos", dir: 1 } };
  const loaded = {};

  // ------------------------------------------------------------------ model
  function sig(x) { return 1 / (1 + Math.exp(-x)); }
  function probs(rh, ra) {
    const d = (rh - ra) / 400;
    const pa = sig(M.c1 - M.beta * d);
    const pad = sig(M.c2 - M.beta * d);
    return [1 - pad, pad - pa, pa];
  }

  // ------------------------------------------------------------------ data loading
  function loadLeague(lg) {
    if (loaded[lg]) return loaded[lg];
    loaded[lg] = new Promise((resolve, reject) => {
      if (window.SOS_DATA && window.SOS_DATA[lg]) return resolve(window.SOS_DATA[lg]);
      const s = document.createElement("script");
      s.src = `data/${lg}.js`;
      s.onload = () => resolve(window.SOS_DATA[lg]);
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return loaded[lg];
  }

  // ------------------------------------------------------------------ core computation
  // Builds everything the views need for (season data, as-of matchday)
  function compute(S, asOf) {
    const n = S.teams.length;
    const T = S.teams.map((name, i) => ({
      i, name, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, xpts: 0,
      elo: S.start[i], elo0: S.start[i], games: [],
    }));
    const remaining = [];
    for (const m of S.m) {
      const [md, date, h, a, hg, ag, rh, ra, rh2, ra2] = m;
      if (hg !== null && md <= asOf) {
        const [ph, pd, pa] = probs(rh, ra);
        const H = T[h], A = T[a];
        const hp = hg > ag ? 3 : hg === ag ? 1 : 0;
        const ap = ag > hg ? 3 : hg === ag ? 1 : 0;
        const hx = 3 * ph + pd, ax = 3 * pa + pd;
        H.p++; A.p++; H.gf += hg; H.ga += ag; A.gf += ag; A.ga += hg;
        H.pts += hp; A.pts += ap; H.xpts += hx; A.xpts += ax;
        if (hp === 3) { H.w++; A.l++; } else if (hp === 1) { H.d++; A.d++; } else { H.l++; A.w++; }
        H.elo = rh2; A.elo = ra2;
        H.games.push({ md, date, opp: a, home: true, gf: hg, ga: ag, pts: hp, xp: hx, elo: rh2, eloPre: rh });
        A.games.push({ md, date, opp: h, home: false, gf: ag, ga: hg, pts: ap, xp: ax, elo: ra2, eloPre: ra });
      } else {
        remaining.push([h, a]);
      }
    }
    T.forEach((t) => { t.luck = t.pts - t.xpts; t.gd = t.gf - t.ga; });

    // Monte Carlo of remaining fixtures with as-of ratings (fixed)
    const pr = remaining.map(([h, a]) => {
      const [ph, pd] = probs(T[h].elo, T[a].elo);
      return [h, a, ph, ph + pd];
    });
    const finals = T.map(() => new Float64Array(SIMS));
    const posCount = T.map(() => new Uint16Array(n));
    const pts = new Float64Array(n);
    const order = new Array(n);
    for (let s = 0; s < SIMS; s++) {
      for (let i = 0; i < n; i++) pts[i] = T[i].pts + T[i].gd * 1e-4 + Math.random() * 1e-5;
      for (const [h, a, ph, phd] of pr) {
        const u = Math.random();
        if (u < ph) pts[h] += 3; else if (u < phd) { pts[h] += 1; pts[a] += 1; } else pts[a] += 3;
      }
      for (let i = 0; i < n; i++) { order[i] = i; finals[i][s] = Math.round(pts[i]); }
      order.sort((x, y) => pts[y] - pts[x]);
      for (let r = 0; r < n; r++) posCount[order[r]][r]++;
    }
    const relN = n >= 20 ? 3 : 3; // 18-team leagues: 2 direct + play-off spot
    T.forEach((t, i) => {
      const arr = Array.from(finals[i]).sort((x, y) => x - y);
      t.projMean = d3.mean(arr);
      t.projLo = arr[Math.floor(SIMS * 0.1)];
      t.projHi = arr[Math.floor(SIMS * 0.9)];
      t.finals = arr;
      t.pTop4 = d3.sum(posCount[i].slice(0, 4)) / SIMS;
      t.pRel = d3.sum(posCount[i].slice(n - relN)) / SIMS;
      t.pTitle = posCount[i][0] / SIMS;
    });

    // table position (points, GD, GF)
    const ranked = [...T].sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
    ranked.forEach((t, r) => { t.pos = r + 1; });
    const eloRanked = [...T].sort((a, b) => b.elo - a.elo);
    eloRanked.forEach((t, r) => { t.eloRank = r + 1; });
    const xRanked = [...T].sort((a, b) => b.projMean - a.projMean);
    xRanked.forEach((t, r) => { t.projPos = r + 1; });
    return { teams: T, n, remaining: remaining.length, relN };
  }

  // ------------------------------------------------------------------ verdict
  function verdict(t, n) {
    const g = t.p;
    const dElo = t.elo - t.elo0;
    const perGame = g ? t.luck / g : 0;
    if (g < 6) {
      return { cls: "neutral", icon: "…", title: "Too early to judge",
        why: `Only ${g} game${g === 1 ? "" : "s"} played. Over this few matches, results are mostly noise. Our study found first-half luck has zero carry-over, and with fewer than 6 games even strength estimates barely move.` };
    }
    if (dElo <= -30 && perGame > -0.25) {
      return { cls: "critical", icon: "!", title: "Genuine decline, review warranted",
        why: `Underlying strength has fallen ${Math.round(-dElo)} Elo points since the season started, and the results are not unlucky (${fmtSigned(t.luck)} pts vs expected). The problem looks real.` };
    }
    if (perGame <= -0.25 && dElo > -30) {
      return { cls: "good", icon: "✓", title: "Stick: the results will come",
        why: `${fmtSigned(t.luck)} points below what the performances were worth, while underlying strength is ${dElo >= 0 ? "up" : "only down"} ${Math.abs(Math.round(dElo))} Elo points. Historically, the unluckiest 10% of teams fully recover to expectation in the second half.` };
    }
    if (perGame >= 0.25 && dElo < 30) {
      return { cls: "warning", icon: "?", title: "Caution: results are flattering",
        why: `${fmtSigned(t.luck)} points above expectation without a matching rise in strength (${dElo >= 0 ? "+" : "−"}${Math.abs(Math.round(dElo))} Elo). Expect the table position to slip; don't hand out a new contract on this run alone.` };
    }
    if (dElo <= -30) {
      return { cls: "serious", icon: "!", title: "Declining and unlucky",
        why: `Strength is down ${Math.round(-dElo)} Elo points and results are also below expectation (${fmtSigned(t.luck)}). Some of the slump is bad luck, but not all of it.` };
    }
    return { cls: "good", icon: "✓", title: "On track",
      why: `Results match performance (${fmtSigned(t.luck)} pts vs expected) and strength has moved ${dElo >= 0 ? "+" : "−"}${Math.abs(Math.round(dElo))} Elo since the start. Nothing here calls for a change.` };
  }

  // ------------------------------------------------------------------ tooltip
  const tip = document.getElementById("tooltip");
  function showTip(html, ev) {
    tip.innerHTML = html; tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > innerHeight - 8) y = ev.clientY - h - pad;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function hideTip() { tip.hidden = true; }

  // ------------------------------------------------------------------ chart helpers
  function frame(el, height, margin) {
    const box = document.getElementById(el);
    box.innerHTML = "";
    const width = Math.max(280, box.clientWidth || 520);
    const svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img");
    const g = svg.append("g").attr("transform", `translate(${margin.l},${margin.t})`);
    return { box, svg, g, w: width - margin.l - margin.r, h: height - margin.t - margin.b, width, height };
  }
  function grid(g, y, w) {
    g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));
  }
  function axes(g, x, y, h, opts = {}) {
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(opts.xt || 6).tickSizeOuter(0).tickFormat(opts.xf || null));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickSizeOuter(0).tickFormat(opts.yf || null))
      .call((s) => s.select(".domain").remove());
  }
  function axisLabel(g, text, x, y, anchor = "start") {
    g.append("text").attr("class", "label-secondary").attr("x", x).attr("y", y).attr("text-anchor", anchor).text(text);
  }
  function legend(box, items) {
    const div = document.createElement("div");
    div.className = "legend";
    div.innerHTML = items.map((it) =>
      `<span><i class="${it.kind || ""}" style="background:${it.color}"></i>${it.label}</span>`).join("");
    box.appendChild(div);
  }

  // ------------------------------------------------------------------ charts (live)
  // luck class per club: same ±0.25 pts/game threshold the verdict uses
  const LUCK_T = 0.25, ELO_T = 30;
  const luckPg = (t) => (t.p ? t.luck / t.p : 0);
  const luckColor = (t) => (luckPg(t) >= LUCK_T ? css("--div-pos") : luckPg(t) <= -LUCK_T ? css("--div-neg") : css("--other"));

  // nearest-point hover + click layer for dense scatters
  function pickLayer(F, data, px, py, onMove) {
    const del = d3.Delaunay.from(data, px, py);
    const ring = F.g.append("circle").attr("r", 9).attr("fill", "none").attr("stroke", css("--text-primary"))
      .attr("stroke-width", 1.5).attr("visibility", "hidden").style("pointer-events", "none");
    let cur = null;
    F.g.append("rect").attr("width", F.w).attr("height", F.h).attr("fill", "transparent").style("cursor", "pointer")
      .on("mousemove", (ev) => {
        const [mx, my] = d3.pointer(ev);
        cur = data[del.find(mx, my)];
        ring.attr("cx", px(cur)).attr("cy", py(cur)).attr("visibility", "visible");
        onMove(cur, ev);
      })
      .on("mouseleave", () => { ring.attr("visibility", "hidden"); hideTip(); })
      .on("click", () => { if (cur) { state.team = cur.i; hideTip(); renderLive(); } });
  }
  function clubTip(t, C) {
    const v = verdict(t, C.n);
    return `<b>${t.name}</b> <span class="muted">${t.pos}${["st", "nd", "rd"][t.pos - 1] || "th"}</span>
      <div class="row"><span>Points / xPts</span><span>${t.pts} / ${fmt1(t.xpts)}</span></div>
      <div class="row"><span>Luck</span><span>${fmtSigned(t.luck)} (${fmtSigned2(luckPg(t))}/game)</span></div>
      <div class="row"><span>Elo change</span><span>${fmtSigned(t.elo - t.elo0).replace(".0", "")}</span></div>
      <div class="row"><span>Verdict</span><span>${v.title.split(":")[0].split(",")[0]}</span></div>
      <div class="muted">Click to focus</div>`;
  }

  function chartDecision(C) {
    const T = C.teams;
    const F = frame("chart-decision", 330, { t: 22, r: 12, b: 38, l: 48 });
    const de = (t) => t.elo - t.elo0;
    const xm = Math.max(0.8, d3.max(T, (t) => Math.abs(luckPg(t))) * 1.12);
    const ym = Math.max(70, d3.max(T, (t) => Math.abs(de(t))) * 1.12);
    const x = d3.scaleLinear().domain([-xm, xm]).range([0, F.w]);
    const y = d3.scaleLinear().domain([-ym, ym]).range([F.h, 0]);
    // verdict zones (checked in the same order as verdict())
    const zones = [
      { v: "--critical", x0: -LUCK_T, x1: xm, y0: -ym, y1: -ELO_T, label: "Genuine decline", lx: xm, ly: -ym, a: "end", dy: -8 },
      { v: "--serious", x0: -xm, x1: -LUCK_T, y0: -ym, y1: -ELO_T, label: "Declining & unlucky", lx: -xm, ly: -ym, a: "start", dy: -8 },
      { v: "--good", x0: -xm, x1: -LUCK_T, y0: -ELO_T, y1: ym, label: "Stick", lx: -xm, ly: ym, a: "start", dy: 16 },
      { v: "--warning", x0: LUCK_T, x1: xm, y0: -ELO_T, y1: ELO_T, label: "Caution", lx: xm, ly: ELO_T, a: "end", dy: 16 },
    ];
    zones.forEach((z) => F.g.append("rect").attr("x", x(z.x0)).attr("width", x(z.x1) - x(z.x0))
      .attr("y", y(z.y1)).attr("height", y(z.y0) - y(z.y1)).attr("fill", css(z.v)).attr("opacity", 0.13));
    grid(F.g, y, F.w);
    axes(F.g, x, y, F.h, { xt: 5, xf: (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1), yf: (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v) });
    F.g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", F.h).attr("stroke", css("--axis"));
    F.g.append("line").attr("x1", 0).attr("x2", F.w).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", css("--axis"));
    [[x(-LUCK_T), 0, x(-LUCK_T), F.h], [x(LUCK_T), y(ELO_T), x(LUCK_T), y(-ELO_T)], [0, y(-ELO_T), F.w, y(-ELO_T)], [x(LUCK_T), y(ELO_T), F.w, y(ELO_T)]]
      .forEach(([x1, y1, x2, y2]) => F.g.append("line").attr("x1", x1).attr("y1", y1).attr("x2", x2).attr("y2", y2)
        .attr("stroke", css("--text-muted")).attr("stroke-width", 1).attr("stroke-dasharray", "3 3"));
    const zoneText = zones.map((z) => ({ z, el: F.g.append("text").attr("class", "label-secondary zone-label").attr("x", x(z.lx) + (z.a === "start" ? 6 : -6))
      .attr("y", y(z.ly) + z.dy).attr("text-anchor", z.a).text(z.label) }));
    F.g.append("text").attr("class", "label-secondary zone-label").attr("x", x(0) + 6).attr("y", y(ym) + 16).text("On track");
    axisLabel(F.g, "Luck per game (pts − xPts) →", F.w, F.h + 32, "end");
    axisLabel(F.g, "↑ Elo change since season start", -40, -10);

    const focus = T[state.team];
    F.g.selectAll("circle.team").data(T.filter((t) => t.i !== state.team)).join("circle").attr("class", "team")
      .attr("cx", (t) => x(luckPg(t))).attr("cy", (t) => y(de(t))).attr("r", 4.5)
      .attr("fill", css("--text-muted")).attr("stroke", css("--surface-1")).attr("stroke-width", 1.5);
    F.g.append("circle").attr("cx", x(luckPg(focus))).attr("cy", y(de(focus))).attr("r", 7)
      .attr("fill", css("--series-1")).attr("stroke", css("--surface-1")).attr("stroke-width", 2);
    const right = x(luckPg(focus)) > F.w * 0.7;
    const fl = F.g.append("text").attr("class", "label-primary").attr("x", x(luckPg(focus)) + (right ? -11 : 11)).attr("y", y(de(focus)) + 4)
      .attr("text-anchor", right ? "end" : "start").text(focus.name);
    // a zone label that collides with the focus dot or its name moves to the other edge of its zone
    const fb = fl.node().getBBox(), cx0 = x(luckPg(focus)), cy0 = y(de(focus));
    const box = { x: Math.min(fb.x, cx0 - 9), y: Math.min(fb.y, cy0 - 9), x2: Math.max(fb.x + fb.width, cx0 + 9), y2: Math.max(fb.y + fb.height, cy0 + 9) };
    zoneText.forEach(({ z, el }) => {
      const b = el.node().getBBox();
      if (b.x < box.x2 && b.x + b.width > box.x && b.y < box.y2 && b.y + b.height > box.y) {
        const otherY = z.ly === z.y0 ? z.y1 : z.y0;
        el.attr("y", y(otherY) + (otherY === z.y1 ? 16 : -8));
      }
    });
    if (focus.p < 6) {
      const note = document.createElement("p");
      note.className = "chart-note";
      note.textContent = `Only ${focus.p} game${focus.p === 1 ? "" : "s"} played: positions this early are mostly noise, so no verdict is given yet.`;
      F.box.appendChild(note);
    }
    pickLayer(F, T, (t) => x(luckPg(t)), (t) => y(de(t)), (t, ev) => showTip(clubTip(t, C), ev));
  }

  function chartLuck(C) {
    const T = C.teams;
    const F = frame("chart-luck", 360, { t: 22, r: 16, b: 38, l: 44 });
    const max = Math.max(3, d3.max(T, (t) => Math.max(t.pts, t.xpts))) * 1.06;
    const x = d3.scaleLinear().domain([0, max]).range([0, F.w]).nice();
    const y = d3.scaleLinear().domain([0, max]).range([F.h, 0]).nice();
    const dm = Math.min(x.domain()[1], y.domain()[1]);
    // normal-range band: ±0.25 pts/game over a typical number of games played
    const band = LUCK_T * (d3.median(T, (t) => t.p) || 0);
    const clipId = "clip-luck";
    F.svg.append("defs").append("clipPath").attr("id", clipId).append("rect").attr("width", F.w).attr("height", F.h);
    F.g.append("path").attr("clip-path", `url(#${clipId})`).attr("fill", css("--other")).attr("opacity", 0.22)
      .attr("d", `M${x(0)},${y(band)}L${x(dm)},${y(dm + band)}L${x(dm)},${y(dm - band)}L${x(0)},${y(-band)}Z`);
    grid(F.g, y, F.w);
    axes(F.g, x, y, F.h);
    axisLabel(F.g, "Expected points (xPts) →", F.w, F.h + 32, "end");
    axisLabel(F.g, "↑ Actual points", -36, -10);
    F.g.append("line").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(dm)).attr("y2", y(dm))
      .attr("stroke", css("--text-muted")).attr("stroke-width", 1).attr("stroke-dasharray", "4 4");
    F.g.append("text").attr("class", "label-secondary").attr("x", 8).attr("y", 14).text("↖ flattered by results");
    F.g.append("text").attr("class", "label-secondary").attr("x", F.w - 4).attr("y", F.h - 8).attr("text-anchor", "end").text("unlucky ↘");

    const sorted = [...T].sort((a, b) => (a.i === state.team) - (b.i === state.team));
    F.g.selectAll("circle.team").data(sorted).join("circle").attr("class", "team")
      .attr("cx", (t) => x(t.xpts)).attr("cy", (t) => y(t.pts))
      .attr("r", (t) => (t.i === state.team ? 7 : 5))
      .attr("fill", luckColor)
      .attr("stroke", (t) => (t.i === state.team ? css("--text-primary") : css("--surface-1")))
      .attr("stroke-width", 2);
    pickLayer(F, T, (t) => x(t.xpts), (t) => y(t.pts), (t, ev) => showTip(clubTip(t, C), ev));
    legend(F.box, [
      { label: "Flattered (≥ +0.25 pts/game)", color: css("--div-pos"), kind: "dot" },
      { label: "Unlucky (≤ −0.25)", color: css("--div-neg"), kind: "dot" },
      { label: "Normal range", color: css("--other"), kind: "dot" },
      { label: "Selected club", color: "", kind: "ring" },
    ]);

    // selective labels: focus + 2 luckiest + 2 unluckiest
    const byLuck = [...T].sort((a, b) => b.luck - a.luck);
    const lab = new Set([state.team, byLuck[0].i, byLuck[1].i, byLuck[T.length - 1].i, byLuck[T.length - 2].i]);
    // place focus label first, then skip any label that would collide with one already placed
    const cand = T.filter((t) => lab.has(t.i)).sort((a, b) => (b.i === state.team) - (a.i === state.team));
    const placed = [];
    cand.forEach((t) => {
      const right = x(t.xpts) > F.w * 0.7;
      const w = t.name.length * 6.6, hh = 14;
      const lx = right ? x(t.xpts) - 10 - w : x(t.xpts) + 10;
      const ly = y(t.pts) - 7;
      const hit = placed.some((b) => lx < b.x + b.w && lx + w > b.x && ly < b.y + b.h && ly + hh > b.y);
      const dotHit = T.some((u) => u.i !== t.i && Math.abs(x(u.xpts) - (lx + w / 2)) < w / 2 && Math.abs(y(u.pts) - (ly + hh / 2)) < hh / 2 + 2);
      if (hit || (dotHit && t.i !== state.team)) return;
      placed.push({ x: lx, y: ly, w, h: hh });
      F.g.append("text").attr("class", t.i === state.team ? "label-primary" : "label-secondary")
        .attr("x", right ? x(t.xpts) - 10 : x(t.xpts) + 10).attr("y", y(t.pts) + 4)
        .attr("text-anchor", right ? "end" : "start").text(t.name);
    });
  }

  function chartTraj(C) {
    const t = C.teams[state.team];
    document.getElementById("traj-title").textContent = `${t.name}: points vs expected, game by game`;
    const F = frame("chart-traj", 400, { t: 12, r: 64, b: 38, l: 44 });
    if (!t.games.length) { F.box.innerHTML = '<p class="empty">No games played yet at this matchday.</p>'; return; }
    let cp = 0, cx = 0;
    const rows = [{ g: 0, p: 0, x: 0 }].concat(t.games.map((gm, k) => {
      cp += gm.pts; cx += gm.xp; return { g: k + 1, p: cp, x: cx, gm };
    }));
    // top: cumulative lines; bottom strip: per-game luck (own scale, own panel)
    const stripH = 64, gap = 26, mainH = F.h - stripH - gap;
    const x = d3.scaleLinear().domain([0, Math.max(rows.length - 1, 1)]).range([0, F.w]);
    const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => Math.max(r.p, r.x)) * 1.08 || 3]).range([mainH, 0]).nice();
    grid(F.g, y, F.w);
    F.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickSizeOuter(0)).call((s) => s.select(".domain").remove());
    F.g.append("line").attr("x1", 0).attr("x2", F.w).attr("y1", mainH).attr("y2", mainH).attr("stroke", css("--axis"));
    F.g.append("g").attr("class", "axis").attr("transform", `translate(0,${F.h})`)
      .call(d3.axisBottom(x).ticks(Math.min(10, rows.length - 1)).tickSizeOuter(0).tickFormat(d3.format("d")));
    axisLabel(F.g, "Games played →", F.w, F.h + 32, "end");
    const s0 = mainH + gap;
    const lm = Math.max(1.5, d3.max(t.games, (gm) => Math.abs(gm.pts - gm.xp)));
    const ys = d3.scaleLinear().domain([-lm, lm]).range([F.h, s0]);
    axisLabel(F.g, "Each game: points − xPts", 0, s0 - 8);
    F.g.append("line").attr("x1", 0).attr("x2", F.w).attr("y1", ys(0)).attr("y2", ys(0)).attr("stroke", css("--axis"));
    const bw = Math.max(2, Math.min(12, F.w / rows.length - 3));
    F.g.selectAll("rect.gbar").data(rows.slice(1)).join("rect").attr("class", "gbar")
      .attr("x", (r) => x(r.g) - bw / 2).attr("width", bw).attr("rx", Math.min(2, bw / 2))
      .attr("y", (r) => Math.min(ys(0), ys(r.gm.pts - r.gm.xp)))
      .attr("height", (r) => Math.max(1, Math.abs(ys(r.gm.pts - r.gm.xp) - ys(0))))
      .attr("fill", (r) => (r.gm.pts - r.gm.xp >= 0 ? css("--div-pos") : css("--div-neg")));
    F.g.append("text").attr("class", "label-secondary").attr("x", F.w + 6).attr("y", ys(lm * 0.55) + 4).text("lucky");
    F.g.append("text").attr("class", "label-secondary").attr("x", F.w + 6).attr("y", ys(-lm * 0.55) + 4).text("unlucky");
    // gap area
    F.g.append("path").datum(rows)
      .attr("fill", t.luck >= 0 ? css("--div-pos") : css("--div-neg")).attr("opacity", 0.1)
      .attr("d", d3.area().x((r) => x(r.g)).y0((r) => y(r.x)).y1((r) => y(r.p)));
    const line = (k) => d3.line().x((r) => x(r.g)).y((r) => y(r[k]));
    F.g.append("path").datum(rows).attr("fill", "none").attr("stroke", css("--text-muted")).attr("stroke-width", 2)
      .attr("stroke-dasharray", "5 4").attr("d", line("x"));
    F.g.append("path").datum(rows).attr("fill", "none").attr("stroke", css("--series-1")).attr("stroke-width", 2)
      .attr("stroke-linejoin", "round").attr("stroke-linecap", "round").attr("d", line("p"));
    const last = rows[rows.length - 1];
    F.g.append("circle").attr("cx", x(last.g)).attr("cy", y(last.p)).attr("r", 4.5)
      .attr("fill", css("--series-1")).attr("stroke", css("--surface-1")).attr("stroke-width", 2);
    const ly1 = y(last.p), ly2 = y(last.x);
    const sep = Math.abs(ly1 - ly2) < 14 ? (ly1 < ly2 ? -7 : 7) : 0;
    F.g.append("text").attr("class", "label-primary").attr("x", x(last.g) + 8).attr("y", ly1 + 4 + sep).text(`${last.p} pts`);
    F.g.append("text").attr("class", "label-secondary").attr("x", x(last.g) + 8).attr("y", ly2 + 4 - sep).text(`${fmt1(last.x)} xPts`);
    legend(F.box, [
      { label: "Actual points", color: css("--series-1") }, { label: "Expected points (xPts)", color: "", kind: "dash" },
      { label: "Game above xPts", color: css("--div-pos"), kind: "band" }, { label: "Game below xPts", color: css("--div-neg"), kind: "band" },
    ]);

    // crosshair hover
    const cross = F.g.append("line").attr("y1", 0).attr("y2", F.h).attr("stroke", css("--axis")).attr("visibility", "hidden");
    F.g.append("rect").attr("width", F.w).attr("height", F.h).attr("fill", "transparent")
      .on("mousemove", (ev) => {
        const [mx] = d3.pointer(ev);
        const r = rows[Math.max(1, Math.min(rows.length - 1, Math.round(x.invert(mx))))];
        if (!r || !r.gm) return;
        cross.attr("x1", x(r.g)).attr("x2", x(r.g)).attr("visibility", "visible");
        const opp = C.teams[r.gm.opp].name;
        showTip(`<b>Game ${r.g} · MD ${r.gm.md}</b> <span class="muted">${r.gm.date}</span>
          <div>${r.gm.home ? "vs" : "at"} ${opp}: <b>${r.gm.gf}–${r.gm.ga}</b></div>
          <div class="row"><span>Points earned / expected</span><span>${r.gm.pts} / ${fmt1(r.gm.xp)}</span></div>
          <div class="row"><span>Cumulative pts</span><span>${r.p}</span></div>
          <div class="row"><span>Cumulative xPts</span><span>${fmt1(r.x)}</span></div>
          <div class="row"><span>Game luck</span><span>${fmtSigned(r.gm.pts - r.gm.xp)}</span></div>`, ev);
      })
      .on("mouseleave", () => { cross.attr("visibility", "hidden"); hideTip(); });
  }

  function chartElo(C) {
    const t = C.teams[state.team];
    document.getElementById("elo-title").textContent = `${t.name}: underlying strength (Elo)`;
    const F = frame("chart-elo", 320, { t: 14, r: 76, b: 38, l: 48 });
    const rows = [{ g: 0, elo: t.elo0 }].concat(t.games.map((gm, k) => ({ g: k + 1, elo: gm.elo, gm })));
    // reference levels as of this matchday: 4th-strongest and last-safe club by Elo
    const elos = C.teams.map((u) => u.elo).sort((a, b) => b - a);
    const top4 = elos[3], safe = elos[C.n - C.relN - 1];
    const ext = d3.extent(rows.map((r) => r.elo).concat([top4, safe]));
    const x = d3.scaleLinear().domain([0, Math.max(rows.length - 1, 1)]).range([0, F.w]);
    const y = d3.scaleLinear().domain([ext[0] - 20, ext[1] + 20]).range([F.h, 0]).nice();
    F.g.append("rect").attr("x", 0).attr("width", F.w).attr("y", y(top4)).attr("height", y(safe) - y(top4))
      .attr("fill", css("--other")).attr("opacity", 0.16);
    grid(F.g, y, F.w);
    axes(F.g, x, y, F.h, { xt: Math.min(10, Math.max(1, rows.length - 1)), xf: d3.format("d"), yf: d3.format("d") });
    axisLabel(F.g, "Games played →", F.w, F.h + 32, "end");
    [[top4, "top-4 level"], [safe, "drop-zone line"]].forEach(([v, lab]) => {
      F.g.append("line").attr("x1", 0).attr("x2", F.w).attr("y1", y(v)).attr("y2", y(v))
        .attr("stroke", css("--text-muted")).attr("stroke-dasharray", "4 4").attr("stroke-width", 1);
      F.g.append("text").attr("class", "label-secondary").attr("x", F.w + 6).attr("y", y(v) + 4).text(lab);
    });
    F.g.append("text").attr("class", "label-secondary").attr("x", 6).attr("y", (y(top4) + y(safe)) / 2 + 4).text("mid-table range");
    F.g.append("path").datum(rows).attr("fill", "none").attr("stroke", css("--series-1")).attr("stroke-width", 2)
      .attr("stroke-linejoin", "round").attr("d", d3.line().x((r) => x(r.g)).y((r) => y(r.elo)));
    const last = rows[rows.length - 1];
    F.g.append("circle").attr("cx", x(last.g)).attr("cy", y(last.elo)).attr("r", 4.5)
      .attr("fill", css("--series-1")).attr("stroke", css("--surface-1")).attr("stroke-width", 2);
    const near = [top4, safe].find((v) => Math.abs(y(last.elo) - y(v)) < 14);
    const labY = near !== undefined ? y(last.elo) + (y(last.elo) < y(near) ? -6 : 16) : y(last.elo) + 4;
    F.g.append("text").attr("class", "label-primary").attr("x", x(last.g) + 8).attr("y", labY).text(Math.round(last.elo));
    const cross = F.g.append("line").attr("y1", 0).attr("y2", F.h).attr("stroke", css("--axis")).attr("visibility", "hidden");
    F.g.append("rect").attr("width", F.w).attr("height", F.h).attr("fill", "transparent")
      .on("mousemove", (ev) => {
        const [mx] = d3.pointer(ev);
        const r = rows[Math.max(0, Math.min(rows.length - 1, Math.round(x.invert(mx))))];
        cross.attr("x1", x(r.g)).attr("x2", x(r.g)).attr("visibility", "visible");
        const body = r.gm
          ? `<b>Game ${r.g}</b> ${r.gm.home ? "vs" : "at"} ${C.teams[r.gm.opp].name} ${r.gm.gf}–${r.gm.ga}
             <div class="row"><span>Elo after</span><span>${Math.round(r.elo)} (${fmtSigned(r.elo - r.gm.eloPre)})</span></div>`
          : `<b>Season start</b><div class="row"><span>Elo</span><span>${Math.round(r.elo)}</span></div>`;
        showTip(body, ev);
      })
      .on("mouseleave", () => { cross.attr("visibility", "hidden"); hideTip(); });
  }

  function chartProj(C) {
    const t = C.teams[state.team];
    document.getElementById("proj-title").textContent = `${t.name}: where the season ends`;
    const F = frame("chart-proj", 320, { t: 22, r: 16, b: 38, l: 44 });
    const counts = d3.rollups(t.finals, (v) => v.length, (v) => v).sort((a, b) => a[0] - b[0]);
    const x = d3.scaleBand().domain(d3.range(d3.min(counts, (c) => c[0]), d3.max(counts, (c) => c[0]) + 1)).range([0, F.w]).padding(0.12);
    const y = d3.scaleLinear().domain([0, d3.max(counts, (c) => c[1]) / SIMS]).range([F.h, 0]).nice();
    grid(F.g, y, F.w);
    const step = Math.ceil(x.domain().length / 10);
    F.g.append("g").attr("class", "axis").attr("transform", `translate(0,${F.h})`)
      .call(d3.axisBottom(x).tickValues(x.domain().filter((d, i) => i % step === 0)).tickSizeOuter(0));
    F.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(".0%"))).call((s) => s.select(".domain").remove());
    axisLabel(F.g, "Final points →", F.w, F.h + 32, "end");
    const bw = Math.min(24, x.bandwidth());
    const r = Math.min(4, bw / 2);
    F.g.selectAll("path.bar").data(counts).join("path").attr("class", "bar")
      .attr("fill", (c) => (c[0] >= t.projLo && c[0] <= t.projHi ? css("--series-1") : css("--other")))
      .attr("d", (c) => {
        const x0 = x(c[0]) + (x.bandwidth() - bw) / 2, y0 = y(c[1] / SIMS), hgt = F.h - y0;
        const rr = Math.min(r, hgt);
        return `M${x0},${F.h}V${y0 + rr}Q${x0},${y0} ${x0 + rr},${y0}H${x0 + bw - rr}Q${x0 + bw},${y0} ${x0 + bw},${y0 + rr}V${F.h}Z`;
      })
      .on("mousemove", (ev, c) => showTip(`<b>${c[0]} points</b><div class="row"><span>Probability</span><span>${(c[1] / SIMS * 100).toFixed(1)}%</span></div>`, ev))
      .on("mouseleave", hideTip);
    // marker at the average outcome
    const mx = x(Math.round(t.projMean)) + x.bandwidth() / 2;
    F.g.append("line").attr("x1", mx).attr("x2", mx).attr("y1", -6).attr("y2", F.h)
      .attr("stroke", css("--text-primary")).attr("stroke-width", 1).attr("stroke-dasharray", "3 3");
    F.g.append("text").attr("class", "label-primary").attr("x", mx).attr("y", -10).attr("text-anchor", "middle")
      .text(`expected ${Math.round(t.projMean)} pts`);
    legend(F.box, [
      { label: `80% range: ${t.projLo}–${t.projHi} pts`, color: css("--series-1"), kind: "dot" },
      { label: "Less likely outcomes", color: css("--other"), kind: "dot" },
    ]);
  }

  // ------------------------------------------------------------------ verdict + tiles
  function renderVerdict(C) {
    const t = C.teams[state.team];
    const v = verdict(t, C.n);
    const colorVar = { good: "--good", warning: "--warning", serious: "--serious", critical: "--critical", neutral: "--text-muted" }[v.cls];
    document.getElementById("verdict").innerHTML = `
      <p class="club">${t.name} · ${META.leagues[state.league]} ${state.season} · after matchday ${state.md}</p>
      <p class="call"><span class="badge ${v.cls}" style="background:var(${colorVar})" aria-hidden="true">${v.icon}</span>${v.title}</p>
      <p class="why">${v.why}</p>
      <p class="rule">Rule: luck = points − xPts; strength change = Elo now − Elo at season start. Thresholds ±0.25 pts/game and ±30 Elo.</p>`;
    const tiles = [
      { label: "League position", value: `${t.pos}<span class="sub"> / ${C.n}</span>`, sub: `Elo rank ${t.eloRank} · ${t.p} played` },
      { label: "Points vs expected", value: fmtSigned(t.luck), sub: `${t.pts} pts from ${fmt1(t.xpts)} xPts` },
      { label: "Elo change this season", value: fmtSigned(t.elo - t.elo0).replace(".0", ""), sub: `${Math.round(t.elo0)} → ${Math.round(t.elo)}` },
      { label: "Projected final points", value: Math.round(t.projMean), sub: `80% range ${t.projLo}–${t.projHi}` },
      { label: "Chance of top 4", value: pct(t.pTop4), sub: `Title ${pct(t.pTitle)}` },
      { label: "Chance of bottom 3", value: pct(t.pRel), sub: C.n === 18 ? "incl. play-off place" : "relegation places" },
    ];
    document.getElementById("tiles").innerHTML = tiles.map((x) =>
      `<div class="tile"><div class="label">${x.label}</div><div class="value">${x.value}</div><div class="sub">${x.sub}</div></div>`).join("");
  }

  // ------------------------------------------------------------------ table
  const COLS = [
    { key: "pos", label: "#", f: (t) => t.pos },
    { key: "name", label: "Club", f: (t) => t.name },
    { key: "p", label: "P", f: (t) => t.p },
    { key: "gd", label: "GD", f: (t) => (t.gd > 0 ? "+" : "") + t.gd },
    { key: "pts", label: "Pts", f: (t) => t.pts },
    { key: "xpts", label: "xPts", f: (t) => fmt1(t.xpts) },
    { key: "luck", label: "Luck (pts − xPts)", f: null },
    { key: "elo", label: "Elo", f: (t) => Math.round(t.elo) },
    { key: "eloRank", label: "Strength rank", f: (t) => {
      const d = t.pos - t.eloRank;
      return `${t.eloRank}<span class="delta">${d > 0 ? "▲" + d : d < 0 ? "▼" + -d : ""}</span>`;
    } },
    { key: "projMean", label: "Proj. pts", f: (t) => Math.round(t.projMean) },
    { key: "pTop4", label: "Top 4", f: (t) => pct(t.pTop4), tint: true },
    { key: "pRel", label: "Bottom 3", f: (t) => pct(t.pRel), tint: true },
  ];
  // single-hue tint for probability cells: stronger = more likely
  const tint = (p) => `background:color-mix(in srgb, var(--series-1) ${Math.round(p * 38)}%, transparent)`;
  function renderTable(C) {
    const maxLuck = Math.max(1, d3.max(C.teams, (t) => Math.abs(t.luck)));
    const { key, dir } = state.sort;
    const rows = [...C.teams].sort((a, b) => {
      const va = a[key], vb = b[key];
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
    });
    const bar = (v) => {
      const w = 90, half = w / 2, len = Math.abs(v) / maxLuck * (half - 2);
      const xx = v >= 0 ? half : half - len;
      return `<svg width="${w}" height="12" aria-hidden="true"><line x1="${half}" x2="${half}" y1="0" y2="12" stroke="var(--axis)"/>
        <rect x="${xx}" y="2" width="${Math.max(len, 0.5)}" height="8" rx="2" fill="var(${v >= 0 ? "--div-pos" : "--div-neg"})"/></svg>`;
    };
    const tbl = document.getElementById("standings");
    tbl.innerHTML = `<thead><tr>${COLS.map((c) =>
      `<th data-k="${c.key}" ${c.key === key ? `aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}>${c.label}${c.key === key ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((t) => {
        const zone = t.pos <= 4 ? "zone-top" : t.pos > C.n - C.relN ? "zone-rel" : "";
        return `<tr data-i="${t.i}" class="${zone} ${t.i === state.team ? "focus" : ""}">${COLS.map((c) =>
          c.key === "luck" ? `<td class="luck"><span class="luckbar">${fmtSigned(t.luck)} ${bar(t.luck)}</span></td>`
            : `<td${c.tint ? ` style="${tint(t[c.key])}"` : ""}>${c.f(t)}</td>`).join("")}</tr>`;
      }).join("")}</tbody>`;
    document.getElementById("table-legend").innerHTML = [
      [`zone" style="background:var(--good)`, "Top-4 places"], [`zone" style="background:var(--critical)`, `Bottom ${C.relN}`],
      [`band" style="background:var(--div-pos)`, "Points above xPts"], [`band" style="background:var(--div-neg)`, "Points below xPts"],
      [`band" style="background:color-mix(in srgb, var(--series-1) 38%, transparent)`, "Shading = probability"],
    ].map(([k, l]) => `<span><i class="${k}"></i>${l}</span>`).join("") +
      `<span>▲/▼ = places higher/lower on strength than in the table</span>`;
    tbl.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k;
      state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: ["pos", "name", "pRel"].includes(k) ? 1 : -1 };
      renderTable(C);
    }));
    tbl.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => {
      state.team = +tr.dataset.i; renderLive();
    }));
  }

  // ------------------------------------------------------------------ evidence (static)
  function renderEvidence() {
    const st = META.study;
    document.getElementById("evidence-lede").innerHTML =
      `We split <strong>${st.n.toLocaleString()} complete club-seasons</strong> (5 leagues, 2011–2026) at the halfway mark.
       The luckiest 10% of teams were <strong>${fmtSigned(st.lucky10.pae1)} pts/game</strong> above expectation in the first half,
       then <strong>${fmtSigned(st.lucky10.pae2)}</strong> in the second. The unluckiest 10% went from <strong>${fmtSigned(st.unlucky10.pae1)}</strong>
       to <strong>${fmtSigned(st.unlucky10.pae2)}</strong>. Luck does not carry over (r = ${st.pae_persistence_r.toFixed(3)}); strength does.`;

    // persistence scatter
    {
      const F = frame("chart-persist", 300, { t: 12, r: 12, b: 38, l: 44 });
      const pts = st.scatter;
      const x = d3.scaleLinear().domain([-1.3, 1.3]).range([0, F.w]);
      const y = d3.scaleLinear().domain([-1.3, 1.3]).range([F.h, 0]);
      grid(F.g, y, F.w);
      axes(F.g, x, y, F.h, { xt: 5, xf: fmtSigned, yf: fmtSigned });
      F.g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", F.h).attr("stroke", css("--axis"));
      F.g.append("line").attr("x1", 0).attr("x2", F.w).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", css("--axis"));
      axisLabel(F.g, "Luck, 1st half (pts/game) →", F.w, F.h + 32, "end");
      axisLabel(F.g, "Luck, 2nd half", 0, -2);
      // "if luck persisted" reference diagonal
      F.g.append("line").attr("x1", x(-1.3)).attr("y1", y(-1.3)).attr("x2", x(1.3)).attr("y2", y(1.3))
        .attr("stroke", css("--text-muted")).attr("stroke-width", 1).attr("stroke-dasharray", "4 4");
      F.g.append("text").attr("class", "label-secondary").attr("x", x(1.25)).attr("y", y(1.25) + 14)
        .attr("text-anchor", "end").text("if luck persisted");
      F.g.append("g").selectAll("circle").data(pts).join("circle")
        .attr("cx", (d) => x(d[0])).attr("cy", (d) => y(d[1])).attr("r", 2.4)
        .attr("fill", css("--series-1")).attr("opacity", 0.22);
      // average 2nd-half luck within each tenth of 1st-half luck
      const srt = [...pts].sort((a, b) => a[0] - b[0]);
      const dec = d3.range(10).map((k) => {
        const s = srt.slice(Math.floor(k * srt.length / 10), Math.floor((k + 1) * srt.length / 10));
        return { k, x: d3.mean(s, (d) => d[0]), y: d3.mean(s, (d) => d[1]), n: s.length };
      });
      F.g.append("path").datum(dec).attr("fill", "none").attr("stroke", css("--series-2")).attr("stroke-width", 2)
        .attr("d", d3.line().x((d) => x(d.x)).y((d) => y(d.y)));
      F.g.selectAll("circle.dec").data(dec).join("circle").attr("class", "dec")
        .attr("cx", (d) => x(d.x)).attr("cy", (d) => y(d.y)).attr("r", 4.5)
        .attr("fill", css("--series-2")).attr("stroke", css("--surface-1")).attr("stroke-width", 2);
      F.g.append("text").attr("class", "label-primary").attr("x", x(1.25)).attr("y", y(-1.12))
        .attr("text-anchor", "end").text(`r = ${st.pae_persistence_r.toFixed(2)}`);
      legend(F.box, [
        { label: "Club-season", color: css("--series-1"), kind: "dot" },
        { label: "Average per tenth of 1st-half luck", color: css("--series-2"), kind: "dot" },
      ]);
      const del = d3.Delaunay.from(pts, (d) => x(d[0]), (d) => y(d[1]));
      const ring = F.g.append("circle").attr("r", 5).attr("fill", css("--series-1")).attr("stroke", css("--surface-1")).attr("stroke-width", 2).attr("visibility", "hidden");
      F.g.append("rect").attr("width", F.w).attr("height", F.h).attr("fill", "transparent")
        .on("mousemove", (ev) => {
          const [px, py] = d3.pointer(ev);
          const d = pts[del.find(px, py)];
          ring.attr("cx", x(d[0])).attr("cy", y(d[1])).attr("visibility", "visible");
          showTip(`<div class="row"><span>1st-half luck</span><span>${fmtSigned(d[0])} pts/g</span></div><div class="row"><span>2nd-half luck</span><span>${fmtSigned(d[1])} pts/g</span></div>`, ev);
        })
        .on("mouseleave", () => { ring.attr("visibility", "hidden"); hideTip(); });
    }

    // R² bars (horizontal)
    {
      const data = Object.entries(st.r2).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
      const F = frame("chart-r2", 300, { t: 8, r: 52, b: 38, l: 8 });
      const y = d3.scaleBand().domain(data.map((d) => d.k)).range([0, F.h]).padding(0.45);
      const x = d3.scaleLinear().domain([0, 0.7]).range([0, F.w]);
      F.g.append("g").attr("class", "gridline").attr("transform", `translate(0,${F.h})`)
        .call(d3.axisBottom(x).ticks(4).tickSize(-F.h).tickFormat(""));
      F.g.append("g").attr("class", "axis").attr("transform", `translate(0,${F.h})`)
        .call(d3.axisBottom(x).ticks(4).tickFormat(d3.format(".0%")).tickSizeOuter(0));
      axisLabel(F.g, "Variance explained (R²) →", F.w, F.h + 32, "end");
      const bh = Math.min(24, y.bandwidth());
      const best = data[0].k;
      data.forEach((d) => {
        const y0 = y(d.k) + (y.bandwidth() - bh) / 2;
        const w = x(d.v), r = 4;
        F.g.append("text").attr("class", "label-secondary").attr("x", 0).attr("y", y0 - 6).text(d.k);
        F.g.append("path").attr("fill", d.k === best ? css("--series-1") : css("--other"))
          .attr("d", `M0,${y0}H${w - r}Q${w},${y0} ${w},${y0 + r}V${y0 + bh - r}Q${w},${y0 + bh} ${w - r},${y0 + bh}H0Z`)
          .on("mousemove", (ev) => showTip(`<b>${d.k}</b><div class="row"><span>R²</span><span>${d.v.toFixed(3)}</span></div><div class="muted">n = ${st.n} club-seasons</div>`, ev))
          .on("mouseleave", hideTip);
        F.g.append("text").attr("class", "label-primary").attr("x", w + 6).attr("y", y0 + bh / 2 + 4).text(d3.format(".0%")(d.v));
      });
    }

    // calibration
    {
      const cal = M.calibration;
      const F = frame("chart-calib", 300, { t: 12, r: 12, b: 38, l: 44 });
      const x = d3.scaleLinear().domain([0, 1]).range([0, F.w]);
      const y = d3.scaleLinear().domain([0, 1]).range([F.h, 0]);
      grid(F.g, y, F.w);
      axes(F.g, x, y, F.h, { xt: 5, xf: d3.format(".0%"), yf: d3.format(".0%") });
      axisLabel(F.g, "Predicted home-win probability →", F.w, F.h + 32, "end");
      axisLabel(F.g, "Observed home-win rate", 0, -2);
      F.g.append("line").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(1)).attr("y2", y(1))
        .attr("stroke", css("--axis")).attr("stroke-width", 1.5).attr("stroke-dasharray", "4 4");
      F.g.append("path").datum(cal).attr("fill", "none").attr("stroke", css("--series-1")).attr("stroke-width", 2)
        .attr("d", d3.line().x((d) => x(d.pred)).y((d) => y(d.obs)));
      F.g.selectAll("circle").data(cal).join("circle").attr("cx", (d) => x(d.pred)).attr("cy", (d) => y(d.obs)).attr("r", 4.5)
        .attr("fill", css("--series-1")).attr("stroke", css("--surface-1")).attr("stroke-width", 2)
        .on("mousemove", (ev, d) => showTip(`<div class="row"><span>Predicted</span><span>${(d.pred * 100).toFixed(1)}%</span></div>
          <div class="row"><span>Observed</span><span>${(d.obs * 100).toFixed(1)}%</span></div><div class="muted">${d.n.toLocaleString()} matches</div>`, ev))
        .on("mouseleave", hideTip);
      F.g.append("text").attr("class", "label-secondary").attr("x", x(0.98)).attr("y", y(0.98) + 16).attr("text-anchor", "end").text("perfect calibration");
    }

    // method text
    const t = M.test;
    const items = [
      ["Data", `Every result in the Premier League, LaLiga, Bundesliga, Serie A and Ligue 1 from 2010-11 to the current 2026-27 season (${META.source}).`],
      ["Strength: Elo", `Chronological Elo per league (K = ${M.K}, margin-of-victory multiplier, home edge ${M.HFA}). Ratings regress ${Math.round(M.REGRESS * 100)}% to the mean each summer; promoted clubs start at the level of the clubs they replace. Settings tuned on 2011–2019 only.`],
      ["Expected points", `An ordered-logit model turns the pre-match Elo gap into win/draw/loss probabilities. xPts = 3·P(win) + 1·P(draw). Fitted on seasons up to ${M.train_last}.`],
      ["Out-of-sample test", `On ${t.n.toLocaleString()} matches from 2019-20 onward the model scores log loss ${t.logloss.toFixed(3)} vs ${t.logloss_base.toFixed(3)} for a no-skill baseline, and Brier ${t.brier.toFixed(3)} vs ${t.brier_base.toFixed(3)}.`],
      ["Projection", `${SIMS.toLocaleString()} Monte Carlo simulations of the remaining fixtures with ratings frozen at the selected matchday. Nothing after that matchday is used, so any past season can be replayed honestly.`],
      ["Limits", "Elo and xPts here come from results, not shot data (xG), so they cannot see chance quality. Injuries, transfers and fixture congestion are not modelled. Treat the verdict as a structured second opinion, not a decision."],
    ];
    document.getElementById("method").innerHTML = items.map(([h, p]) => `<div><h4>${h}</h4><p>${p}</p></div>`).join("");
  }

  // ------------------------------------------------------------------ controls
  let current = null;
  const selL = document.getElementById("sel-league");
  const selS = document.getElementById("sel-season");
  const selM = document.getElementById("sel-md");
  const outM = document.getElementById("md-out");
  const selT = document.getElementById("sel-team");

  Object.entries(META.leagues).forEach(([k, v]) => selL.add(new Option(v, k)));

  async function setLeague(lg, keepSeason) {
    state.league = lg;
    selL.value = lg;
    const data = await loadLeague(lg);
    const seasons = META.seasons[lg].slice(1).reverse(); // skip Elo burn-in season
    selS.innerHTML = "";
    seasons.forEach((s) => selS.add(new Option(s, s)));
    let first = false;
    if (keepSeason && seasons.includes(keepSeason)) state.season = keepSeason;
    else if (!state.booted) {
      // first load: replay the latest COMPLETE season from its halfway point
      state.season = seasons.find((s) => data[s].m.every((m) => m[4] !== null)) || seasons[0];
      first = true;
    } else state.season = seasons[0];
    selS.value = state.season;
    setSeason(data, null, first);
    state.booted = true;
  }

  function setSeason(data, prevTeamName, halfway) {
    current = data[state.season];
    const played = current.m.filter((m) => m[4] !== null).map((m) => m[0]);
    const maxMd = d3.max(current.m, (m) => m[0]);
    const lastPlayed = played.length ? d3.max(played) : 1;
    selM.max = lastPlayed; selM.min = 1;
    state.md = halfway ? Math.ceil(maxMd / 2) : lastPlayed;
    selM.value = state.md;
    selT.innerHTML = "";
    const names = current.teams.map((n, i) => [n, i]).sort((a, b) => a[0].localeCompare(b[0]));
    names.forEach(([n, i]) => selT.add(new Option(n, i)));
    const keep = prevTeamName ? current.teams.indexOf(prevTeamName) : -1;
    state.team = keep >= 0 ? keep : null;
    state.maxMd = maxMd;
    renderLive(true);
  }

  let C = null;
  function renderLive(recompute) {
    if (recompute || !C) {
      C = compute(current, state.md);
      if (state.team === null) {
        // default focus: the club whose results most misrepresent its strength
        state.team = [...C.teams].sort((a, b) => Math.abs(b.luck) - Math.abs(a.luck))[0].i;
      }
    }
    outM.textContent = `${state.md}${state.md >= state.maxMd ? " (final)" : ` of ${state.maxMd}`}`;
    selT.value = state.team;
    renderVerdict(C);
    chartDecision(C);
    chartLuck(C);
    chartTraj(C);
    chartElo(C);
    chartProj(C);
    renderTable(C);
  }

  selL.addEventListener("change", () => setLeague(selL.value, state.season));
  selS.addEventListener("change", async () => {
    const prev = current && state.team !== null ? current.teams[state.team] : null;
    state.season = selS.value;
    setSeason(await loadLeague(state.league), prev);
  });
  let mdTimer = null;
  selM.addEventListener("input", () => {
    state.md = +selM.value;
    outM.textContent = state.md;
    clearTimeout(mdTimer);
    mdTimer = setTimeout(() => renderLive(true), 120);
  });
  selT.addEventListener("change", () => { state.team = +selT.value; renderLive(); });

  let rz = null;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { renderLive(); renderEvidence(); }, 150); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderLive(); renderEvidence(); });

  renderEvidence();
  setLeague("en.1");
})();
