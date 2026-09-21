// Fait tourner le plugin entier contre un faux serveur SignalK et une nav
// simulée : près tribord, virement, près bâbord, puis un bord au moteur.
// On vérifie que des points sortent des bords stables, qu'aucun ne sort du
// virement ni du moteur, et que le rejeu du brut retrouve la même chose.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polaire-'));

// Faux temps : le plugin s'appuie sur Date.now() pour horodater et juger la
// fraîcheur. On avance d'une seconde par tick simulé.
let now = Date.parse('2026-09-02T10:00:00Z');
const realNow = Date.now;
Date.now = () => now;

// Aucun accès réseau dans les tests, et on le vérifie au lieu de l'espérer.
// Le plugin fait trois sorties HTTP — le reversement de la polaire, le ping
// d'installation et la vérification de version chez npm — et aucune n'a quoi
// que ce soit à faire dans un `npm test` : ce serait le collecteur de
// production qui compterait les machines de développement.
const realFetch = global.fetch;
const netAttempts = [];
global.fetch = async (url) => {
  netAttempts.push(String(url));
  throw new Error('aucun réseau dans les tests');
};

const D2R = Math.PI / 180;
const KN = 1 / 1.94384;

let world = {};
function node(v) {
  return { value: v, timestamp: new Date(now).toISOString(), $source: 'test' };
}
const fakeApp = {
  getDataDirPath: () => dataDir,
  // Le vrai serveur SignalK sait écrire la configuration d'un plugin sans le
  // redémarrer, sous la forme { enabled, configuration } — c'est ce qui permet
  // au bandeau du pot commun de demander le modèle et le nom sur place. On
  // reproduit cette forme exacte, parce que c'est elle que la route doit
  // respecter : un fichier de config qui remonte les groupes d'un cran coûte
  // à l'équipage tous ses réglages avancés.
  savedOptions: {
    enabled: true,
    configuration: { windowS: 30, polarBins: { twsBins: [6, 8, 10] }, advanced: { maxSampleMB: 50 } },
  },
  readPluginOptions: () => fakeApp.savedOptions,
  savePluginOptions: (configuration, cb) => {
    fakeApp.savedOptions = Object.assign({}, fakeApp.savedOptions, { configuration });
    cb(null);
  },
  setPluginStatus: () => {},
  debug: () => {},
  error: (e) => {
    throw e;
  },
  getSelfPath: (p) => {
    if (p === 'propulsion') {
      return { Engine1: { revolutions: node(world.rpm / 60), state: node(world.rpm > 0 ? 'started' : 'stopped') } };
    }
    const map = {
      'navigation.speedOverGround': world.sog * KN,
      'navigation.speedThroughWater': world.stw * KN,
      'environment.wind.speedApparent': world.aws * KN,
      'environment.wind.angleApparent': world.awa * D2R,
      'environment.wind.speedTrue': world.tws * KN,
      'environment.wind.angleTrueWater': world.twa * D2R,
      // La route fond, distincte du cap quand le monde le demande : c'est
      // l'écart entre les deux qui porte toute la mesure de dérive.
      'navigation.courseOverGroundTrue': (world.cog == null ? world.hdg : world.cog) * D2R,
      'navigation.headingTrue': world.hdg * D2R,
      'navigation.rateOfTurn': (world.rot || 0) * D2R,
      'navigation.state': world.navState,
      'navigation.attitude': { roll: (world.roll || 0) * D2R, pitch: 0, yaw: null },
    };
    return p in map ? node(map[p]) : null;
  },
};

// On capture le callback du setInterval pour piloter l'horloge nous-mêmes.
let tick = null;
const realSetInterval = global.setInterval;
global.setInterval = (fn) => {
  tick = fn;
  return 0;
};
global.clearInterval = () => {};

const plugin = require('../index.js')(fakeApp);
// Identité du bateau (sans elle le plugin ne collecte rien), et vérification
// de version coupée : le registre npm n'a rien à faire d'un `npm test`, et la
// tenue de ce module (rien au démarrage, silence hors ligne) est couverte par
// test/update.test.js. Le ping d'installation, lui, s'abstient d'office la
// première heure — l'horloge de ce test n'y arrive pas.
const IDENT = { boatModel: 'Test 40', shareName: 'test', sharePolar: false, checkForUpdates: false };
plugin.start(Object.assign({ windowS: 30, minSamples: 1, staleMs: 6000 }, IDENT));
global.setInterval = realSetInterval;
assert.ok(tick, 'le plugin a bien démarré une boucle');

// Un peu de bruit réaliste : sans lui, le test validerait un monde parfait
// que le filtre n'aura jamais à traiter.
let seed = 7;
const noise = (amp) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return ((seed / 0x7fffffff) * 2 - 1) * amp;
};

function run(seconds, f) {
  for (let i = 0; i < seconds; i++) {
    world = f(i);
    tick();
    now += 1000;
  }
}

// Au près le bateau dérive : 5° sous le vent de son cap, du côté opposé à
// celui d'où vient le vent. Tribord amure (twa > 0, vent de droite) la route
// part à gauche du cap, bâbord amure à droite — c'est ce basculement que
// lib/leeway.js exploite pour séparer la dérive du courant.
const LEEWAY = 5;
const closeHauled = (hdg, twa) => (i) => ({
  sog: 6.4 + noise(0.25),
  stw: 6.1 + noise(0.25),
  aws: 15 + noise(0.4),
  awa: (twa > 0 ? 32 : -32) + noise(2),
  tws: 12 + noise(0.4),
  twa: twa + noise(3),
  hdg: hdg + noise(3),
  cog: hdg + (twa > 0 ? -LEEWAY : LEEWAY) + noise(3),
  rot: noise(0.5),
  roll: twa > 0 ? 14 : -14,
  rpm: 0,
  navState: 'sailing',
});

