// Le ping quotidien. C'est la seule donnée que ce plugin envoie sans que
// l'équipage y gagne quoi que ce soit — elle mérite donc d'être tenue plus
// court que le reste, pas moins. Ce que ce fichier vérifie surtout : que la
// charge utile ne peut pas grossir en douce, et qu'un réglage coupé coupe
// vraiment.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUsage, isDue, pingEndpointFrom, DAY, RETRY_MS, MIN_UPTIME_MS } = require('../lib/usage');

const T0 = 1e12;

// ── La règle de déclenchement, nue ─────────────────────────────────────────
const UP = MIN_UPTIME_MS; // tourne depuis assez longtemps pour avoir le droit de parler
assert.strictEqual(isDue({ lastSentAt: T0, lastTry: T0 }, T0 + DAY - 1, DAY, UP), false, 'moins d\'un jour : rien');
assert.strictEqual(isDue({ lastSentAt: T0, lastTry: T0 }, T0 + DAY, DAY, UP), true, 'un jour plus tard : un ping');
assert.strictEqual(isDue({ lastSentAt: 0, lastTry: 0 }, T0, DAY, UP), true, 'première fois, une fois lancé');
assert.strictEqual(isDue({ lastSentAt: 0, lastTry: 0 }, T0, 0, UP), false, 'période nulle = coupé');

// La première heure ne compte pas : une installation essayée cinq minutes
// puis retirée n'est pas une installation, et un `npm test` n'en est pas une
// non plus. C'est ce qui garde le chiffre sobre.
assert.strictEqual(isDue({ lastSentAt: 0, lastTry: 0 }, T0, DAY, 0), false, 'au démarrage : rien');
assert.strictEqual(isDue({ lastSentAt: 0, lastTry: 0 }, T0, DAY, UP - 1), false, 'à 59 min : toujours rien');

// Après un échec on retente dans l'heure, pas le lendemain : au mouillage le
// réseau revient souvent dans la journée. Mais on ne martèle pas.
const failed = { lastSentAt: 0, lastTry: T0, lastError: 'ENETUNREACH' };
assert.strictEqual(isDue(failed, T0 + 60000, DAY, UP), false, 'on ne martèle pas un lien mort');
assert.strictEqual(isDue(failed, T0 + RETRY_MS + 1, DAY, UP), true, 'la reprise revient d\'elle-même');

// ── D'où part le ping ──────────────────────────────────────────────────────
// Qui héberge son propre collecteur ne doit pas se retrouver à pinger le mien.
assert.strictEqual(pingEndpointFrom('https://autopolar.quicky.app/v1/polars'), 'https://autopolar.quicky.app/v1/ping');
assert.strictEqual(pingEndpointFrom('http://boat.local:8080/v1/polars/'), 'http://boat.local:8080/v1/ping');
assert.strictEqual(pingEndpointFrom(''), '', 'pas de partage configuré : pas de ping');
assert.strictEqual(pingEndpointFrom('pas une url'), '', 'URL illisible : on n\'invente rien');
assert.strictEqual(
  pingEndpointFrom('https://example.test/autre/chemin'),
  '',
  'chemin inattendu : on ne poste pas à l\'aveugle sur une URL inconnue'
);

// ── L'objet, avec un réseau bouchonné ──────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
const file = path.join(dir, 'usage.json');
const OPTS = { usageStats: true, usageEndpoint: 'https://collector.test/v1/ping' };

let posts = [];
let fail = false;
global.fetch = async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) });
  if (fail) throw new Error('ENETUNREACH');
  return { ok: true, status: 200 };
};
const settle = () => new Promise((r) => setImmediate(r));

// La charge utile de référence : exactement ce que décrit la configuration.
// Si ce test casse parce qu'un champ a été ajouté, ce n'est pas le test qu'il
// faut corriger — c'est la description de l'option, sinon on envoie quelque
// chose qu'on n'a pas annoncé.
const ALLOWED = ['schema', 'plugin', 'installId', 'version', 'node', 'signalk', 'firstSeen', 'sharing'];

