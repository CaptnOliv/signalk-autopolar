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
// Le plugin fait deux sorties HTTP — le reversement de la polaire et le ping
// d'installation — et ni l'une ni l'autre n'a quoi que ce soit à faire dans
// un `npm test` : ce serait le collecteur de production qui compterait les
// machines de développement.
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
  setPluginStatus: () => {},
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
      'navigation.courseOverGroundTrue': world.hdg * D2R,
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
const IDENT = { boatModel: 'Test 40', shareName: 'test', sharePolar: false };
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

const closeHauled = (hdg, twa) => (i) => ({
  sog: 6.4 + noise(0.25),
  stw: 6.1 + noise(0.25),
  aws: 15 + noise(0.4),
  awa: (twa > 0 ? 32 : -32) + noise(2),
  tws: 12 + noise(0.4),
  twa: twa + noise(3),
  hdg: hdg + noise(3),
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
function call(key, query = {}, body = {}) {
  let out = null;
  routes[key]({ query, body }, { json: (v) => (out = v), type: () => {}, send: (v) => (out = v), end: () => {} });
  return out;
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
assert.ok(call('GET /api/export.csv', { min: '1' }).includes('twa,'));
const jieter = call('GET /api/export.jieter', { min: '1' });
assert.ok(/^# signalk-autopolar/.test(jieter) && /\ntwa\/tws;/.test(jieter), 'export Jieter bien formé');

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
  pl.start({ windowS: 30, minSamples: 1 });
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

plugin.stop();
assert.deepStrictEqual(netAttempts, [], `rien ne doit sortir pendant les tests, obtenu : ${netAttempts.join(', ')}`);
global.fetch = realFetch;
Date.now = realNow;
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('smoke: ok —', afterMotor, 'points,', samples.length, 'échantillons bruts');
