#!/usr/bin/env node
// Vérifie la migration du brut (samples.jsonl → un fichier par mois) sur une
// COPIE du dossier de données, avant de la laisser tourner à bord.
//
//   cp -a ~/.signalk/plugin-config-data/signalk-autopolar /tmp/autopolar-copy
//   node tool/verify-raw-split.js /tmp/autopolar-copy
//
// Refuse de toucher au vrai dossier de SignalK. Mesure et compare :
//   0. si le dépôt a le tag v1.4.0 : le rejeu par le code de la 1.4.0 lui-même,
//      la référence (points, durée, pic mémoire, blocage de la boucle) ;
//   1. le rejeu du fichier unique par le nouveau code, avant migration ;
//   2. la lecture à l'ancienne (readFileSync du fichier entier), pour mémoire ;
//   3. la migration elle-même : durée, plus long blocage de la boucle
//      d'événements pendant qu'elle tourne, lignes avant et après ;
//   4. le texte exporté après migration, octet pour octet, contre les lignes
//      valides du fichier d'origine ;
//   5. le rejeu après migration : mêmes points, même nombre.
//
// Chaque rejeu tourne dans un processus à part, pour que le pic mémoire
// mesuré soit le sien et pas celui de l'outil.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { performance, monitorEventLoopDelay } = require('perf_hooks');

// AUTOPOLAR_ROOT : rejouer avec une autre version du plugin (la 1.4.0).
const ROOT = process.env.AUTOPOLAR_ROOT || path.join(__dirname, '..');
const mode = process.argv[2];

// ── Rejeu complet par le plugin, dans un processus fils ─────────────────────
async function childReplay(dir, out, noMaintenance) {
  if (noMaintenance) {
    // Lire le fichier unique tel quel, sans laisser la migration démarrer.
    const S = require(path.join(ROOT, 'lib/samples'));
    const orig = S.createSampleLog;
    S.createSampleLog = (d, o) => Object.assign(orig(d, o), { load() {} });
  }
  global.fetch = async () => {
    throw new Error('no network in verification');
  };
  const app = {
    getDataDirPath: () => dir,
    setPluginStatus() {},
    setPluginError() {},
    debug() {},
    error: (m) => process.stderr.write(String(m) + '\n'),
    getSelfPath: () => null,
    readPluginOptions: () => ({}),
    savePluginOptions: (c, cb) => cb && cb(null),
  };
  const plugin = require(path.join(ROOT, 'index.js'))(app);
  const config = process.env.AUTOPOLAR_CONFIG ? JSON.parse(fs.readFileSync(process.env.AUTOPOLAR_CONFIG, 'utf8')).configuration || {} : {};
  plugin.start(Object.assign({}, config, { usageStats: false, checkForUpdates: false, sharePolar: false }));
  const routes = {};
  plugin.registerWithRouter({ get: (p, h) => (routes['GET ' + p] = h), post: (p, h) => (routes['POST ' + p] = h) });
  // La boucle d'événements pendant le rejeu : en 1.4.0 il était synchrone de
  // bout en bout, et l'alarme de mouillage attendait qu'il finisse.
  // Mesuré par un battement de 10 ms lancé AVANT le rejeu : un histogramme
  // de délai ne voit pas un blocage qui commence avant son premier tour.
  let maxLag = 0;
  let lastBeat = performance.now();
  const beat = setInterval(() => {
    const t = performance.now();
    maxLag = Math.max(maxLag, t - lastBeat - 10);
    lastBeat = t;
  }, 10);
  await new Promise((r) => setTimeout(r, 50));
  const t0 = performance.now();
  const res = await new Promise((resolve) => routes['POST /api/rebuild']({ body: { dryRun: false } }, { json: resolve }));
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 50));
  clearInterval(beat);
  fs.copyFileSync(path.join(dir, 'runs.jsonl'), out);
  plugin.stop();
  process.stdout.write(
    JSON.stringify({ count: res.count, ms, maxRssMB: process.resourceUsage().maxRSS / 1024, maxLagMs: maxLag }) + '\n'
  );
  process.exit(0);
}

