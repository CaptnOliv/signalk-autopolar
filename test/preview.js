// Aperçu local de la webapp, avec une polaire simulée d'Océanis 48 : sert les
// mêmes routes que SignalK monterait, sur http://localhost:8099/plugins/signalk-autopolar/
// Sert à regarder le rendu sans avoir à redémarrer le serveur du bord.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = process.env.PREVIEW_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'polaire-preview-'));
// Un bateau plausible sous voile, pour que le panneau « en direct » montre
// quelque chose. Sans lui l'aperçu s'ouvre sur des tuiles vides et un état
// « starting up » — ce qui ne dit rien de ce que l'app fait réellement en nav,
// et fait de mauvaises captures d'écran.
const D2R = Math.PI / 180;
const KN = 1 / 1.94384;
let tick = 0;
const node = (v) => ({ value: v, timestamp: new Date().toISOString(), $source: 'preview' });
function fakeBoat(p) {
  // Tout oscille un peu : un voilier ne tient jamais rien de constant, et
  // c'est justement ce que le filtre est censé tolérer.
  const w = (a) => Math.sin(tick / 7) * a;
  if (p === 'propulsion') return { Engine1: { revolutions: node(0), state: node('stopped') } };
  const map = {
    'navigation.speedOverGround': (7.4 + w(0.35)) * KN,
    'navigation.speedThroughWater': (8.1 + w(0.3)) * KN,
    'environment.wind.speedApparent': (12.4 + w(0.8)) * KN,
    'environment.wind.angleApparent': (78 + w(7)) * D2R,
    'environment.wind.speedTrue': (16.2 + w(0.9)) * KN,
    'environment.wind.angleTrueWater': (118 + w(6)) * D2R,
    'navigation.headingTrue': (212 + w(4)) * D2R,
    'navigation.courseOverGroundTrue': (214 + w(4)) * D2R,
    'navigation.rateOfTurn': w(0.4) * D2R,
    'navigation.state': 'sailing',
    'navigation.attitude': { roll: (12 + w(3)) * D2R, pitch: w(2.4) * D2R, yaw: null },
  };
  return p in map ? node(map[p]) : null;
}
const fakeApp = { getDataDirPath: () => dataDir, setPluginStatus: () => {}, error: console.error, debug: () => {}, getSelfPath: fakeBoat };
const realSetInterval = global.setInterval;
let captured = null;
global.setInterval = (fn) => {
  captured = fn;
  return 0;
};
const plugin = require('../index.js')(fakeApp);
// Le partage part vers un puits local : l'aperçu doit exercer tout le chemin
// (palier, envoi, état affiché) sans jamais écrire dans le vrai fonds commun.
const IDENT = {
  boatModel: 'Example 40',
  shareName: 'preview',
  shareEndpoint: 'http://127.0.0.1:8099/dev/collect',
  shareEveryPoints: 500,
};
plugin.start(Object.assign({}, IDENT));
global.setInterval = realSetInterval;
// On fait tourner la boucle du plugin pour de vrai : c'est elle qui remplit
// l'état en direct, la fenêtre en cours et les métriques.
if (captured) realSetInterval(() => { tick++; captured(); }, 1000);

// Polaire de référence grossière : vitesse = f(TWS, TWA), avec le creux du
// près et l'affaissement au vent arrière.
function ref(tws, twa) {
  const a = (twa * Math.PI) / 180;
  const base = Math.min(9.2, 1.45 * Math.pow(tws, 0.62));
  const shape = Math.pow(Math.sin(Math.min(a, Math.PI - 0.25 * a) * 0.92), 0.75);
  const upwindPenalty = twa < 40 ? Math.max(0, (twa - 25) / 15) : 1;
  const deep = twa > 150 ? 0.86 + 0.14 * ((180 - twa) / 30) : 1;
  return Math.max(0, base * shape * upwindPenalty * deep);
}

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const noise = (a) => (rnd() * 2 - 1) * a;