// 1. Cinq minutes de près tribord bien tenu.
run(300, closeHauled(100, 45));
const afterTack1 = plugin && require('fs').readFileSync(path.join(dataDir, 'runs.jsonl'), 'utf8').trim().split('\n').length;
assert.ok(afterTack1 >= 8, `près tribord : au moins 8 points en 5 min, obtenu ${afterTack1}`);

// 2. Un virement : 20 s de cap qui tourne vite. Rien ne doit en sortir.
const before = afterTack1;
run(20, (i) => ({
  sog: 3 + noise(0.5),
  stw: 3 + noise(0.5),
  aws: 10,
  awa: 32 - i * 6,
  tws: 12,
  twa: 45 - i * 8,
  hdg: 100 - i * 9,
  rot: -9,
  roll: 14 - i * 2,
  rpm: 0,
  navState: 'sailing',
}));
let count = fs.readFileSync(path.join(dataDir, 'runs.jsonl'), 'utf8').trim().split('\n').length;
assert.strictEqual(count, before, 'aucun point ne doit sortir du virement');

// 3. Près bâbord.
run(300, closeHauled(-80, -45));
const afterPort = fs.readFileSync(path.join(dataDir, 'runs.jsonl'), 'utf8').trim().split('\n').length;
assert.ok(afterPort > before + 5, 'des points sortent aussi sur bâbord amure');

// 4. Un bord au moteur, parfaitement stable : rien ne doit être retenu.
run(300, () => ({
  sog: 7 + noise(0.1),
  stw: 6.9 + noise(0.1),
  aws: 12,
  awa: 20,
  tws: 8,
  twa: 60,
  hdg: 50,
  rot: 0,
  roll: 0,
  rpm: 1800,
  navState: 'motoring',
}));
const afterMotor = fs.readFileSync(path.join(dataDir, 'runs.jsonl'), 'utf8').trim().split('\n').length;
assert.strictEqual(afterMotor, afterPort, 'un bord au moteur ne doit produire aucun point');

// Le brut ne contient pas non plus le moteur, mais contient bien le virement
// (c'est justement ce qu'on veut pouvoir réexaminer plus tard).
const samples = fs.readFileSync(path.join(dataDir, 'samples.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.ok(samples.length > 600 && samples.length < 640, `brut = les 620 s sous voile, obtenu ${samples.length}`);
// Le faux bord publie à la fois `revolutions` et `state`, comme la plupart des
// installations : la décision s'appuie donc sur les deux, jamais sur autostate.
assert.ok(!samples.some((s) => s.eng !== 'state+rpm'), 'les deux témoins moteur sont utilisés ici');

// ── API ──
const routes = {};
plugin.registerWithRouter({
  get: (p, h) => (routes['GET ' + p] = h),
  post: (p, h) => (routes['POST ' + p] = h),
});
// Les en-têtes du dernier appel. Le nom d'un fichier exporté porte la
// projection — c'est la seule chose qui, une fois le .pol téléchargé, dit
// encore si on regarde du SOG ou du STW.
let lastHeaders = {};
function call(key, query = {}, body = {}) {
  let out = null;
  lastHeaders = {};
  routes[key](
    { query, body },
    {
      json: (v) => (out = v),
      type: () => {},
      send: (v) => (out = v),
      end: () => {},
      setHeader: (k, v) => (lastHeaders[k] = v),
    }
  );
  return out;
}
// Les routes de l'historique sont asynchrones (elles interrogent le serveur) :
// on attend la réponse au lieu de lire un null.
function callAsync(key, query = {}, body = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      json: resolve,
      type: () => {},
      send: resolve,
      end: () => resolve(null),
      setHeader: (k, v) => (lastHeaders[k] = v),
    };
    Promise.resolve(routes[key]({ query, body }, res)).catch(reject);
  });
}

const status = call('GET /api/status');
assert.strictEqual(status.disk.runCount, afterMotor);

const polar = call('GET /api/polar', { min: '1' });
const bin12 = polar.bins.find((b) => b.ws === 12);
assert.ok(bin12.cells.some((c) => c.twa === 45 && c.n > 0), 'la case 12 nd / 45° est remplie');
assert.ok(bin12.targets.upwind, 'un angle de VMG optimal est calculé');

// Les quatre projections doivent toutes rendre quelque chose.
for (const speed of ['sog', 'stw'])
  for (const wind of ['true', 'apparent'])
    assert.ok(call('GET /api/polar', { speed, wind, min: '1' }).used > 0, `projection ${speed}/${wind} non vide`);

// Amures séparées : chaque bord a ses points.
assert.ok(call('GET /api/polar', { tack: 'port', min: '1' }).used > 0);
assert.ok(call('GET /api/polar', { tack: 'starboard', min: '1' }).used > 0);

