const assert = require('assert');
const p = require('../lib/polar');

// Deux bandes de vent, une seule allure mesurée dans chacune : de quoi
// vérifier l'interpolation sans que le lissage vienne brouiller les valeurs.
const runs = [
  { id: 1, ts: 1, sog: 6.0, stw: 5.5, twa: 90, tws: 10, awa: 60, aws: 12, sail: { main: 'full', head: 'genoa' } },
  { id: 2, ts: 2, sog: 6.0, stw: 5.5, twa: 90, tws: 10, awa: 60, aws: 12, sail: { main: 'full', head: 'genoa' } },
  { id: 3, ts: 3, sog: 8.0, stw: 7.5, twa: 90, tws: 14, awa: 55, aws: 17, sail: { main: 'full', head: 'genoa' } },
  { id: 4, ts: 4, sog: 8.0, stw: 7.5, twa: 90, tws: 14, awa: 55, aws: 17, sail: { main: 'full', head: 'genoa' } },
];
const base = { twsBins: [10, 12, 14], twaStep: 5, minSamples: 1, smooth: false };
const pol = p.buildPolar(runs, base);

// Pile sur une case mesurée : la valeur de la case, rien d'autre.
assert.strictEqual(p.referenceAt(pol, 10, 90).value, 6);
assert.strictEqual(p.referenceAt(pol, 10, -90).value, 6, "l'angle est pris en valeur absolue");

// Entre deux bandes, on interpole : 12 nd est à mi-chemin de 10 et 14. Sans
// ça, un demi-nœud de vent ferait sauter le repère d'un demi-nœud de vitesse
// — un repère qui saute ne se barre pas.
const mid = p.referenceAt(pol, 12, 90);
assert.ok(Math.abs(mid.value - 7) < 1e-9);
assert.strictEqual(mid.n, 4, 'les deux cases qui ont servi sont comptées');
assert.strictEqual(mid.from.length, 2);

// Entre deux angles mesurés, on interpole aussi.
const runs2 = runs.concat([{ id: 5, ts: 5, sog: 7.0, stw: 6.5, twa: 95, tws: 10, awa: 65, aws: 12, sail: { main: 'full', head: 'genoa' } }]);
const pol2 = p.buildPolar(runs2, base);
assert.ok(Math.abs(p.referenceAt(pol2, 10, 92.5).value - 6.5) < 1e-9);

// Là où on n'a jamais navigué, il n'y a pas de repère — et on le dit, plutôt
// que d'étirer la case voisine à travers 60° de vide.
assert.strictEqual(p.referenceAt(pol, 10, 40), null, 'aucune mesure à cette allure');
assert.strictEqual(p.referenceAt(pol, 30, 90), null, 'aucune mesure dans ce vent');
// 20 nd tombe hors de la bande 14 (11..16) : pas de repère non plus.
assert.strictEqual(p.referenceAt(pol, 20, 90), null, "on n'extrapole pas au-delà de la bande mesurée");
// Deux mesures suffisent pour tracer, pas pour se juger dessus : le drapeau
// le dit au lieu de laisser lire un chiffre nu.
assert.strictEqual(p.referenceAt(pol, 10, 90).weak, true);
assert.strictEqual(p.referenceAt(pol, 10, 90).n, 2);

// ── Comparaison des voilures ───────────────────────────────────────────────
const mix = [
  { id: 11, ts: 11, sog: 6.0, stw: 5.5, twa: 95, tws: 12, awa: 70, aws: 14, sail: { main: 'full', head: 'genoa' } },
  { id: 12, ts: 12, sog: 6.4, stw: 5.9, twa: 90, tws: 12.5, awa: 68, aws: 14, sail: { main: 'full', head: 'genoa' } },
  { id: 13, ts: 13, sog: 5.6, stw: 5.1, twa: 100, tws: 11.5, awa: 72, aws: 14, sail: { main: 'r1', head: 'genoa' } },
  { id: 14, ts: 14, sog: 5.8, stw: 5.3, twa: 92, tws: 12, awa: 70, aws: 14, sail: { main: 'r1', head: 'genoa' } },
  // Hors voisinage : autre allure, et autre vent.
  { id: 15, ts: 15, sog: 7.9, stw: 7.4, twa: 140, tws: 12, awa: 120, aws: 9, sail: { main: 'r2', head: 'jib' } },
  { id: 16, ts: 16, sog: 4.0, stw: 3.6, twa: 95, tws: 6, awa: 70, aws: 8, sail: { main: 'r2', head: 'jib' } },
];
const cmp = p.sailCompare(mix, { twsBins: [12], twaStep: 5 }, { ws: 12, twa: 95, dws: 2, dtwa: 20 });
assert.strictEqual(cmp.rows.length, 2, 'seules les voilures navigées ICI sont comparées');
assert.strictEqual(cmp.n, 4);
assert.strictEqual(cmp.rows[0].key, 'full|genoa', 'la plus rapide en tête');
assert.ok(Math.abs(cmp.rows[0].value - 6.2) < 1e-9);
assert.strictEqual(cmp.rows[0].n, 2);
assert.ok(cmp.rows[0].twsMean > 12 && cmp.rows[0].twsMean < 12.5);
assert.strictEqual(cmp.rows[1].key, 'r1|genoa');
assert.strictEqual(cmp.rows[0].lastTs, 12);

// Le filtre de voilure de la webapp ne doit PAS s'appliquer ici : on compare
// justement les voilures entre elles. S'il passait, la comparaison n'aurait
// qu'une ligne — et paraîtrait sûre d'elle.
const filtered = p.sailCompare(mix, { sail: { main: 'r1', head: '' }, twaStep: 5 }, { ws: 12, twa: 95 });
assert.strictEqual(filtered.rows.length, 2);

// Un point exclu à la main sort de la comparaison comme il sort de la polaire.
const ex = p.sailCompare(mix, { excluded: new Set([12]), twaStep: 5 }, { ws: 12, twa: 95, dws: 2, dtwa: 20 });
assert.strictEqual(ex.rows.find((r) => r.key === 'full|genoa').n, 1);

// La statistique demandée est celle de la polaire affichée : comparer des
// moyennes à des médianes ferait mentir l'écart.
const med = p.sailCompare(mix, { stat: 'max', twaStep: 5 }, { ws: 12, twa: 95, dws: 2, dtwa: 20 });
assert.strictEqual(med.rows[0].value, 6.4);

// La fenêtre est bien une fenêtre : resserrée, elle laisse tomber ce qui est
// loin.
const tight = p.sailCompare(mix, {}, { ws: 12, twa: 95, dws: 0.6, dtwa: 2 });
assert.strictEqual(tight.n, 1);
assert.strictEqual(p.sailCompare(mix, {}, { ws: 12, twa: 95, dws: 0.6, dtwa: 3 }).n, 2, 'la borne est incluse');

// STW au lieu de SOG : c'est la même mesure lue autrement, pas un autre jeu.
const stw = p.sailCompare(mix, { speed: 'stw' }, { ws: 12, twa: 95, dws: 2, dtwa: 20 });
assert.ok(Math.abs(stw.rows[0].value - 5.7) < 1e-9);

console.log('now: ok');