const runsFile = path.join(dataDir, 'runs.jsonl');
if (!fs.existsSync(runsFile)) {
  const out = [];
  let t = Date.parse('2026-09-02T12:00:00Z');
  const sails = [{ main: 'full', head: 'genoa' }, { main: '1ris', head: 'genoa' }];
  for (let i = 0; i < 900; i++) {
    const tws = [5, 7, 9, 11, 13, 15, 17][Math.floor(rnd() * 7)] + noise(1);
    const twa = (30 + rnd() * 150) * (rnd() > 0.5 ? 1 : -1);
    const stw = ref(tws, Math.abs(twa)) + noise(0.35);
    if (stw < 0.5) continue;
    const sog = stw + noise(0.3) + 0.15;
    const awaRad = Math.atan2(tws * Math.sin((twa * Math.PI) / 180), tws * Math.cos((twa * Math.PI) / 180) + stw);
    const aws = Math.hypot(tws * Math.sin((twa * Math.PI) / 180), tws * Math.cos((twa * Math.PI) / 180) + stw);
    t += 90000;
    out.push({
      id: t, ts: t, n: 60,
      sog: +sog.toFixed(2), stw: +stw.toFixed(2),
      twa: +twa.toFixed(1), tws: +tws.toFixed(2),
      awa: +((awaRad * 180) / Math.PI).toFixed(1), aws: +aws.toFixed(2),
      hdg: +(rnd() * 360).toFixed(1), cog: 0, roll: twa > 0 ? 12 : -12,
      engineSource: 'rpm', sail: sails[i % 20 === 0 ? 1 : 0],
      metrics: { hdgSpread: 4, twsSpread: 1.1 },
    });
  }
  // Deux valeurs franchement aberrantes, pour vérifier que le tri se voit.
  out[100].sog = 14.9; out[100].stw = 14.2;
  fs.writeFileSync(runsFile, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  plugin.stop();
  plugin.start(Object.assign({}, IDENT));
}

const routes = { GET: {}, POST: {} };
plugin.registerWithRouter({ get: (p, h) => (routes.GET[p] = h), post: (p, h) => (routes.POST[p] = h) });

const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'], '/style.css': ['style.css', 'text/css'] };

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace('/plugins/signalk-autopolar', '') || '/';
    if (STATIC[p]) {
      const [file, type] = STATIC[p];
      res.setHeader('Content-Type', type);
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'public', file)));
    }
    if (p === '/dev/collect') {
      let n = '';
      req.on('data', (c) => (n += c));
      return req.on('end', () => {
        console.log(`[dev collect] ${n.length} octets recus`);
        res.end('ok');
      });
    }
    const h = routes[req.method] && routes[req.method][p];
    if (!h) {
      res.statusCode = 404;
      return res.end('nope');
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const query = Object.fromEntries(u.searchParams);
      const body = raw ? JSON.parse(raw) : {};
      h(
        { query, body },
        // Le faux `res` doit ressembler à celui d'Express, sinon l'aperçu
        // valide des routes qui planteront en production — ou l'inverse,
        // comme ici : `setHeader` existe sur toute réponse HTTP, et son
        // absence dans ce bouchon a fait échouer une route parfaitement
        // correcte. Un harnais qui ment ne sert à rien.
        {
          type: (t) => res.setHeader('Content-Type', t.includes('/') ? t : 'text/plain'),
          setHeader: (k, v) => res.setHeader(k, v),
          set: (k, v) => res.setHeader(k, v),
          status(c) {
            res.statusCode = c;
            return this;
          },
          json: (v) => res.end(JSON.stringify(v)),
          send: (v) => res.end(v),
          end: () => res.end(),
        }
      );
    });
  })
  .listen(8099, () => console.log('apercu : http://localhost:8099/plugins/signalk-autopolar/  (donnees dans ' + dataDir + ')'));
