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


// ── Ce qui a déjà été tranché ──────────────────────────────────────────────
//
// Une période traitée — corrigée ou simplement confirmée — n'a plus rien à
// demander, et doit finir par sortir de la liste. Encore faut-il la
// reconnaître, et c'est moins évident qu'il n'y paraît.
//
// Le piège : les frontières de segments ne sont pas des données, ce sont des
// DÉDUCTIONS. Elles sortent d'une comparaison à la polaire, qui change à
// chaque nav. Une confirmation posée sur « 12:47 → 13:08 » se retrouve, trois
// sorties plus tard, face à un segment « 12:45 → 12:57 » : les mêmes points,
// deux minutes plus tôt. Un test de contenance à l'horloge la rate — la plage
// ne commence pas avant le segment — et la période, déjà réglée, revient
// éternellement demander une décision. Mesuré sur Jazzy : 24 plages
// enregistrées sur 31 ne correspondaient plus à aucun segment, et quatre
// périodes dont 100 % des points étaient traités s'affichaient encore, douze
// jours après.
//
// On compte donc en POINTS, pas en minutes. Ce que l'équipage a confirmé,
// c'est que l'étiquette de ces mesures-là est juste ; l'horaire n'était qu'une
// façon de les désigner. Un segment dont tous les points sont couverts est
// traité, quelles que soient les secondes de part et d'autre.
//
// Pas de tout ou rien pour autant : sous le seuil, le segment reste affiché ET
// dit ce qui manque (« 20 des 32 points »). Cacher une moitié de période
// jamais étiquetée serait pire que la redemander.
const HANDLED_COVERAGE = 0.9;

function markHandled(segments, runs, ranges, opts) {
  const o = Object.assign({ coverage: HANDLED_COVERAGE }, opts);
  const sorted = [...(runs || [])].sort((a, b) => a.ts - b.ts);
  for (const seg of segments) {
    const pts = sorted.filter((r) => r.ts >= seg.from && r.ts <= seg.to);
    // Un segment sans point n'a pas de quoi voter : on retombe sur la
    // contenance à l'horloge, qui est exactement ce qu'on sait faire de mieux.
    const hit = (r) =>
      pts.length
        ? pts.filter((p) => p.ts >= r.from && p.ts <= r.to).length
        : r.from <= seg.from && r.to >= seg.to
        ? 1
        : 0;
    const total = pts.length || 1;

    let best = null;
    const union = new Set();
    const unionOf = (kind) => {
      const set = new Set();
      for (const r of ranges) {
        if (r.kind !== kind) continue;
        for (const p of pts) if (p.ts >= r.from && p.ts <= r.to) set.add(p.ts);
      }
      return set;
    };
    // Plusieurs plages peuvent se chevaucher (deux « ok » posés sur des
    // découpages successifs) : c'est leur UNION qui couvre, pas la meilleure
    // d'entre elles. Compter la meilleure seule ferait réapparaître une
    // période traitée en deux fois.
    const corrected = unionOf('corrected');
    const reviewed = unionOf('reviewed');
    for (const t of corrected) union.add(t);
    for (const t of reviewed) union.add(t);

    for (const r of ranges) {
      const n = hit(r);
      if (n && (!best || n > best.n)) best = { n, range: r };
    }

    const cov = pts.length ? union.size / total : best ? 1 : 0;
    const corrCov = pts.length ? corrected.size / total : 0;
    if (cov >= o.coverage) {
      seg.handled = corrCov >= o.coverage ? 'corrected' : 'reviewed';
      seg.handledIndex = best ? best.range.index : null;
      seg.handledOf = best ? best.range.kind : seg.handled;
    } else {
      seg.handled = null;
      seg.handledIndex = null;
      seg.handledOf = null;
    }
    // Toujours renseigné, traité ou non : c'est ce qui permet d'écrire « 20 des
    // 32 points » au lieu d'un verdict nu, et de voir pourquoi une période
    // qu'on croit avoir réglée revient.
    seg.handledPts = pts.length ? union.size : 0;
    seg.pts = pts.length;
  }
  return segments;
}

function suggest(runs, polar, opts) {
  const pts = residuals(runs, polar);
  const boundaries = detect(pts, opts);
  return { boundaries, segments: segments(runs, boundaries), analysed: pts.length, total: runs.length };
}

module.exports = { residuals, detect, segments, suggest, markHandled, HANDLED_COVERAGE, DEFAULTS };