// La lecture telle que la faisait la 1.4.0 : tout le fichier dans une chaîne.
function childOldRead(file) {
  const t0 = performance.now();
  const data = fs.readFileSync(file, 'utf8');
  const recs = [];
  let start = 0;
  while (start < data.length) {
    let end = data.indexOf('\n', start);
    if (end === -1) end = data.length;
    const line = data.slice(start, end);
    start = end + 1;
    if (!line) continue;
    try {
      recs.push(JSON.parse(line));
    } catch (e) {
      /* ligne tronquée */
    }
  }
  process.stdout.write(JSON.stringify({ count: recs.length, ms: performance.now() - t0, maxRssMB: process.resourceUsage().maxRSS / 1024 }) + '\n');
}

// La lecture nouvelle, seule, gardant les lignes comme le fait rebuild().
async function childNewRead(dir) {
  const { createSampleLog } = require(path.join(ROOT, 'lib/samples'));
  const t0 = performance.now();
  const recs = [];
  await createSampleLog(dir).each((s) => recs.push(s));
  process.stdout.write(JSON.stringify({ count: recs.length, ms: performance.now() - t0, maxRssMB: process.resourceUsage().maxRSS / 1024 }) + '\n');
}

function child(args, env) {
  const r = spawnSync(process.execPath, [__filename, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
    maxBuffer: 1 << 26,
  });
  if (r.status !== 0) throw new Error(`child ${args[0]} failed: ${r.stderr}`);
  if (r.stderr.trim()) process.stderr.write(r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const mb = (n) => (n / 1048576).toFixed(1);
const dirSize = (dir, re) =>
  fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);

async function main(dir) {
  const real = fs.realpathSync(dir);
  const live = path.join(os.homedir(), '.signalk');
  if (fs.existsSync(live)) {
    const lr = fs.realpathSync(live);
    if (real === lr || real.startsWith(lr + path.sep)) {
      throw new Error(`${real} is inside ~/.signalk — work on a copy, never on the live data`);
    }
  }
  const legacy = path.join(real, 'samples.jsonl');
  if (!fs.existsSync(legacy)) throw new Error(`no samples.jsonl in ${real}`);
  if (fs.readdirSync(real).some((f) => /^samples-/.test(f))) throw new Error('monthly files already present: start from a fresh copy');

  // Lignes valides du fichier d'origine, comptées comme le faisait la 1.4.0.
  const before = { bytes: fs.statSync(legacy).size, valid: 0, bad: 0 };
  const validText = [];
  for (const line of fs.readFileSync(legacy, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      JSON.parse(line);
      before.valid++;
      validText.push(line);
    } catch (e) {
      before.bad++;
    }
  }
  console.log(`samples.jsonl: ${mb(before.bytes)} MB, ${before.valid} valid lines, ${before.bad} truncated`);

  const outBefore = path.join(real, 'runs-before-migration.jsonl');
  const outAfter = path.join(real, 'runs-after-migration.jsonl');
  const out140 = path.join(real, 'runs-1.4.0.jsonl');
  const replayLine = (r) =>
    `${r.count} points, ${r.ms.toFixed(0)} ms, peak RSS ${r.maxRssMB.toFixed(0)} MB, event loop blocked up to ${r.maxLagMs.toFixed(0)} ms`;

  // La référence : le code de la 1.4.0, extrait du dépôt dans un dossier
  // temporaire. Sans git ou sans le tag, on s'en passe et on le dit.
  let ref = null;
  const v140 = fs.mkdtempSync(path.join(os.tmpdir(), 'autopolar-1.4.0-'));
  const x = spawnSync('sh', ['-c', `git -C "${path.join(__dirname, '..')}" archive v1.4.0 | tar -x -C "${v140}"`], { encoding: 'utf8' });
  if (x.status === 0 && fs.existsSync(path.join(v140, 'index.js'))) {
    ref = child(['replay', real, out140], { AUTOPOLAR_ROOT: v140 });
    console.log(`replay by the 1.4.0 code: ${replayLine(ref)}`);
  } else {
    console.log('(no v1.4.0 tag in this checkout: skipping the comparison with the 1.4.0 code)');
  }
  fs.rmSync(v140, { recursive: true, force: true });

  const oldRead = child(['old-read', legacy]);
  console.log(`1.4.0 read (whole file in memory): ${oldRead.count} lines, ${oldRead.ms.toFixed(0)} ms, peak RSS ${oldRead.maxRssMB.toFixed(0)} MB`);
  const replayBefore = child(['replay', real, outBefore, 'no-maintenance']);
  console.log(`replay before migration: ${replayLine(replayBefore)}`);

  // La migration, dans ce processus, avec un œil sur la boucle d'événements :
  // c'est elle qui fait tourner l'alarme de mouillage à bord.
  const { createSampleLog } = require(path.join(ROOT, 'lib/samples'));
  const logs = [];
  const log = createSampleLog(real, { log: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) });
  const eld = monitorEventLoopDelay({ resolution: 10 });
  let ticks = 0;
  const beat = setInterval(() => ticks++, 100);
  eld.enable();
  const t0 = performance.now();
  log.load();
  await log.idle();
  const migMs = performance.now() - t0;
  eld.disable();
  clearInterval(beat);
  for (const m of logs) console.log('  ' + m);
  const info = log.info();
  assert.ok(info.migration && !info.migration.error, `migration failed: ${JSON.stringify(info.migration)}`);
  const afterBytes = dirSize(real, /^samples-\d{4}-\d{2}\.jsonl(\.gz)?$/);
  console.log(
    `migration: ${migMs.toFixed(0)} ms, ${info.migration.lines} lines (${info.migration.months.join(', ')}), ` +
      `${mb(before.bytes)} MB → ${mb(afterBytes)} MB on disk; event loop: max delay ${(eld.max / 1e6).toFixed(0)} ms, ` +
      `p99 ${(eld.percentile(99) / 1e6).toFixed(0)} ms, ${ticks} of ~${Math.floor(migMs / 100)} 100-ms timers fired`
  );
  assert.strictEqual(info.migration.lines, before.valid, 'same number of lines before and after');
  assert.ok(!fs.existsSync(legacy), 'samples.jsonl removed once verified');

  // Octet pour octet : l'export du brut migré = les lignes valides d'origine.
  const chunks = [];
  for await (const c of log.stream()) chunks.push(c);
  const exported = Buffer.concat(chunks).toString('utf8');
  assert.strictEqual(exported, validText.join('\n') + '\n', 'exported text differs from the original valid lines');
  console.log(`export after migration: identical to the original valid lines (${mb(exported.length)} MB)`);

  const newRead = child(['new-read', real]);
  console.log(`streamed read keeping every line (worst case, rebuild() no longer does): ${newRead.count} lines, ${newRead.ms.toFixed(0)} ms, peak RSS ${newRead.maxRssMB.toFixed(0)} MB`);
  const replayAfter = child(['replay', real, outAfter]);
  console.log(`replay after migration: ${replayLine(replayAfter)}`);

  const a = fs.readFileSync(outBefore, 'utf8');
  const b = fs.readFileSync(outAfter, 'utf8');
  assert.strictEqual(replayAfter.count, replayBefore.count, 'same number of points');
  assert.strictEqual(b, a, 'replayed points differ');
  console.log(`points: identical before and after (${replayAfter.count})`);
  if (ref) {
    assert.strictEqual(fs.readFileSync(out140, 'utf8'), b, 'points differ from the 1.4.0 replay');
    console.log('points: identical to the 1.4.0 replay, byte for byte');
  }
  console.log('OK');
}

if (mode === 'replay') childReplay(process.argv[3], process.argv[4], process.argv[5] === 'no-maintenance');
else if (mode === 'old-read') childOldRead(process.argv[3]);
else if (mode === 'new-read') childNewRead(process.argv[3]);
else if (!mode) {
  console.error('usage: node tool/verify-raw-split.js <copy of the data directory>');
  process.exit(2);
} else
  main(mode).catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
