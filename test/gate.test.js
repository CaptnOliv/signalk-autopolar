const assert = require('assert');
const { classify, assessWindow, condense } = require('../lib/gate');

const OPTS = {
  engineOffRpm: 50,
  autostateFallback: true,
  minSogKn: 1,
  minAwsKn: 1.5,
  minTwaDeg: 25,
  windowS: 9,
  awaDriftMaxDeg: 15,
  awaSpreadMaxDeg: 45,
  twsDriftMaxKn: 3,
  twsSpreadMaxKn: 8,
  sogDriftMaxKn: 1.5,
  sogSpreadMaxKn: 2.5,
  rotMaxDegS: 6,
};

const base = {
  sog: 6, stw: 5.8, awa: 40, aws: 14, twa: 55, tws: 11, hdg: 100, cog: 102, roll: 12, rot: 0.2,
  rpm: 0, engineState: 'stopped', navState: 'sailing', rpmEverSeen: true,
  fresh: { sog: true, stw: true, awa: true, aws: true, rpm: true, engineState: true },
};
const s = (o) => Object.assign({}, base, o, { fresh: Object.assign({}, base.fresh, (o || {}).fresh) });

assert.strictEqual(classify(s(), OPTS).usable, true);
assert.strictEqual(classify(s(), OPTS).engineSource, 'state+rpm', 'les deux témoins sont là et concordent');

// Le moteur tourne : rien à apprendre, quoi qu'en dise le reste.
assert.strictEqual(classify(s({ rpm: 1200 }), OPTS).reason, 'motoring');
assert.strictEqual(classify(s({ engineState: 'started' }), OPTS).reason, 'motoring');

// ── Quand les deux témoins se contredisent ────────────────────────────────
// On ne cherche pas le régime, seulement « tourne / ne tourne pas ». Un
// `revolutions` mal mis à l'échelle par une passerelle (la spec dit des hertz,
// rien ne l'impose) peut faire passer un moteur à l'arrêt pour un ralenti — et
// inversement. Dans le doute on prend la lecture prudente : collecter un point
// au moteur salit la polaire pour toujours, en rater un ne coûte que ce point.
assert.strictEqual(classify(s({ rpm: 900, engineState: 'stopped' }), OPTS).reason, 'motoring');
assert.strictEqual(classify(s({ rpm: 0, engineState: 'started' }), OPTS).reason, 'motoring');

// Un seul témoin suffit, et la source le dit.
const onlyState = classify(s({ rpm: null, fresh: { rpm: false } }), OPTS);
assert.strictEqual(onlyState.usable, true);
assert.strictEqual(onlyState.engineSource, 'state');
const onlyRpm = classify(s({ engineState: null, fresh: { engineState: false } }), OPTS);
assert.strictEqual(onlyRpm.usable, true);
assert.strictEqual(onlyRpm.engineSource, 'rpm');

// Le RPM n'arrive plus. autostate dit « sailing » et il a déjà vu du moteur
// par le passé : on accepte, en traçant que la décision vient de là.
const fb = classify(s({ rpm: null, engineState: null, fresh: { rpm: false, engineState: false } }), OPTS);
assert.strictEqual(fb.usable, true);
assert.strictEqual(fb.engineSource, 'autostate');

// Même situation, mais on n'a JAMAIS vu de donnée moteur : autostate annonce
// « sailing » par défaut, ce qui ne prouve rien. On refuse.
assert.strictEqual(
  classify(s({ rpm: null, engineState: null, rpmEverSeen: false, fresh: { rpm: false, engineState: false } }), OPTS).reason,
  'engine_unknown'
);

// Repli désactivé : sans donnée moteur, on ne collecte pas.
assert.strictEqual(
  classify(s({ rpm: null, engineState: null, fresh: { rpm: false, engineState: false } }), Object.assign({}, OPTS, { autostateFallback: false })).reason,
  'engine_unknown'
);

assert.strictEqual(classify(s({ navState: 'anchored', sog: 0.4 }), OPTS).reason, 'anchored');
// ... mais un navigation.state en retard ne bloque pas un bateau qui avance.
assert.strictEqual(classify(s({ navState: 'anchored', sog: 6 }), OPTS).usable, true);
assert.strictEqual(classify(s({ sog: 0.5 }), OPTS).reason, 'too_slow');
assert.strictEqual(classify(s({ twa: 10 }), OPTS).reason, 'in_irons');
assert.strictEqual(classify(s({ fresh: { awa: false } }), OPTS).reason, 'no_wind_data');

