// Journal brut : un fichier par mois calendaire UTC.
//
//   samples-2026-10.jsonl      — le mois en cours, en clair, une ligne JSON par
//                                seconde sous voile, en append.
//   samples-2026-09.jsonl.gz   — un mois clos, compressé (zlib de Node, aucune
//                                dépendance). Le mois est celui de l'horodatage
//                                `t` de chaque ligne, pas celui de l'horloge
//                                au moment d'écrire.
//
// Pourquoi découper. Mesuré le 12/10/2026 sur Jazzy : un fichier unique de
// 95 Mo pour 20 jours de nav (486 000 lignes), que gzip ramène à 15,5 Mo. Le
// disque n'était pas le problème ; deux choses l'étaient. Le plafond
// (500 Mo) arrêtait l'écriture pour toujours, dans environ 85 jours de nav —
// le brut qui s'arrête en silence, c'est le rejeu qu'on perd. Et la relecture
// chargeait le fichier entier dans une chaîne : vers 500 Mo, on touche à la
// taille maximale d'une chaîne dans Node, et le rejeu plante le jour où on en
// a besoin. Ici tout se lit en flux, fichier après fichier.
//
// Un mois peut avoir à la fois un .gz et un clair : c'est le cas du mois en
// cours juste après la migration de l'ancien samples.jsonl (ses lignes
// anciennes sont compressées, les nouvelles s'ajoutent en clair). La règle
// est simple et vaut partout : dans un même mois, le .gz précède le clair.
// La compression d'un mois clos ajoute le clair au .gz comme un nouveau
// membre gzip (gunzip lit les membres concaténés bout à bout).
//
// Sûreté face aux coupures d'alimentation. Le serveur tourne sur un Pi qu'on
// coupe au tableau électrique. Toute transformation (migration, compression,
// suppression pour faire de la place) suit le même chemin :
//   1. tout est écrit dans des fichiers *.tmp, synchronisés sur disque, puis
//      relus et comptés — rien d'existant n'a encore bougé ;
//   2. un petit fichier samples-commit.json décrit les renommages et les
//      suppressions à faire ; il est lui-même écrit en .tmp puis renommé ;
//   3. on applique, puis on efface samples-commit.json.
// Au démarrage : un samples-commit.json présent est rejoué jusqu'au bout
// (chaque étape est rejouable sans effet de bord), puis tous les *.tmp
// restants sont jetés — ils appartenaient à un travail interrompu avant le
// point 2, dont les sources sont intactes. Aucune ligne perdue, aucune en
// double, quel que soit l'instant de la coupure.
//
// Rien de tout ça n'est sur le chemin de l'écriture à chaque seconde : la
// migration et la compression tournent en tâche de fond, en flux. Le serveur
// porte aussi l'alarme de mouillage et le pilote ; gzip de 95 Mo prend ~4 s
// sur un Pi 5, et c'est exactement la boucle qu'on ne veut pas bloquer.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { pipeline } = require('stream/promises');
const { once } = require('events');
const { StringDecoder } = require('string_decoder');
const { performance } = require('perf_hooks');

const LEGACY = 'samples.jsonl';
const MARKER = 'samples-commit.json';
const MONTH_RE = /^samples-(\d{4}-\d{2})\.jsonl(\.gz)?$/;
const TMP_RE = /^samples-.*\.tmp$/;

// Bornes larges (2000 → 2100) : au-delà, un `t` est une valeur aberrante,
// pas une date, et toISOString() lèverait une exception.
function monthOf(t) {
  if (typeof t !== 'number' || !(t > 946684800000 && t < 4102444800000)) return null;
  return new Date(t).toISOString().slice(0, 7);
}

const mb = (n) => (n / 1048576).toFixed(1);

class Aborted extends Error {}
// Une erreur APRÈS la pose de samples-commit.json : les .tmp qu'il nomme ne
// doivent surtout pas être nettoyés, c'est le prochain démarrage qui finira.
class CommitFailed extends Error {}

// Découpe un flux en lignes, par paquets (un par bloc lu). Le reste d'un bloc
// est reporté sur le suivant ; StringDecoder évite de couper un caractère
// UTF-8 en deux à la frontière.
async function* linesOf(stream) {
  const dec = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of stream) {
    const s = rest + dec.write(chunk);
    const cut = s.lastIndexOf('\n');
    if (cut === -1) {
      rest = s;
      continue;
    }
    rest = s.slice(cut + 1);
    yield s.slice(0, cut).split('\n');
  }
  rest += dec.end();
  if (rest) yield [rest];
}

