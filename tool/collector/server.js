// Collecteur de polaires — le bout qui reçoit ce que les plugins reversent.
//
// Sans dépendance, un seul fichier : il tourne derrière nginx-proxy, ne parle
// qu'HTTP et n'écrit que des fichiers texte. Ce qui arrive ici est déjà
// anonyme par construction (aucune position n'est collectée à bord), donc le
// service n'a aucun secret à garder et aucune authentification à gérer.
//
// Une soumission remplace la précédente du même bateau : le fonds commun doit
// détenir la meilleure version de chaque polaire, pas un historique de
// brouillons. L'historique existe quand même, en append-only, parce qu'une
// régression côté plugin doit rester diagnosticable.
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = process.env.POLARS_DIR || '/data';
const PORT = Number(process.env.PORT || 8080);
const MAX_BYTES = 4 * 1024 * 1024;

const slug = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

function save(body) {
  const model = slug(body.model);
  const name = slug(body.name);
  // Un modèle et un nom sont la seule chose qui rende une polaire réutilisable :
  // sans eux on stockerait un fichier que personne ne pourrait rattacher.
  if (!model || !name) throw new Error('model and name are required');
  if (!body.pol || typeof body.pol !== 'string') throw new Error('no polar');

  const dir = path.join(DIR, model);
  fs.mkdirSync(dir, { recursive: true });
  const rec = Object.assign({ receivedAt: new Date().toISOString() }, body);
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(rec, null, 2));
  fs.writeFileSync(path.join(dir, `${name}.pol`), body.pol);
  fs.appendFileSync(
    path.join(DIR, 'log.jsonl'),
    JSON.stringify({
      at: rec.receivedAt,
      model: body.model,
      name: body.name,
      points: body.points,
      cells: body.cells,
      bands: body.bands,
      version: body.version,
    }) + '\n'
  );
  return { model, name };
}

http
  .createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || !req.url.startsWith('/v1/polars')) return send(404, { error: 'not found' });

    let raw = '';
    let over = false;
    req.on('data', (c) => {
      raw += c;
      // Une polaire complète fait quelques dizaines de kilo-octets ; au-delà
      // de quelques mégas ce n'est plus une polaire, on coupe avant d'écrire.
      if (raw.length > MAX_BYTES && !over) {
        over = true;
        send(413, { error: 'too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return;
      try {
        const { model, name } = save(JSON.parse(raw));
        console.log(`[polars] ${model}/${name} ${raw.length}o`);
        send(200, { ok: true });
      } catch (e) {
        console.log(`[polars] rejet: ${e.message}`);
        send(400, { error: e.message });
      }
    });
  })
  .listen(PORT, () => console.log(`collector on :${PORT}, data in ${DIR}`));