// ── Fenêtres : dérive contre dispersion ──
const win = (n, f = () => ({})) =>
  Array.from({ length: n }, (_, i) => Object.assign({ ts: 1000 + i * 1000 }, base, f(i)));

assert.strictEqual(assessWindow(win(3), OPTS).reason, 'accumulating');
assert.strictEqual(assessWindow(win(9), OPTS).stable, true);

// LE cas qui compte : un voilier réel dans la mer. Rien n'est constant — le
// vent apparent oscille de 30°, la force de 4 nd, la vitesse de 1,8 nd, le
// bateau roule — mais rien ne DÉRIVE : l'allure de la fin est celle du début.
// Ce point doit être retenu et moyenné, pas jeté.
const houle = assessWindow(
  win(9, (i) => ({
    awa: 40 + [0, 12, -15, 8, -10, 14, -12, 6, -3][i],
    tws: 11 + [0, 1.8, -2, 1.2, -1.5, 2, -1.8, 0.9, -0.6][i],
    sog: 6 + [0, 0.8, -0.9, 0.6, -0.7, 0.9, -0.8, 0.4, -0.3][i],
    hdg: 100 + [0, 9, -11, 6, -8, 10, -9, 5, -2][i],
    rot: [0.2, 3, -3.5, 2, -2.6, 3.2, -3, 1.6, -0.9][i],
  })),
  OPTS
);
assert.strictEqual(houle.stable, true, `mer formée mais allure tenue : doit être retenu (${houle.reason})`);
assert.ok(houle.metrics.awaSpread > 20, 'la dispersion est bien réelle');
assert.ok(Math.abs(houle.metrics.awaDrift) < 10, "mais l'allure n'a pas dérivé");
assert.ok(houle.metrics.quality > 0 && houle.metrics.quality < 1, 'une note de confiance est calculée');

// Le cas symétrique : ça ne bouge presque pas d'une seconde à l'autre, mais
// l'allure s'en va tranquillement de 27°. Fin et début ne décrivent plus le
// même bateau — rejet, alors que la dispersion instantanée est minime.
const derive = assessWindow(win(9, (i) => ({ awa: 40 + i * 3, hdg: 100 + i * 3 })), OPTS);
assert.strictEqual(derive.reason, 'course_changed');

// Sous pilote en mode vent, une bascule fait tourner le bateau de 40° sans
// que l'allure change d'un degré. Le cap n'est donc PAS un critère de rejet.
const bascule = assessWindow(win(9, (i) => ({ hdg: 100 + i * 5, awa: 40 })), OPTS);
assert.strictEqual(bascule.stable, true, 'suivre une bascule au pilote reste une mesure valide');
assert.ok(Math.abs(bascule.metrics.hdgDrift) > 20, 'le cap a bien tourné, on le note sans le refuser');

// Le vent monte franchement : la fin de fenêtre n'est plus la même case.
assert.strictEqual(assessWindow(win(9, (i) => ({ tws: 11 + i * 0.8 })), OPTS).reason, 'wind_shifting');
// Le bateau accélère encore.
assert.strictEqual(assessWindow(win(9, (i) => ({ sog: 6 + i * 0.3 })), OPTS).reason, 'accelerating');

// Manœuvres : virement et giration soutenue.
assert.strictEqual(assessWindow(win(9, (i) => ({ awa: i < 4 ? 40 : -40 })), OPTS).reason, 'tack_change');
assert.strictEqual(assessWindow(win(9, () => ({ rot: 9 })), OPTS).reason, 'turning');
// Une embardée ponctuelle sur une lame n'est pas une manœuvre.
assert.strictEqual(assessWindow(win(9, (i) => ({ rot: i === 4 ? 14 : 0.2 })), OPTS).stable, true);

// Plafonds de dispersion : au-delà on ne mesure plus rien.
assert.strictEqual(assessWindow(win(9, (i) => ({ awa: 40 + (i % 2 ? 30 : -30) })), OPTS).reason, 'wind_erratic');
assert.strictEqual(assessWindow(win(9, (i) => ({ sog: 6 + (i % 2 ? 2 : -2) })), OPTS).reason, 'speed_erratic');

// Au portant plein, le signe de l'angle vacille sans qu'on ait empanné : ce
// n'est pas un changement d'amure.
assert.strictEqual(assessWindow(win(9, (i) => ({ awa: i % 2 ? 175 : -175 })), OPTS).stable, true);

const c = condense(win(9), { id: 42 });
assert.strictEqual(c.id, 42);
assert.strictEqual(c.n, 9);
assert.ok(Math.abs(c.sog - 6) < 1e-9);

console.log('gate: ok');
