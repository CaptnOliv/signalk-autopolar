const assert = require('assert');
const p = require('../lib/polar');

// Binning des forces : frontières à mi-chemin entre centres, bins extrêmes
// étendus d'une demi-largeur seulement — une rafale à 40 nd n'a rien à faire
// dans la case « 25 nd ».
const edges = p.windBinEdges([4, 6, 8, 10]);
assert.strictEqual(edges[0].lo, 3);
assert.strictEqual(edges[0].hi, 5);
assert.strictEqual(edges[3].hi, 11);
assert.strictEqual(p.findWindBin(edges, 40), null);
assert.strictEqual(p.findWindBin(edges, 9.9).ws, 10);

const centers = p.twaCenters(5);
assert.strictEqual(centers[centers.length - 1], 180);
assert.strictEqual(p.findTwaBin(centers, 5, 52), 50);
assert.strictEqual(p.findTwaBin(centers, 5, -52), 50, 'le bin est en valeur absolue');
assert.strictEqual(p.findTwaBin(centers, 5, 178), 180);

// Un jeu de points : même case, vitesses différentes.
const runs = [
  { id: 1, ts: 1, sog: 6.0, stw: 5.5, twa: 51, tws: 10.2, awa: 32, aws: 15, sail: { main: 'full', head: 'genoa' } },
  { id: 2, ts: 2, sog: 6.4, stw: 5.9, twa: 49, tws: 9.8, awa: 31, aws: 15, sail: { main: 'full', head: 'genoa' } },
  { id: 3, ts: 3, sog: 9.9, stw: 9.5, twa: 50, tws: 10.0, awa: 31, aws: 15, sail: { main: 'r1', head: 'genoa' } },
  { id: 4, ts: 4, sog: 7.2, stw: 7.0, twa: -95, tws: 10.1, awa: -70, aws: 12, sail: { main: 'full', head: 'genoa' } },
];

// Lissage désactivé ici : ces cas testent les valeurs mesurées elles-mêmes.
const base = { twsBins: [10], twaStep: 5, minSamples: 1, smooth: false };
const pol = p.buildPolar(runs, base);
const cell50 = pol.bins[0].cells.find((c) => c.twa === 50);
assert.strictEqual(cell50.n, 3);
assert.ok(Math.abs(cell50.mean - (6.0 + 6.4 + 9.9) / 3) < 1e-9);
assert.strictEqual(cell50.median, 6.4);
assert.strictEqual(cell50.max, 9.9);

// Une seule mesure aberrante ne doit pas emporter la case : la médiane la
// laisse dehors, la moyenne non. C'est pour ça que la webapp offre le choix.
const polMed = p.buildPolar(runs, Object.assign({ stat: 'median' }, base));
assert.strictEqual(polMed.bins[0].cells.find((c) => c.twa === 50).value, 6.4);

// Exclusion d'un point aberrant, décidée depuis la webapp.
const polEx = p.buildPolar(runs, Object.assign({ excluded: new Set([3]) }, base));
assert.strictEqual(polEx.bins[0].cells.find((c) => c.twa === 50).n, 2);

// Case forcée à la main : elle prime, et se signale comme telle.
const polOv = p.buildPolar(runs, Object.assign({ overrides: { '10|50': 6.2 } }, base));
const ov = polOv.bins[0].cells.find((c) => c.twa === 50);
assert.strictEqual(ov.value, 6.2);
assert.strictEqual(ov.overridden, true);

// Filtre de voilure.
assert.strictEqual(p.buildPolar(runs, Object.assign({ sail: { main: 'r1' } }, base)).used, 1);

// Amure : le point à -95° est bâbord.
assert.strictEqual(p.buildPolar(runs, Object.assign({ tack: 'port' }, base)).used, 1);
assert.strictEqual(p.buildPolar(runs, Object.assign({ tack: 'starboard' }, base)).used, 3);

// Les quatre projections lisent les mêmes points sous des angles différents :
// en apparent, le point à 51° de vent vrai tombe dans la case 30°.
const polApp = p.buildPolar(runs, { twsBins: [15], twaStep: 5, wind: 'apparent', minSamples: 1, smooth: false });
assert.strictEqual(polApp.bins[0].cells.find((c) => c.twa === 30).n, 3);

