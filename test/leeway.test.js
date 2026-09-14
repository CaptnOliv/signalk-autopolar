// La dérive doit être séparée de ce qui lui ressemble : un courant, une
// erreur de compas. Comme pour le speedo, on fabrique des mondes dont la
// réponse est connue d'avance — c'est le seul moyen de vérifier une mesure
// qu'aucun instrument du bord ne rend directement.
const assert = require('assert');
const leeway = require('../lib/leeway');
const polar = require('../lib/polar');

// Un bateau qui dérive d'un angle connu, décroissant quand on abat (c'est la
// réalité : plus le bateau avance et moins la quille glisse), avec les deux
// amures et, en option, un courant et une erreur de compas.
//
// Convention : twa négatif = vent de bâbord = bâbord amure. La dérive pousse
// alors la route vers la droite du cap, donc cog > hdg.
function world({ leewayAt = (twa) => Math.max(0, 8 - twa / 12), current = 0, compass = 0, headings = [10, 100, 190, 280], twas = [40, 55, 75, 110, 150] } = {}) {
  const runs = [];
  let id = 0;
  for (const hdg of headings)
    for (const twa of twas)
      for (const sign of [-1, 1]) {
        const lee = leewayAt(twa) * (sign < 0 ? 1 : -1); // bâbord amure : à droite
        runs.push({
          id: id++,
          ts: 1000 * ++id,
          hdg: hdg + compass,
          cog: hdg + lee + current,
          sog: 6,
          stw: 6,
          twa: twa * sign,
          tws: 12,
          awa: (twa / 2) * sign,
          aws: 16,
          roll: 12 * -sign,
          hdgSrc: 'true',
        });
      }
  return runs;
}

// ── Le cas de base : de la dérive et rien d'autre ───────────────────────────
{
  const a = leeway.analyse(world());
  assert.strictEqual(a.verdict, 'ok');
  assert.ok(a.usable, 'la courbe doit être utilisable');
  assert.ok(Math.abs(a.bias) < 0.3, `biais ≈ 0 attendu, obtenu ${a.bias}`);
  // 8 - 40/12 = 4,67° à 40° du vent.
  assert.ok(Math.abs(leeway.leewayAt(a.curve, 40) - 4.67) < 0.4, `dérive à 40° : ${leeway.leewayAt(a.curve, 40)}`);
  // Elle décroît quand on abat — c'est le cœur du sujet : pincer coûte plus
  // cher que la seule perte de vitesse.
  assert.ok(leeway.leewayAt(a.curve, 40) > leeway.leewayAt(a.curve, 75) + 1);
}

// ── Un courant s'ajoute : il ne doit PAS être compté comme de la dérive ─────
{
  const a = leeway.analyse(world({ current: 4 }));
  assert.strictEqual(a.verdict, 'ok');
  assert.ok(Math.abs(a.bias - 4) < 0.5, `le courant doit atterrir dans le biais, obtenu ${a.bias}`);
  assert.ok(Math.abs(leeway.leewayAt(a.curve, 40) - 4.67) < 0.5, 'la dérive reste la même malgré le courant');
}

// ── Une erreur de compas : même traitement, même résultat ───────────────────
{
  const a = leeway.analyse(world({ compass: -7 }));
  assert.ok(Math.abs(a.bias - 7) < 0.5, `l'erreur de compas doit atterrir dans le biais, obtenu ${a.bias}`);
  assert.ok(Math.abs(leeway.leewayAt(a.curve, 40) - 4.67) < 0.5);
}

// ── Une seule amure : on ne conclut pas ─────────────────────────────────────
//
// C'est l'angle mort de la méthode et il doit se dire, pas se deviner : avec
// un seul bord, une dérive de 5° et un courant de 5° sont le même chiffre.
{
  const oneTack = world().filter((r) => r.twa < 0);
  const a = leeway.analyse(oneTack);
  assert.ok(a.verdict !== 'ok', `verdict ${a.verdict} : une seule amure ne doit rien conclure`);
  assert.ok(!a.usable, 'aucune correction ne doit être proposée sur une seule amure');
}

