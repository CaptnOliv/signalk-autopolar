// Le journal brut découpé par mois (lib/samples.js) : écriture à cheval sur
// deux mois, lecture mêlant gzip et clair, migration de l'ancien fichier
// unique, migration tuée en plein travail puis relancée, ligne tronquée,
// plafond. Aucun réseau ; tout se passe dans un dossier temporaire.
//
// Le test de coupure est le seul qui compte vraiment, et il ne se simule pas
// avec un `throw` : on lance la migration dans un processus fils et on le tue
// (SIGKILL, comme une coupure au tableau) à des instants différents, jusqu'à
// ce qu'elle ait abouti. Puis on vérifie, ligne à ligne, que rien n'a été
// perdu ni dupliqué.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { createSampleLog, monthOf } = require('../lib/samples');

// ── Processus fils : une migration, rien d'autre ───────────────────────────
if (process.argv[2] === 'child') {
  const fake = Number(process.env.FAKE_NOW);
  Date.now = () => fake;
  // Coupure au pire moment : juste après le n-ième renommage, c'est-à-dire
  // marqueur posé et commit à moitié appliqué.
  const crashAt = Number(process.env.CRASH_AT_RENAME || 0);
  if (crashAt) {
    const rename = fs.renameSync;
    let n = 0;
    fs.renameSync = (...a) => {
      rename(...a);
      if (++n === crashAt) process.kill(process.pid, 'SIGKILL');
    };
  }
  const log = createSampleLog(process.argv[3]);
  log.load();
  log.idle().then(() => process.stdout.write('done\n'));
  return;
}

const realNow = Date.now;
let now = Date.parse('2026-10-12T12:00:00Z');
Date.now = () => now;

const tmpDirs = [];
function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autopolar-samples-'));
  tmpDirs.push(d);
  return d;
}
const ls = (d) => fs.readdirSync(d).sort();
const sample = (t, extra) => Object.assign({ t, sog: 5.1, stw: 5, awa: 40, aws: 12, twa: 50, tws: 9, hdg: 180 }, extra);

async function readAll(log) {
  const out = [];
  const n = await log.each((s) => out.push(s));
  assert.strictEqual(n, out.length);
  return out;
}