// STW au lieu de SOG.
assert.strictEqual(p.buildPolar(runs, Object.assign({ speed: 'stw' }, base)).bins[0].cells.find((c) => c.twa === 50).median, 5.9);

// VMG : l'angle retenu au près est celui qui fait le plus de route au vent,
// pas celui qui va le plus vite.
const vmgRuns = [
  { id: 1, sog: 5.0, twa: 40, tws: 10 },
  { id: 2, sog: 6.0, twa: 60, tws: 10 },
  { id: 3, sog: 6.3, twa: 80, tws: 10 },
];
const t = p.buildPolar(vmgRuns, { twsBins: [10], twaStep: 20, minSamples: 1, smooth: false }).bins[0].targets;
assert.strictEqual(t.upwind.twa, 40, 'meilleur VMG au près à 40° malgré une vitesse plus faible');

// ── Lissage ──
// Une case creusée par le hasard de l'échantillonnage est relevée par ses
// voisines, en proportion du nombre de mesures qu'elles portent ; la valeur
// mesurée reste lisible dans `raw`, et une case vide le reste.
const bumpy = [
  { id: 1, sog: 6.0, twa: 60, tws: 10 },
  { id: 2, sog: 3.0, twa: 70, tws: 10 },
  { id: 3, sog: 6.2, twa: 80, tws: 10 },
];
const sm = p.buildPolar(bumpy, { twsBins: [10], twaStep: 10, minSamples: 1, smooth: true }).bins[0];
const c70 = sm.cells.find((c) => c.twa === 70);
assert.strictEqual(c70.raw, 3.0, 'la mesure brute reste accessible');
assert.ok(c70.value > 4 && c70.value < 5, `le creux est relevé, obtenu ${c70.value}`);
assert.strictEqual(sm.cells.find((c) => c.twa === 120).value, null, 'une case vide reste vide');

// Une case forcée à la main n'est pas retouchée par le lissage.
const smOv = p.buildPolar(bumpy, { twsBins: [10], twaStep: 10, minSamples: 1, smooth: true, overrides: { '10|70': 5.5 } }).bins[0];
assert.strictEqual(smOv.cells.find((c) => c.twa === 70).value, 5.5);

// Export .pol : lisible par qtVlm / OpenCPN, sans lignes vides.
const polText = p.toPol(pol);
assert.ok(polText.startsWith('twa/tws\t10'));
assert.ok(polText.split('\n').every((l) => !/^\d+(\t0)+$/.test(l)), 'pas de ligne entièrement vide');

// Export Jieter : la même matrice, séparateur point-virgule, en-tête en
// commentaire, lignes de cible VMG (une seule valeur non nulle) en fin.
const jieterText = p.toJieter(pol);
const jl = jieterText.trim().split('\n');
assert.ok(jl[0].startsWith('# signalk-autopolar'), 'un en-tête en commentaire');
assert.ok(jl[1].startsWith('twa/tws;10'), 'ligne d’en-tête TWS en point-virgule');
assert.ok(jl.slice(1).every((l) => l.split(';').length === 2), 'une bande de vent => deux colonnes');
// Les lignes de cible VMG (près + portant) s'ajoutent après la matrice : le
// Jieter a donc plus de lignes utiles que le .pol tabulé équivalent.
assert.ok(
  jl.length > polText.trim().split('\n').length + 1,
  'des lignes de cible VMG en plus de la matrice'
);

// Format canonique polar-format : unités SI, matrice alignée sur les axes,
// axes strictement croissants, angles dans 0..π.
const canon = p.toCanonical(pol, { name: 'Jazzy', boatType: 'Oceanis 48' });
assert.strictEqual(canon.kind, 'polarTable');
assert.strictEqual(canon.units.twa, 'rad');
assert.strictEqual(canon.axes.tws.length, canon.values.boatSpeedMatrix.length);
assert.ok(canon.values.boatSpeedMatrix.every((r) => r.length === canon.axes.twa.length), 'colonnes = axe TWA');
assert.ok(canon.axes.twa.every((v, i) => i === 0 || v > canon.axes.twa[i - 1]), 'TWA strictement croissant');
assert.ok(canon.axes.twa.every((v) => v >= 0 && v <= Math.PI), 'TWA dans 0..π');
assert.ok(Math.abs(canon.axes.tws[0] - 10 / 1.94384) < 1e-6, 'TWS converti en m/s');
assert.strictEqual(canon.name, 'Jazzy');
assert.strictEqual(canon.boatType, 'Oceanis 48');
assert.strictEqual(canon.source, 'signalk-autopolar');
assert.strictEqual(p.validateCanonicalShape(canon), null, 'le document canonique passe la validation');

