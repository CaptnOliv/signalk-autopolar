// Construction de la polaire à partir des points collectés.
//
// Rien n'est figé au moment de la collecte : un point enregistré porte
// SIMULTANÉMENT sa vitesse surface et sa vitesse fond, son vent vrai et son
// vent apparent. Les quatre polaires demandées (SOG|STW × vrai|apparent) sont
// donc quatre projections des mêmes données, recalculées à la volée. C'est ce
// qui permet de comparer, de rebinner, de changer de statistique ou d'exclure
// des points après coup sans jamais avoir à re-naviguer.

const { mean, median, percentile, stdev, wrap180 } = require('./geom');
const { correct } = require('./speedo');

// Des centres de bins (ex. [4,6,8,10,...]) on déduit des intervalles dont les
// frontières tombent à mi-chemin. Les bins extrêmes sont étendus d'une
// demi-largeur, pas jusqu'à l'infini : une rafale à 40 nd n'a rien à faire
// dans la case « 25 nd ».
function windBinEdges(centers) {
  const c = [...centers].sort((a, b) => a - b);
  return c.map((v, i) => {
    const prevGap = i > 0 ? v - c[i - 1] : c.length > 1 ? c[1] - c[0] : 2;
    const nextGap = i < c.length - 1 ? c[i + 1] - v : prevGap;
    return { ws: v, lo: v - prevGap / 2, hi: v + nextGap / 2 };
  });
}

function findWindBin(edges, v) {
  for (const e of edges) if (v >= e.lo && v < e.hi) return e;
  return null;
}

function twaCenters(step) {
  const out = [];
  for (let a = 0; a <= 180 + 1e-9; a += step) out.push(Math.round(a * 100) / 100);
  return out;
}

function findTwaBin(centers, step, a) {
  const abs = Math.abs(a);
  const idx = Math.round(abs / step);
  const c = centers[Math.min(idx, centers.length - 1)];
  if (Math.abs(abs - c) > step / 2 + 1e-9) return null;
  return c;
}

const STATS = {
  mean,
  median,
  p90: (a) => percentile(a, 0.9),
  max: (a) => Math.max(...a),
};

const DEFAULTS = {
  speed: 'sog',
  wind: 'true',
  tack: 'merged',
  stat: 'mean',
  twsBins: [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 30],
  twaStep: 5,
  minSamples: 1,
  excluded: null,
  overrides: null,
  sail: null,
  sailRanges: null,
  // Écarte les points dont la seule preuve « pas au moteur » est une
  // déclaration de l'équipage. Ils valent pour soi, pas pour un corpus
  // partagé : personne ne peut vérifier une parole.
  excludeDeclared: false,
  // Écarte les points d'ébauche reconstruits depuis le History API du serveur
  // (lib/history.js). Ils sont de vraies mesures, mais lues par tranches de
  // temps et sans vitesse surface : on veut pouvoir voir la polaire des seules
  // mesures prises par le plugin lui-même, d'un clic et sans rien effacer.
  excludeHistory: false,
  smooth: true,
  // Courbe de correction du speedo (lib/speedo.js). Ne sert que pour la
  // projection 'stwc' : la mesure brute n'est jamais modifiée sur le disque.
  stwCal: null,
  vmgOffsets: [5, 10],
};

// Extrait d'un point la paire (vitesse, force du vent, angle du vent) selon
// la projection demandée.
function project(run, o) {
  const speed =
    o.speed === 'stw'
      ? run.stw
      : o.speed === 'stwc'
      ? correct(o.stwCal, run.stw)
      : run.sog;
  const ws = o.wind === 'apparent' ? run.aws : run.tws;
  const wa = o.wind === 'apparent' ? run.awa : run.twa;
  if (typeof speed !== 'number' || typeof ws !== 'number' || typeof wa !== 'number') return null;
  return { speed, ws, wa: wrap180(wa) };
}

// Les premières versions écrivaient les voiles d'avant en français
// (`genois`, `trinquette`, `rolled`). Les clés sont passées à l'anglais avec
// le reste du plugin, mais on ne réécrit pas 10 Mo de journal pour ça : on
// normalise à la lecture. Une donnée déjà écrite ne se corrige pas en la
// modifiant, elle se corrige en la traduisant.
const LEGACY = { genois: 'genoa', trinquette: 'jib', rolled: 'furled' };
function normalizeSail(sail) {
  if (!sail) return { main: '', head: '' };
  const head = String(sail.head || '')
    .split('-')
    .map((part) => LEGACY[part] || part)
    .join('-');
  return { main: sail.main || '', head };
}

