const assert = require('assert');
const { classify, assessWindow, condense } = require('../lib/gate');

const OPTS = {
  autostateFallback: true,
  minSogKn: 1,
  minAwsKn: 1.5,
  minTwaDeg: 25,
  maxUpwindSpeedRatio: 1,
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

// ── `revolutions` lu comme un simple booléen ──────────────────────────────
// On ne cherche pas le régime, seulement « tourne / ne tourne pas » : toute
// valeur non nulle = en marche, quelle que soit l'unité de la passerelle
// (hertz, tr/min, pulses). Une valeur minuscule suffit donc.
assert.strictEqual(classify(s({ rpm: 0.5, engineState: 'stopped' }), OPTS).reason, 'motoring');
// Et quand les deux témoins se contredisent, on prend la lecture prudente :
// collecter un point au moteur salit la polaire pour toujours, en rater un ne
// coûte que ce point.
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

// ── Déclaration de l'équipage, faute de tout signal moteur ────────────────
// La seule branche où la machine croit un humain sur parole. Elle ne doit
// s'ouvrir que si AUCUNE mesure moteur n'est disponible : une déclaration ne
// contredit jamais un instrument.
const noEngine = { rpm: null, engineState: null, rpmEverSeen: false, fresh: { rpm: false, engineState: false } };
{
  const d = classify(s(Object.assign({}, noEngine, { declaredSailing: true })), OPTS);
  assert.strictEqual(d.usable, true);
  assert.strictEqual(d.engineSource, 'declared', 'le point est marqué comme déclaré, donc filtrable');

  // Sans déclaration, on refuse : c'est la bonne réponse, pas un défaut.
  assert.strictEqual(classify(s(noEngine), OPTS).reason, 'engine_unknown');

  // Et une déclaration ne peut pas faire passer un moteur qui tourne.
  assert.strictEqual(classify(s({ rpm: 1200, declaredSailing: true }), OPTS).reason, 'motoring');
  assert.strictEqual(classify(s({ engineState: 'started', declaredSailing: true }), OPTS).reason, 'motoring');

  // Une mesure disponible prime toujours sur la parole.
  assert.strictEqual(classify(s({ declaredSailing: true }), OPTS).engineSource, 'state+rpm');
}

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

// ── Plus vite que le vent, au près ─────────────────────────────────────────
// Le contrôle physique : il attrape le moteur quand le signal moteur ment.
// Les deux polaires du fonds commun qui l'ont motivé annonçaient 1,26× et
// 1,29× le vent vrai au près, avec un verdict moteur du rang le plus solide.
assert.strictEqual(classify(s({ twa: 50, tws: 4, sog: 5 }), OPTS).reason, 'faster_than_wind');
assert.strictEqual(classify(s({ twa: -50, tws: 4, sog: 5 }), OPTS).reason, 'faster_than_wind', 'une amure ou l\'autre');
// À la stricte égalité on passe : le seuil est une borne physique, pas une marge.
assert.strictEqual(classify(s({ twa: 50, tws: 5, sog: 5 }), OPTS).usable, true);
// Au-delà de 70° la règle ne s'applique plus : un surf au portant dépasse
// vraiment le vent vrai, et ce n'est pas le moteur.
assert.strictEqual(classify(s({ twa: 140, tws: 4, sog: 8 }), OPTS).usable, true);
assert.strictEqual(classify(s({ twa: 70, tws: 4, sog: 8 }), OPTS).reason, 'faster_than_wind', '70° est encore du près');
// Réglable, parce qu'un foiler dépasse vraiment le vent au près.
assert.strictEqual(classify(s({ twa: 50, tws: 4, sog: 5 }), Object.assign({}, OPTS, { maxUpwindSpeedRatio: 0 })).usable, true);
assert.strictEqual(classify(s({ twa: 50, tws: 4, sog: 5 }), Object.assign({}, OPTS, { maxUpwindSpeedRatio: 2 })).usable, true);
// Sans vent vrai exploitable, on ne conclut pas — c'est `in_irons` ou le
// manque de données qui tranche, jamais cette règle-ci.
assert.strictEqual(classify(s({ twa: 50, tws: 0, sog: 5 }), OPTS).usable, true);
// L'ordre compte : au mouillage dans du courant, 1,2 nd par 0,5 nd de vent
// doit se lire « trop lent », pas « plus vite que le vent ».
assert.strictEqual(classify(s({ twa: 50, tws: 0.5, sog: 0.8 }), OPTS).reason, 'too_slow');

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

// ── Le balancement de la tête de mât n'est pas du vent ────────────────────
//
// Les scénarios ci-dessous reprennent ce qu'a montré le brut de Jazzy au
// portant dans la houle : une oscillation à la période du roulis (5 s),
// d'amplitude constante en nœuds, donc énorme en degrés dès que l'apparent
// est faible. Fenêtre de 60 s, comme à bord.
const { smoothApparent } = require('../lib/gate');
const ROLL = Object.assign({}, OPTS, { windowS: 60, awaSmoothS: 5 });
const RAW = Object.assign({}, ROLL, { awaSmoothS: 0 });
// Apparent vu d'une tête de mât qui balaie `swayKn` nœuds de travers à la
// période `periodS` : on compose les vitesses, comme le fait la vraie girouette.
const masthead = (meanAwa, aws, swayKn, periodS) => (i) => {
  const r = (meanAwa * Math.PI) / 180;
  const x = aws * Math.cos(r);
  const y = aws * Math.sin(r) + swayKn * Math.sin((2 * Math.PI * i) / periodS);
  return { awa: (Math.atan2(y, x) * 180) / Math.PI, aws: Math.hypot(x, y), twa: 150, tws: 14 };
};

// Grand largue, 7 nd d'apparent, 3,5 nd de balancement : ±27° lus à la
// girouette. Le brut refuse, le lissé retient — et dit les deux chiffres.
const largue = win(60, masthead(135, 7, 3.5, 5));
assert.strictEqual(assessWindow(largue, RAW).reason, 'wind_erratic', 'sans lissage, le roulis passe pour du vent erratique');
const largueOk = assessWindow(largue, ROLL);
assert.strictEqual(largueOk.stable, true, `allure tenue, mât qui balance : doit être retenu (${largueOk.reason})`);
assert.ok(largueOk.metrics.awaSpread > 45, 'la girouette a bien balayé plus que le plafond');
assert.ok(largueOk.metrics.awaSpreadSmoothed < 2, 'et il n\'en reste presque rien une fois la période moyennée');
assert.strictEqual(assessWindow(largue, RAW).metrics.awaSpreadSmoothed, undefined, 'pas de lissage, pas de second chiffre');

// Plein vent arrière : l'apparent se balance de part et d'autre de 180° et
// ressort sous 160° de l'autre bord. Ce n'est pas un empannage.
const arriere = win(60, masthead(172, 6, 3.5, 5));
assert.strictEqual(assessWindow(arriere, RAW).reason, 'tack_change', 'le brut y voyait un changement d\'amure');
assert.strictEqual(assessWindow(arriere, ROLL).stable, true, 'le lissé non');

// Un VRAI empannage, lui, reste une manœuvre — roulis compris.
const empannage = win(60, (i) => masthead(i < 30 ? 140 : -140, 8, 3.5, 5)(i));
assert.strictEqual(assessWindow(empannage, ROLL).reason, 'tack_change');
// Et un vrai virement aussi, y compris quand il tombe en fin de fenêtre.
assert.strictEqual(assessWindow(win(60, (i) => ({ awa: i < 30 ? 35 : -35 })), ROLL).reason, 'tack_change');
assert.strictEqual(assessWindow(win(60, (i) => ({ awa: i < 54 ? 35 : -35 })), ROLL).reason, 'tack_change');

// Le lissage ne doit rien pardonner d'autre que le roulis : un vent qui se
// promène vraiment (±35° sur 20 s) reste erratique, et une allure qui s'en va
// reste une allure qui change.
const promene = win(60, (i) => ({ awa: 90 + 35 * Math.sin((2 * Math.PI * i) / 20) }));
assert.strictEqual(assessWindow(promene, ROLL).reason, 'wind_erratic');
assert.strictEqual(assessWindow(win(60, (i) => ({ awa: 40 + i * 0.5 })), ROLL).reason, 'course_changed');

// Une moyenne glissante n'annule une oscillation que sur une période entière :
// à 5 s il ne reste rien d'un roulis de 5 s, à 3 s il en reste la moitié.
const amp = (k) => {
  const a = smoothApparent(win(60, masthead(135, 7, 3.5, 5)), k);
  return Math.max(...a) - Math.min(...a);
};
// Seules les tranches complètes sont rendues : 60 secondes, 56 tranches de 5.
assert.strictEqual(smoothApparent(largue, 5).length, 56);
assert.ok(amp(5) < 1, `période entière : oscillation annulée (${amp(5).toFixed(1)}°)`);
assert.ok(amp(3) > 20, `période partielle : il en reste (${amp(3).toFixed(1)}°)`);
// 0 et 1 rendent le brut tel quel.
assert.deepStrictEqual(smoothApparent(largue, 0), largue.map((x) => x.awa));
assert.deepStrictEqual(smoothApparent(largue, 1), largue.map((x) => x.awa));

const c = condense(win(9), { id: 42 });
assert.strictEqual(c.id, 42);
assert.strictEqual(c.n, 9);
assert.ok(Math.abs(c.sog - 6) < 1e-9);

console.log('gate: ok');