// Une polaire sans aucune case mesurée ne s’envoie pas.
assert.throws(() => p.toCanonical(p.buildPolar([], { twsBins: [10], twaStep: 10 })), /polaire vide/);

// Une bande de vent qui n'a que du portant (ou que du près) est écartée : le
// consommateur (polar-math → signalk-polar-management) déréférence une cible
// VMG à null pour le bord manquant.
{
  const oneSided = [
    { id: 1, sog: 6.0, twa: 45, tws: 8 }, // 8 nd : près + portant → gardée
    { id: 2, sog: 5.5, twa: 135, tws: 8 },
    { id: 3, sog: 7.5, twa: 130, tws: 20 }, // 20 nd : que du portant → écartée
    { id: 4, sog: 7.6, twa: 140, tws: 20 },
  ];
  const o = { twsBins: [8, 20], twaStep: 5, minSamples: 1, smooth: false };
  const c = p.toCanonical(p.buildPolar(oneSided, o), { name: 'x' });
  assert.strictEqual(c.axes.tws.length, 1, 'seule la bande avec les deux bords survit');
  assert.ok(Math.abs(c.axes.tws[0] - 8 / 1.94384) < 1e-6, "c'est bien la bande 8 nd");
}

// Rien que du portant partout → inexploitable, message distinct de « vide ».
assert.throws(
  () =>
    p.toCanonical(
      p.buildPolar(
        [
          { id: 1, sog: 7, twa: 130, tws: 12 },
          { id: 2, sog: 7, twa: 150, tws: 12 },
        ],
        { twsBins: [12], twaStep: 10, minSamples: 1, smooth: false }
      )
    ),
  /inexploitable/
);

// ── Voisinage de la VMG optimale ──────────────────────────────────────────
// Connaître le meilleur angle ne suffit pas : ce qu'on barre, c'est la forme
// de la cloche autour de lui. On vérifie que les voisins sont bien rapportés
// à l'optimum, et qu'aucun d'eux ne le dépasse (sinon ce n'était pas
// l'optimum).
{
  const runs = [];
  let id = 0;
  // Cloche piquée à 40° au près : la VMG doit y culminer.
  for (const [twa, sog] of [[30, 5.0], [35, 5.6], [40, 6.0], [45, 6.2], [50, 6.3], [55, 6.35]])
    for (let k = 0; k < 3; k++) runs.push({ id: id++, sog, twa, tws: 12 });
  const bin = p.buildPolar(runs, { twsBins: [12], twaStep: 5, minSamples: 1, smooth: false, vmgOffsets: [5, 10] }).bins[0];
  const up = bin.targets.upwind;
  assert.ok(up, 'une cible au près');
  assert.ok(up.around.length >= 2, `des voisins rapportés (${up.around.length})`);
  for (const a of up.around) {
    assert.strictEqual(a.twa, up.twa + a.delta, "le voisin est à l'écart annoncé");
    assert.ok(a.dVmg <= 1e-9, `aucun voisin ne peut battre l'optimum (${a.delta}° : ${a.dVmg})`);
    assert.ok(Math.abs(a.dPct - (100 * a.dVmg) / up.vmg) < 1e-6, 'le pourcentage suit l’écart');
  }
  // Un voisin qui sort de la plage 0-180° ou d'une case vide n'est pas inventé.
  const edge = p.buildPolar(
    [{ id: 99, sog: 6, twa: 175, tws: 12 }],
    { twsBins: [12], twaStep: 5, minSamples: 1, smooth: false, vmgOffsets: [5, 10] }
  ).bins[0].targets.downwind;
  assert.strictEqual(edge.around.length, 0, "pas de voisin là où il n'y a rien");
}

