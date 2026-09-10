// Ébauche de polaire depuis le History API de SignalK.
//
// Le problème que ça résout : un bateau qui installe autopolar aujourd'hui
// n'a rien avant la nav de demain, alors que le serveur, lui, garde peut-être
// des mois de vent et de vitesse dans un magasin d'historique. Autant s'en
// servir pour partir d'une ébauche plutôt que d'une page blanche.
//
// Trois règles qui tiennent tout ce fichier :
//
//  1. **Le filtre ne change pas.** Les points sont fabriqués par le MÊME
//     lib/gate.js que la collecte en direct, avec les mêmes seuils. Un second
//     filtre « spécial historique » divergerait, et on ne saurait plus ce que
//     vaut une case de la polaire. Ce qui change, c'est la matière première ;
//     pas le jugement porté sur elle.
//
//  2. **On mesure la dégradation au lieu de la supposer.** Un magasin
//     d'historique agrège par tranches de temps : demander 60 s de tranches
//     lisserait la dispersion que le filtre a justement pour métier de
//     refuser. On sonde donc la finesse réellement disponible (voir
//     `pickResolution`) et on REFUSE l'import quand une fenêtre ne
//     reposerait plus que sur quelques tranches.
//
//  3. **On ne repasse jamais par-dessus ce que le plugin a vu lui-même.**
//     Une période déjà observée en direct a été jugée par le filtre sur des
//     données à pleine fréquence. Y réinjecter une version lissée, c'est
//     laisser une donnée moins bonne annuler un rejet délibéré.
//
// Tout est pur : la lecture se fait par une fonction `getValues` injectée
// (l'API du serveur en production, un bouchon dans les tests).

const { MS_TO_KN, R2D, wrap180, trueWind, median } = require('./geom');

// Les chemins qu'autopolar sait lire, et ce qu'ils valent pour lui.
//
// `aggregate` n'est pas cosmétique. Un angle ne se moyenne PAS comme un
// nombre : au vent arrière, la moyenne de +179° et -179° vaut 0°, soit
// « au près » — la mesure serait inversée. On prend donc UNE valeur réelle
// de la tranche (`first`) pour tout ce qui est angulaire, et la moyenne
// seulement pour les grandeurs scalaires.
const CANDIDATES = [
  { key: 'awa', path: 'environment.wind.angleApparent', aggregate: 'first', role: 'required', unit: 'angle', label: 'apparent wind angle' },
  { key: 'aws', path: 'environment.wind.speedApparent', aggregate: 'average', role: 'required', unit: 'speed', label: 'apparent wind speed' },
  { key: 'sog', path: 'navigation.speedOverGround', aggregate: 'average', role: 'required', unit: 'speed', label: 'speed over ground' },
  { key: 'stw', path: 'navigation.speedThroughWater', aggregate: 'average', role: 'bonus', unit: 'speed', label: 'speed through water' },
  { key: 'tws', path: 'environment.wind.speedTrue', aggregate: 'average', role: 'bonus', unit: 'speed', label: 'true wind speed' },
  { key: 'twa', path: 'environment.wind.angleTrueWater', aggregate: 'first', role: 'bonus', unit: 'angle', label: 'true wind angle' },
  { key: 'hdg', path: 'navigation.headingTrue', aggregate: 'first', role: 'bonus', unit: 'angle360', label: 'heading' },
  { key: 'cog', path: 'navigation.courseOverGroundTrue', aggregate: 'first', role: 'bonus', unit: 'angle360', label: 'course over ground' },
  { key: 'rot', path: 'navigation.rateOfTurn', aggregate: 'average', role: 'bonus', unit: 'angle', label: 'rate of turn' },
];

// Le moteur. Son chemin porte le nom de la ligne d'arbre (`Engine1`, `port`,
// `main`…), qu'on ne peut pas deviner : on le découvre dans la liste des
// chemins archivés, et on prend TOUTES les lignes trouvées — une seule qui
// tourne suffit à disqualifier la période.
const ENGINE_RE = /^propulsion\.[^.]+\.(state|revolutions)$/;

