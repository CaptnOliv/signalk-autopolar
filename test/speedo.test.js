// Le diagnostic du speedo doit distinguer deux causes qui produisent le même
// écart moyen entre STW et SOG, et appellent des réponses opposées : ne rien
// toucher (courant) ou recalibrer le capteur. On lui donne donc des mondes
// synthétiques où la réponse est connue d'avance.
const assert = require('assert');
const speedo = require('../lib/speedo');
const polar = require('../lib/polar');

const D2R = Math.PI / 180;

// Un monde sans courant, où seule la roue à aubes ment (facteur constant).
function speedoWorld({ gain = 1 / 0.9, headings = [0, 45, 90, 135, 180, 225, 270, 315], speeds = [3, 5, 7, 9] } = {}) {
  const runs = [];
  let id = 0;
  for (const hdg of headings)
    for (const real of speeds)
      runs.push({ id: id++, ts: id * 1000, hdg, cog: hdg, sog: real, stw: real * gain, twa: 90, tws: 12, awa: 60, aws: 14, roll: 0 });
  return runs;
}

// Un monde où le speedo est juste et où c'est l'eau qui bouge : le décalage
// est un vecteur FIXE dans le repère terrestre, indépendant de la vitesse.
function currentWorld({ setDeg = 90, driftKn = 1, headings = [0, 45, 90, 135, 180, 225, 270, 315], speeds = [3, 5, 7, 9] } = {}) {
  const runs = [];
  let id = 0;
  for (const hdg of headings)
    for (const stw of speeds) {
      const wx = stw * Math.sin(hdg * D2R);
      const wy = stw * Math.cos(hdg * D2R);
      const gx = wx + driftKn * Math.sin(setDeg * D2R);
      const gy = wy + driftKn * Math.cos(setDeg * D2R);
      runs.push({
        id: id++,
        ts: id * 1000,
        hdg,
        cog: (Math.atan2(gx, gy) / D2R + 360) % 360,
        sog: Math.hypot(gx, gy),
        stw,
        twa: 90,
        tws: 12,
        awa: 60,
        aws: 14,
        roll: 0,
      });
    }
  return runs;
}

// ── Les deux mondes sont reconnus pour ce qu'ils sont ──────────────────────
{
  const a = speedo.analyse(speedoWorld());
  assert.strictEqual(a.diagnosis.verdict, 'speedo', `speedo pur mal diagnostiqué : ${a.diagnosis.verdict}`);
  assert.ok(Math.abs(a.gain - 0.9) < 0.01, `gain attendu 0.90, obtenu ${a.gain.toFixed(3)}`);
}
{
  const a = speedo.analyse(currentWorld());
  assert.strictEqual(a.diagnosis.verdict, 'current', `courant pur mal diagnostiqué : ${a.diagnosis.verdict}`);
}