// ── Filtre de voilure ─────────────────────────────────────────────────────
// Le marquage ne sert à rien s'il ne se relit pas : filtrer doit vraiment
// écarter les points d'une autre configuration.
{
  const runs = [
    { id: 1, sog: 7.0, twa: 130, tws: 16, sail: { main: 'full', head: 'genois-full' } },
    { id: 2, sog: 7.2, twa: 130, tws: 16, sail: { main: 'full', head: 'genois-full' } },
    { id: 3, sog: 6.0, twa: 130, tws: 16, sail: { main: 'r1', head: 'genois-full' } },
  ];
  const o = { twsBins: [16], twaStep: 10, minSamples: 1, smooth: false };
  const all = p.buildPolar(runs, o).bins[0].cells.find((c) => c.twa === 130);
  assert.strictEqual(all.n, 3);
  const fullOnly = p.buildPolar(runs, Object.assign({ sail: { main: 'full', head: 'genois-full' } }, o)).bins[0].cells.find((c) => c.twa === 130);
  assert.strictEqual(fullOnly.n, 2, 'seuls les points de cette voilure');
  assert.ok(fullOnly.value > all.value, 'et la valeur change en conséquence');
  // Un critère vide ne filtre pas sur ce critère.
  const anyHead = p.buildPolar(runs, Object.assign({ sail: { main: 'r1', head: '' } }, o)).bins[0].cells.find((c) => c.twa === 130);
  assert.strictEqual(anyHead.n, 1);

  // Les clés françaises des premières versions se lisent toujours : la donnée
  // déjà écrite ne se corrige pas en la modifiant, mais en la traduisant.
  const legacy = [
    { id: 10, sog: 7.0, twa: 130, tws: 16, sail: { main: 'full', head: 'genois-full' } },
    { id: 11, sog: 7.0, twa: 130, tws: 16, sail: { main: 'full', head: 'trinquette-rolled' } },
  ];
  assert.deepStrictEqual(p.normalizeSail(legacy[0].sail), { main: 'full', head: 'genoa-full' });
  assert.deepStrictEqual(p.normalizeSail(legacy[1].sail), { main: 'full', head: 'jib-furled' });
  const mixed = p.buildPolar(runs.concat(legacy), Object.assign({ sail: { main: 'full', head: 'genoa-full' } }, o)).bins[0].cells.find((c) => c.twa === 130);
  assert.strictEqual(mixed.n, 3, 'ancienne et nouvelle écriture tombent dans la même case');
  // Et un filtre écrit à l'ancienne trouve la donnée écrite à la nouvelle.
  const oldFilter = p.buildPolar(runs.concat(legacy), Object.assign({ sail: { main: 'full', head: 'genois-full' } }, o)).bins[0].cells.find((c) => c.twa === 130);
  assert.strictEqual(oldFilter.n, 3);
}

// ── Points déclarés, exclus du partage ────────────────────────────────────
// Un point dont la seule preuve « pas au moteur » est la parole de l'équipage
// vaut pour son propriétaire, pas pour un corpus partagé : personne d'autre ne
// peut la vérifier. Il compte donc chez soi et disparaît à l'export partagé.
{
  const runs = [
    { id: 1, sog: 7.0, twa: 130, tws: 16, engineSource: 'rpm' },
    { id: 2, sog: 5.0, twa: 130, tws: 16, engineSource: 'declared' },
  ];
  const o = { twsBins: [16], twaStep: 10, minSamples: 1, smooth: false };
  const mine = p.buildPolar(runs, o).bins[0].cells.find((c) => c.twa === 130);
  const shared = p.buildPolar(runs, Object.assign({ excludeDeclared: true }, o)).bins[0].cells.find((c) => c.twa === 130);
  assert.strictEqual(mine.n, 2, 'chez soi, les deux comptent');
  assert.strictEqual(shared.n, 1, 'à partager, seul le point vérifiable reste');
  assert.strictEqual(shared.value, 7.0);
}

console.log('polar: ok');