// Résolutions candidates, en secondes. On s'arrête à la première qui donne
// des tranches presque toujours pleines : plus fin, ce sont des trous ; plus
// grossier, c'est du lissage gratuit.
const RESOLUTIONS = [1, 2, 3, 5, 10];

// Au-delà de ce taux de tranches incomplètes, la résolution est trop fine
// pour ce magasin : les fenêtres se briseraient sur des trous.
const MAX_HOLE_RATE = 0.02;

// Une fenêtre doit reposer sur au moins ce nombre de tranches, sinon la
// dérive et la dispersion ne veulent plus rien dire (avec 2 tranches, « le
// régime a-t-il changé ? » n'a pas de réponse).
const MIN_WINDOW_SAMPLES = 6;

// Le History API attend des instants au sens Temporal. Le serveur, lui,
// n'appelle que `toString()` sur ce qu'on lui passe (et certains
// fournisseurs lisent `epochMilliseconds`) : on livre donc un objet qui
// répond aux deux, plutôt que d'ajouter @js-temporal/polyfill en dépendance
// pour trois champs. autopolar tient à ses zéro dépendances.
function instant(ms) {
  const iso = new Date(ms).toISOString();
  return {
    toString: () => iso,
    toJSON: () => iso,
    epochMilliseconds: ms,
    get epochNanoseconds() {
      return BigInt(ms) * 1000000n;
    },
  };
}

// ── Lecture ─────────────────────────────────────────────────────────────────

// Traduit une ValuesResponse en { cols, rows } : `cols` dit quelle colonne
// porte quoi, `rows` est la matrice telle quelle. On ne se fie PAS à l'ordre
// demandé — un fournisseur a le droit de réordonner ou de dédoubler par
// source ; c'est `values[]` qui fait foi.
function readResponse(resp, specs) {
  const cols = {};
  const values = (resp && resp.values) || [];
  values.forEach((v, i) => {
    const spec = specs.find((s) => s.path === v.path && (!v.method || v.method === s.aggregate));
    // Une colonne dont on ne reconnaît ni le chemin ni la méthode (une
    // expansion par source, par exemple) : on la rattache au chemin, la
    // première gagne. Mieux vaut une source arbitraire qu'une colonne perdue.
    const byPath = spec || specs.find((s) => s.path === v.path);
    if (!byPath) return;
    if (cols[byPath.key] === undefined) cols[byPath.key] = i + 1; // +1 : la colonne 0 est l'horodatage
  });
  return { cols, rows: (resp && resp.data) || [] };
}

// Les spécifications de chemins à demander, pour une liste de clés retenues.
// `withSpread` ajoute min/max sur les vitesses : à résolution grossière, la
// moyenne d'une tranche efface la dispersion intérieure, et c'est
// précisément ce que le filtre a pour métier de voir. On la récupère donc au
// lieu de faire comme si elle n'existait pas.
function planSpecs(keys, engines, withSpread) {
  const specs = [];
  for (const c of CANDIDATES) {
    if (!keys.includes(c.key)) continue;
    specs.push({ key: c.key, path: c.path, aggregate: c.aggregate, unit: c.unit });
    if (withSpread && (c.key === 'sog' || c.key === 'aws')) {
      specs.push({ key: `${c.key}Min`, path: c.path, aggregate: 'min', unit: c.unit });
      specs.push({ key: `${c.key}Max`, path: c.path, aggregate: 'max', unit: c.unit });
    }
  }
  for (const p of engines) specs.push({ key: `eng:${p}`, path: p, aggregate: 'first', unit: 'raw' });
  return specs;
}

const toRequest = (specs, fromMs, toMs, resolution) => ({
  from: instant(fromMs),
  to: instant(toMs),
  resolution,
  pathSpecs: specs.map((s) => ({ path: s.path, aggregate: s.aggregate, parameter: [] })),
});

