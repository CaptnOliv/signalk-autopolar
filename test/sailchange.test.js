// Retrouver quand la voilure a changé, et affecter une voilure à toute une
// plage. Deux exigences opposées : ne pas rater un vrai changement, et ne pas
// crier au changement à chaque risée. Les mondes synthétiques ci-dessous ont
// une réponse connue, ce qui permet de mesurer les deux.
const assert = require('assert');
const sc = require('../lib/sailchange');
const polar = require('../lib/polar');

const T0 = Date.parse('2026-09-02T10:00:00Z');
const MIN = 60000;

// Une nav à vent et allure constants, avec une marche de performance connue au
// point `at` : c'est le changement de voilure qu'on veut retrouver.
function passage({ n = 60, step = 0, at = 30, noise = 0, twa = 120, tws = 14, base = 7 } = {}) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  const runs = [];
  for (let i = 0; i < n; i++)
    runs.push({
      id: i,
      ts: T0 + i * 3 * MIN,
      sog: base + (i >= at ? step : 0) + rnd() * noise,
      twa,
      tws,
      roll: 15 + (i >= at ? -5 : 0),
    });
  return runs;
}

const build = (runs) => polar.buildPolar(runs, { minSamples: 1, twaStep: 5 });

// ── Une marche franche est retrouvée, à sa place ──────────────────────────
{
  const runs = passage({ step: -0.9, at: 30 });
  const r = sc.suggest(runs, build(runs));
  const steps = r.boundaries.filter((b) => b.kind === 'step');
  assert.ok(steps.length >= 1, 'la marche doit être détectée');
  const best = steps.sort((a, b) => b.score - a.score)[0];
  const off = Math.abs(best.ts - runs[30].ts) / MIN;
  assert.ok(off <= 20, `détectée à ${off} min du vrai changement`);
  assert.ok(best.step < 0, 'le sens de la marche est rapporté');
  assert.ok(best.heelStep < 0, 'la gîte a baissé, et ça se voit');
}

// ── Une mer qui bouge n'est pas un changement de voilure ──────────────────
// Sans marche, du bruit seul ne doit rien déclencher : c'est cette moitié-là
// qui rend l'outil utilisable, une liste de faux positifs ne se lit pas.
{
  const runs = passage({ step: 0, noise: 0.5 });
  const r = sc.suggest(runs, build(runs), { minStepKn: 0.5 });
  assert.strictEqual(r.boundaries.filter((b) => b.kind === 'step').length, 0, 'aucun changement à signaler');
}

// ── Une longue interruption est une frontière en soi ──────────────────────
// On ne navigue pas 40 min sans qu'un point sorte par hasard : c'est presque
// toujours une manœuvre, un grain ou un bord au moteur.
{
  const runs = passage({ n: 20, step: 0 });
  for (let i = 10; i < 20; i++) runs[i].ts += 120 * MIN;
  const r = sc.suggest(runs, build(runs));
  const gaps = r.boundaries.filter((b) => b.kind === 'gap');
  assert.strictEqual(gaps.length, 1);
  assert.strictEqual(gaps[0].ts, runs[10].ts);
  assert.ok(gaps[0].gapMin > 100);
}

// ── Les segments couvrent tout, sans trou ni recouvrement ─────────────────
{
  const runs = passage({ n: 30 });
  const segs = sc.segments(runs, [{ ts: runs[10].ts }, { ts: runs[20].ts }]);
  assert.strictEqual(segs.length, 3);
  assert.strictEqual(segs.reduce((a, s) => a + s.n, 0), runs.length, 'aucun point perdu');
  assert.strictEqual(segs[0].from, runs[0].ts);
  assert.strictEqual(segs[2].to, runs[29].ts);
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i].from > segs[i - 1].to, 'pas de recouvrement');
  // Deux frontières au même instant ne créent pas de segment vide.
  const dup = sc.segments(runs, [{ ts: runs[10].ts }, { ts: runs[10].ts }]);
  assert.strictEqual(dup.length, 2);
}

// ── Affectation a posteriori : la correction s'applique sans rien détruire ─
{
  const run = { ts: T0 + 10 * MIN, sail: { main: 'full', head: 'genois-full' } };
  assert.deepStrictEqual(polar.effectiveSail(run, null), { main: 'full', head: 'genoa-full' });

  const ranges = [{ from: T0, to: T0 + 60 * MIN, main: 'r1', head: 'genoa-full' }];
  assert.deepStrictEqual(polar.effectiveSail(run, ranges), { main: 'r1', head: 'genoa-full' });

  // Hors plage, l'étiquette d'origine reste la vérité.
  const later = { ts: T0 + 120 * MIN, sail: { main: 'full', head: 'gennaker' } };
  assert.deepStrictEqual(polar.effectiveSail(later, ranges), { main: 'full', head: 'gennaker' });

  // Corriger deux fois la même période : la dernière correction gagne.
  ranges.push({ from: T0, to: T0 + 60 * MIN, main: 'r2', head: 'jib-full' });
  assert.deepStrictEqual(polar.effectiveSail(run, ranges), { main: 'r2', head: 'jib-full' });
}

// ── Et le filtre de la polaire suit la correction ─────────────────────────
{
  const runs = [
    { id: 1, ts: T0, sog: 7, twa: 130, tws: 16, sail: { main: 'full', head: 'genoa-full' } },
    { id: 2, ts: T0 + 10 * MIN, sog: 6, twa: 130, tws: 16, sail: { main: 'full', head: 'genoa-full' } },
  ];
  const o = { twsBins: [16], twaStep: 10, minSamples: 1, smooth: false };
  const ranges = [{ from: T0 + 5 * MIN, to: T0 + 20 * MIN, main: 'r1', head: 'genoa-full' }];
  const asFull = polar.buildPolar(runs, Object.assign({ sail: { main: 'full', head: 'genoa-full' }, sailRanges: ranges }, o));
  const asReefed = polar.buildPolar(runs, Object.assign({ sail: { main: 'r1', head: 'genoa-full' }, sailRanges: ranges }, o));
  const cell = (p) => p.bins[0].cells.find((c) => c.twa === 130);
  assert.strictEqual(cell(asFull).n, 1, 'le point corrigé a quitté la voilure pleine');
  assert.strictEqual(cell(asReefed).n, 1, 'et rejoint la voilure réduite');
  assert.strictEqual(cell(asFull).value, 7);
  assert.strictEqual(cell(asReefed).value, 6);
}

console.log('sailchange: ok');