// Nuage de points et exclusion d'un aberrant.
const cloud = call('GET /api/scatter', { ws: '12', min: '1' });
assert.ok(cloud.length > 5, 'le nuage de points est peuplé');
const victim = cloud[0].id;
call('POST /api/exclude', {}, { ids: [victim], excluded: true });
assert.strictEqual(call('GET /api/status').excluded, 1);
assert.strictEqual(call('GET /api/scatter', { ws: '12', min: '1' }).length, cloud.length - 1);
call('POST /api/exclude', {}, { ids: [victim], excluded: false });

// Case forcée à la main.
call('POST /api/cell-override', {}, { ws: 12, twa: 45, value: 6.9 });
assert.strictEqual(call('GET /api/polar', { min: '1' }).bins.find((b) => b.ws === 12).cells.find((c) => c.twa === 45).value, 6.9);
call('POST /api/cell-override', {}, { ws: 12, twa: 45, value: null });

// Rejeu du brut : le filet de sécurité. À seuils identiques il doit retrouver
// le même nombre de points ; en desserrant la fenêtre, davantage.
const dry = call('POST /api/rebuild', {}, { dryRun: true, opts: { windowS: 30 } });
assert.ok(Math.abs(dry.count - afterMotor) <= 1, `rejeu à seuils identiques : ${dry.count} vs ${afterMotor}`);
assert.strictEqual(call('GET /api/status').disk.runCount, afterMotor, 'un dryRun ne touche à rien');
const loose = call('POST /api/rebuild', {}, { dryRun: true, opts: { windowS: 15 } });
assert.ok(loose.count > dry.count, 'une fenêtre plus courte donne plus de points');

