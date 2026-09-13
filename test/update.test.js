// lib/update.js — « il existe une version plus récente ».
//
// Ce qui doit être verrouillé ici n'est pas la comparaison de numéros (elle est
// triviale) mais la tenue du module : rien ne sort au démarrage, rien ne sort
// quand l'option est coupée, et hors ligne il se tait au lieu d'annoncer une
// panne. Un plugin qui crie « impossible de vérifier les mises à jour » tous
// les jours au large est un plugin qu'on désinstalle.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUpdate, isDue, isNewer, compare, registryUrl, DAY, MIN_UPTIME_MS } = require('../lib/update');

// ── Comparaison de versions ────────────────────────────────────────────────
assert.strictEqual(compare('0.9.0', '0.8.1'), 1);
assert.strictEqual(compare('0.10.0', '0.9.9'), 1, '10 n\'est pas avant 9');
assert.strictEqual(compare('1.0.0', '1.0.0'), 0);
assert.ok(isNewer('0.9.0', '0.8.1'));
assert.ok(!isNewer('0.8.1', '0.9.0'), 'on ne propose pas de revenir en arrière');
assert.ok(!isNewer('0.9.0', '0.9.0'));
// Une préversion est antérieure à la version nue : on ne pousse jamais une rc
// sur un bateau, et qui en fait tourner une n'est pas « en retard ».
assert.ok(!isNewer('1.0.0-rc1', '1.0.0'));
assert.ok(isNewer('1.0.0', '1.0.0-rc1'));
// Sans version lisible des deux côtés, on ne dit rien plutôt qu'une bêtise.
assert.ok(!isNewer(null, '0.9.0'));
assert.ok(!isNewer('latest', '0.9.0'));
assert.ok(!isNewer('1.0.0', 'unknown'));

// ── L'URL du registre ──────────────────────────────────────────────────────
// Un paquet scopé porte un `/` dans son nom. Non encodé, le registre répond
// 404 et on conclurait « pas de mise à jour » pour toujours, en silence.
assert.strictEqual(
  registryUrl('@captnoliv/signalk-autopolar'),
  'https://registry.npmjs.org/@captnoliv%2Fsignalk-autopolar/latest'
);
assert.strictEqual(registryUrl('signalk-autopolar'), 'https://registry.npmjs.org/signalk-autopolar/latest');
assert.strictEqual(registryUrl(''), '', 'sans nom de paquet, pas de requête');

// ── Quand vérifier ─────────────────────────────────────────────────────────
const fresh = { latest: null, checkedAt: 0, lastTry: 0 };
assert.strictEqual(isDue(fresh, 1e12, DAY, MIN_UPTIME_MS - 1), false, 'rien au démarrage');
assert.strictEqual(isDue(fresh, 1e12, DAY, MIN_UPTIME_MS + 1), true);
assert.strictEqual(isDue({ checkedAt: 1e12 - 1000, lastTry: 1e12 - 1000 }, 1e12, DAY, 1e9), false, 'une fois par jour');
assert.strictEqual(isDue(fresh, 1e12, 0, 1e9), false, 'un intervalle nul coupe tout');

// ── Le module, avec un faux registre ───────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopolar-update-'));
const file = path.join(dir, 'update.json');
const realFetch = global.fetch;
const seen = [];

async function run() {
  // 1. Option coupée : aucune requête, jamais.
  global.fetch = async (u) => {
    seen.push(String(u));
    throw new Error('rien ne doit sortir ici');
  };
  let up = createUpdate(file, () => {});
  assert.strictEqual(up.maybeCheck({ checkForUpdates: false, name: 'x' }), false);
  assert.strictEqual(up.maybeCheck({ checkForUpdates: true, name: '' }), false, 'sans nom de paquet, rien');
  // Option active, mais le plugin vient de démarrer.
  assert.strictEqual(up.maybeCheck({ checkForUpdates: true, name: 'pkg' }), false, 'rien dans les premières minutes');
  assert.deepStrictEqual(seen, [], 'aucune sortie réseau');
  // Et tant qu'on n'a rien vérifié, on n'annonce rien.
  assert.deepStrictEqual(up.status('0.8.1', true).latest, null);

  // 2. Le registre répond. On triche sur l'uptime en antidatant l'état : le
  // module ne lit l'horloge qu'à travers Date.now, qu'on laisse tranquille.
  fs.writeFileSync(file, JSON.stringify({ latest: null, checkedAt: 0, lastTry: 0 }));
  global.fetch = async (u) => {
    seen.push(String(u));
    return { ok: true, json: async () => ({ name: 'pkg', version: '0.9.0' }) };
  };
  up = createUpdate(file, () => {});
  // Uptime : on force la main en appelant la décision pure, puis on vérifie
  // que le chemin complet passe une fois le délai écoulé.
  const realNow = Date.now;
  Date.now = () => realNow() + MIN_UPTIME_MS + 1000;
  assert.strictEqual(up.maybeCheck({ checkForUpdates: true, name: 'pkg' }), true);
  await new Promise((r) => setTimeout(r, 10));
  Date.now = realNow;
  assert.deepStrictEqual(seen, ['https://registry.npmjs.org/pkg/latest']);

  let st = up.status('0.8.1', true);
  assert.strictEqual(st.latest, '0.9.0', 'une version plus récente est annoncée');
  assert.strictEqual(st.current, '0.8.1');
  assert.ok(st.checkedAt > 0);
  // À jour : la webapp ne doit avoir aucune règle de version à réimplémenter,
  // donc `latest` est nul quand il n'y a rien à proposer.
  assert.strictEqual(up.status('0.9.0', true).latest, null);
  assert.strictEqual(up.status('1.0.0', true).latest, null, 'plus récent que le registre : rien non plus');

  // 3. Hors ligne : on se tait. L'état précédent reste consultable, et rien
  // n'est présenté comme une panne.
  seen.length = 0;
  fs.writeFileSync(file, JSON.stringify({ latest: '0.9.0', checkedAt: 1, lastTry: 0 }));
  up = createUpdate(file, () => {});
  global.fetch = async () => {
    throw new Error('ENETUNREACH');
  };
  const realNow2 = Date.now;
  Date.now = () => realNow2() + MIN_UPTIME_MS + 1000;
  assert.strictEqual(up.maybeCheck({ checkForUpdates: true, name: 'pkg' }), true);
  await new Promise((r) => setTimeout(r, 10));
  Date.now = realNow2;
  st = up.status('0.8.1', true);
  assert.strictEqual(st.latest, '0.9.0', 'la dernière réponse connue tient encore');
  assert.strictEqual(st.lastError, 'ENETUNREACH', "l'erreur est consultable, pas affichée comme telle");

  // 4. Une réponse illisible n'est pas une version.
  fs.writeFileSync(file, JSON.stringify({ latest: null, checkedAt: 0, lastTry: 0 }));
  up = createUpdate(file, () => {});
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  const realNow3 = Date.now;
  Date.now = () => realNow3() + MIN_UPTIME_MS + 1000;
  up.maybeCheck({ checkForUpdates: true, name: 'pkg' });
  await new Promise((r) => setTimeout(r, 10));
  Date.now = realNow3;
  assert.strictEqual(up.status('0.8.1', true).latest, null);

  global.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('update: ok');
}

run().catch((e) => {
  global.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
