// Collecteur de polaires — le bout qui reçoit ce que les plugins reversent,
// et qui compte les installations.
//
// Sans dépendance, un seul fichier : il tourne derrière nginx-proxy, ne parle
// qu'HTTP et n'écrit que des fichiers texte. Ce qui arrive ici est déjà
// anonyme par construction (aucune position n'est collectée à bord), donc le
// service n'a aucun secret à garder et aucune authentification à gérer.
//
// Trois routes :
//   POST /v1/polars  la polaire d'un bateau, qui remplace la précédente
//   POST /v1/ping    « cette installation existe », une fois par jour
//   GET  /v1/stats   le compte, en lecture publique
//
// Une soumission remplace la précédente du même bateau : le fonds commun doit
// détenir la meilleure version de chaque polaire, pas un historique de
// brouillons. L'historique existe quand même, en append-only, parce qu'une
// régression côté plugin doit rester diagnosticable.
//
// La clé de remplacement est l'`installId` tiré par le plugin, pas le nom :
// deux Oceanis 48 dont les propriétaires écrivent « Jazzy » s'écrasaient l'un
// l'autre en silence, et un bateau qui changeait de nom laissait un doublon
// orphelin derrière lui. Les envois sans identifiant (plugins ≤ 0.6.1) gardent
// l'ancien comportement — ils ne doivent pas cesser d'être acceptés.
//
// Ce qui n'est PAS gardé : aucune adresse IP, nulle part. Ni dans les
// fichiers, ni dans le journal. C'est ce qui permet d'annoncer le ping
// franchement côté plugin plutôt que de le déguiser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.POLARS_DIR || '/data';
const PORT = Number(process.env.PORT || 8080);
const MAX_BYTES = 4 * 1024 * 1024;
const PING_MAX_BYTES = 8 * 1024;
const DAY = 86400000;
// Deux envois du même bateau à dix minutes d'intervalle, c'est un bouton
// « send now » qu'on essaie — pas une nouvelle polaire. On n'en notifie qu'un.
const NOTIFY_DEBOUNCE_MS = 600000;

const slug = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

// Un identifiant vient du réseau : il finit dans un nom de fichier et dans
// une clé de registre, donc on ne garde que ce qui ne peut rien traverser.
const cleanId = (s) => (/^[A-Za-z0-9-]{8,64}$/.test(String(s || '')) ? String(s) : null);
const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6);