// Exports.
assert.ok(call('GET /api/export.pol', { min: '1' }).startsWith('twa/tws\t'));
const csv = call('GET /api/export.csv', { min: '1' });
assert.ok(/^# signalk-autopolar/.test(csv) && /\ntwa,/.test(csv), 'le CSV annonce sa projection');
const jieter = call('GET /api/export.jieter', { min: '1' });
assert.ok(/^# signalk-autopolar/.test(jieter) && /\ntwa\/tws;/.test(jieter), 'export Jieter bien formé');

// Un .pol est une matrice nue : rien dans le fichier ne dit s'il est en SOG ou
// en STW. Le nom le dit, et c'est pour ça qu'il est verrouillé ici — deux
// exports pris à cinq minutes d'écart doivent être distinguables après coup.
call('GET /api/export.pol', { min: '1', speed: 'sog', wind: 'true', stat: 'mean' });
assert.match(lastHeaders['Content-Disposition'], /filename="[^"]*-sog-true-mean\.pol"/, `nom SOG : ${lastHeaders['Content-Disposition']}`);
call('GET /api/export.pol', { min: '1', speed: 'stw', wind: 'apparent', stat: 'median' });
assert.match(lastHeaders['Content-Disposition'], /filename="[^"]*-stw-apparent-median\.pol"/, `nom STW : ${lastHeaders['Content-Disposition']}`);
// La sauvegarde JSON n'a pas de projection et ne doit pas prétendre en avoir une.
call('GET /api/export.json');
assert.match(lastHeaders['Content-Disposition'], /filename="[^"]*-autopolar-backup\.json"/);

// Comment ce bateau navigue. Le faux bord tire un bord sous voile : la carte
// doit décrire ces points-là, et rien d'autre — surtout pas le temps moteur ni
// le mouillage, qui ne sont jamais entrés dans la collecte.
const hab = call('GET /api/habits');
assert.strictEqual(hab.points, afterMotor, 'la carte décrit les points retenus, pas le temps passé en mer');
assert.ok(hab.hours > 0 && hab.hours < 1, `quelques minutes de nav retenues, obtenu ${hab.hours}`);
assert.strictEqual(
  hab.pointsOfSail.reduce((a, b) => a + b.points, 0),
  hab.points,
  'chaque point tombe dans exactement une allure'
);
assert.strictEqual(hab.wind.reduce((a, b) => a + b.points, 0), hab.points);
assert.strictEqual(hab.tacks.port + hab.tacks.starboard, hab.points);
assert.ok(Math.abs(hab.balance.upwind + hab.balance.downwind - 1) < 1e-9);

// Mise à jour : la route répond toujours, même sans vérification faite, et elle
// n'annonce rien tant qu'elle ne sait rien. C'est ce qui permet à la webapp de
// n'avoir aucune règle de version à réimplémenter.
const upd = call('GET /api/update');
assert.strictEqual(upd.latest, null, 'rien de vérifié, rien d\'annoncé');
assert.ok(/^\d+\.\d+\.\d+/.test(upd.current), `version installée annoncée : ${upd.current}`);

// Polar Management : le faux serveur n'a pas de resourcesApi, donc indisponible,
// et l'envoi est refusé proprement plutôt que de lever une exception.
const pm = call('GET /api/polar-management');
assert.strictEqual(pm.available, false, 'pas de resourcesApi => Polar Management indisponible');
assert.strictEqual(call('POST /api/polar-management/send', {}, {}).ok, false, 'envoi refusé, sans exception');

// Un coup de pouce : le bandeau ne s'ouvre pas sur une polaire de 20 points,
// et une réponse le ferme définitivement. La règle elle-même est testée nue
// dans support.test.js — ici on vérifie juste qu'elle est bien câblée.
const sup = call('GET /api/support');
assert.strictEqual(sup.ask, false, 'rien à remercier avant que la polaire serve à quelque chose');
assert.strictEqual(sup.links.kofi, 'https://ko-fi.com/captnoliv');
call('POST /api/support/answer', {}, { outcome: 'never' });
assert.strictEqual(call('GET /api/support').ask, false);

// ── Dérive : de la mesure à la polaire lue sur le fond ────────────────────
// Le monde de test dérive de 5° au près, du bon côté selon l'amure. La chaîne
// entière doit donc retrouver ce chiffre, sans le confondre avec le courant
// (il n'y en a pas ici : le biais doit tomber à zéro).
{
  const lw = call('GET /api/leeway');
  assert.strictEqual(lw.verdict, 'ok', `verdict de dérive : ${lw.verdict}`);
  assert.ok(lw.usable, 'la dérive mesurée doit être exploitable');
  assert.ok(Math.abs(lw.upwind - 5) < 1.5, `5° de dérive attendus, obtenu ${lw.upwind}`);
  assert.ok(Math.abs(lw.bias) < 1.5, `aucun courant dans ce monde, biais obtenu ${lw.bias}`);
  assert.strictEqual(lw.magneticHeading, 0);

  // La lecture « sur le fond » ouvre les angles : la même nav à 45° barrés se
  // range autour de 50° une fois la dérive prise en compte.
  const water = call('GET /api/polar', { min: '1', smooth: '0' });
  const ground = call('GET /api/polar', { min: '1', smooth: '0', angle: 'ground' });
  assert.strictEqual(water.angle, 'water');
  assert.strictEqual(ground.angle, 'ground');
  const angles = (p) =>
    p.bins.find((b) => b.ws === 12).cells.filter((c) => c.n).map((c) => c.twa);
  assert.ok(angles(water).includes(45), `cases eau : ${angles(water)}`);
  assert.ok(Math.max(...angles(ground)) > Math.max(...angles(water)), 'la lecture fond ouvre les angles');

  // Et la cible de VMG porte les deux angles, sans qu'on ait à changer de vue.
  const t = water.bins.find((b) => b.ws === 12).targets.upwind;
  assert.ok(t.twaGround > t.twa && t.vmgGround < t.vmg, 'cible annotée de son équivalent sur le fond');

  // Le repère du moment doit être lu dans le MÊME repère que la courbe
  // affichée. Sinon on compare la vitesse tenue à 45° barrés à la case 45°
  // d'une polaire où cette case décrit un bateau qui ne dérive pas : l'écart
  // affiché serait faux de toute la dérive, sans que rien ne le signale.
  // Une seule seconde de près, sans bruit : de quoi poser l'état courant sans
  // fabriquer un point de plus. Le bruit est retiré exprès — un point retenu
  // est une médiane sur 60 s, alors qu'ici on lit une seconde, où ±3° de bruit
  // sur le cap ET sur la route noieraient les 5° qu'on veut voir.
  // Tribord amure (vent de droite) : la route part à gauche du cap.
  run(1, () => ({
    sog: 6.4, stw: 6.1, aws: 15, awa: 32, tws: 12, twa: 45,
    hdg: 100, cog: 100 - LEEWAY, rot: 0, roll: 14, rpm: 0, navState: 'sailing',
  }));
  const nowWater = call('GET /api/now', { min: '1' });
  const nowGround = call('GET /api/now', { min: '1', angle: 'ground' });
  assert.ok(nowWater.has && nowGround.has, 'un état courant exploitable');
  assert.ok(Math.abs(nowWater.twa - Math.abs(nowWater.waSteered)) < 0.01, 'en lecture eau, angle affiché = angle barré');
  assert.ok(Math.abs(Math.abs(nowWater.waSteered) - 45) < 0.01, 'on barre bien 45°');
  assert.ok(
    Math.abs(nowGround.twa - (45 + LEEWAY)) < 1.5,
    `en lecture fond, l'angle du moment s'ouvre de la dérive : ${nowGround.waSteered} barrés → ${nowGround.twa}`
  );
  assert.ok(Math.abs(nowGround.vmgGround) <= Math.abs(nowGround.vmg) + 1e-9, 'la VMG sur le fond ne dépasse jamais l\'autre');
}

// ── Ce qui part vraiment dans le fonds commun ─────────────────────────────
// La charge utile se verrouille champ par champ, comme celle du ping : c'est
// ce qui oblige à mettre à jour la description de l'option quand on ajoute
// quelque chose, au lieu de l'élargir en silence.
{
  const pay = JSON.parse(call('GET /api/share.json'));
  assert.strictEqual(pay.schema, 1);
  assert.strictEqual(pay.speed, 'sog');
  assert.strictEqual(pay.stat, 'median');

  // Les deux lectures de vitesse voyagent ensemble : aucune des deux ne se
  // suffit (la SOG porte le courant, la STW porte l'erreur du capteur).
  const cells = pay.bins.flatMap((b) => b.cells);
  assert.ok(cells.length, 'des cases dans la charge utile');
  assert.ok(cells.some((c) => c.stw != null && c.nStw > 0), 'la lecture STW accompagne la lecture SOG');

  // Et de quoi les départager : le verdict du speedo et la dérive mesurée.
  assert.ok(pay.leeway && pay.leeway.verdict === 'ok', 'la dérive part avec la polaire');
  assert.ok(pay.leeway.curve.length, 'la courbe de dérive aussi');
  assert.ok(pay.speedo && typeof pay.speedo.gain === 'number', 'le verdict du speedo part avec');

  // Rien qui dise OÙ le bateau navigue. Le biais de dérive (courant + compas)
  // et la direction du courant implicite restent à bord : ils décrivent
  // l'endroit, pas le bateau. On le vérifie sur le texte sérialisé, seule
  // façon de ne pas dépendre de la forme de l'objet.
  const txt = JSON.stringify(pay);
  for (const forbidden of ['bias', 'latitude', 'longitude', 'position', 'meanAbsDir', 'meanRelDir', 'earthFrame'])
    assert.ok(!txt.includes(forbidden), `« ${forbidden} » ne doit pas quitter le bateau`);
}

// ── Suggestions de voilure : une période confirmée ne doit pas revenir ────
// Les frontières bougent avec la polaire ; le rattachement se fait donc en
// points, pas en minutes. Ici on confirme une période décalée de quelques
// secondes par rapport au découpage, et elle doit rester traitée.
{
  const sug = call('GET /api/sail-suggest');
  assert.ok(Array.isArray(sug.segments), 'des segments');
  assert.strictEqual(typeof sug.hideHandledAfterDays, 'number');
  const seg = sug.segments.find((x) => x.n >= 2);
  if (seg) {
    assert.strictEqual(seg.handled, null, 'rien de traité au départ');
    // Volontairement décalée : elle ne contient pas le segment au sens de
    // l'horloge, mais elle couvre bien tous ses points.
    call('POST /api/sail-reviewed', {}, { from: seg.from - 5000, to: seg.to + 5000 });
    const again = call('GET /api/sail-suggest').segments.find((x) => x.from === seg.from);
    assert.ok(again, 'le segment est toujours là');
    assert.strictEqual(again.handled, 'reviewed', 'une plage décalée de 5 s couvre quand même ses points');
    assert.strictEqual(again.handledPts, again.pts);
    call('POST /api/sail-reviewed/clear', {}, {});
  }
}

// ── Le pot commun ─────────────────────────────────────────────────────────
// Le ping dit où en est le partage en trois états. Ce test tourne avec
// sharePolar: false et une identité remplie : c'est « coupé », pas « jamais
// configuré » — et c'est toute la différence, puisque l'un est une décision et
// l'autre un formulaire vide.
assert.strictEqual(JSON.parse(call('GET /api/usage.json')).sharing, 'off');
// Le bandeau du pot commun vise ce cas précis — une polaire qui ne sort pas —
// mais il ne dit rien avant d'avoir quelque chose à montrer : 20 points ne
// valent aucune demande. La règle est testée nue dans support.test.js.
const sp = call('GET /api/share-prompt');
assert.strictEqual(sp.ask, false, 'rien à proposer avant que la polaire vaille quelque chose');
assert.strictEqual(sp.why, 'milestone not reached');
assert.strictEqual(sp.state, 'off');
assert.strictEqual(sp.canSave, true, 'ce serveur sait enregistrer sa configuration');

// Enregistrer depuis le bandeau : deux champs changent, le partage se rallume,
// et SURTOUT rien d'autre ne bouge dans le fichier de configuration. C'est le
// point qui mérite un test — `opts` est aplati au démarrage, et le réécrire
// tel quel remonterait polarBins et advanced d'un cran.
const savedBefore = fakeApp.savedOptions.configuration;
const saved = call('POST /api/share-prompt/save', {}, { model: 'Beneteau Oceanis 48 (2013)', name: 'Jazzy' });
assert.strictEqual(saved.ok, true);
assert.strictEqual(saved.state, 'on');
const cfg = fakeApp.savedOptions.configuration;
assert.strictEqual(cfg.boatModel, 'Beneteau Oceanis 48 (2013)');
assert.strictEqual(cfg.shareName, 'Jazzy');
assert.strictEqual(cfg.sharePolar, true, 'dire oui rallume le partage');
assert.deepStrictEqual(cfg.polarBins, savedBefore.polarBins, 'les groupes du schéma restent des groupes');
assert.deepStrictEqual(cfg.advanced, savedBefore.advanced, 'et les réglages avancés restent à leur place');
assert.strictEqual(fakeApp.savedOptions.enabled, true, 'le plugin ne se désactive pas au passage');
// Pris en compte tout de suite : enregistrer ne redémarre pas le plugin.
assert.strictEqual(JSON.parse(call('GET /api/usage.json')).sharing, 'on');
assert.strictEqual(call('GET /api/share').configured, true);
const spAfter = call('GET /api/share-prompt');
assert.strictEqual(spAfter.ask, false, 'la question ne se repose plus');
assert.strictEqual(spAfter.why, 'sharing is on');
// Sans les deux champs, on n'écrit rien du tout.
assert.strictEqual(call('POST /api/share-prompt/save', {}, { model: 'x' }).ok, false);

// Tag de voilure.
call('POST /api/sail', {}, { main: '1ris', head: 'genoa' });
assert.deepStrictEqual(call('GET /api/status').sail, { main: '1ris', head: 'genoa' });

// Une donnée inattendue dans l'arbre ne doit pas faire remonter d'exception :
// sur 30 h de nav, perdre la collecte est ennuyeux, perdre SignalK ne l'est
// pas du tout.
const brokenApp = Object.assign({}, fakeApp, {
  getSelfPath: () => {
    throw new Error('arbre corrompu');
  },
});
let logged = 0;
brokenApp.error = () => logged++;
const p2 = require('../index.js')(brokenApp);
let tick2 = null;
global.setInterval = (fn) => {
  tick2 = fn;
  return 0;
};
p2.start(Object.assign({}, IDENT));
global.setInterval = realSetInterval;
assert.doesNotThrow(() => tick2(), 'un arbre cassé ne fait pas remonter d\'exception');
assert.ok(logged > 0, "l'erreur est signalée et non avalée en silence");
p2.stop();

// ── `revolutions` : un booléen, pas un régime ─────────────────────────────
// On ne convertit rien et on n'affiche aucun chiffre : toute valeur non nulle,
// quelle que soit son unité (hertz, tr/min, pulses), veut dire « le moteur
// tourne ». Le verdict rendu à la webapp est donc « running », et rien n'est
// collecté tant qu'il tourne.
{
  // Un régime de nav valide, pour que le filtre aille jusqu'au verdict moteur
  // au lieu de s'arrêter avant sur un manque de vent.
  world = { sog: 6, stw: 5.8, aws: 14, awa: 42, tws: 11, twa: 48, hdg: 100, rot: 0, roll: 12, navState: 'sailing' };
  const engineLive = (revValue) => {
    const app = Object.assign({}, fakeApp, {
      getSelfPath: (path) =>
        path === 'propulsion'
          ? { Engine1: { revolutions: node(revValue) } } // pas de `state` : seul `revolutions` tranche
          : fakeApp.getSelfPath(path),
    });
    const pl = require('../index.js')(app);
    let t = null;
    global.setInterval = (fn) => {
      t = fn;
      return 0;
    };
    pl.start(Object.assign({}, IDENT));
    global.setInterval = realSetInterval;
    let handler = null;
    pl.registerWithRouter({
      get: (route, fn) => {
        if (route === '/api/live') handler = fn;
      },
      post: () => {},
    });
    t();
    let payload = null;
    handler({ query: {} }, { json: (x) => (payload = x) });
    pl.stop();
    return payload;
  };

  // 30 Hz, 1800 « tr/min », 0,5 pulse : peu importe l'échelle, c'est « running ».
  for (const v of [30, 1800, 0.5]) {
    assert.strictEqual(engineLive(v).engine.state, 'running', `revolutions=${v} ⇒ moteur en marche`);
  }
  // Zéro (ou pas de donnée) : le moteur est à l'arrêt, la collecte peut se faire.
  assert.strictEqual(engineLive(0).engine.state, 'off', 'revolutions=0 ⇒ moteur à l\'arrêt');
  // Aucun chiffre moteur ne fuit vers la webapp : seul le verdict est exposé.
  const p = engineLive(30);
  assert.ok(!('rpm' in p.values) && !('rpm' in p.engine), 'aucune valeur de régime dans le payload');
}

// ── Sans identité du bateau, rien n'est collecté ──────────────────────────
// Le consentement au partage se donne une fois, en configuration, et il est
// indissociable du modèle et du nom. Une polaire accumulée en silence sans
// eux ne serait rattachable à rien : mieux vaut ne rien faire, et le dire.
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'polaire-bare-'));
  let status = '';
  const app2 = Object.assign({}, fakeApp, { getDataDirPath: () => bare, setPluginStatus: (m) => (status = m) });
  const pl = require('../index.js')(app2);
  let t = null;
  global.setInterval = (fn) => {
    t = fn;
    return 0;
  };
  pl.start({ windowS: 30, minSamples: 1, checkForUpdates: false });
  global.setInterval = realSetInterval;
  for (let i = 0; i < 200; i++) {
    world = { sog: 6.5, stw: 6.4, aws: 14, awa: 42, tws: 12, twa: 45, hdg: 100, rpm: 0 };
    t();
    now += 1000;
  }
  assert.ok(/set the boat model/.test(status), `le statut le dit clairement, obtenu : ${status}`);
  assert.ok(!fs.existsSync(path.join(bare, 'runs.jsonl')), 'aucun point collecté');
  pl.stop();
  fs.rmSync(bare, { recursive: true, force: true });
}

