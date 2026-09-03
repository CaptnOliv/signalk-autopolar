// L'alerte d'inactivité : le vrai risque n'est pas que le plugin plante, mais
// qu'il refuse tout en silence pendant 30 h. On vérifie donc qu'il le dit,
// qu'il ne le dit qu'une fois, et qu'il signale le retour à la normale.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polaire-notify-'));
let now = Date.parse('2026-09-02T12:00:00Z');
const realNow = Date.now;
Date.now = () => now;

// ntfy bouchonné : aucun accès réseau dans les tests.
const sent = [];
let failNext = 0;
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (failNext > 0) {
    failNext--;
    throw new Error('ENETUNREACH');
  }
  sent.push({ url, title: init.headers.Title, body: init.body, auth: init.headers.Authorization });
  return { ok: true, status: 200 };
};

const D2R = Math.PI / 180;
const KN = 1 / 1.94384;
let world = {};
const node = (v) => ({ value: v, timestamp: new Date(now).toISOString() });
const fakeApp = {
  getDataDirPath: () => dataDir,
  setPluginStatus: () => {},
  debug: () => {},
  error: () => {},
  getSelfPath: (p) => {
    if (p === 'propulsion') return { Engine1: { revolutions: node(0), state: node('stopped') } };
    const map = {
      'navigation.speedOverGround': world.sog * KN,
      'navigation.speedThroughWater': world.sog * KN,
      'environment.wind.speedApparent': 14 * KN,
      'environment.wind.angleApparent': world.awa * D2R,
      'environment.wind.speedTrue': 11 * KN,
      'environment.wind.angleTrueWater': 55 * D2R,
      'navigation.headingTrue': world.hdg * D2R,
      'navigation.courseOverGroundTrue': world.hdg * D2R,
      'navigation.rateOfTurn': 0,
      'navigation.state': 'sailing',
      'navigation.attitude': { roll: 0.2, pitch: 0, yaw: null },
    };
    return p in map ? node(map[p]) : null;
  },
};

let tick = null;
const realSetInterval = global.setInterval;
const capture = (fn) => {
  tick = fn;
  return 0;
};
global.clearInterval = () => {};

// Le vrai plugin est piloté par setInterval : entre deux ticks, l'event loop
// tourne et les envois en cours se résolvent. Un test qui enchaîne les ticks
// en synchrone ne verrait jamais la file se dépiler.
const breathe = () => new Promise((r) => setImmediate(r));

async function ticks(fn, n, sim) {
  for (let i = 0; i < n; i++) {
    world = sim(i);
    fn();
    now += 1000;
    if (i % 10 === 0) await breathe();
  }
  await breathe();
}

function startPlugin(options) {
  global.setInterval = capture;
  const p = require('../index.js')(fakeApp);
  p.start(options);
  global.setInterval = realSetInterval;
  return [p, tick];
}

(async () => {
  // ── Fenêtre absurdement longue : aucun point ne pourra jamais sortir, ce
  // qui est exactement la panne silencieuse qu'on veut voir signalée.
  const [p1, t1] = startPlugin({ windowS: 100000, idleAlertMin: 1, ntfyUrl: 'https://ntfy.test/jazzy', ntfyToken: 'tk_test' });

  await ticks(t1, 120, () => ({ sog: 6, awa: 40, hdg: 100 }));
  assert.strictEqual(sent.length, 1, `une alerte et une seule, obtenu ${sent.length}`);
  assert.match(sent[0].title, /nothing is coming in/);
  assert.strictEqual(sent[0].auth, 'Bearer tk_test', 'le jeton est envoyé');
  assert.match(sent[0].body, /1 min of sailing/);

  // Le temps au mouillage ne compte pas : le compteur ne suit que la voile.
  const before = sent.length;
  await ticks(t1, 300, () => ({ sog: 0.1, awa: 40, hdg: 100 }));
  assert.strictEqual(sent.length, before, "rien de neuf tant qu'on ne navigue pas");
  p1.stop();

  // ── Un point finit par sortir : le retour à la normale est signalé, une fois.
  sent.length = 0;
  const [p2, t2] = startPlugin({ windowS: 30, idleAlertMin: 1, ntfyUrl: 'https://ntfy.test/jazzy', ntfyToken: 'tk_test' });
  // 90 s d'allure qui part dans tous les sens (rien ne peut être retenu),
  // puis un régime propre.
  await ticks(t2, 200, (i) => (i < 90 ? { sog: 6, awa: 40 + (i % 2 ? 40 : -40), hdg: 100 } : { sog: 6, awa: 40, hdg: 100 }));
  const titles = sent.map((m) => m.title);
  assert.ok(titles.some((t) => /nothing is coming in/.test(t)), `alerte partie (${titles.join(' | ')})`);
  assert.ok(titles.some((t) => /collecting again/.test(t)), `retour à la normale signalé (${titles.join(' | ')})`);
  assert.strictEqual(titles.filter((t) => /collecting again/.test(t)).length, 1, 'signalé une seule fois');
  p2.stop();

  // ── Un envoi qui échoue (plus d'Internet au large) n'est pas perdu.
  sent.length = 0;
  failNext = 1;
  const [p3, t3] = startPlugin({ windowS: 100000, idleAlertMin: 1, ntfyUrl: 'https://ntfy.test/jazzy' });
  await ticks(t3, 70, () => ({ sog: 6, awa: 40, hdg: 100 }));
  assert.strictEqual(sent.length, 0, "l'envoi a échoué, rien n'est encore parti");
  now += 61000; // la file n'est retentée qu'une fois par minute
  await ticks(t3, 3, () => ({ sog: 6, awa: 40, hdg: 100 }));
  assert.strictEqual(sent.length, 1, "l'alerte en attente a bien été renvoyée");
  p3.stop();

  // ── … y compris si la nav est finie entre-temps.
  //
  // C'est le scénario réel, et il a été un vrai bug : l'alerte part au large,
  // le lien Starlink est coupé, elle est mise en file — puis on rentre au
  // mouillage, où le réseau revient. Tant que `flush()` n'était appelé que
  // sur la branche « sous voile », la file restait gelée pour toujours,
  // exactement à l'instant où elle aurait pu partir.
  sent.length = 0;
  failNext = 1;
  const [p4, t4] = startPlugin({ windowS: 100000, idleAlertMin: 1, ntfyUrl: 'https://ntfy.test/jazzy' });
  await ticks(t4, 70, () => ({ sog: 6, awa: 40, hdg: 100 }));
  assert.strictEqual(sent.length, 0, "l'envoi a échoué, rien n'est parti");
  now += 61000;
  await ticks(t4, 5, () => ({ sog: 0.1, awa: 40, hdg: 100 })); // mouillage
  assert.strictEqual(sent.length, 1, 'la file se vide même au mouillage');
  p4.stop();

  Date.now = realNow;
  global.fetch = realFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('notify: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