// Une valeur d'en-tête HTTP est une ByteString : un seul caractère hors
// Latin-1 — un accent dans un nom de bateau, un emoji, un tiret cadratin — et
// `fetch` lève « Cannot convert argument to a ByteString ». Ici les titres
// sont fabriqués avec du texte libre venu d'inconnus : c'est le cas où ça
// arrivera pour de bon. ntfy sait décoder l'« encoded-word » RFC 2047.
// (Même fonction que lib/notify.js côté plugin ; le collecteur est copié seul
// dans son image Docker, il ne peut rien partager avec le paquet.)
function headerSafe(s) {
  s = s == null ? '' : String(s);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function createCollector(o) {
  const opts = Object.assign(
    {
      dir: DIR,
      ntfyUrl: process.env.NTFY_URL || '',
      ntfyToken: process.env.NTFY_TOKEN || '',
      // Une notification par nouvelle installation, en plus de celles des
      // polaires : c'est bavard tant que le plugin est confidentiel, et
      // exactement ce qu'on veut savoir à ce stade. Coupé par défaut.
      notifyNewInstalls: /^(1|true|yes)$/i.test(process.env.NTFY_NEW_INSTALLS || ''),
      log: console.log,
    },
    o || {}
  );

  const installsFile = path.join(opts.dir, 'installs.json');
  let installs = {};
  fs.mkdirSync(opts.dir, { recursive: true });
  if (fs.existsSync(installsFile)) {
    try {
      installs = JSON.parse(fs.readFileSync(installsFile, 'utf8'));
    } catch (e) {
      // Registre illisible : on repart de zéro plutôt que de refuser du
      // service. Le compte redémarre, les polaires sur disque sont intactes.
      opts.log(`[polars] registre illisible, on repart: ${e.message}`);
      installs = {};
    }
  }

  // Écriture par fichier temporaire puis renommage : le registre est réécrit à
  // chaque requête, et une coupure au milieu ne doit pas le laisser tronqué.
  function saveInstalls() {
    const tmp = `${installsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(installs, null, 2));
    fs.renameSync(tmp, installsFile);
  }

  async function notify(title, body, tags) {
    if (!opts.ntfyUrl) return;
    try {
      const headers = { Title: headerSafe(title), Tags: headerSafe(tags || '') };
      if (opts.ntfyToken) headers.Authorization = `Bearer ${opts.ntfyToken}`;
      const res = await fetch(opts.ntfyUrl, { method: 'POST', headers, body });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
    } catch (e) {
      // Une notification perdue ne doit jamais coûter la polaire qui l'a
      // déclenchée : elle est déjà sur le disque quand on arrive ici.
      opts.log(`[polars] ntfy: ${e.message}`);
    }
  }

  const counts = () => {
    const ids = Object.keys(installs);
    const now = Date.now();
    return {
      installs: ids.length,
      active30d: ids.filter((i) => now - (installs[i].lastSeen || 0) < 30 * DAY).length,
      polars: ids.filter((i) => installs[i].lastPolar).length,
    };
  };

  // Où écrire la polaire de ce bateau. Le chemin lisible (`modèle/nom`) est
  // gardé — il faut pouvoir fouiller le fonds à la main — mais il ne fait pas
  // autorité : c'est l'identifiant qui décide qui a le droit d'écraser quoi.
  function resolveFile(id, model, name) {
    const want = `${model}/${name}`;
    if (!id) return want;
    if (installs[id] && installs[id].file === want) return want;
    for (const [other, rec] of Object.entries(installs)) {
      if (other !== id && rec.file === want) return `${want}-${shortHash(id)}`;
    }
    return want;
  }

  function save(body) {
    const model = slug(body.model);
    const name = slug(body.name);
    // Un modèle et un nom sont la seule chose qui rende une polaire réutilisable :
    // sans eux on stockerait un fichier que personne ne pourrait rattacher.
    if (!model || !name) throw new Error('model and name are required');
    if (!body.pol || typeof body.pol !== 'string') throw new Error('no polar');

    const id = cleanId(body.installId);
    const prev = id ? installs[id] : null;
    const file = resolveFile(id, model, name);
    const isNew = !prev || !prev.lastPolar;

    fs.mkdirSync(path.join(opts.dir, path.dirname(file)), { recursive: true });
    const rec = Object.assign({ receivedAt: new Date().toISOString() }, body);
    fs.writeFileSync(path.join(opts.dir, `${file}.json`), JSON.stringify(rec, null, 2));
    fs.writeFileSync(path.join(opts.dir, `${file}.pol`), body.pol);

    // Le bateau a été renommé, ou son modèle corrigé : on déplace au lieu
    // d'accumuler. Une installation, une polaire.
    if (prev && prev.file && prev.file !== file) {
      for (const ext of ['.json', '.pol']) {
        try {
          fs.unlinkSync(path.join(opts.dir, prev.file + ext));
        } catch (e) {
          /* déjà parti, ou jamais écrit */
        }
      }
    }

    const now = Date.now();
    if (id) {
      installs[id] = Object.assign({}, prev, {
        firstSeen: (prev && prev.firstSeen) || now,
        lastSeen: now,
        lastPolar: now,
        file,
        model: body.model,
        name: body.name,
        version: body.version || (prev && prev.version) || null,
        // Seul autopolar reverse des polaires ; l'attribution est sûre, et
        // sans elle un bateau qui partage sans jamais pinguer ne serait
        // rattaché à aucun plugin dans les statistiques.
        plugin: body.plugin || (prev && prev.plugin) || 'signalk-autopolar',
        points: body.points,
        cells: body.cells,
        sharing: true,
      });
      saveInstalls();
    }

    fs.appendFileSync(
      path.join(opts.dir, 'log.jsonl'),
      JSON.stringify({
        at: rec.receivedAt,
        model: body.model,
        name: body.name,
        installId: id,
        points: body.points,
        cells: body.cells,
        bands: body.bands,
        version: body.version,
      }) + '\n'
    );

    // Le débounce ne porte que sur la notification, jamais sur l'écriture : on
    // garde toujours la dernière polaire, on n'en parle pas toujours.
    const quiet = prev && prev.lastNotifiedAt && now - prev.lastNotifiedAt < NOTIFY_DEBOUNCE_MS;
    if (!quiet) {
      if (id) {
        installs[id].lastNotifiedAt = now;
        saveInstalls();
      }
      const c = counts();
      const lines = [
        `${body.name || '?'} — ${body.model || '?'}`,
        `${body.points || 0} points, ${body.cells || 0} cells, ${body.bands || 0} wind bands`,
        `plugin ${body.version || '?'}`,
        `${c.polars} polar(s) from ${c.installs} install(s)`,
      ];
      notify(
        `${isNew ? 'New polar' : 'Polar updated'}: ${body.model || '?'}`,
        lines.join('\n'),
        isNew ? 'sailboat,star' : 'sailboat'
      );
    }

    return { model, name, file, isNew };
  }

  // Le ping : rien d'autre que « cette installation existe ». Il est accepté
  // même sans modèle ni nom — c'est tout l'intérêt, il compte les
  // installations qui ne partagent pas leur polaire.
  function ping(body) {
    const id = cleanId(body.installId);
    if (!id) throw new Error('installId is required');
    const now = Date.now();
    const prev = installs[id];
    const isNew = !prev;
    installs[id] = Object.assign({}, prev, {
      firstSeen: (prev && prev.firstSeen) || now,
      lastSeen: now,
      lastPing: now,
      plugin: body.plugin || (prev && prev.plugin) || null,
      version: body.version || null,
      node: body.node || null,
      signalk: body.signalk || null,
      // Déclaré au bateau, jamais déduit : une installation peut partager sa
      // polaire et couper le ping, ou l'inverse.
      sharing: Boolean(body.sharing),
    });
    saveInstalls();

    if (isNew && opts.notifyNewInstalls) {
      const c = counts();
      notify(
        `New install: ${body.plugin || 'unknown plugin'}`,
        [
          `version ${body.version || '?'} on SignalK ${body.signalk || '?'}, node ${body.node || '?'}`,
          `sharing a polar: ${body.sharing ? 'yes' : 'no'}`,
          `${c.installs} install(s) known, ${c.active30d} active in the last 30 days`,
        ].join('\n'),
        'wave,star'
      );
    }
    return { isNew };
  }

  // Le compte, en lecture publique. Volontairement sans les noms de bateaux :
  // un compteur n'en a pas besoin, et cette route n'est protégée par rien.
  function stats() {
    const now = Date.now();
    const ids = Object.keys(installs);
    const models = {};
    // Plusieurs plugins pointent sur ce même collecteur : mélanger leurs
    // comptes ne dirait rien de personne, et deux plugins peuvent porter le
    // même numéro de version. Chacun le sien.
    const plugins = {};
    const bucket = (name) => {
      const k = name || 'unknown';
      plugins[k] = plugins[k] || { plugin: k, installs: 0, active30d: 0, active7d: 0, sharing: 0, polars: 0, versions: {} };
      return plugins[k];
    };
    let sharing = 0;
    let first = null;
    for (const id of ids) {
      const r = installs[id];
      const b = bucket(r.plugin);
      b.installs++;
      if (now - (r.lastSeen || 0) < 30 * DAY) b.active30d++;
      if (now - (r.lastSeen || 0) < 7 * DAY) b.active7d++;
      if (r.lastPolar) b.polars++;
      if (r.sharing) b.sharing++;
      if (r.version) b.versions[r.version] = (b.versions[r.version] || 0) + 1;
      if (r.sharing) sharing++;
      if (r.model) {
        const k = String(r.model);
        models[k] = models[k] || { model: k, boats: 0, points: 0 };
        models[k].boats++;
        models[k].points += Number(r.points) || 0;
      }
      if (r.firstSeen && (first == null || r.firstSeen < first)) first = r.firstSeen;
    }
    const c = counts();
    return {
      installs: c.installs,
      active30d: c.active30d,
      active7d: ids.filter((i) => now - (installs[i].lastSeen || 0) < 7 * DAY).length,
      sharing,
      polars: c.polars,
      plugins: Object.values(plugins).sort((a, b) => b.installs - a.installs),
      models: Object.values(models).sort((a, b) => b.boats - a.boats || b.points - a.points),
      firstSeen: first ? new Date(first).toISOString() : null,
      at: new Date(now).toISOString(),
    };
  }

  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = String(req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/health') return send(200, { ok: true });
    if (req.method === 'GET' && url === '/v1/stats') return send(200, stats());

    const isPolar = req.method === 'POST' && url.startsWith('/v1/polars');
    const isPing = req.method === 'POST' && url.startsWith('/v1/ping');
    if (!isPolar && !isPing) return send(404, { error: 'not found' });

    const limit = isPing ? PING_MAX_BYTES : MAX_BYTES;
    let raw = '';
    let over = false;
    req.on('data', (c) => {
      raw += c;
      // Une polaire complète fait quelques dizaines de kilo-octets ; au-delà
      // de quelques mégas ce n'est plus une polaire, on coupe avant d'écrire.
      if (raw.length > limit && !over) {
        over = true;
        send(413, { error: 'too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return;
      try {
        const body = JSON.parse(raw);
        if (isPing) {
          ping(body);
          return send(200, { ok: true });
        }
        const { file } = save(body);
        opts.log(`[polars] ${file} ${raw.length}o`);
        send(200, { ok: true });
      } catch (e) {
        opts.log(`[polars] rejet: ${e.message}`);
        send(400, { error: e.message });
      }
    });
  });

  return { server, save, ping, stats, installs: () => installs };
}

module.exports = { createCollector, slug, headerSafe };

if (require.main === module) {
  const { server } = createCollector();
  server.listen(PORT, () => console.log(`collector on :${PORT}, data in ${DIR}`));
}