// ── Un cap magnétique brut est écarté ───────────────────────────────────────
//
// Sinon la déclinaison locale (jusqu'à 15°) entrerait telle quelle dans la
// mesure. Le point n'est pas corrigé en douce : il est retiré, et compté.
{
  const runs = world().map((r) => Object.assign({}, r, { hdgSrc: 'magnetic' }));
  const a = leeway.analyse(runs);
  assert.strictEqual(a.n, 0, 'aucun point magnétique brut ne doit être retenu');
  assert.strictEqual(a.magneticHeading, runs.length);
  assert.ok(!a.usable);
}

// ── Sans cap du tout : on le dit, et rien ne casse ──────────────────────────
{
  const runs = world().map((r) => Object.assign({}, r, { hdg: null }));
  const a = leeway.analyse(runs);
  assert.strictEqual(a.verdict, 'no_heading');
  assert.ok(!a.usable);
  assert.strictEqual(leeway.leewayAt(a.curve, 40), 0);
}

// ── L'angle sur le fond ─────────────────────────────────────────────────────
//
// Il OUVRE toujours l'angle : on arrive sous le vent de là où on pointe,
// jamais au-dessus. Le signe de l'amure est conservé.
{
  const runs = world({ current: 3 });
  const a = leeway.analyse(runs);
  for (const r of runs.slice(0, 40)) {
    const g = leeway.groundTwa(r, a);
    assert.ok(g != null);
    assert.ok(Math.sign(g) === Math.sign(r.twa), 'l amure ne doit pas changer');
    assert.ok(Math.abs(g) >= Math.abs(r.twa) - 0.2, `${r.twa} → ${g} : l'angle fond doit être plus ouvert`);
  }
}

// ── La polaire lue sur le fond ──────────────────────────────────────────────
//
// Deux vérifications qui comptent plus que les valeurs : la lecture fond
// déplace bien la courbe vers des angles plus ouverts, et elle refuse de
// s'appliquer quand la dérive n'a pas été mesurée (une correction devinée
// serait pire qu'aucune, parce qu'elle aurait l'air mesurée).
{
  const runs = world();
  const model = leeway.analyse(runs);
  const water = polar.buildPolar(runs, { stat: 'median', minSamples: 1, smooth: false, leeway: model });
  const ground = polar.buildPolar(runs, { stat: 'median', minSamples: 1, smooth: false, angle: 'ground', leeway: model });

  assert.strictEqual(water.angle, 'water');
  assert.strictEqual(ground.angle, 'ground');
  assert.strictEqual(ground.angleAsked, 'ground');

  const filled = (p) => {
    const b = p.bins.find((x) => x.ws === 12);
    return b.cells.filter((c) => c.n).map((c) => c.twa);
  };
  assert.deepStrictEqual(filled(water), [40, 55, 75, 110, 150]);
  // 40° barrés + 4,67° de dérive = 44,7°, soit la case 45.
  assert.ok(filled(ground).includes(45), `cases fond : ${filled(ground)}`);
  assert.ok(!filled(ground).includes(40));

  // La cible de VMG est annotée des deux angles, et la VMG sur le fond est
  // forcément la plus basse des deux au près.
  const t = water.bins.find((b) => b.ws === 12).targets.upwind;
  assert.ok(t.twaGround > t.twa);
  assert.ok(t.vmgGround < t.vmg);

  // Sans modèle exploitable, le bouton ne fait rien — et le dit.
  const noModel = polar.buildPolar(runs, { stat: 'median', minSamples: 1, angle: 'ground', leeway: null });
  assert.strictEqual(noModel.angle, 'water');
  assert.strictEqual(noModel.angleAsked, 'ground');
  assert.strictEqual(noModel.used, water.used);
}

console.log('leeway: ok');
