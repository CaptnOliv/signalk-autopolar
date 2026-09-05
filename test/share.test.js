// Le reversement de la polaire : quand il part, quand il ne part pas, et ce
// qui se passe quand le réseau n'est pas là. C'est la seule fonction du
// plugin qui fait sortir des données du bateau — elle mérite d'être tenue.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createShare, isDue, RETRY_MS } = require('../lib/share');

// ── La règle de déclenchement, nue ─────────────────────────────────────────
const st = { lastCount: 500, lastTry: 0 };
assert.strictEqual(isDue(st, 999, 500, 1e9), false, 'sous le palier : rien ne part');
assert.strictEqual(isDue(st, 1000, 500, 1e9), true, 'palier atteint : ça part');
assert.strictEqual(isDue(st, 1000, 0, 1e9), false, 'palier à 0 = partage désactivé');
const failed = { lastCount: 500, lastTry: 1e9, lastError: 'ENETUNREACH' };
assert.strictEqual(isDue(failed, 1000, 500, 1e9 + 1000), false, 'après un échec, on ne martèle pas un lien mort');
assert.strictEqual(
  isDue(failed, 1000, 500, 1e9 + RETRY_MS + 1),
  true,
  'après le délai de reprise, la tentative revient d\'elle-même'
);
assert.strictEqual(
  isDue({ lastCount: 500, lastTry: 1e9 }, 1000, 500, 1e9 + 1000),
  true,
  'le délai ne bride pas deux paliers atteints coup sur coup'
);

// ── Le vrai objet, avec un réseau bouchonné ────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-test-'));
const file = path.join(dir, 'share.json');
const OPTS = {
  sharePolar: true,
  shareEndpoint: 'https://collector.test/v1/polars',
  shareEveryPoints: 500,
  boatModel: 'Test 40',
  shareName: 'test',
};
let posts = [];
let fail = false;
global.fetch = async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) });
  if (fail) throw new Error('ENETUNREACH');
  return { ok: true, status: 200 };
};
const settle = () => new Promise((r) => setImmediate(r));
const payload = () => ({ schema: 1, model: 'Test 40', pol: 'x' });

(async () => {
  const s = createShare(file, () => {});
  assert.strictEqual(s.maybeSend(OPTS, 499, payload), false, '499 points : trop tôt');
  assert.strictEqual(posts.length, 0);

  s.maybeSend(OPTS, 500, payload);
  await settle();
  assert.strictEqual(posts.length, 1, 'un envoi au premier palier');
  assert.strictEqual(posts[0].url, OPTS.shareEndpoint);
  assert.strictEqual(posts[0].body.model, 'Test 40');
  assert.strictEqual(s.state().lastCount, 500);

  // Le palier suivant est calé sur ce qui est vraiment parti, pas sur
  // l'horloge : entre les deux, la boucle appelle maybeSend à chaque seconde
  // et ne doit rien faire.
  for (let i = 501; i < 1000; i += 37) s.maybeSend(OPTS, i, payload);
  await settle();
  assert.strictEqual(posts.length, 1, 'rien entre deux paliers');

  // ── Réseau coupé : l'envoi n'est pas perdu, il est retenté ───────────────
  fail = true;
  s.maybeSend(OPTS, 1000, payload);
  await settle();
  assert.strictEqual(posts.length, 2, 'tentative au deuxième palier');
  assert.strictEqual(s.state().lastCount, 500, 'un échec ne fait pas avancer le palier');
  assert.ok(s.state().lastError, "l'échec est retenu et visible");

  s.maybeSend(OPTS, 1200, payload);
  await settle();
  assert.strictEqual(posts.length, 2, 'on ne martèle pas : une tentative par période');

  // ── Consentement et identité ────────────────────────────────────────────
  fail = false;
  posts = [];
  const off = createShare(path.join(dir, 'off.json'), () => {});
  assert.strictEqual(off.maybeSend(Object.assign({}, OPTS, { sharePolar: false }), 5000, payload), false);
  assert.strictEqual(off.maybeSend(Object.assign({}, OPTS, { boatModel: '' }), 5000, payload), false);
  assert.strictEqual(off.maybeSend(Object.assign({}, OPTS, { shareEndpoint: '' }), 5000, payload), false);
  await settle();
  assert.strictEqual(posts.length, 0, 'sans consentement ni identité, rien ne sort du bateau');

  // ── « Envoyer maintenant » ──────────────────────────────────────────────
  // Sert au premier envoi quand on vient d'activer le partage, donc il doit
  // franchir à la fois le palier et le délai de reprise.
  const s2 = createShare(path.join(dir, 'now.json'), () => {});
  s2.force();
  s2.maybeSend(OPTS, 12, payload);
  await settle();
  assert.strictEqual(posts.length, 1, 'envoi forcé même sous le palier');

  // ── L'état survit à un redémarrage ──────────────────────────────────────
  const reopened = createShare(file, () => {});
  assert.strictEqual(reopened.state().lastCount, 500, 'le palier est relu sur disque');

  console.log('share: ok');
})();
