// Le collecteur, en vrai : un serveur qui écoute, des requêtes HTTP réelles,
// un ntfy bouchonné. Sans dépendance, comme le service lui-même.
//
// Ce qui est tenu ici, dans l'ordre d'importance : qu'une polaire ne puisse
// pas en écraser une autre, que le ping compte les installations sans rien
// exiger d'elles, et qu'un nom de bateau accentué ne fasse pas exploser la
// notification — c'est arrivé ailleurs, avec la file d'alertes gelée à la clé.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCollector } = require('./server.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-test-'));

// ntfy bouchonné. Comme dans les tests du plugin, le stub refuse ce que le
// vrai `fetch` refuse : un caractère hors Latin-1 dans un en-tête.
const notified = [];
global.fetch = async (url, init) => {
  for (const v of Object.values(init.headers || {})) {
    const i = String(v).search(/[^\x00-\xff]/);
    if (i >= 0) throw new TypeError(`Cannot convert argument to a ByteString (index ${i})`);
  }
  notified.push({ url, title: init.headers.Title, body: init.body, auth: init.headers.Authorization });
  return { ok: true, status: 200 };
};

const logs = [];
const { server } = createCollector({
  dir,
  ntfyUrl: 'https://ntfy.test/jazzy',
  ntfyToken: 'tk_test',
  notifyNewInstalls: true,
  log: (m) => logs.push(m),
});

const settle = () => new Promise((r) => setTimeout(r, 10));