// La voilure qui compte pour un point : celle qu'on a corrigée après coup si
// une plage la couvre, sinon celle qui était enregistrée sur le moment. On
// prend la DERNIÈRE plage qui couvre l'instant — corriger deux fois la même
// période doit se comporter comme on l'attend : la dernière correction gagne.
function effectiveSail(run, ranges) {
  let out = run.sail;
  if (ranges && ranges.length) {
    for (const r of ranges) {
      if (run.ts >= r.from && run.ts <= r.to) out = { main: r.main, head: r.head };
    }
  }
  return normalizeSail(out);
}

function matchSail(run, sail, ranges) {
  if (!sail) return true;
  // Les deux côtés sont normalisés : un filtre posé sur une donnée ancienne
  // doit trouver la donnée nouvelle, et réciproquement.
  const tag = effectiveSail(run, ranges);
  const want = normalizeSail(sail);
  for (const k of Object.keys(want)) {
    if (!want[k]) continue;
    if (tag[k] !== want[k]) return false;
  }
  return true;
}

function matchTack(wa, tack) {
  if (tack === 'merged' || !tack) return true;
  if (Math.abs(wa) < 20 || Math.abs(wa) > 160) return true; // amure sans objet
  return tack === 'port' ? wa < 0 : wa > 0;
}