function countNewlines(buf) {
  let n = 0;
  let i = -1;
  while ((i = buf.indexOf(10, i + 1)) !== -1) n++;
  return n;
}

async function fsyncFile(file) {
  const fh = await fsp.open(file, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Un flux gzip vers un fichier, avec contre-pression et erreurs (disque
// plein) remontées au lieu d'un blocage silencieux.
function gzipWriter(file) {
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(file);
  const done = pipeline(gz, out);
  let err = null;
  done.catch((e) => (err = e));
  return {
    async write(data) {
      if (err) throw err;
      if (!gz.write(data)) await Promise.race([once(gz, 'drain'), done]);
      if (err) throw err;
    },
    async end() {
      gz.end();
      await done;
      await fsyncFile(file);
    },
    destroy() {
      gz.destroy();
      out.destroy();
    },
  };
}

// Lignes (sauts de ligne) et octets d'un fichier .gz une fois décompressé.
async function countGz(file) {
  let lines = 0;
  let bytes = 0;
  const gun = zlib.createGunzip();
  const done = pipeline(fs.createReadStream(file), gun);
  for await (const chunk of gun) {
    lines += countNewlines(chunk);
    bytes += chunk.length;
  }
  await done;
  return { lines, bytes };
}

function createSampleLog(dir, opts = {}) {
  const maxBytes = opts.maxBytes || 500 * 1024 * 1024;
  const dropOldest = Boolean(opts.dropOldest);
  const log = opts.log || (() => {});
  const warn = opts.warn || log;

  const p = (name) => path.join(dir, name);
  const plainName = (m) => `samples-${m}.jsonl`;
  const gzName = (m) => `samples-${m}.jsonl.gz`;
  const nowMonth = () => monthOf(Date.now());

  let bytes = 0; // tout ce qui est réellement occupé sur disque
  let count = 0; // lignes écrites depuis le démarrage
  let full = false;
  let stuck = false; // plafond atteint et plus rien d'assez vieux à supprimer
  let fullWarned = false;
  let lastMonth = null;
  let dropped = []; // mois supprimés pour faire de la place, depuis le démarrage
  let migration = null;
  let migrationFailed = false;
  let readErrors = 0;
  // Incrémenté par reset() et close() : un travail de fond lancé sous une
  // génération précédente abandonne avant de toucher quoi que ce soit.
  let gen = 0;
  let closed = false;
  // Un commit resté en travers : plus aucune transformation tant qu'il est là.
  let blocked = false;
  let job = null;
  let again = false;

  const exists = (name) => fs.existsSync(p(name));
  const unlinkQuiet = (name) => {
    try {
      fs.unlinkSync(p(name));
    } catch (e) {
      /* déjà parti */
    }
  };
  const readdir = () => {
    try {
      return fs.readdirSync(dir);
    } catch (e) {
      return [];
    }
  };
  const rand = () => crypto.randomBytes(4).toString('hex');

  // Les fichiers du brut dans l'ordre de lecture : l'ancien fichier unique
  // d'abord s'il est encore là, puis mois par mois, le .gz avant le clair.
  function scan() {
    const names = readdir();
    const months = new Map();
    for (const n of names) {
      const mm = MONTH_RE.exec(n);
      if (!mm) continue;
      const e = months.get(mm[1]) || {};
      if (mm[2]) e.gz = n;
      else e.plain = n;
      months.set(mm[1], e);
    }
    const keys = [...months.keys()].sort();
    const legacy = names.includes(LEGACY);
    const list = legacy ? [LEGACY] : [];
    for (const k of keys) {
      const e = months.get(k);
      if (e.gz) list.push(e.gz);
      if (e.plain) list.push(e.plain);
    }
    return { months, keys, legacy, list };
  }

  function measure() {
    const s = scan();
    const sizes = {};
    let total = 0;
    for (const n of s.list) {
      try {
        sizes[n] = fs.statSync(p(n)).size;
        total += sizes[n];
      } catch (e) {
        /* parti entre-temps */
      }
    }
    bytes = total;
    s.sizes = sizes;
    return s;
  }

  // ── Journal de commit ────────────────────────────────────────────────────
  function fsyncDir() {
    try {
      const fd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      /* certains systèmes de fichiers refusent : le renommage reste atomique */
    }
  }

  // Rejouable autant de fois qu'il faut. Garde-fou : si un renommage n'a ni
  // sa source ni sa destination, quelque chose a disparu hors de nous — on ne
  // supprime alors rien, puisque les suppressions sont justement les sources
  // de ce qui manque.
  function applyPlan(plan) {
    for (const [from, to] of plan.renames || []) if (exists(from)) fs.renameSync(p(from), p(to));
    const lost = (plan.renames || []).filter(([, to]) => !exists(to));
    if (lost.length) throw new Error(`commit incomplete, ${lost.map((x) => x[1]).join(', ')} missing — nothing deleted`);
    for (const n of plan.deletes || []) unlinkQuiet(n);
  }

  // Synchrone de bout en bout, et c'est voulu : aucune écriture du brut ne
  // peut se glisser entre la décision et son application.
  function commit(plan) {
    const tmp = p(MARKER + '.tmp');
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(plan));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p(MARKER));
    fsyncDir();
    try {
      applyPlan(plan);
      fsyncDir();
      unlinkQuiet(MARKER);
    } catch (e) {
      blocked = true;
      throw new CommitFailed(String((e && e.message) || e));
    }
  }

  function recover() {
    if (exists(MARKER)) {
      let plan = null;
      try {
        plan = JSON.parse(fs.readFileSync(p(MARKER), 'utf8'));
      } catch (e) {
        /* impossible en pratique : il n'est posé qu'une fois complet */
      }
      if (plan) {
        try {
          applyPlan(plan);
        } catch (e) {
          // On laisse tout en place, marqueur compris : rien n'est perdu, et
          // un humain peut regarder. Le brut continue de s'écrire à côté.
          warn(`raw log: could not finish an interrupted ${plan.op || 'operation'} (${e.message}) — files left as they are`);
          blocked = true;
          return;
        }
        log(`raw log: finished an interrupted ${plan.op || 'operation'}`);
      }
      unlinkQuiet(MARKER);
    }
    for (const n of readdir()) if (TMP_RE.test(n)) unlinkQuiet(n);
  }

  // Une coupure en pleine écriture laisse une ligne sans fin. La prochaine
  // écriture s'y collerait et la ligne suivante, complète, serait perdue
  // avec elle : on referme la ligne tronquée, qui sera ignorée à la lecture.
  function closeTail(name) {
    let fd;
    try {
      fd = fs.openSync(p(name), 'r+');
      const size = fs.fstatSync(fd).size;
      if (!size) return;
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      if (b[0] !== 10) fs.writeSync(fd, '\n', size);
    } catch (e) {
      /* illisible : la lecture ignorera de toute façon la ligne */
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }

  // ── Plafond ──────────────────────────────────────────────────────────────
  function refreshFull() {
    if (bytes < maxBytes) {
      full = false;
      stuck = false;
      fullWarned = false;
      return;
    }
    if (dropOldest && !stuck) {
      // On continue d'écrire : la place se libère en tâche de fond, et
      // quelques secondes au-dessus du plafond ne coûtent rien.
      full = false;
      schedule();
      return;
    }
    full = true;
    if (!fullWarned) {
      fullWarned = true;
      warn(
        `raw log full: ${mb(bytes)} MB on disk for a ${mb(maxBytes)} MB cap — writing stopped` +
          (dropOldest ? ' (nothing older than the current month left to delete)' : '')
      );
    }
  }

  function needsWork(s) {
    if (s.legacy && !migrationFailed) return true;
    const cur = nowMonth();
    if (s.keys.some((k) => k < cur && s.months.get(k).plain)) return true;
    return dropOldest && bytes >= maxBytes;
  }

  function load() {
    blocked = false;
    recover();
    const s = scan();
    for (const k of s.keys) {
      const e = s.months.get(k);
      if (e.plain) closeTail(e.plain);
    }
    lastMonth = null;
    stuck = false;
    const m = measure();
    refreshFull();
    if (needsWork(m)) schedule();
  }

  // ── Écriture, à chaque seconde ───────────────────────────────────────────
  function append(rec) {
    const m = monthOf(rec && rec.t) || nowMonth();
    if (m !== lastMonth) {
      // Un mois vient de s'ouvrir : le précédent peut partir en compression,
      // et un plafond bloqué peut avoir un mois de plus à libérer.
      if (lastMonth) {
        stuck = false;
        schedule();
      }
      lastMonth = m;
    }
    if (full) return false;
    const line = JSON.stringify(rec) + '\n';
    fs.appendFileSync(p(plainName(m)), line); // une erreur remonte à l'appelant
    bytes += Buffer.byteLength(line);
    count++;
    if (bytes >= maxBytes) refreshFull();
    return true;
  }

  // ── Travail de fond ──────────────────────────────────────────────────────
  function schedule() {
    if (closed) return Promise.resolve();
    if (job) {
      again = true;
      return job;
    }
    const g = gen;
    job = (async () => {
      do {
        again = false;
        // Jamais dans la pile d'appel de l'écriture : on rend la main d'abord.
        await new Promise((r) => setImmediate(r));
        await maintain(g);
      } while (again && g === gen && !closed);
    })()
      .catch((e) => {
        if (!(e instanceof Aborted)) warn(`raw log maintenance failed: ${(e && e.message) || e}`);
      })
      .finally(() => {
        job = null;
      });
    return job;
  }

  const check = (g) => {
    if (g !== gen || closed) throw new Aborted();
  };

  async function maintain(g) {
    check(g);
    if (blocked) return;
    stuck = false;
    let s = measure();
    if (s.legacy && !migrationFailed) {
      await migrate(g);
      s = measure();
    }
    const cur = nowMonth();
    for (const k of s.keys) {
      if (k >= cur || !s.months.get(k).plain) continue;
      await compress(k, g);
    }
    if (dropOldest) dropForRoom(g);
    measure();
    refreshFull();
  }

  // Ajoute `part` (un ou plusieurs membres gzip) au .gz d'un mois. S'il n'y a
  // pas encore de .gz, le morceau devient le .gz ; sinon on écrit la
  // concaténation dans un autre .tmp. Rend le plan de renommage.
  async function stageMonth(m, part, id, temps) {
    if (!exists(gzName(m))) return [part, gzName(m)];
    const joined = `samples-${m}.${id}.gz.tmp`;
    temps.push(joined);
    await pipeline(fs.createReadStream(p(gzName(m))), fs.createWriteStream(p(joined)));
    await pipeline(fs.createReadStream(p(part)), fs.createWriteStream(p(joined), { flags: 'a' }));
    await fsyncFile(p(joined));
    const want = fs.statSync(p(gzName(m))).size + fs.statSync(p(part)).size;
    if (fs.statSync(p(joined)).size !== want) throw new Error(`concatenation of ${m} has the wrong size`);
    return [joined, gzName(m)];
  }

  // Répartit l'ancien samples.jsonl dans les fichiers mensuels, tous
  // compressés — y compris la part du mois en cours : ses lignes sont plus
  // anciennes que tout ce qui s'écrit pendant la migration, qui part déjà
  // dans le clair du mois. L'original n'est supprimé qu'au commit, une fois
  // chaque mois relu et recompté.
  async function migrate(g) {
    const t0 = performance.now();
    const id = rand();
    const temps = [];
    const parts = new Map();
    const writers = [];
    let valid = 0;
    let skipped = 0;
    let lastM = null;
    let fallback;
    try {
      fallback = monthOf(fs.statSync(p(LEGACY)).mtimeMs) || nowMonth();
      const partFor = (m) => {
        let part = parts.get(m);
        if (!part) {
          const name = `samples-${m}.${id}.part.tmp`;
          temps.push(name);
          part = { name, lines: 0, w: gzipWriter(p(name)) };
          writers.push(part.w);
          parts.set(m, part);
        }
        return part;
      };
      for await (const lines of linesOf(fs.createReadStream(p(LEGACY)))) {
        check(g);
        const batch = new Map();
        for (const line of lines) {
          if (!line) continue;
          let rec;
          try {
            rec = JSON.parse(line);
          } catch (e) {
            skipped++; // ligne tronquée par une coupure : elle n'a jamais été relue
            continue;
          }
          const m = monthOf(rec && rec.t) || lastM || fallback;
          lastM = m;
          const b = batch.get(m) || { text: '', n: 0 };
          b.text += line + '\n';
          b.n++;
          batch.set(m, b);
          valid++;
        }
        for (const [m, b] of batch) {
          const part = partFor(m);
          part.lines += b.n;
          await part.w.write(b.text);
        }
      }
      for (const part of parts.values()) await part.w.end();

      // Vérification : chaque mois relu depuis le disque, décompressé, doit
      // rendre exactement les lignes qu'on y a mises.
      let after = 0;
      for (const [m, part] of parts) {
        check(g);
        const { lines } = await countGz(p(part.name));
        if (lines !== part.lines) throw new Error(`${m}: ${lines} lines read back, ${part.lines} written`);
        after += lines;
      }
      if (after !== valid) throw new Error(`${after} lines after migration, ${valid} before`);

      const renames = [];
      for (const [m, part] of [...parts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        renames.push(await stageMonth(m, part.name, id, temps));
      }
      check(g);
      commit({ op: 'migration', renames, deletes: [LEGACY, ...temps] });
      migration = { lines: valid, skipped, months: [...parts.keys()].sort(), ms: Math.round(performance.now() - t0) };
      log(
        `raw log: samples.jsonl split into ${parts.size} monthly file(s), ${valid} lines checked` +
          (skipped ? `, ${skipped} truncated line(s) dropped` : '') +
          ` (${migration.ms} ms)`
      );
    } catch (e) {
      for (const w of writers) w.destroy();
      if (e instanceof CommitFailed) {
        blocked = true;
        migrationFailed = true;
        migration = { error: e.message };
        warn(`raw log: migration interrupted while committing (${e.message}); it will finish at next start`);
        return;
      }
      for (const n of temps) unlinkQuiet(n);
      if (e instanceof Aborted) throw e;
      // On ne réessaie pas dans la même session : une erreur qui revient à
      // chaque seconde ne dirait rien de plus. Le fichier unique reste lu
      // tel quel, rien n'est perdu ; nouvel essai au prochain démarrage.
      migrationFailed = true;
      migration = { error: String((e && e.message) || e) };
      warn(`raw log: could not split samples.jsonl, kept as is (${migration.error})`);
    }
  }

  // Compresse un mois clos. Seuls les octets présents au départ sont pris ;
  // si une écriture tardive (horloge qui saute) a allongé le clair entre-
  // temps, on abandonne et on recommencera — rien n'est perdu.
  async function compress(m, g) {
    const plain = plainName(m);
    const size = fs.statSync(p(plain)).size;
    if (!size) {
      check(g);
      commit({ op: 'compression', renames: [], deletes: [plain] });
      return;
    }
    const id = rand();
    const part = `samples-${m}.${id}.part.tmp`;
    const temps = [part];
    const w = gzipWriter(p(part));
    try {
      let lines = 0;
      let last = 10;
      for await (const chunk of fs.createReadStream(p(plain), { start: 0, end: size - 1 })) {
        check(g);
        lines += countNewlines(chunk);
        last = chunk[chunk.length - 1];
        await w.write(chunk);
      }
      if (last !== 10) {
        await w.write('\n');
        lines++;
      }
      await w.end();
      const back = await countGz(p(part));
      if (back.lines !== lines) throw new Error(`${m}: ${back.lines} lines read back, ${lines} written`);
      const rename = await stageMonth(m, part, id, temps);
      check(g);
      if (fs.statSync(p(plain)).size !== size) {
        for (const n of temps) unlinkQuiet(n);
        again = true;
        return;
      }
      commit({ op: 'compression', renames: [rename], deletes: [plain, ...temps] });
      log(`raw log: ${m} compressed, ${mb(size)} MB → ${mb(fs.statSync(p(gzName(m))).size)} MB`);
    } catch (e) {
      w.destroy();
      if (e instanceof CommitFailed) {
        blocked = true;
        warn(`raw log: compression of ${m} interrupted while committing (${e.message}); it will finish at next start`);
        return;
      }
      for (const n of temps) unlinkQuiet(n);
      if (e instanceof Aborted) throw e;
      warn(`raw log: could not compress ${m}, left as is (${(e && e.message) || e})`);
    }
  }

  // Seulement sur option explicite : supprime les mois clos les plus anciens
  // jusqu'à repasser sous le plafond. Jamais le mois en cours, jamais pendant
  // une migration inachevée (l'ancien fichier unique n'a pas de mois).
  function dropForRoom(g) {
    let s = measure();
    const cur = nowMonth();
    while (bytes >= maxBytes) {
      const k = s.legacy ? null : s.keys.find((x) => x < cur);
      if (!k) {
        stuck = true;
        return;
      }
      check(g);
      const e = s.months.get(k);
      const names = [e.gz, e.plain].filter(Boolean);
      const freed = names.reduce((n, x) => n + (s.sizes[x] || 0), 0);
      commit({ op: 'rotation', renames: [], deletes: names });
      dropped.push(k);
      warn(`raw log full: deleted ${k} (${mb(freed)} MB) to make room, as configured`);
      s = measure();
    }
  }

  // ── Lecture ──────────────────────────────────────────────────────────────
  //
  // Les fichiers sont ouverts tous ensemble, d'un coup, avant la première
  // lecture : un instantané. Une compression ou une migration qui se termine
  // pendant qu'on lit peut renommer et supprimer à sa guise, les descripteurs
  // déjà ouverts continuent de pointer sur les données d'avant. Et on ne lit
  // que les octets présents à l'ouverture : ce qui s'écrit pendant un rejeu
  // attend le suivant.
  function snapshot() {
    const out = [];
    for (const n of scan().list) {
      try {
        const fd = fs.openSync(p(n), 'r');
        out.push({ name: n, fd, size: fs.fstatSync(fd).size, gz: n.endsWith('.gz') });
      } catch (e) {
        /* parti entre la liste et l'ouverture : ce n'est plus du brut */
      }
    }
    return out;
  }

  function closeAll(snap) {
    for (const f of snap) {
      try {
        fs.closeSync(f.fd);
      } catch (e) {
        /* déjà fermé */
      }
    }
  }

  function source(f) {
    const raw = fs.createReadStream('', { fd: f.fd, start: 0, end: f.size - 1, autoClose: false });
    if (!f.gz) return raw;
    const gun = zlib.createGunzip();
    pipeline(raw, gun).catch(() => {}); // l'erreur ressort par l'itération de `gun`
    return gun;
  }

  // Rejoue le brut ligne par ligne, tous les mois dans l'ordre, sans jamais
  // tenir un fichier entier en mémoire. Un mois illisible (disque abîmé) est
  // signalé et sauté : il ne doit pas coûter tous les autres.
  async function each(fn) {
    const snap = snapshot();
    let n = 0;
    try {
      for (const f of snap) {
        if (!f.size) continue;
        try {
          for await (const lines of linesOf(source(f))) {
            for (const line of lines) {
              if (!line) continue;
              try {
                fn(JSON.parse(line));
                n++;
              } catch (e) {
                /* ligne tronquée par une coupure d'alim, ignorée */
              }
            }
          }
        } catch (e) {
          readErrors++;
          warn(`raw log: ${f.name} could not be read to the end (${(e && e.message) || e})`);
        }
      }
    } finally {
      closeAll(snap);
    }
    return n;
  }

  // Le brut entier en un seul flux texte, décompressé, pour l'export. Le
  // consommateur impose son rythme ; s'il s'en va, on s'arrête.
  function stream() {
    const out = new PassThrough();
    const snap = snapshot();
    const room = () =>
      new Promise((r) => {
        const done = () => {
          out.off('drain', done);
          out.off('close', done);
          r();
        };
        out.on('drain', done);
        out.on('close', done);
      });
    (async () => {
      try {
        for (const f of snap) {
          if (out.destroyed) break;
          if (!f.size) continue;
          try {
            for await (const chunk of source(f)) {
              if (out.destroyed) break;
              if (!out.write(chunk)) await room();
            }
          } catch (e) {
            readErrors++;
            warn(`raw log: ${f.name} could not be read to the end (${(e && e.message) || e})`);
          }
        }
      } finally {
        closeAll(snap);
        if (!out.destroyed) out.end();
      }
    })();
    return out;
  }

  function reset() {
    gen++;
    for (const n of readdir()) {
      if (n === LEGACY || n === MARKER || MONTH_RE.test(n) || TMP_RE.test(n)) unlinkQuiet(n);
    }
    blocked = false;
    bytes = 0;
    count = 0;
    full = false;
    stuck = false;
    fullWarned = false;
    lastMonth = null;
    dropped = [];
    migration = null;
    migrationFailed = false;
  }

  // Signature de l'état du brut (noms et tailles) : sert de clé de cache à
  // l'index de couverture. La taille seule ne suffit plus, une compression
  // la fait baisser.
  function signature() {
    const s = measure();
    const h = crypto.createHash('sha1');
    for (const n of s.list) h.update(`${n}:${s.sizes[n]};`);
    return h.digest('hex').slice(0, 16);
  }

  return {
    load,
    append,
    each,
    stream,
    reset,
    signature,
    // Pour les tests et l'outil de vérification : attend la fin du travail
    // de fond en cours (migration, compression, rotation).
    idle: () => job || Promise.resolve(),
    maintain: () => schedule(),
    close: () => {
      closed = true;
      gen++;
    },
    files: () => scan().list.map(p),
    info: () => ({
      bytes,
      count,
      full,
      maxBytes,
      dropOldest,
      dropped: dropped.slice(),
      migration,
      busy: Boolean(job),
      readErrors,
    }),
  };
}

module.exports = { createSampleLog, monthOf };