// ── Un seul bord : le test des repères ne peut rien dire, celui de l'échelle
// tranche quand même. C'est tout l'intérêt d'en avoir deux.
const MANY = [3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
{
  const a = speedo.analyse(speedoWorld({ headings: [180], speeds: MANY }));
  assert.strictEqual(a.diagnosis.frames, null, "sur un seul cap, le test des repères doit s'abstenir");
  assert.strictEqual(a.diagnosis.verdict, 'speedo', 'le test d’échelle doit encore conclure');
}
{
  const a = speedo.analyse(currentWorld({ headings: [180], speeds: MANY }));
  assert.strictEqual(a.diagnosis.frames, null);
  assert.strictEqual(a.diagnosis.verdict, 'current');
}

// ── Rien du tout à se mettre sous la dent : on le dit, on n'invente pas ────
{
  const a = speedo.analyse(speedoWorld({ headings: [180], speeds: [6] }));
  assert.strictEqual(a.diagnosis.verdict, 'inconclusive', 'sans variété, aucun verdict ne doit être rendu');
}

// ── Courbe de correction : interpolation entre paliers, plat au-delà ───────
{
  const curve = [
    { stw: 4, factor: 0.95 },
    { stw: 8, factor: 0.85 },
  ];
  assert.ok(Math.abs(speedo.factorAt(curve, 6) - 0.9) < 1e-9, 'interpolation au milieu');
  assert.strictEqual(speedo.factorAt(curve, 1), 0.95, 'sous le premier palier : facteur du premier palier');
  assert.strictEqual(speedo.factorAt(curve, 20), 0.85, 'au-delà du dernier : pas de pente extrapolée');
  assert.strictEqual(speedo.factorAt([], 6), 1, 'sans courbe, on ne corrige rien');
  assert.strictEqual(speedo.correct(null, 6), 6);
}

// ── La polaire « STW corrigée » doit retomber sur la polaire SOG ───────────
// C'est le contrôle qui vaut pour toute la chaîne : si la correction est
// juste, corriger la vitesse surface d'un speedo menteur redonne la vitesse
// fond, à la précision de la table près.
{
  const runs = speedoWorld({ speeds: [3, 4, 5, 6, 7, 8, 9] }).map((r, i) =>
    Object.assign({}, r, { twa: 60 + (i % 4) * 30, tws: 12 })
  );
  const a = speedo.analyse(runs);
  const bySog = polar.buildPolar(runs, { speed: 'sog', minSamples: 1, smooth: false });
  const byStwC = polar.buildPolar(runs, { speed: 'stwc', stwCal: a.curve, minSamples: 1, smooth: false });
  let compared = 0;
  for (let i = 0; i < bySog.bins.length; i++)
    for (let j = 0; j < bySog.bins[i].cells.length; j++) {
      const x = bySog.bins[i].cells[j].value;
      const y = byStwC.bins[i].cells[j].value;
      if (x == null || y == null) continue;
      compared++;
      assert.ok(Math.abs(x - y) < 0.15, `STW corrigée ${y.toFixed(2)} vs SOG ${x.toFixed(2)}`);
    }
  assert.ok(compared > 3, `il faut de quoi comparer (${compared} cases)`);
  // Et la STW brute, elle, doit rester franchement à côté.
  const byStw = polar.buildPolar(runs, { speed: 'stw', minSamples: 1, smooth: false });
  const diff = byStw.bins.flatMap((b, i) =>
    b.cells.map((c, j) => (c.value != null && bySog.bins[i].cells[j].value != null ? c.value - bySog.bins[i].cells[j].value : null))
  ).filter((x) => x != null);
  assert.ok(Math.max(...diff) > 0.2, 'la STW brute doit rester biaisée, sinon le test ne prouve rien');
}

// ── Pont vers le plugin Airmar : son format, pas le nôtre ──────────────────
{
  const runs = speedoWorld({ headings: [0], speeds: [6] }).map((r) => Object.assign({}, r, { roll: 11 }));
  const out = speedo.toAirmarRuns(runs);
  const rec = JSON.parse(out.trim());
  assert.strictEqual(rec.kind, 'calm');
  assert.strictEqual(rec.speedCol, 7, 'colonne = vitesse indiquée la plus proche');
  assert.strictEqual(rec.heelRow, '10.0°S', 'ligne de gîte à la convention du plugin Airmar');
  assert.ok(Math.abs(rec.corr - (rec.sog - rec.stw)) < 1e-9, 'corr = écart en nœuds');
  // Les points trop lents sont écartés : leur rapport n'est que du bruit.
  assert.strictEqual(speedo.toAirmarRuns([{ ts: 1, sog: 0.4, stw: 0.5, roll: 0 }]), '');
}

// ── Table de calibration : une colonne jamais parcourue reste vide ─────────
{
  const a = speedo.analyse(speedoWorld({ speeds: [7, 8, 9] }));
  const csv = speedo.toCalibrationCsv(a);
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /^stw_shown_kn,/, 'en-tête en anglais comme le reste du plugin');
  assert.match(lines[1], /^1,,,,0$/, "1 kn n'a jamais été navigué : la case reste vide");
  assert.ok(lines.some((l) => /^8,/.test(l) && l.split(',')[1] !== ''), '8 kn doit être renseigné');
}

console.log('speedo: ok');