// Repère ce que le magasin contient : depuis quand, et sur quelle période il
// est le plus fourni.
//
// Le History API n'annonce ni l'un ni l'autre, et on ne va pas balayer cinq
// ans de tranches d'une seconde pour les trouver. On demande donc des
// tranches d'une HEURE sur des fenêtres de plus en plus larges — quelques
// requêtes en tout — et on s'arrête dès que la donnée ne touche plus le bord
// de la fenêtre : c'est le signe qu'on a vu son début.
//
// La période la plus fournie sert ensuite à mesurer la résolution. Prendre
// « le milieu de la plage » serait un piège : un bateau ne navigue pas tous
// les jours, le serveur s'éteint, et le milieu d'une plage de trois mois tombe
// très probablement dans un trou — d'où un verdict « magasin trop pauvre »
// pour un magasin parfaitement fourni ailleurs. On cherche donc la plus
// longue suite d'heures pleines, et on sonde dedans.
async function survey(getValues, opts = {}) {
  const now = opts.now || Date.now();
  const specs = planSpecs(['aws'], [], false);
  const DAYS = opts.days || [1, 7, 30, 90, 365, 1825];
  let hours = null;
  let span = null;
  for (const d of DAYS) {
    const from = now - d * 86400000;
    const resp = await getValues(toRequest(specs, from, now, 3600));
    const { cols, rows } = readResponse(resp, specs);
    if (cols.aws === undefined) return { reason: 'missing_paths' };
    const marks = rows.map((r) => ({ ts: Date.parse(r[0]), on: r[cols.aws] != null }));
    const on = marks.filter((m) => m.on);
    if (!on.length) continue;
    hours = marks;
    span = { from: on[0].ts, to: now };
    if (on[0].ts - from > 3600000) break; // la donnée ne touche pas le bord : on a son début
    if (d === DAYS[DAYS.length - 1]) break;
  }
  if (!span) return { reason: 'empty' };

  // Le balayage est horaire : son verdict est « la donnée commence dans
  // CETTE heure-là », pas « à cette minute ». Afficher l'heure ronde
  // donnerait une plage fausse de trois quarts d'heure. Une requête de plus,
  // à la minute, et le début annoncé est le vrai.
  {
    const resp = await getValues(toRequest(specs, span.from, Math.min(now, span.from + 3600000), 60));
    const { cols, rows } = readResponse(resp, specs);
    const first = rows.find((r) => r[cols.aws] != null);
    if (first) span.from = Date.parse(first[0]);
  }

  // La plus longue suite d'heures pleines.
  let best = null;
  let cur = null;
  for (const m of hours) {
    if (m.on) cur = cur ? { from: cur.from, to: m.ts + 3600000, n: cur.n + 1 } : { from: m.ts, to: m.ts + 3600000, n: 1 };
    else cur = null;
    if (cur && (!best || cur.n > best.n)) best = cur;
  }
  // Une heure « pleine » ne veut dire qu'« au moins une mesure dedans » : son
  // début peut précéder la première mesure de presque une heure, et sa fin la
  // dépasser d'autant. Sonder au jugé dans cette heure-là tombe à côté de la
  // donnée et fait conclure « magasin trop pauvre » sur un magasin très
  // fourni. On redescend donc à la MINUTE sur la période retenue, et on prend
  // la plus longue suite de minutes pleines : là, on sait ce qu'on sonde.
  const coarse = best || { from: span.from, to: Math.min(now, span.from + 3600000), n: 1 };
  // Borné aux dernières 12 h de cette période : 720 lignes suffisent, et la
  // donnée récente est la plus représentative du réglage actuel du bord.
  const mFrom = Math.max(span.from, coarse.to - 12 * 3600000, coarse.from);
  const mTo = Math.min(now, coarse.to);
  const dense = await denseRun(getValues, specs, mFrom, mTo);
  const busy = dense || { from: mFrom, to: mTo };
  const picked = await pickResolution(getValues, busy.from, busy.to, opts);
  return Object.assign({ span, busy, filledHours: hours.filter((m) => m.on).length }, picked);
}