// L'objet compte son propre temps de fonctionnement depuis sa création : on
// avance l'horloge plutôt que d'attendre une heure.
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const runFor = (ms) => {
  clock += ms;
};

(async () => {
  const u = createUsage(file, () => {});
  const id = u.id();
  assert.ok(/^[0-9a-f-]{36}$/.test(id), 'un identifiant est tiré au démarrage');

  const payload = () => ({
    schema: 1,
    plugin: 'signalk-autopolar',
    installId: u.id(),
    version: '9.9.9',
    node: process.version,
    signalk: '2.0.0',
    firstSeen: u.firstSeen(),
    sharing: false,
  });

  assert.strictEqual(u.maybeSend(OPTS, payload), false, 'au démarrage, rien ne part');
  runFor(MIN_UPTIME_MS);
  assert.strictEqual(u.maybeSend(OPTS, payload), true, 'passé la première heure, le premier ping part');
  await settle();
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].url, OPTS.usageEndpoint);
  assert.deepStrictEqual(
    Object.keys(posts[0].body).sort(),
    ALLOWED.slice().sort(),
    'la charge utile est exactement celle qu\'annonce la configuration, pas un champ de plus'
  );

  // Rien qui ressemble à une position ni à une donnée de nav, à aucun niveau.
  const flat = JSON.stringify(posts[0].body).toLowerCase();
  for (const forbidden of ['lat', 'lon', 'position', 'polar', 'sog', 'stw', 'name', 'model']) {
    assert.ok(!flat.includes(`"${forbidden}`), `aucun champ « ${forbidden} » dans le ping`);
  }

  // Une fois par jour : la boucle appelle maybeSend chaque seconde.
  for (let i = 0; i < 50; i++) u.maybeSend(OPTS, payload);
  await settle();
  assert.strictEqual(posts.length, 1, 'un seul ping, quoi qu\'en dise la boucle');

  // ── Coupé en configuration : rien, et pas même une tentative ─────────────
  posts = [];
  const off = createUsage(path.join(dir, 'off.json'), () => {});
  runFor(MIN_UPTIME_MS);
  assert.strictEqual(off.maybeSend(Object.assign({}, OPTS, { usageStats: false }), payload), false);
  assert.strictEqual(off.maybeSend(Object.assign({}, OPTS, { usageEndpoint: '' }), payload), false);
  await settle();
  assert.strictEqual(posts.length, 0, 'réglage coupé : rien ne sort du bateau');

  // ── Un ping perdu est perdu ─────────────────────────────────────────────
  // Contrairement à une alerte de collecte (lib/notify.js), pas de file : une
  // statistique n'a pas le droit d'être mieux traitée que ce qui sert
  // vraiment l'équipage.
  posts = [];
  fail = true;
  const lost = createUsage(path.join(dir, 'lost.json'), () => {});
  runFor(MIN_UPTIME_MS);
  lost.maybeSend(OPTS, payload);
  await settle();
  assert.strictEqual(posts.length, 1);
  assert.ok(lost.state().lastError, 'l\'échec est visible');
  assert.strictEqual(lost.state().sent, 0);
  lost.maybeSend(OPTS, payload);
  await settle();
  assert.strictEqual(posts.length, 1, 'aucune file d\'attente, aucun rattrapage immédiat');

  // ── L'identifiant survit à un redémarrage ───────────────────────────────
  // Sinon chaque restart de SignalK compterait une installation de plus, et
  // le chiffre ne voudrait plus rien dire.
  fail = false;
  const reopened = createUsage(file, () => {});
  assert.strictEqual(reopened.id(), id, 'le même identifiant est relu sur disque');
  assert.strictEqual(reopened.state().sent, 1, 'et le compteur avec');

  // Un état illisible ne plante pas : on repart sur un nouvel identifiant,
  // au prix d'une installation comptée deux fois.
  const junk = path.join(dir, 'junk.json');
  fs.writeFileSync(junk, '{ pas du json');
  const rebuilt = createUsage(junk, () => {});
  assert.ok(rebuilt.id() && rebuilt.id() !== id, 'fichier corrompu : on repart proprement');

  Date.now = realNow;
  console.log('usage: ok');
})();