// ── Ébauche depuis le History API ─────────────────────────────────────────
//
// Un faux magasin d'historique : 45 min de largue la VEILLE de la nav
// simulée. On vérifie les quatre propriétés qui font qu'une ébauche ne peut
// pas abîmer une polaire :
//   — elle vit dans son propre fichier, runs.jsonl n'est pas touché ;
//   — un rejeu du brut ne l'efface pas ;
//   — les périodes déjà observées en direct ne sont pas ré-importées ;
//   — les points restent reconnaissables, filtrables, et comptés au partage.
async function historyTests() {
  const HIST_FROM = Date.parse('2026-09-01T08:00:00Z');
  const HIST_MIN = 45;
  // Le brut du magasin : une mesure toutes les 1,5 s, comme sur le vrai — d'où
  // des trous à 1 s de résolution et des tranches pleines à 2 s.
  const raw = [];
  for (let ms = 0; ms < HIST_MIN * 60000; ms += 1500) {
    raw.push({
      t: HIST_FROM + ms,
      awa: (105 + Math.sin(ms / 600000) * 8) * D2R,
      aws: (9 + Math.sin(ms / 420000) * 0.6) * KN,
      sog: (5.5 + Math.sin(ms / 300000) * 0.3) * KN,
    });
  }
  // L'état moteur, une fois par minute : la cadence réelle quand il arrive du
  // Cerbo par MQTT. C'est elle qui rend la bande de garde nécessaire.
  const engine = [];
  for (let ms = 0; ms <= HIST_MIN * 60000; ms += 60000) engine.push({ t: HIST_FROM + ms, v: 'stopped' });

  const AGG = {
    average: (v) => v.reduce((a, b) => a + b, 0) / v.length,
    first: (v) => v[0],
    min: (v) => Math.min(...v),
    max: (v) => Math.max(...v),
  };
  let queries = 0;
  const fakeHistory = {
    getPaths: async () => [
      'environment.wind.angleApparent',
      'environment.wind.speedApparent',
      'navigation.speedOverGround',
      'propulsion.Engine1.state',
    ],
    getContexts: async () => ['vessels.self'],
    getValues: async (q) => {
      queries++;
      const from = q.from.epochMilliseconds;
      const to = q.to.epochMilliseconds;
      const res = (q.resolution || (to - from) / 1000) * 1000;
      assert.ok(Number.isFinite(from) && Number.isFinite(to), 'le plugin passe bien des instants lisibles');
      const values = q.pathSpecs.map((sp) => ({ path: sp.path, method: sp.aggregate }));
      const rows = [];
      for (let b = from; b < to; b += res) {
        const inBucket = raw.filter((x) => x.t >= b && x.t < b + res);
        const eng = engine.filter((x) => x.t >= b && x.t < b + res);
        rows.push([
          new Date(b).toISOString(),
          ...values.map((v) => {
            if (v.path === 'propulsion.Engine1.state') return eng.length ? eng[0].v : null;
            if (!inBucket.length) return null;
            const key =
              v.path === 'environment.wind.angleApparent' ? 'awa' : v.path === 'environment.wind.speedApparent' ? 'aws' : 'sog';
            return AGG[v.method](inBucket.map((x) => x[key]));
          }),
        ]);
      }
      return { context: 'vessels.self', range: { from: q.from.toString(), to: q.to.toString() }, values, data: rows };
    },
  };
  // Le plugin lit `app.getHistoryApi` au moment de l'appel : on peut donc
  // brancher le faux magasin sur l'instance déjà en route, qui a de vraies
  // mesures et un vrai brut derrière elle.
  fakeApp.getHistoryApi = async () => fakeHistory;

  const check = await callAsync('POST /api/history/check');
  assert.strictEqual(check.verdict, 'ok', `la vérification aboutit, obtenu ${check.verdict} — ${check.why || ''}`);
  assert.strictEqual(check.resolution, 2, "la résolution est mesurée : 2 s, parce qu'à 1 s une tranche sur trois est vide");
  assert.strictEqual(check.windowSamples, 15, 'une fenêtre de 30 s tient sur 15 tranches de 2 s');
  assert.ok(check.points > 10, `des points sortent des 45 min de largue, obtenu ${check.points}`);
  assert.ok(check.sailingMs > 30 * 60000, 'le temps sous voile trouvé est annoncé');
  assert.strictEqual(check.engineCadenceMs, 60000, 'la cadence de publication du moteur est mesurée');
  assert.ok(check.missing.some((m) => m.key === 'stw'), 'ce qui manque est nommé (ici la vitesse surface)');
  assert.ok(check.bands.length, 'les forces de vent couvertes sont annoncées');

  // Une vérification n'écrit rien : c'est tout l'intérêt du premier bouton.
  assert.ok(!fs.existsSync(path.join(dataDir, 'history.jsonl')), "la vérification n'a rien écrit");
  const runsBefore = fs.readFileSync(path.join(dataDir, 'runs.jsonl'), 'utf8');

  const imp = await callAsync('POST /api/history/import');
  assert.strictEqual(imp.ok, true, `import : ${imp.why || ''}`);
  assert.strictEqual(imp.points, check.points, 'le nombre annoncé est celui qui est écrit — pas une estimation');
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'runs.jsonl'), 'utf8'), runsBefore, 'les mesures du plugin ne sont pas touchées');
  const drafted = fs.readFileSync(path.join(dataDir, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(drafted.length, imp.points);
  assert.ok(
    drafted.every((r) => r.origin === 'history' && r.res === 2 && r.engineSource === 'history'),
    'chaque point porte son origine'
  );
  assert.ok(drafted.every((r) => r.stw === null), "sans vitesse surface archivée, rien n'est inventé");

  // Deux imports d'affilée ne doublent pas les points : la plage est
  // remplacée, pas empilée. C'est le bouton sur lequel on clique deux fois.
  const again = await callAsync('POST /api/history/import');
  assert.strictEqual(again.total, imp.total, "un second import remplace au lieu d'empiler");

  // La polaire les voit, et le filtre d'affichage les cache sans rien effacer.
  const withDraft = call('GET /api/polar', { min: '1', history: '1' });
  const without = call('GET /api/polar', { min: '1', history: '0' });
  assert.strictEqual(withDraft.used - without.used, imp.points, "le filtre d'affichage retire exactement les points d'ébauche");
  const st = call('GET /api/status');
  assert.strictEqual(st.disk.historyCount, imp.points);
  assert.strictEqual(st.disk.liveCount + st.disk.historyCount, st.disk.runCount);

  // Le partage les emmène ET les compte : c'est la contrepartie de les
  // envoyer. Un point d'ébauche qui passerait pour une mesure prise en direct,
  // personne ne pourrait le pondérer chez le collecteur.
  // La route rend du texte (JSON indenté, relisible à l'écran) : on le relit.
  const shared = JSON.parse(call('GET /api/share.json'));
  assert.strictEqual(shared.historyPoints, imp.points, "le nombre de points d'ébauche part avec la polaire");
  assert.ok(shared.points >= imp.points);
  // D'où vient le verdict « pas au moteur », point par point. Le faux bord
  // publie `state` ET `revolutions`, donc les points pris en direct sont en
  // `state+rpm` ; l'ébauche tirée de l'historique n'a aucun témoin moteur.
  assert.ok(shared.engineSources && typeof shared.engineSources === 'object', 'la polaire partagée dit sur quoi repose le verdict moteur');
  assert.ok(shared.engineSources['state+rpm'] > 0, `engineSources: ${JSON.stringify(shared.engineSources)}`);
  assert.strictEqual(
    Object.values(shared.engineSources).reduce((a, b) => a + b, 0),
    shared.totalPoints,
    'chaque point est attribué à exactement une source'
  );
  // Et le partage ignore le réglage d'affichage : ce qu'on reverse est ce que
  // la carte Share montre, pas ce qu'on regarde à l'écran.
  assert.strictEqual(JSON.parse(call('GET /api/share.json', { history: '0' })).historyPoints, imp.points);

  // Un rejeu du brut n'efface pas l'ébauche : c'est la raison du fichier
  // séparé. Dans un runs.jsonl commun, elle disparaîtrait sans un mot.
  const replay = call('POST /api/rebuild', {}, { opts: { windowS: 30 } });
  assert.ok(replay.count > 0);
  assert.strictEqual(call('GET /api/status').disk.historyCount, imp.points, "le rejeu du brut laisse l'ébauche en place");

  // Les périodes déjà observées en direct ne sont pas ré-importées. On le
  // vérifie sur la nav simulée : elle est dans le magasin comme dans le brut,
  // et rien n'en ressort.
  const simFrom = Date.parse('2026-09-02T10:00:00Z');
  raw.length = 0;
  engine.length = 0;
  for (let ms = 0; ms < 20 * 60000; ms += 1500) {
    raw.push({ t: simFrom + ms, awa: 105 * D2R, aws: 9 * KN, sog: 5.5 * KN });
    if (ms % 60000 === 0) engine.push({ t: simFrom + ms, v: 'stopped' });
  }
  // Les dix premières minutes de la nav simulée sont dans le brut : le plugin
  // les a vues, à pleine fréquence, et les a jugées. Rien à y refaire.
  const overlap = await callAsync('POST /api/history/import', {}, { from: simFrom, to: simFrom + 9 * 60000, resolution: 2 });
  assert.strictEqual(overlap.ok, true, `import chevauchant : ${overlap.why || ''}`);
  assert.strictEqual(overlap.points, 0, 'une période déjà surveillée en direct ne se ré-importe pas');

  // Et le compte rendu ne dit pas la même chose que « il n'y avait pas de
  // voile » : c'est le message qu'on a lu à tort la première fois, alors que
  // les 41 min étaient bien là et simplement déjà vues. Deux verdicts
  // distincts, parce qu'ils demandent deux réactions opposées.
  const seen = await callAsync('POST /api/history/check', {}, { from: simFrom, to: simFrom + 9 * 60000 });
  assert.strictEqual(seen.verdict, 'already_watched', `obtenu ${seen.verdict} — ${seen.why || ''}`);
  assert.ok(seen.sailingMs > 0, 'la voile trouvée est comptée même quand elle est écartée');
  assert.strictEqual(seen.availableMs, 0, 'et ce qui reste à exploiter vaut zéro');
  assert.ok(/watching itself/.test(seen.why), 'le motif est nommé, pas deviné');
  // La retenue est sélective, pas générale : la fin de la simulation (le bord
  // au moteur, absent du brut) n'est pas couverte, et là l'import travaille.
  // C'est exactement ce à quoi il sert — combler ce que le plugin n'a pas vu.
  const gapFill = await callAsync('POST /api/history/import', {}, { from: simFrom, to: simFrom + 20 * 60000, resolution: 2 });
  assert.ok(gapFill.points > 0, "les périodes non couvertes, elles, sont bien importées");

  // Et on peut tout jeter, sans toucher aux mesures.
  const live = call('GET /api/status').disk.liveCount;
  await callAsync('POST /api/history/clear');
  const after = call('GET /api/status');
  assert.strictEqual(after.disk.historyCount, 0);
  assert.strictEqual(after.disk.liveCount, live, "jeter l'ébauche ne touche pas aux mesures");

  // Un serveur sans History API : on le dit, on ne plante pas.
  delete fakeApp.getHistoryApi;
  assert.strictEqual(call('GET /api/history').available, false);
  const noApi = await callAsync('POST /api/history/check');
  assert.strictEqual(noApi.verdict, 'error');
  assert.ok(/History API/.test(noApi.why));
  return { points: imp.points, queries };
}

historyTests().then(
  (hist) => {
    plugin.stop();
    assert.deepStrictEqual(netAttempts, [], `rien ne doit sortir pendant les tests, obtenu : ${netAttempts.join(', ')}`);
    global.fetch = realFetch;
    Date.now = realNow;
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(
      'smoke: ok —',
      afterMotor,
      'points,',
      samples.length,
      'échantillons bruts,',
      hist.points,
      "points d'ébauche en",
      hist.queries,
      "requêtes d'historique"
    );
  },
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