// La plus longue suite de minutes contenant de la donnée, dans une plage. Une
// minute pleine, sur un magasin échantillonné à la seconde, ce sont des
// dizaines de mesures : c'est un endroit où sonder veut dire quelque chose.
async function denseRun(getValues, specs, fromMs, toMs) {
  if (toMs - fromMs < 120000) return null;
  const resp = await getValues(toRequest(specs, fromMs, toMs, 60));
  const { cols, rows } = readResponse(resp, specs);
  const need = Object.keys(cols).length ? Object.values(cols) : null;
  if (!need) return null;
  let best = null;
  let cur = null;
  for (const r of rows) {
    const ts = Date.parse(r[0]);
    const on = need.every((i) => r[i] != null);
    if (on) cur = cur ? { from: cur.from, to: ts + 60000 } : { from: ts, to: ts + 60000 };
    else cur = null;
    if (cur && (!best || cur.to - cur.from > best.to - best.from)) best = { from: cur.from, to: cur.to };
  }
  if (!best) return null;
  return { from: best.from, to: Math.min(best.to, toMs) };
}

// Choisit la résolution la plus fine dont les tranches sont presque toujours
// pleines. On la MESURE sur un échantillon de la fenêtre plutôt que de la
// déduire de la cadence annoncée : ce qui compte n'est pas la fréquence
// nominale d'un capteur, c'est le nombre de tranches vides qu'on obtiendra.
async function pickResolution(getValues, fromMs, toMs, opts = {}) {
  const specs = planSpecs(['awa', 'aws', 'sog'], [], false);
  // Un échantillon pris au milieu : le début d'une plage tombe souvent sur un
  // démarrage de serveur, où les données arrivent au compte-gouttes.
  const span = Math.min(opts.probeMs || 15 * 60000, toMs - fromMs);
  const mid = fromMs + (toMs - fromMs) / 2;
  const a = Math.max(fromMs, Math.round(mid - span / 2));
  const b = Math.min(toMs, a + span);
  const tried = [];
  for (const res of RESOLUTIONS) {
    const resp = await getValues(toRequest(specs, a, b, res));
    const { cols, rows } = readResponse(resp, specs);
    const need = ['awa', 'aws', 'sog'].map((k) => cols[k]).filter((i) => i !== undefined);
    if (need.length < 3) return { resolution: null, tried, reason: 'missing_paths' };
    let holes = 0;
    for (const r of rows) if (need.some((i) => r[i] == null)) holes++;
    const rate = rows.length ? holes / rows.length : 1;
    tried.push({ resolution: res, rows: rows.length, holeRate: rate });
    if (rows.length && rate <= MAX_HOLE_RATE) return { resolution: res, holeRate: rate, tried };
  }
  return { resolution: null, tried, reason: 'too_sparse' };
}

// ── Moteur ──────────────────────────────────────────────────────────────────