// Regroupe les points en cases (bin de force × bin d'angle).
function bucket(runs, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const edges = windBinEdges(o.twsBins);
  const centers = twaCenters(o.twaStep);
  const excluded = o.excluded instanceof Set ? o.excluded : new Set(o.excluded || []);

  const cells = new Map(); // "ws|twa" -> [{ id, speed, wa, run }]
  let used = 0;
  let rejected = 0;

  for (const run of runs) {
    if (excluded.has(run.id)) continue;
    if (o.excludeDeclared && run.engineSource === 'declared') continue;
    if (o.excludeHistory && run.origin === 'history') continue;
    if (!matchSail(run, o.sail, o.sailRanges)) continue;
    const p = project(run, o);
    if (!p) continue;
    if (!matchTack(p.wa, o.tack)) continue;
    const wb = findWindBin(edges, p.ws);
    const ab = findTwaBin(centers, o.twaStep, p.wa);
    if (!wb || ab == null) {
      rejected++;
      continue;
    }
    const key = `${wb.ws}|${ab}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ id: run.id, speed: p.speed, wa: p.wa, ws: p.ws, run });
    used++;
  }
  return { o, edges, centers, cells, used, rejected, total: runs.length };
}

function buildPolar(runs, opts) {
  const { o, edges, centers, cells, used, rejected, total } = bucket(runs, opts);
  const statFn = STATS[o.stat] || STATS.mean;
  const overrides = o.overrides || {};

  const bins = edges.map((e) => {
    const cellList = [];
    for (const twa of centers) {
      const key = `${e.ws}|${twa}`;
      const pts = cells.get(key) || [];
      const speeds = pts.map((p) => p.speed);
      const ov = overrides[key];
      const cell = {
        twa,
        n: pts.length,
        mean: speeds.length ? mean(speeds) : null,
        median: speeds.length ? median(speeds) : null,
        p90: speeds.length ? percentile(speeds, 0.9) : null,
        max: speeds.length ? Math.max(...speeds) : null,
        sd: speeds.length ? stdev(speeds) : null,
        value: null,
        overridden: false,
        enough: pts.length >= o.minSamples,
      };
      if (typeof ov === 'number') {
        cell.value = ov;
        cell.overridden = true;
      } else if (speeds.length >= o.minSamples) {
        cell.value = statFn(speeds);
      }
      if (cell.value != null) cell.vmg = cell.value * Math.cos((twa * Math.PI) / 180);
      cellList.push(cell);
    }
    if (o.smooth) smoothCells(cellList);
    return { ws: e.ws, lo: e.lo, hi: e.hi, cells: cellList, targets: targetsFor(cellList, o.vmgOffsets) };
  });

  return {
    speed: o.speed,
    wind: o.wind,
    tack: o.tack,
    stat: o.stat,
    twaStep: o.twaStep,
    twsBins: o.twsBins,
    minSamples: o.minSamples,
    bins,
    used,
    rejected,
    total,
  };
}

// Sur une seule nav, une case ne contient souvent que deux ou trois mesures :
// la courbe sort en dents de scie, et un export brut donnerait un routage
// erratique. On lisse donc par une moyenne mobile sur les cases voisines,
// pondérée par leur nombre de mesures — une case bien remplie tire ses
// voisines, l'inverse n'est pas vrai. La valeur mesurée reste disponible
// (champ `raw`) et rien n'est inventé : une case vide le reste.
function smoothCells(cells) {
  const before = cells.map((c) => c.value);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    c.raw = before[i];
    if (before[i] == null || c.overridden) continue;
    let sum = 0;
    let wsum = 0;
    for (let k = -1; k <= 1; k++) {
      const j = i + k;
      if (j < 0 || j >= cells.length || before[j] == null) continue;
      const w = (k === 0 ? 2 : 1) * Math.max(cells[j].n || 1, 1);
      sum += before[j] * w;
      wsum += w;
    }
    c.value = sum / wsum;
    if (c.value != null) c.vmg = c.value * Math.cos((c.twa * Math.PI) / 180);
  }
}

// Meilleur VMG au près et au portant : l'angle qui fait réellement avancer
// vers (ou sous) le vent le plus vite. C'est le chiffre qu'on regarde en nav,
// bien plus que la vitesse brute.
function targetsFor(cells, offsets) {
  let up = null;
  let down = null;
  for (const c of cells) {
    if (c.value == null) continue;
    if (c.twa <= 90) {
      if (!up || c.vmg > up.vmg) up = { twa: c.twa, vmg: c.vmg, speed: c.value };
    } else if (!down || c.vmg < down.vmg) down = { twa: c.twa, vmg: c.vmg, speed: c.value };
  }
  if (down) down = { twa: down.twa, vmg: Math.abs(down.vmg), speed: down.speed };
  return {
    upwind: withNeighbourhood(up, cells, offsets),
    downwind: withNeighbourhood(down, cells, offsets),
  };
}

// Le voisinage de l'optimum. Connaître le meilleur angle ne dit pas ce qu'il
// coûte de s'en écarter : sur certains bateaux la cloche est plate et lofer
// de 10° ne coûte presque rien (on prend la risée, on soulage l'équipage),
// sur d'autres elle est pointue et le même écart coûte un demi-nœud de VMG.
// C'est cette forme-là qu'on barre, pas le seul maximum.
function withNeighbourhood(target, cells, offsets) {
  if (!target) return null;
  const offs = offsets && offsets.length ? offsets : DEFAULTS.vmgOffsets;
  const deltas = [];
  for (const d of offs) deltas.push(-d, d);
  deltas.sort((a, b) => a - b);
  const around = [];
  for (const d of deltas) {
    const twa = target.twa + d;
    if (twa <= 0 || twa >= 180) continue;
    const c = cells.find((x) => Math.abs(x.twa - twa) < 1e-9 && x.value != null);
    if (!c) continue;
    const vmg = Math.abs(c.vmg);
    around.push({
      twa: c.twa,
      delta: d,
      speed: c.value,
      vmg,
      n: c.n,
      dVmg: vmg - target.vmg,
      dPct: target.vmg ? (100 * (vmg - target.vmg)) / target.vmg : null,
    });
  }
  return Object.assign({}, target, { around });
}

// Le nuage de points d'une case, pour l'inspection et le tri des aberrants
// dans la webapp.
function cellPoints(runs, opts, ws, twa) {
  const { cells } = bucket(runs, opts);
  const pts = cells.get(`${ws}|${twa}`) || [];
  return pts.map((p) => ({
    id: p.id,
    ts: p.run.ts,
    speed: p.speed,
    ws: p.ws,
    wa: p.wa,
    sog: p.run.sog,
    stw: p.run.stw,
    tws: p.run.tws,
    twa: p.run.twa,
    aws: p.run.aws,
    awa: p.run.awa,
    roll: p.run.roll,
    pitch: p.run.pitch,
    // L'amplitude du tangage, pas un verdict : le seuil qui la transforme en
    // mot peut changer, la mesure non.
    pitchSpread: p.run.metrics ? p.run.metrics.pitchSpread : null,
    quality: p.run.metrics ? p.run.metrics.quality : null,
    n: p.run.n,
    sail: effectiveSail(p.run, opts && opts.sailRanges),
    sailRecorded: normalizeSail(p.run.sail),
    engineSource: p.run.engineSource,
    // D'où vient ce point : mesuré en direct, ou reconstruit depuis
    // l'historique du serveur. Inspecter une case suspecte sans pouvoir le
    // savoir, ce serait un chiffre qu'on ne peut pas recouper.
    origin: p.run.origin || null,
    res: p.run.res || null,
  }));
}

// Tous les points d'un bin de force, en (angle, vitesse) — c'est le nuage que
// la webapp superpose à la courbe pour montrer sur quoi elle est bâtie.
function scatter(runs, opts, ws) {
  const { cells } = bucket(runs, opts);
  const out = [];
  for (const [key, pts] of cells) {
    const [w] = key.split('|');
    if (Number(w) !== ws) continue;
    for (const p of pts) out.push({ id: p.id, wa: p.wa, speed: p.speed, ws: p.ws, ts: p.run.ts });
  }
  return out;
}

// ── Où en est-on, là, tout de suite ────────────────────────────────────────
//
// La polaire répond « ce que le bateau sait faire ». En nav la question est
// l'inverse : « ce qu'il fait en ce moment vaut-il ce qu'il sait faire ? ».
// On lit donc la courbe au point (force, angle) du moment.
//
// Deux règles. On interpole, parce que le vent ne tombe jamais pile au centre
// d'une case et qu'arrondir à la case voisine ferait sauter le repère d'un
// demi-nœud pour un demi-nœud de vent. Et on n'invente rien : hors des cases
// mesurées la réponse est « on n'a jamais navigué là », qui est une
// information en soi — c'est précisément là qu'il reste à naviguer.
function valueAtAngle(bin, twa, step) {
  const lo = Math.floor(twa / step) * step;
  const at = (a) => bin.cells.find((c) => Math.abs(c.twa - a) < 1e-9 && c.value != null) || null;
  const cl = at(lo);
  const ch = at(lo + step);
  if (cl && ch) {
    const t = (twa - lo) / step;
    return { value: cl.value * (1 - t) + ch.value * t, n: (cl.n || 0) + (ch.n || 0), twa: Math.round(twa) };
  }
  const only = cl || ch;
  // Une seule des deux cases est mesurée : elle vaut comme repère si c'est
  // bien celle dans laquelle on se trouve, pas au-delà. Prolonger une courbe
  // à travers une case vide, c'est dessiner une mesure qui n'existe pas.
  if (!only || Math.abs(twa - only.twa) > step / 2) return null;
  return { value: only.value, n: only.n || 0, twa: only.twa };
}

function referenceAt(polar, ws, wa) {
  if (!polar || !polar.bins || typeof ws !== 'number' || typeof wa !== 'number') return null;
  const twa = Math.abs(wrap180(wa));
  const step = polar.twaStep || 5;
  // Seules comptent les bandes de vent qui ont VRAIMENT une mesure à cette
  // allure : encadrer le vent du moment entre deux bandes mesurées est une
  // interpolation, même si une bande vide traîne entre les deux. Le sauter
  // n'invente rien, le prolonger au-delà de la dernière mesurée, si.
  const measured = [...polar.bins]
    .sort((a, b) => a.ws - b.ws)
    .map((bin) => ({ bin, v: valueAtAngle(bin, twa, step) }))
    .filter((x) => x.v);
  if (!measured.length) return null;
  let below = null;
  let above = null;
  for (const x of measured) {
    if (x.bin.ws <= ws) below = x;
    if (x.bin.ws >= ws && !above) above = x;
  }
  const one = (x) => ({
    value: x.v.value,
    n: x.v.n,
    weak: x.v.n < 3,
    twa: Math.round(twa),
    ws,
    from: [{ ws: x.bin.ws, twa: x.v.twa, value: x.v.value, n: x.v.n }],
  });
  if (below && above && below !== above) {
    const t = (ws - below.bin.ws) / (above.bin.ws - below.bin.ws);
    const n = below.v.n + above.v.n;
    return {
      value: below.v.value * (1 - t) + above.v.value * t,
      n,
      weak: n < 3,
      twa: Math.round(twa),
      ws,
      from: [
        { ws: below.bin.ws, twa: below.v.twa, value: below.v.value, n: below.v.n },
        { ws: above.bin.ws, twa: above.v.twa, value: above.v.value, n: above.v.n },
      ],
    };
  }
  // Pas d'encadrement : on est au-dessus de la plus forte bande mesurée, ou
  // au-dessous de la plus faible. La bande la plus proche ne vaut que si le
  // vent du moment tombe dedans — au-delà, il n'y a pas de repère, et le dire
  // vaut mieux que d'étirer la voisine.
  const x = below || above;
  if (ws < x.bin.lo || ws >= x.bin.hi) return null;
  return one(x);
}

// ── Changer de voilure : qu'est-ce que ça donnerait ? ──────────────────────
//
// Le filtre de voilure sait déjà tracer une courbe par configuration, mais il
// répond à la mauvaise question en nav. Ce qu'on veut savoir n'est pas « à
// quoi ressemble la polaire sous un ris » mais « ici, dans ce vent, à cette
// allure, qu'ont donné les autres configurations ». On regroupe donc par
// voilure les mesures du VOISINAGE du point courant, pas toute la polaire.
//
// Ce n'est pas une expérience : les configurations n'ont pas été navigées au
// même moment ni dans la même mer, et on ne peut pas les rejouer. Chaque
// ligne porte donc son nombre de mesures, le vent moyen réellement rencontré
// et la date de la dernière — de quoi juger si la comparaison tient. Un
// classement seul aurait l'air sûr précisément parce qu'il est court.
function sailCompare(runs, opts, center) {
  const o = Object.assign({}, DEFAULTS, opts);
  const statFn = STATS[o.stat] || STATS.mean;
  const excluded = o.excluded instanceof Set ? o.excluded : new Set(o.excluded || []);
  const ws = Number(center.ws);
  const twa = Math.abs(wrap180(Number(center.twa)));
  const dws = center.dws != null ? Number(center.dws) : 2;
  const dtwa = center.dtwa != null ? Number(center.dtwa) : 20;
  const out = { center: { ws, twa, dws, dtwa }, rows: [], n: 0, scanned: runs.length };
  if (isNaN(ws) || isNaN(twa)) return out;

  const groups = new Map();
  for (const run of runs) {
    if (excluded.has(run.id)) continue;
    if (o.excludeDeclared && run.engineSource === 'declared') continue;
    if (o.excludeHistory && run.origin === 'history') continue;
    // Le filtre de voilure de la webapp est délibérément ignoré : on compare
    // justement les voilures entre elles, le filtrer viderait la question.
    const p = project(run, o);
    if (!p) continue;
    if (Math.abs(p.ws - ws) > dws) continue;
    const a = Math.abs(p.wa);
    if (Math.abs(a - twa) > dtwa) continue;
    const sail = effectiveSail(run, o.sailRanges);
    const key = `${sail.main}|${sail.head}`;
    if (!groups.has(key)) groups.set(key, { key, sail, speeds: [], twas: [], wss: [], lastTs: 0 });
    const gr = groups.get(key);
    gr.speeds.push(p.speed);
    gr.twas.push(a);
    gr.wss.push(p.ws);
    gr.lastTs = Math.max(gr.lastTs, run.ts || run.id || 0);
    out.n++;
  }

  out.rows = [...groups.values()]
    .map((gr) => {
      const value = statFn(gr.speeds);
      const twaMean = mean(gr.twas);
      return {
        key: gr.key,
        sail: gr.sail,
        n: gr.speeds.length,
        value,
        mean: mean(gr.speeds),
        median: median(gr.speeds),
        p90: percentile(gr.speeds, 0.9),
        max: Math.max(...gr.speeds),
        sd: stdev(gr.speeds),
        vmg: value * Math.cos((twaMean * Math.PI) / 180),
        twaMean,
        twsMean: mean(gr.wss),
        twsMin: Math.min(...gr.wss),
        twsMax: Math.max(...gr.wss),
        lastTs: gr.lastTs,
      };
    })
    .sort((a, b) => b.value - a.value);
  return out;
}

// ── Exports ────────────────────────────────────────────────────────────────
// Format .pol : angles en lignes, forces en colonnes, séparateur tabulation.
// C'est ce qu'avalent qtVlm, OpenCPN (WeatherRouting) et Expedition.
function toPol(polar) {
  const angles = polar.bins[0].cells.map((c) => c.twa);
  const header = ['twa/tws', ...polar.bins.map((b) => b.ws)].join('\t');
  const lines = [header];
  for (let i = 0; i < angles.length; i++) {
    const twa = angles[i];
    const row = polar.bins.map((b) => {
      const v = b.cells[i].value;
      return v == null ? '0' : v.toFixed(2);
    });
    if (row.every((v) => v === '0')) continue; // pas de ligne vide inutile
    lines.push([twa, ...row].join('\t'));
  }
  return lines.join('\n') + '\n';
}

// Format Jieter : la même matrice que .pol, mais séparateur point-virgule, un
// en-tête en commentaire, et deux séries de lignes de cible VMG en fin de
// table — une seule valeur non nulle par ligne, ce que l'importateur range en
// beat/run. C'est ce qu'avale signalk-polar-management, et l'écosystème ORC
// (github.com/jieter/orc-data).
function toJieter(polar) {
  const angles = polar.bins[0].cells.map((c) => c.twa);
  // Seulement les bandes de vent réellement étayées : l'importateur de
  // signalk-polar-management refuse toute la table si une colonne TWS est
  // entièrement vide (« Each TWS column must contain at least one positive
  // boat speed »).
  const bins = polar.bins.filter((b) => b.cells.some((c) => c.value != null));
  const twsList = bins.map((b) => b.ws);
  if (!bins.length) return `# signalk-autopolar — no data\ntwa/tws\n`;
  const lines = [
    `# signalk-autopolar — ${polar.speed.toUpperCase()} / ${polar.wind} wind / ${polar.stat} per cell`,
    ['twa/tws', ...twsList].join(';'),
  ];
  for (let i = 0; i < angles.length; i++) {
    const row = bins.map((b) => {
      const v = b.cells[i].value;
      return v == null ? '0' : v.toFixed(2);
    });
    if (row.every((v) => v === '0')) continue; // pas de ligne vide inutile
    lines.push([angles[i], ...row].join(';'));
  }
  // Une ligne de cible par bande de vent : angle en colonne 0, vitesse dans la
  // seule colonne de cette bande. L'importateur lit « une valeur => cible »,
  // beat si l'angle est au près, run au portant.
  for (const kind of ['upwind', 'downwind']) {
    bins.forEach((b, col) => {
      const t = b.targets && b.targets[kind];
      if (!t || t.speed == null) return;
      const row = twsList.map((_, j) => (j === col ? t.speed.toFixed(2) : ''));
      lines.push([t.twa, ...row].join(';'));
    });
  }
  return lines.join('\n') + '\n';
}

// Format canonique polar-format (github.com/…/polar-format) : document JSON
// auto-descriptif, unités SI (m/s, radians), matrice indexée
// [bande de vent][angle], symétrie bâbord/tribord implicite. C'est ce que
// stocke signalk-polar-management ; on le construit ici pour le lui passer en
// direct, sans fichier intermédiaire.
const KN_TO_MS = 1 / 1.94384; // même facteur que polar-format
const DEG_TO_RAD = Math.PI / 180;
const clampPi = (r) => Math.min(r, Math.PI);

function toCanonical(polar, meta = {}) {
  const allAngles = polar.bins[0].cells.map((c) => c.twa);
  const hasAny = polar.bins.some((b) => b.cells.some((c) => c.value != null));
  if (!hasAny) {
    throw new Error('polaire vide : aucune case mesurée à envoyer');
  }
  // On ne garde que les bandes de vent exploitables : au moins une mesure au
  // près (< 90°) ET une au portant (>= 90°). Une bande qui n'a que l'un des
  // deux bords n'a pas de VMG calculable de l'autre côté — polar-math renvoie
  // alors une cible à `null` que les consommateurs (signalk-polar-management,
  // routeurs) déréférencent sans garde. On préfère livrer une polaire plus
  // courte mais qui s'affiche partout. Les bandes écartées restent dans les
  // exports .pol / Jieter / CSV, qui n'ont pas cette contrainte.
  const usable = (b) =>
    b.cells.some((c) => c.value != null && c.twa < 90) &&
    b.cells.some((c) => c.value != null && c.twa >= 90);
  const bins = polar.bins.filter(usable);
  const cols = [];
  for (let j = 0; j < allAngles.length; j++) {
    if (bins.some((b) => b.cells[j].value != null)) cols.push(j);
  }
  if (!bins.length || !cols.length) {
    throw new Error(
      'polaire inexploitable : aucune bande de vent avec des mesures au près ET au portant'
    );
  }
  const tws = bins.map((b) => b.ws * KN_TO_MS);
  const twa = cols.map((j) => clampPi(allAngles[j] * DEG_TO_RAD));
  const boatSpeedMatrix = bins.map((b) =>
    cols.map((j) => {
      const v = b.cells[j].value;
      return v == null ? 0 : Math.max(0, v * KN_TO_MS);
    })
  );
  const target = (t) =>
    t && t.speed != null
      ? {
          twa: clampPi(t.twa * DEG_TO_RAD),
          tbs: Math.max(0, t.speed * KN_TO_MS),
          vmg: Math.abs(t.vmg || 0) * KN_TO_MS,
        }
      : null;
  const rows = bins.map((b, i) => ({
    tws: tws[i],
    beat: target(b.targets && b.targets.upwind),
    run: target(b.targets && b.targets.downwind),
  }));

  const doc = {
    kind: 'polarTable',
    schemaVersion: '1.0.0',
    units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
    symmetry: { portStarboardSymmetric: true },
    axes: { tws, twa },
    values: { boatSpeedMatrix },
    derived: { rows },
  };
  const name = String(meta.name || '').trim();
  const boatType = String(meta.boatType || '').trim();
  if (name) doc.name = name;
  if (boatType) doc.boatType = boatType;
  doc.source = 'signalk-autopolar';
  if (meta.notes) doc.notes = String(meta.notes);

  const err = validateCanonicalShape(doc);
  if (err) throw new Error(`polaire invalide : ${err}`);
  return doc;
}

// Les règles sémantiques de polar-format (axes strictement croissants,
// dimensions de la matrice, plage 0..π, vitesses positives) en une poignée de
// lignes et sans dépendance : de quoi refuser tôt un document que
// signalk-polar-management rejetterait de toute façon — mais dont il avale
// l'erreur en interne (le setResource du serveur SignalK n'attend pas le
// fournisseur et ne propage pas son rejet).
function validateCanonicalShape(doc) {
  const inc = (a) => a.every((v, i) => i === 0 || v > a[i - 1]);
  const { tws, twa } = doc.axes;
  if (!tws.length || !twa.length) return 'axe vide';
  if (!tws.every((v) => v > 0 && Number.isFinite(v))) return 'TWS <= 0';
  if (!inc(tws)) return 'axe TWS non strictement croissant';
  if (!inc(twa)) return 'axe TWA non strictement croissant';
  if (twa.some((v) => v < 0 || v > Math.PI)) return 'TWA hors 0..π';
  const m = doc.values.boatSpeedMatrix;
  if (m.length !== tws.length) return 'lignes de matrice ≠ axe TWS';
  if (m.some((r) => r.length !== twa.length)) return 'colonnes de matrice ≠ axe TWA';
  if (m.some((r) => r.some((v) => !Number.isFinite(v) || v < 0))) return 'vitesse négative ou non finie';
  return null;
}

// CSV lisible : la même chose, mais avec le nombre d'échantillons derrière
// chaque valeur — pour savoir sur quoi on met les pieds.
function toCsv(polar) {
  const angles = polar.bins[0].cells.map((c) => c.twa);
  const head = ['twa', ...polar.bins.flatMap((b) => [`${b.ws}kn`, `${b.ws}kn_n`])].join(',');
  const lines = [head];
  for (let i = 0; i < angles.length; i++) {
    const row = polar.bins.flatMap((b) => {
      const c = b.cells[i];
      return [c.value == null ? '' : c.value.toFixed(2), c.n || ''];
    });
    if (row.every((v) => v === '')) continue;
    lines.push([angles[i], ...row].join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  normalizeSail,
  effectiveSail,
  buildPolar,
  referenceAt,
  sailCompare,
  cellPoints,
  scatter,
  toPol,
  toJieter,
  toCanonical,
  validateCanonicalShape,
  toCsv,
  windBinEdges,
  twaCenters,
  findTwaBin,
  findWindBin,
  DEFAULTS,
};