function post(port, route, body) {
  return req(port, 'POST', route, JSON.stringify(body));
}
function req(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const r = require('http').request({ port, method, path: route }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const polar = (over) =>
  Object.assign(
    {
      schema: 1,
      model: 'Beneteau Oceanis 48',
      name: 'Jazzy',
      installId: 'aaaaaaaa-1111-2222-3333-444444444444',
      version: '0.7.0',
      points: 480,
      cells: 83,
      bands: 9,
      pol: 'twa/tws\t6\t8\n45\t4.1\t5.0\n',
    },
    over
  );

server.listen(0, async () => {
  const port = server.address().port;
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const exists = (f) => fs.existsSync(path.join(dir, f));

  // ── Une première polaire ────────────────────────────────────────────────
  let r = await post(port, '/v1/polars', polar());
  assert.strictEqual(r.status, 200);
  assert.ok(exists('beneteau-oceanis-48/jazzy.pol'), 'le .pol est écrit sous un chemin lisible');
  assert.ok(exists('beneteau-oceanis-48/jazzy.json'), 'le brut aussi');
  await settle();
  assert.strictEqual(notified.length, 1, 'une notification pour une nouvelle polaire');
  assert.match(notified[0].title, /^New polar/);
  assert.match(notified[0].body, /480 points/);
  assert.strictEqual(notified[0].auth, 'Bearer tk_test', 'le jeton part bien');

  // ── Le même bateau renvoie : ça remplace, sans re-notifier ──────────────
  // Deux envois à dix minutes d'intervalle, c'est quelqu'un qui essaie le
  // bouton « send now ». La polaire est gardée, on n'en parle pas deux fois.
  notified.length = 0;
  r = await post(port, '/v1/polars', polar({ points: 900, pol: 'nouvelle\n' }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(read('beneteau-oceanis-48/jazzy.pol'), 'nouvelle\n', 'la polaire est remplacée');
  assert.strictEqual(
    fs.readdirSync(path.join(dir, 'beneteau-oceanis-48')).length,
    2,
    'un seul couple de fichiers : pas d\'historique de brouillons'
  );
  await settle();
  assert.strictEqual(notified.length, 0, 'mais pas de seconde notification dans la foulée');

  // ── L'homonyme : le cœur du sujet ───────────────────────────────────────
  // Un autre Oceanis 48 dont le propriétaire a aussi écrit « Jazzy » ne doit
  // pas écraser la polaire du premier — c'est ce que le nom seul ne pouvait
  // pas garantir.
  r = await post(port, '/v1/polars', polar({ installId: 'bbbbbbbb-9999-8888-7777-666666666666', pol: 'autre\n', points: 12 }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(read('beneteau-oceanis-48/jazzy.pol'), 'nouvelle\n', 'le premier est intact');
  const others = fs.readdirSync(path.join(dir, 'beneteau-oceanis-48')).filter((f) => /^jazzy-/.test(f));
  assert.strictEqual(others.length, 2, 'le second est rangé à côté, sous un suffixe');

  // ── Un bateau renommé déplace sa polaire au lieu d'en semer une ─────────
  r = await post(port, '/v1/polars', polar({ name: 'Anonyme', pol: 'renomme\n' }));
  assert.strictEqual(r.status, 200);
  assert.ok(exists('beneteau-oceanis-48/anonyme.pol'), 'la polaire suit le nouveau nom');
  assert.ok(!exists('beneteau-oceanis-48/jazzy.pol'), "et ne laisse pas d'orphelin derrière elle");

  // ── Compatibilité : les plugins ≤ 0.6.1 n'envoient pas d'identifiant ────
  const legacy = polar({ name: 'Vieux', pol: 'legacy\n' });
  delete legacy.installId;
  r = await post(port, '/v1/polars', legacy);
  assert.strictEqual(r.status, 200, 'un envoi sans identifiant reste accepté');
  assert.strictEqual(read('beneteau-oceanis-48/vieux.pol'), 'legacy\n');

  // ── Refus ───────────────────────────────────────────────────────────────
  assert.strictEqual((await post(port, '/v1/polars', { pol: 'x' })).status, 400, 'sans modèle ni nom : refusé');
  assert.strictEqual((await post(port, '/v1/polars', polar({ pol: null }))).status, 400, 'sans polaire : refusé');
  assert.strictEqual((await req(port, 'GET', '/nawak')).status, 404);

  // ── Le ping ─────────────────────────────────────────────────────────────
  // Il n'exige ni modèle ni nom : c'est tout son intérêt, il compte les
  // installations qui ne partagent pas leur polaire.
  notified.length = 0;
  r = await post(port, '/v1/ping', {
    schema: 1,
    plugin: 'signalk-autopolar',
    installId: 'cccccccc-0000-0000-0000-000000000000',
    version: '0.7.0',
    node: 'v22.5.0',
    signalk: '2.13.0',
    sharing: false,
  });
  assert.strictEqual(r.status, 200);
  await settle();
  assert.strictEqual(notified.length, 1, 'une nouvelle installation est signalée');
  assert.match(notified[0].title, /New install: signalk-autopolar/);
  assert.match(notified[0].body, /sharing a polar: no/);

  // Le lendemain, le même ping ne re-signale rien.
  notified.length = 0;
  await post(port, '/v1/ping', { installId: 'cccccccc-0000-0000-0000-000000000000', version: '0.7.0' });
  await settle();
  assert.strictEqual(notified.length, 0, 'un ping quotidien ne notifie qu\'à la première fois');

  assert.strictEqual((await post(port, '/v1/ping', { version: '0.7.0' })).status, 400, 'sans identifiant : refusé');

  // ── Un deuxième plugin sur le même collecteur ───────────────────────────
  // `signalk-ac42-autopilot` pointe sur la même URL pour l'instant. Les deux
  // comptes ne doivent pas se mélanger : deux plugins peuvent porter le même
  // numéro de version, et « 12 installations » ne voudrait plus rien dire.
  notified.length = 0;
  r = await post(port, '/v1/ping', {
    schema: 1,
    plugin: 'signalk-ac42-autopilot',
    installId: 'eeeeeeee-0000-0000-0000-000000000000',
    version: '1.2.0',
    node: 'v22.5.0',
    signalk: '2.13.0',
  });
  assert.strictEqual(r.status, 200);
  await settle();
  assert.match(notified[0].title, /New install: signalk-ac42-autopilot/, 'la notification dit de quel plugin il s\'agit');

  // ── Le compte ───────────────────────────────────────────────────────────
  const st = (await req(port, 'GET', '/v1/stats')).body;
  assert.strictEqual(st.installs, 4, 'deux bateaux qui partagent, un qui ne fait que pinguer, plus un autre plugin');
  const byPlugin = Object.fromEntries(st.plugins.map((p) => [p.plugin, p]));
  assert.strictEqual(byPlugin['signalk-autopolar'].installs, 3, 'les polaires sont attribuées à autopolar');
  assert.strictEqual(byPlugin['signalk-autopolar'].polars, 2);
  assert.strictEqual(byPlugin['signalk-ac42-autopilot'].installs, 1, 'et le pilote compte pour lui seul');
  assert.strictEqual(byPlugin['signalk-ac42-autopilot'].polars, 0, 'un plugin sans polaire n\'en invente pas');
  assert.deepStrictEqual(byPlugin['signalk-ac42-autopilot'].versions, { '1.2.0': 1 });
  assert.strictEqual(st.polars, 2, 'deux polaires, l\'envoi sans identifiant n\'étant compté nulle part');
  assert.strictEqual(st.active7d, 4);
  assert.strictEqual(st.models[0].model, 'Beneteau Oceanis 48');
  assert.strictEqual(st.models[0].boats, 2);
  // Un compteur public n'a pas besoin des noms de bateaux, et cette route
  // n'est protégée par rien : ils n'y sont pas.
  assert.ok(!JSON.stringify(st).includes('Jazzy'), 'aucun nom de bateau dans les stats publiques');
  assert.ok(!JSON.stringify(st).includes('Anonyme'));

  // ── Un nom accentué ne doit pas faire exploser la notification ──────────
  // C'est le piège des en-têtes ByteString : le titre est fabriqué avec du
  // texte libre venu d'inconnus, donc il finira par contenir un accent, un
  // tiret cadratin ou un emoji.
  notified.length = 0;
  logs.length = 0;
  r = await post(port, '/v1/polars', {
    model: 'Bénéteau Océanis 48 — édition « fête »',
    name: 'Rêve 🌊',
    installId: 'dddddddd-0000-0000-0000-000000000000',
    version: '0.7.0',
    points: 42,
    pol: 'x\n',
  });
  assert.strictEqual(r.status, 200, 'la polaire est acceptée quoi qu\'il arrive');
  await settle();
  assert.strictEqual(notified.length, 1, 'et la notification part quand même');
  assert.match(notified[0].title, /^=\?UTF-8\?B\?/, 'le titre non-ASCII est encodé en RFC 2047');
  assert.strictEqual(
    Buffer.from(notified[0].title.slice(10, -2), 'base64').toString('utf8'),
    'New polar: Bénéteau Océanis 48 — édition « fête »',
    'et se relit correctement'
  );
  assert.match(notified[0].body, /Rêve/, 'le corps, lui, part en UTF-8 sans encodage');
  assert.deepStrictEqual(logs.filter((l) => /ntfy/.test(l)), [], 'aucune erreur ntfy');

  // ── Le registre survit à un redémarrage ─────────────────────────────────
  const { stats: stats2 } = createCollector({ dir, log: () => {} });
  assert.strictEqual(stats2().installs, 5, 'le compte est relu sur disque');

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('collector: ok');
});