// Les instants où une propulsion tournait, et la cadence de publication.
//
// Deux subtilités qui décident de la validité de l'import. La première :
// l'état moteur arrive souvent une fois par minute (sur Jazzy il vient du
// Cerbo par MQTT), donc la quasi-totalité des tranches sont vides et il faut
// prolonger la dernière valeur connue. La seconde : ce prolongement doit
// jouer DANS LES DEUX SENS. Si le moteur démarre à 10:36:00 et que
// l'échantillon suivant tombe à 10:36:30, la demi-minute intermédiaire
// paraîtrait à la voile. On entoure donc chaque « en marche » d'une bande de
// garde égale à la cadence observée — la même prudence que le filtre en
// direct, qui retient toujours la lecture qui exclut le point.
function engineTimeline(rows, cols) {
  const idx = Object.keys(cols)
    .filter((k) => k.startsWith('eng:'))
    .map((k) => cols[k]);
  const running = [];
  const stopped = [];
  const stamps = [];
  for (const r of rows) {
    const ts = Date.parse(r[0]);
    for (const i of idx) {
      const v = r[i];
      if (v == null) continue;
      stamps.push(ts);
      const isRunning = typeof v === 'number' ? v > 0 : String(v) !== 'stopped';
      (isRunning ? running : stopped).push(ts);
    }
  }
  // Cadence : la médiane des écarts entre deux lectures. Bornée à 180 s comme
  // `engineStaleMs` en direct — au-delà, on ne prolonge plus, on ne sait plus.
  const gaps = [];
  for (let i = 1; i < stamps.length; i++) {
    const g = stamps[i] - stamps[i - 1];
    if (g > 0) gaps.push(g);
  }
  const cadence = gaps.length ? median(gaps) : null;
  const guard = Math.min(Math.max(cadence || 60000, 10000), 180000);
  return { running, stopped, guard, cadence, samples: stamps.length };
}

// Verdict moteur pour un instant : 'running', 'stopped' ou null (on ne sait
// pas). Le doute n'est jamais tranché en faveur de la collecte.
function engineAt(tl, ts) {
  const near = (list) => {
    // Recherche dichotomique : l'import balaie des dizaines de milliers de
    // tranches contre des milliers de lectures moteur.
    let lo = 0;
    let hi = list.length - 1;
    let best = Infinity;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const d = Math.abs(list[m] - ts);
      if (d < best) best = d;
      if (list[m] < ts) lo = m + 1;
      else hi = m - 1;
    }
    return best;
  };
  if (tl.running.length && near(tl.running) <= tl.guard) return 'running';
  if (tl.stopped.length && near(tl.stopped) <= tl.guard) return 'stopped';
  return null;
}

// ── Instantanés ─────────────────────────────────────────────────────────────

// Une tranche d'historique remise dans la forme que lib/gate.js attend. Les
// unités du magasin sont celles de SignalK (SI) : mètres par seconde et
// radians, exactement comme l'arbre en direct.
function toSnapshots(rows, cols, opts = {}) {
  const tl = engineTimeline(rows, cols);
  const kn = (v) => (typeof v === 'number' ? v * MS_TO_KN : null);
  const ang = (v) => (typeof v === 'number' ? wrap180(v * R2D) : null);
  const at = (r, key, conv) => (cols[key] === undefined ? null : conv(r[cols[key]]));
  const out = [];
  for (const r of rows) {
    const ts = Date.parse(r[0]);
    const sog = at(r, 'sog', kn);
    const aws = at(r, 'aws', kn);
    const awa = at(r, 'awa', ang);
    const stw = at(r, 'stw', kn);
    if (sog == null || aws == null || awa == null) continue; // tranche trouée
    let tws = at(r, 'tws', kn);
    let twa = at(r, 'twa', ang);
    let twSource = 'history';
    if (tws == null || twa == null) {
      // Même repli qu'en direct, et même ordre de préférence : la vitesse
      // surface donne le vent vrai « surface », faute de quoi le vent sol.
      const ref = typeof stw === 'number' && stw > 0 ? stw : sog;
      const t = trueWind(awa, aws, ref);
      tws = t.tws;
      twa = wrap180(t.twa);
      twSource = typeof stw === 'number' && stw > 0 ? 'calculé/STW' : 'calculé/SOG';
    }
    const eng = engineAt(tl, ts);
    // Dispersion intérieure de la tranche, quand on l'a demandée : c'est ce
    // que la moyenne a effacé. On la porte sur l'instantané pour que le tri
    // des fenêtres puisse la refuser (voir `windowSpreadOk`).
    const bandSpread = (key) => {
      const lo = at(r, `${key}Min`, kn);
      const hi = at(r, `${key}Max`, kn);
      return lo != null && hi != null ? hi - lo : null;
    };
    out.push({
      ts,
      sog,
      stw,
      awa,
      aws,
      twa,
      tws,
      hdg: at(r, 'hdg', (v) => (typeof v === 'number' ? v * R2D : null)),
      cog: at(r, 'cog', (v) => (typeof v === 'number' ? v * R2D : null)),
      rot: at(r, 'rot', (v) => (typeof v === 'number' ? v * R2D : null)),
      // Aucun magasin d'historique n'archive `navigation.attitude` (objet) :
      // l'état de la mer ne sera pas mesuré sur ces points, et c'est dit
      // plutôt que rempli d'une valeur inventée.
      roll: null,
      pitch: null,
      navState: null,
      // Le filtre lit ces deux-là ; on lui donne le verdict déjà tranché
      // au-dessus, avec la bande de garde. `null` = on ne sait pas, et le
      // filtre refusera le point (`engine_unknown`).
      rpm: eng === 'running' ? 1 : eng === 'stopped' ? 0 : null,
      engineState: null,
      rpmEverSeen: true,
      declaredSailing: false,
      twSource,
      sogBand: bandSpread('sog'),
      awsBand: bandSpread('aws'),
      fresh: {
        sog: true,
        stw: stw != null,
        awa: true,
        aws: true,
        twa: true,
        tws: true,
        hdg: cols.hdg !== undefined,
        rpm: eng !== null,
        engineState: false,
      },
    });
  }
  return { snaps: out, engine: tl };
}