async function streamText(log) {
  const chunks = [];
  for await (const c of log.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Un ancien samples.jsonl : `days` jours d'une heure de nav chacun, un jour
// tous les `step` jours à partir de `from`, plus une ligne tronquée au milieu
// et une en fin de fichier.
function legacyFile(dir, from, days, step, perDay = 3600) {
  const lines = [];
  for (let d = 0; d < days; d++) {
    const t0 = from + d * step * 86400000;
    for (let i = 0; i < perDay; i++) lines.push(JSON.stringify(sample(t0 + i * 1000, { i })));
  }
  const half = Math.floor(lines.length / 2);
  const text = lines.slice(0, half).join('\n') + '\n{"t":17,"sog":4.' + '\n' + lines.slice(half).join('\n') + '\n{"t":1790000000000,"so';
  fs.writeFileSync(path.join(dir, 'samples.jsonl'), text);
  return lines;
}

async function main() {
  // ── 1. Écriture à cheval sur un changement de mois ──────────────────────
  {
    const dir = freshDir();
    now = Date.parse('2026-09-30T23:59:58Z');
    const log = createSampleLog(dir);
    log.load();
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(log.append(sample(now)), true);
      now += 1000;
    }
    await log.idle();
    // Le nom vient du `t` de chaque ligne : deux lignes en septembre, deux en
    // octobre — et septembre vient de se clore, il est déjà compressé.
    assert.deepStrictEqual(ls(dir), ['samples-2026-09.jsonl.gz', 'samples-2026-10.jsonl']);
    const back = await readAll(log);
    assert.deepStrictEqual(
      back.map((s) => s.t),
      [0, 1, 2, 3].map((k) => Date.parse('2026-09-30T23:59:58Z') + k * 1000),
      'les quatre lignes, dans l’ordre'
    );
    // Une ligne horodatée en septembre mais écrite en octobre (horloge qui
    // saute) va dans le fichier de septembre, et sera fondue dans son .gz.
    log.append(sample(Date.parse('2026-09-15T00:00:00Z')));
    assert.ok(fs.existsSync(path.join(dir, 'samples-2026-09.jsonl')));
    log.load();
    await log.idle();
    assert.deepStrictEqual(ls(dir), ['samples-2026-09.jsonl.gz', 'samples-2026-10.jsonl']);
    assert.strictEqual((await readAll(log)).length, 5);
    // Le .gz est fait de deux membres concaténés : gunzip les lit tous.
    const sept = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'samples-2026-09.jsonl.gz'))).toString().trim().split('\n');
    assert.strictEqual(sept.length, 3);
    assert.strictEqual(monthOf(Date.parse('2026-12-31T23:59:59.999Z')), '2026-12');
    assert.strictEqual(monthOf('nope'), null);
  }

  // ── 2. Lecture mêlant gzip et clair, dans l'ordre ───────────────────────
  {
    const dir = freshDir();
    const t = (s) => Date.parse(s);
    const gz = (name, recs) =>
      fs.writeFileSync(path.join(dir, name), zlib.gzipSync(recs.map((r) => JSON.stringify(r) + '\n').join('')));
    const plain = (name, recs) => fs.writeFileSync(path.join(dir, name), recs.map((r) => JSON.stringify(r) + '\n').join(''));
    gz('samples-2026-07.jsonl.gz', [sample(t('2026-07-01T00:00:00Z')), sample(t('2026-07-02T00:00:00Z'))]);
    plain('samples-2026-08.jsonl', [sample(t('2026-08-01T00:00:00Z'))]);
    gz('samples-2026-10.jsonl.gz', [sample(t('2026-10-01T00:00:00Z'))]);
    plain('samples-2026-10.jsonl', [sample(t('2026-10-05T00:00:00Z'))]);
    gz('samples-2026-06.jsonl.gz', [sample(t('2026-06-01T00:00:00Z'))]);
    now = t('2026-10-12T12:00:00Z');
    const log = createSampleLog(dir, { maxBytes: 1e9 });
    // Sans load() : aucune compression, on lit les fichiers tels quels.
    const order = (await readAll(log)).map((s) => new Date(s.t).toISOString().slice(0, 10));
    assert.deepStrictEqual(order, ['2026-06-01', '2026-07-01', '2026-07-02', '2026-08-01', '2026-10-01', '2026-10-05']);
    // L'export rend le même texte, décompressé, bout à bout.
    const text = await streamText(log);
    assert.deepStrictEqual(
      text.trim().split('\n').map((l) => new Date(JSON.parse(l).t).toISOString().slice(0, 10)),
      order
    );
    // Puis load() : août est clos, il se compresse ; octobre reste tel quel.
    log.load();
    await log.idle();
    assert.deepStrictEqual(ls(dir), [
      'samples-2026-06.jsonl.gz',
      'samples-2026-07.jsonl.gz',
      'samples-2026-08.jsonl.gz',
      'samples-2026-10.jsonl',
      'samples-2026-10.jsonl.gz',
    ]);
    assert.deepStrictEqual((await readAll(log)).map((s) => new Date(s.t).toISOString().slice(0, 10)), order);
    // La taille annoncée est celle du disque, pas celle décompressée.
    const onDisk = ls(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    assert.strictEqual(log.info().bytes, onDisk);
  }

  // ── 3. Ligne tronquée ────────────────────────────────────────────────────
  {
    const dir = freshDir();
    now = Date.parse('2026-10-12T12:00:00Z');
    const f = path.join(dir, 'samples-2026-10.jsonl');
    fs.writeFileSync(f, JSON.stringify(sample(now)) + '\n' + '{"t":' + now + ',"sog":5.');
    const log = createSampleLog(dir);
    log.load();
    // La coupure a laissé une ligne sans fin : load() la referme, sinon la
    // prochaine écriture s'y collerait et serait perdue avec elle.
    log.append(sample(now + 1000));
    const back = await readAll(log);
    assert.deepStrictEqual(back.map((s) => s.t), [now, now + 1000], 'la ligne tronquée est ignorée, la suivante survit');
    await log.idle();
  }

  // ── 4. Migration d'un fichier unique ─────────────────────────────────────
  {
    const dir = freshDir();
    now = Date.parse('2026-10-12T12:00:00Z');
    const lines = legacyFile(dir, Date.parse('2026-08-25T10:00:00Z'), 6, 9, 600);
    const before = fs.readFileSync(path.join(dir, 'samples.jsonl'), 'utf8');
    const logs = [];
    const log = createSampleLog(dir, { log: (m) => logs.push(m) });
    log.load();
    // Pendant la migration, le brut continue de s'écrire, dans le clair du
    // mois — et une lecture voit tout, ancien fichier compris.
    log.append(sample(now, { live: true }));
    assert.strictEqual((await readAll(log)).length, lines.length + 1);
    await log.idle();
    assert.deepStrictEqual(ls(dir), [
      'samples-2026-08.jsonl.gz',
      'samples-2026-09.jsonl.gz',
      'samples-2026-10.jsonl',
      'samples-2026-10.jsonl.gz',
    ]);
    const info = log.info();
    assert.strictEqual(info.migration.lines, lines.length, 'même nombre de lignes avant et après');
    assert.strictEqual(info.migration.skipped, 2, 'les deux lignes tronquées sont comptées, pas recopiées');
    assert.ok(logs.some((m) => /split into 3 monthly/.test(m)), logs.join('\n'));
    const back = await readAll(log);
    assert.strictEqual(back.length, lines.length + 1);
    // Mêmes lignes, même ordre, octet pour octet : l'export d'aujourd'hui est
    // l'ancien fichier sans ses lignes tronquées, suivi de ce qui s'est écrit.
    const text = await streamText(log);
    assert.strictEqual(text, lines.join('\n') + '\n' + JSON.stringify(sample(now, { live: true })) + '\n');
    assert.ok(before.length > text.length - 200, 'sanity');
  }

  // ── 5. Migration tuée en plein travail, relancée, plusieurs fois ─────────
  {
    const dir = freshDir();
    const fakeNow = Date.parse('2026-10-12T12:00:00Z');
    // Assez gros pour que la migration dure : ~60 000 lignes, ~9 Mo.
    const lines = legacyFile(dir, Date.parse('2026-07-20T08:00:00Z'), 30, 3, 2000);
    const runChild = (killAfterMs) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [__filename, 'child', dir], {
          env: Object.assign({}, process.env, { FAKE_NOW: String(fakeNow), CRASH_AT_RENAME: '' }),
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        const timer = killAfterMs != null ? setTimeout(() => child.kill('SIGKILL'), killAfterMs) : null;
        child.on('exit', () => {
          if (timer) clearTimeout(timer);
          resolve(out.includes('done'));
        });
      });
    let kills = 0;
    let finished = false;
    for (const ms of [40, 90, 150, 220, 300, 380, 470, 560, 680, 800]) {
      if (!fs.existsSync(path.join(dir, 'samples.jsonl'))) break;
      if (await runChild(ms)) {
        finished = true;
        break;
      }
      kills++;
    }
    if (!finished) await runChild(null);
    assert.ok(!fs.existsSync(path.join(dir, 'samples.jsonl')), 'la migration finit par aboutir');
    assert.ok(kills > 0, 'au moins une coupure a eu lieu en cours de route');
    now = fakeNow;
    const log = createSampleLog(dir);
    log.load();
    await log.idle();
    assert.ok(!ls(dir).some((f) => /tmp|commit/.test(f)), `plus aucun fichier de travail : ${ls(dir).join(', ')}`);
    const text = await streamText(log);
    assert.strictEqual(text, lines.join('\n') + '\n', `ni perte ni doublon après ${kills} coupure(s)`);
  }

  // ── 5 bis. Coupure en plein commit ───────────────────────────────────────
  // Le commit d'une migration renomme d'abord le marqueur, puis chaque mois.
  // On tue le processus après le 1er, le 2e, puis le 3e renommage : à chaque
  // fois, le démarrage suivant doit finir le travail, sans perte ni doublon.
  for (const crashAt of [1, 2, 3]) {
    const dir = freshDir();
    const fakeNow = Date.parse('2026-10-12T12:00:00Z');
    const lines = legacyFile(dir, Date.parse('2026-08-10T08:00:00Z'), 8, 9, 300);
    const crashed = await new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, 'child', dir], {
        env: Object.assign({}, process.env, { FAKE_NOW: String(fakeNow), CRASH_AT_RENAME: String(crashAt) }),
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      child.on('exit', (code, sig) => resolve(sig === 'SIGKILL'));
    });
    assert.ok(crashed, `le processus a bien été tué au renommage ${crashAt}`);
    assert.ok(fs.existsSync(path.join(dir, 'samples-commit.json')), 'le marqueur est resté sur disque');
    now = fakeNow;
    const log = createSampleLog(dir);
    log.load();
    await log.idle();
    assert.deepStrictEqual(ls(dir), ['samples-2026-08.jsonl.gz', 'samples-2026-09.jsonl.gz', 'samples-2026-10.jsonl.gz']);
    assert.strictEqual(await streamText(log), lines.join('\n') + '\n', `coupure au renommage ${crashAt} : ni perte ni doublon`);
  }

  // ── 6. Coupure à chaque étape du commit, simulée sur disque ─────────────
  {
    // Les .tmp d'un travail interrompu avant son commit sont jetés ; un
    // samples-commit.json resté là est rejoué jusqu'au bout.
    const dir = freshDir();
    now = Date.parse('2026-10-12T12:00:00Z');
    const t = Date.parse('2026-09-03T10:00:00Z');
    const lines = [0, 1, 2].map((i) => JSON.stringify(sample(t + i * 1000)));
    fs.writeFileSync(path.join(dir, 'samples-2026-09.jsonl'), lines.join('\n') + '\n');
    // État 1 : un .tmp orphelin et un marqueur à moitié écrit.
    fs.writeFileSync(path.join(dir, 'samples-2026-09.ab12cd34.part.tmp'), 'garbage');
    fs.writeFileSync(path.join(dir, 'samples-commit.json.tmp'), '{"op":"compre');
    // État 2 : le marqueur posé, le renommage fait, la suppression du clair
    // pas encore — c'est le seul instant où les données existent en double.
    fs.writeFileSync(path.join(dir, 'samples-2026-08.jsonl.gz'), zlib.gzipSync(JSON.stringify(sample(t - 30 * 86400000)) + '\n'));
    fs.writeFileSync(path.join(dir, 'samples-2026-08.jsonl'), 'déjà dans le .gz\n');
    fs.writeFileSync(
      path.join(dir, 'samples-commit.json'),
      JSON.stringify({
        op: 'compression',
        renames: [['samples-2026-08.ffff0000.part.tmp', 'samples-2026-08.jsonl.gz']],
        deletes: ['samples-2026-08.jsonl', 'samples-2026-08.ffff0000.part.tmp'],
      })
    );
    const log = createSampleLog(dir);
    log.load();
    await log.idle();
    assert.deepStrictEqual(ls(dir), ['samples-2026-08.jsonl.gz', 'samples-2026-09.jsonl.gz']);
    assert.strictEqual((await readAll(log)).length, 4, 'août une fois, septembre une fois');

    // Garde-fou : un marqueur dont la destination a disparu ne supprime rien.
    const dir2 = freshDir();
    fs.writeFileSync(path.join(dir2, 'samples.jsonl'), lines.join('\n') + '\n');
    fs.writeFileSync(
      path.join(dir2, 'samples-commit.json'),
      JSON.stringify({ op: 'migration', renames: [['gone.tmp', 'samples-2026-09.jsonl.gz']], deletes: ['samples.jsonl'] })
    );
    const warned = [];
    const log2 = createSampleLog(dir2, { warn: (m) => warned.push(m) });
    log2.load();
    await log2.idle();
    assert.ok(fs.existsSync(path.join(dir2, 'samples.jsonl')), "l'original n'est pas supprimé");
    assert.ok(warned.some((m) => /nothing deleted/.test(m)), warned.join('\n'));
    assert.strictEqual((await readAll(log2)).length, 3, 'et il reste lisible');
  }

  // ── 7. Plafond atteint ───────────────────────────────────────────────────
  {
    // Par défaut : l'écriture s'arrête, et on le dit.
    const dir = freshDir();
    now = Date.parse('2026-10-12T12:00:00Z');
    const warned = [];
    const log = createSampleLog(dir, { maxBytes: 2000, warn: (m) => warned.push(m) });
    log.load();
    let written = 0;
    while (log.append(sample(now + written * 1000))) written++;
    assert.ok(written > 5 && written < 30, `${written} lignes avant le plafond`);
    assert.strictEqual(log.info().full, true);
    assert.strictEqual(log.append(sample(now)), false, 'plus rien ne s’écrit');
    assert.strictEqual(warned.filter((m) => /raw log full/.test(m)).length, 1, 'annoncé une fois, pas à chaque seconde');
    // Rien n'est supprimé sans l'option.
    now = Date.parse('2026-11-02T00:00:00Z');
    log.append(sample(now));
    await log.idle();
    assert.strictEqual((await readAll(log)).length, written, 'rien de supprimé');
    // La compression du mois clos a libéré de la place : l'écriture reprend.
    assert.ok(log.info().bytes < 2000, `${log.info().bytes} octets après compression`);
    assert.strictEqual(log.info().full, false);
    assert.strictEqual(log.append(sample(now + 1000)), true, 'l’écriture reprend une fois la place libérée');
    await log.idle();
  }
  {
    // Sur option : les mois clos les plus anciens partent, jamais le courant.
    const dir = freshDir();
    now = Date.parse('2026-10-12T12:00:00Z');
    const gz = (m, n) =>
      fs.writeFileSync(
        path.join(dir, `samples-${m}.jsonl.gz`),
        zlib.gzipSync(
          Array.from({ length: n }, (_, i) => JSON.stringify(sample(Date.parse(`${m}-02T00:00:00Z`) + i * 1000, { r: Math.random() }))).join('\n') + '\n',
          { level: 0 }
        )
      );
    gz('2026-07', 40);
    gz('2026-08', 40);
    gz('2026-09', 40);
    const size = (m) => fs.statSync(path.join(dir, `samples-${m}.jsonl.gz`)).size;
    const max = size('2026-07') + size('2026-08') + size('2026-09') + 500;
    const warned = [];
    const log = createSampleLog(dir, { maxBytes: max, dropOldest: true, warn: (m) => warned.push(m) });
    log.load();
    let i = 0;
    while (log.info().bytes < max) assert.strictEqual(log.append(sample(now + i++ * 1000)), true);
    // Au-dessus du plafond, on continue d'écrire : la place se libère en
    // tâche de fond, juillet part.
    assert.strictEqual(log.append(sample(now + i++ * 1000)), true);
    await log.idle();
    assert.deepStrictEqual(ls(dir), ['samples-2026-08.jsonl.gz', 'samples-2026-09.jsonl.gz', 'samples-2026-10.jsonl']);
    assert.deepStrictEqual(log.info().dropped, ['2026-07']);
    assert.ok(warned.some((m) => /deleted 2026-07/.test(m)), 'chaque suppression est annoncée');
    // Le mois courant seul au-dessus du plafond : il n'est jamais supprimé,
    // l'écriture s'arrête.
    const dir2 = freshDir();
    const log2 = createSampleLog(dir2, { maxBytes: 1500, dropOldest: true, warn: () => {} });
    log2.load();
    let k = 0;
    while (log2.append(sample(now + k * 1000)) && k < 1000) {
      k++;
      if (k % 5 === 0) await log2.idle();
    }
    await log2.idle();
    assert.strictEqual(log2.info().full, true);
    assert.deepStrictEqual(ls(dir2), ['samples-2026-10.jsonl']);
    assert.strictEqual((await readAll(log2)).length, k);
  }

  // ── 8. Remise à zéro ─────────────────────────────────────────────────────
  {
    const dir = freshDir();
    now = Date.parse('2026-10-12T12:00:00Z');
    legacyFile(dir, Date.parse('2026-08-25T10:00:00Z'), 4, 9, 2000);
    fs.writeFileSync(path.join(dir, 'runs.jsonl'), '{}\n');
    const log = createSampleLog(dir);
    log.load();
    // En pleine migration : le travail de fond abandonne, rien ne revient.
    log.reset();
    await log.idle();
    assert.deepStrictEqual(ls(dir), ['runs.jsonl'], 'tout le brut parti, et seulement lui');
    assert.strictEqual(log.info().bytes, 0);
    assert.strictEqual((await readAll(log)).length, 0);
    log.append(sample(now));
    assert.strictEqual((await readAll(log)).length, 1);
  }
}

main().then(
  () => {
    Date.now = realNow;
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    console.log('samples: ok');
  },
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
