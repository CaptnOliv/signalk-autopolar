// Retrouver après coup QUAND la voilure a changé.
//
// Le problème est concret : on prend un ris quand il faut le prendre, pas
// quand c'est commode pour l'application. Le temps qu'on repense au sélecteur,
// une heure de points est déjà partie sous la mauvaise étiquette — et souvent
// on n'y repense pas du tout.
//
// Or un changement de voilure laisse une trace mesurable : à vent et allure
// identiques, le bateau ne va plus à la même vitesse ni à la même gîte. On
// cherche donc des MARCHES dans l'écart entre la vitesse observée et celle que
// la polaire prédit pour ces conditions-là. Passer par l'écart, et non par la
// vitesse brute, est ce qui permet de ne pas confondre « on a pris un ris »
// avec « le vent est tombé ».
//
// Trois limites, à dire plutôt qu'à laisser découvrir :
//   — on détecte QUAND quelque chose a changé, jamais QUOI. C'est à l'humain
//     de dire si c'était un ris ou un enroulement de génois ;
//   — un changement qui n'affecte pas la performance est invisible par
//     construction (rouler trois tours de génois par petit temps) ;
//   — un changement simultané à une bascule ou à une molle est confondu avec
//     elle. D'où le score : il dit à quel point la marche est franche.

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const DEFAULTS = {
  side: 6, // points comparés de chaque côté d'une frontière candidate
  minStepKn: 0.3, // marche minimale pour être signalée
  minSeparationMs: 20 * 60 * 1000, // deux frontières trop proches = une seule
  gapMs: 45 * 60 * 1000, // une interruption longue est une frontière en soi
};

// Écart entre la vitesse mesurée et celle que la polaire donne pour les mêmes
// conditions. La polaire est construite sur TOUTES les données, donc sur un
// mélange des voilures : peu importe, c'est la marche qu'on cherche, pas le
// niveau absolu.
function residuals(runs, polar) {
  const out = [];
  for (const run of runs) {
    if (typeof run.sog !== 'number' || typeof run.tws !== 'number' || typeof run.twa !== 'number') continue;
    let bin = null;
    for (const b of polar.bins) if (run.tws >= b.lo && run.tws < b.hi) bin = b;
    if (!bin) continue;
    let best = null;
    for (const c of bin.cells) {
      if (c.value == null) continue;
      if (!best || Math.abs(c.twa - Math.abs(run.twa)) < Math.abs(best.twa - Math.abs(run.twa))) best = c;
    }
    if (!best || Math.abs(best.twa - Math.abs(run.twa)) > 10) continue;
    out.push({
      ts: run.ts,
      id: run.id,
      dSpeed: run.sog - best.value,
      heel: typeof run.roll === 'number' ? Math.abs(run.roll) : null,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// Frontières candidates : les marches franches, et les longues interruptions.
function detect(points, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const found = [];

  for (let i = 1; i < points.length; i++) {
    if (points[i].ts - points[i - 1].ts >= o.gapMs) {
      found.push({
        ts: points[i].ts,
        kind: 'gap',
        score: 1,
        step: null,
        heelStep: null,
        gapMin: Math.round((points[i].ts - points[i - 1].ts) / 60000),
        before: i,
        after: points.length - i,
      });
    }
  }

  if (points.length >= o.side * 2) {
    const raw = [];
    for (let i = o.side; i <= points.length - o.side; i++) {
      const before = points.slice(i - o.side, i);
      const after = points.slice(i, i + o.side);
      const step = mean(after.map((p) => p.dSpeed)) - mean(before.map((p) => p.dSpeed));
      const hb = before.map((p) => p.heel).filter((v) => v != null);
      const ha = after.map((p) => p.heel).filter((v) => v != null);
      const heelStep = hb.length && ha.length ? median(ha) - median(hb) : null;
      raw.push({ i, ts: points[i].ts, step, heelStep, score: Math.abs(step) });
    }
    // Suppression des non-maxima : une vraie marche fait monter le score sur
    // plusieurs frontières voisines, et on ne veut en signaler qu'une.
    raw.sort((a, b) => b.score - a.score);
    for (const c of raw) {
      if (c.score < o.minStepKn) break;
      if (found.some((f) => Math.abs(f.ts - c.ts) < o.minSeparationMs)) continue;
      found.push({
        ts: c.ts,
        kind: 'step',
        score: c.score,
        step: c.step,
        heelStep: c.heelStep,
        before: c.i,
        after: points.length - c.i,
      });
    }
  }

  return found.sort((a, b) => a.ts - b.ts);
}

// Les frontières découpent le temps en segments. C'est sur ces segments-là
// qu'on affecte une voilure d'un seul geste, plutôt que point par point.
function segments(runs, boundaries) {
  if (!runs.length) return [];
  const sorted = [...runs].sort((a, b) => a.ts - b.ts);
  const cuts = [...new Set(boundaries.map((b) => b.ts))].sort((a, b) => a - b);
  const segs = [];
  let start = sorted[0].ts;
  let bucket = [];
  const push = (end) => {
    if (!bucket.length) return;
    segs.push({
      from: start,
      to: bucket[bucket.length - 1].ts,
      n: bucket.length,
      ids: bucket.map((r) => r.id),
    });
  };
  for (const r of sorted) {
    if (cuts.length && r.ts >= cuts[0]) {
      push(r.ts);
      while (cuts.length && r.ts >= cuts[0]) cuts.shift();
      start = r.ts;
      bucket = [];
    }
    bucket.push(r);
  }
  push(Infinity);
  return segs;
}

function suggest(runs, polar, opts) {
  const pts = residuals(runs, polar);
  const boundaries = detect(pts, opts);
  return { boundaries, segments: segments(runs, boundaries), analysed: pts.length, total: runs.length };
}

module.exports = { residuals, detect, segments, suggest, DEFAULTS };