// La dispersion intérieure d'une fenêtre ne doit pas passer sous le radar
// parce qu'une moyenne l'a gommée. On applique aux amplitudes de tranche les
// MÊMES plafonds que le filtre applique à la fenêtre entière : une tranche
// qui contient à elle seule plus d'écart que ce qu'on tolère sur 60 s décrit
// du chaos, pas un régime établi.
function windowSpreadOk(win, o) {
  for (const s of win) {
    if (s.sogBand != null && s.sogBand > o.sogSpreadMaxKn) return false;
    if (s.awsBand != null && s.awsBand > o.twsSpreadMaxKn) return false;
  }
  return true;
}

// ── Couverture ──────────────────────────────────────────────────────────────

// Fusionne une suite d'horodatages en intervalles, en coupant dès qu'un trou
// dépasse `gapMs`. Sert à décrire « les périodes déjà vues en direct ».
function toIntervals(stamps, gapMs) {
  const out = [];
  let cur = null;
  for (const ts of stamps) {
    if (!cur) cur = { from: ts, to: ts };
    else if (ts - cur.to > gapMs) {
      out.push(cur);
      cur = { from: ts, to: ts };
    } else cur.to = ts;
  }
  if (cur) out.push(cur);
  return out;
}

const inIntervals = (intervals, ts) => intervals.some((iv) => ts >= iv.from && ts <= iv.to);

// Retire d'une plage les morceaux déjà couverts, et renvoie ce qui reste.
function subtract(range, intervals) {
  let parts = [{ from: range.from, to: range.to }];
  for (const iv of intervals) {
    const next = [];
    for (const p of parts) {
      if (iv.to < p.from || iv.from > p.to) {
        next.push(p);
        continue;
      }
      if (iv.from > p.from) next.push({ from: p.from, to: iv.from });
      if (iv.to < p.to) next.push({ from: iv.to, to: p.to });
    }
    parts = next;
  }
  return parts.filter((p) => p.to > p.from);
}

module.exports = {
  CANDIDATES,
  ENGINE_RE,
  RESOLUTIONS,
  MAX_HOLE_RATE,
  MIN_WINDOW_SAMPLES,
  instant,
  readResponse,
  planSpecs,
  toRequest,
  pickResolution,
  denseRun,
  survey,
  engineTimeline,
  engineAt,
  toSnapshots,
  windowSpreadOk,
  toIntervals,
  inIntervals,
  subtract,
};
