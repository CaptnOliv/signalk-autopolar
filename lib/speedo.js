// Diagnostic du speedo : la vitesse surface est-elle juste ?
//
// Sur une nav, l'écart entre vitesse surface et vitesse fond a deux causes
// possibles, et elles ne se corrigent pas du tout de la même façon :
//
//   — un COURANT. Le bateau dérive sur l'eau : l'écart est un vecteur à peu
//     près fixe DANS LE REPÈRE TERRESTRE. Il n'y a rien à corriger sur le
//     capteur, et la polaire STW est la bonne.
//   — une ERREUR DE SPEEDO. La roue à aubes lit faux : l'écart est un vecteur
//     fixe DANS LE REPÈRE DU BATEAU, toujours dans l'axe. C'est le capteur
//     qu'il faut calibrer, et c'est la polaire SOG qui est la bonne.
//
// Le discriminant est donc la concentration circulaire de la direction du
// « courant implicite » (route fond − route eau) dans chacun des deux
// repères. Elle n'a de sens que si le bateau a suivi des caps variés : sur un
// seul bord les deux repères se confondent et le test ne conclut rien. On le
// dit alors explicitement plutôt que de trancher au hasard.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// Longueur du vecteur résultant d'un jeu d'angles : 1 = tous alignés, 0 =
// dispersés uniformément. C'est la mesure standard de concentration d'une
// distribution circulaire, et elle se compare directement entre les deux
// repères puisqu'elle porte sur les mêmes points.
function concentration(anglesDeg) {
  if (!anglesDeg.length) return 0;
  let x = 0;
  let y = 0;
  for (const a of anglesDeg) {
    x += Math.cos(a * D2R);
    y += Math.sin(a * D2R);
  }
  return Math.hypot(x, y) / anglesDeg.length;
}

function meanAngle(anglesDeg) {
  if (!anglesDeg.length) return null;
  let x = 0;
  let y = 0;
  for (const a of anglesDeg) {
    x += Math.cos(a * D2R);
    y += Math.sin(a * D2R);
  }
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Route fond moins route eau. La route eau est prise le long du cap : la
// dérive du bateau la fait tourner de quelques degrés, ce qui ajoute du bruit
// mais ne déplace pas la conclusion (elle porte sur une concentration, pas
// sur une direction précise).
function impliedCurrent(run) {
  if (![run.sog, run.stw, run.cog, run.hdg].every((v) => typeof v === 'number')) return null;
  const gx = run.sog * Math.sin(run.cog * D2R);
  const gy = run.sog * Math.cos(run.cog * D2R);
  const wx = run.stw * Math.sin(run.hdg * D2R);
  const wy = run.stw * Math.cos(run.hdg * D2R);
  const cx = gx - wx;
  const cy = gy - wy;
  const dir = (Math.atan2(cx, cy) * R2D + 360) % 360;
  return { mag: Math.hypot(cx, cy), dir, rel: (dir - run.hdg + 360 + 360) % 360 };
}

const DEFAULTS = {
  minSogKn: 1.5, // en dessous, le rapport des deux vitesses n'est que du bruit
  minMagKn: 0.3, // écart trop petit : sa direction ne veut rien dire
  binKn: 1, // largeur des paliers de la table de correction
  minPerBin: 5,
};

function analyse(runs, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const used = runs.filter(
    (r) =>
      typeof r.sog === 'number' &&
      typeof r.stw === 'number' &&
      r.sog >= o.minSogKn &&
      r.stw >= o.minSogKn
  );

  // ── Ajustements globaux ──────────────────────────────────────────────────
  let gain = null;
  let gainRmse = null;
  let affine = null;
  if (used.length >= 5) {
    const sxx = used.reduce((a, r) => a + r.stw * r.stw, 0);
    const sxy = used.reduce((a, r) => a + r.stw * r.sog, 0);
    gain = sxy / sxx;
    gainRmse = Math.sqrt(used.reduce((a, r) => a + (r.sog - gain * r.stw) ** 2, 0) / used.length);

    const n = used.length;
    const sx = used.reduce((a, r) => a + r.stw, 0);
    const sy = used.reduce((a, r) => a + r.sog, 0);
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const a0 = (sy - b * sx) / n;
    affine = {
      slope: b,
      offset: a0,
      rmse: Math.sqrt(used.reduce((a, r) => a + (r.sog - (a0 + b * r.stw)) ** 2, 0) / n),
    };
  }

  // ── Courant ou speedo ? ──────────────────────────────────────────────────
  const cur = [];
  for (const r of used) {
    const c = impliedCurrent(r);
    if (c && c.mag >= o.minMagKn) cur.push(c);
  }
  const relDirs = cur.map((c) => c.rel);
  const absDirs = cur.map((c) => c.dir);
  const headings = used.map((r) => r.hdg).filter((h) => typeof h === 'number');
  const boatFrame = concentration(relDirs);
  const earthFrame = concentration(absDirs);
  const headingSpread = 1 - concentration(headings); // 0 = un seul bord

  // Second test, indépendant du premier et — c'est tout son intérêt — valable
  // même sur un seul bord : un courant décale la route d'un nombre de nœuds
  // à peu près CONSTANT, quelle que soit la vitesse du bateau. Une erreur
  // d'échelle du speedo, elle, décale d'un écart PROPORTIONNEL à la vitesse.
  // On ajuste donc les deux modèles sur l'écart mesuré et on regarde lequel
  // explique le mieux les données.
  const pairs = used
    .filter((r) => typeof r.stw === 'number')
    .map((r) => ({ x: r.stw, y: r.stw - r.sog }));
  let scaling = null;
  if (pairs.length >= 10) {
    const cst = pairs.reduce((a, p) => a + p.y, 0) / pairs.length;
    const rmseConst = Math.sqrt(pairs.reduce((a, p) => a + (p.y - cst) ** 2, 0) / pairs.length);
    const k = pairs.reduce((a, p) => a + p.x * p.y, 0) / pairs.reduce((a, p) => a + p.x * p.x, 0);
    const rmseProp = Math.sqrt(pairs.reduce((a, p) => a + (p.y - k * p.x) ** 2, 0) / pairs.length);
    scaling = {
      constantKn: cst,
      rmseConstant: rmseConst,
      slope: k,
      rmseProportional: rmseProp,
      favours: rmseProp < rmseConst * 0.9 ? 'speedo' : rmseConst < rmseProp * 0.9 ? 'current' : 'tie',
      speedSpread: Math.max(...pairs.map((p) => p.x)) - Math.min(...pairs.map((p) => p.x)),
    };
  }

  // Verdict combiné. Les deux tests ont des angles morts différents (le
  // premier a besoin de caps variés, le second de vitesses variées), donc
  // deux tests d'accord valent bien plus que l'un des deux tout seul — et
  // quand ils se contredisent, on le dit au lieu de choisir.
  const frames =
    cur.length < 20 || headingSpread < 0.15
      ? null
      : boatFrame > earthFrame + 0.15
      ? 'speedo'
      : earthFrame > boatFrame + 0.15
      ? 'current'
      : 'tie';
  const scales = scaling && scaling.speedSpread >= 2 ? scaling.favours : null;

  let verdict;
  if (frames && scales && frames !== 'tie' && scales !== 'tie') verdict = frames === scales ? frames : 'conflicting';
  else if (frames && frames !== 'tie') verdict = frames;
  else if (scales && scales !== 'tie') verdict = scales;
  else verdict = 'inconclusive';

  const diagnosis = {
    verdict,
    frames,
    scales,
    boatFrame,
    earthFrame,
    headingSpread,
    scaling,
    n: cur.length,
    meanRelDir: meanAngle(relDirs),
    meanAbsDir: meanAngle(absDirs),
    medianMagKn: median(cur.map((c) => c.mag)),
  };

  // ── Table de correction empirique ────────────────────────────────────────
  // Aucun modèle imposé : on prend la médiane du rapport observé par palier
  // de vitesse indiquée. Une roue à aubes dérive rarement de façon linéaire,
  // et c'est précisément ce que la table multi-points du DST810 sait corriger.
  const byBin = new Map();
  for (const r of used) {
    const lo = Math.floor(r.stw / o.binKn) * o.binKn;
    if (!byBin.has(lo)) byBin.set(lo, []);
    byBin.get(lo).push(r);
  }
  const table = [...byBin.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lo, rs]) => ({
      lo,
      hi: lo + o.binKn,
      n: rs.length,
      stw: median(rs.map((r) => r.stw)),
      sog: median(rs.map((r) => r.sog)),
      factor: median(rs.map((r) => r.sog / r.stw)),
      enough: rs.length >= o.minPerBin,
    }));

  const solid = table.filter((t) => t.enough);
  return {
    n: used.length,
    total: runs.length,
    gain,
    gainRmse,
    affine,
    diagnosis,
    table,
    curve: solid.map((t) => ({ stw: t.stw, factor: t.factor, n: t.n })),
    coverage: solid.length ? { from: solid[0].lo, to: solid[solid.length - 1].hi } : null,
  };
}

// Facteur de correction à une vitesse donnée : interpolation linéaire entre
// les paliers mesurés, extrapolation plate au-delà. On n'invente pas de
// tendance là où on n'a pas navigué — au-delà du dernier palier mesuré, on
// garde le dernier facteur connu plutôt que de prolonger une pente.
function factorAt(curve, stw) {
  if (!curve || !curve.length || typeof stw !== 'number') return 1;
  if (stw <= curve[0].stw) return curve[0].factor;
  if (stw >= curve[curve.length - 1].stw) return curve[curve.length - 1].factor;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (stw <= b.stw) {
      const t = (stw - a.stw) / (b.stw - a.stw || 1);
      return a.factor + t * (b.factor - a.factor);
    }
  }
  return 1;
}

const correct = (curve, stw) => (typeof stw === 'number' ? stw * factorAt(curve, stw) : null);

// ── Pont vers airmar-dst810-auto-calibration ──────────────────────────────
// Ce plugin-là collecte les mêmes couples (STW indiquée, vitesse réelle) mais
// seulement par vent calme, pour remplir la table avancée du DST810. Nos
// points de nav sont exactement la même matière ; plutôt que de recopier des
// chiffres à la main, on les exporte dans SON format de journal, à concaténer
// à son runs.jsonl.
//
// `corr` y est l'écart en nœuds (SOG − STW), et la ligne de gîte suit sa
// convention (0 implicite, sinon l'angle le plus proche suffixé du bord).
const AIRMAR_SPEED_COLUMNS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const AIRMAR_HEEL_ANGLES = [10, 20];

function heelRow(rollDeg, heelAnglesDeg, rollSign) {
  if (typeof rollDeg !== 'number') return '0.0°';
  const signed = rollDeg * (rollSign || 1);
  const abs = Math.abs(signed);
  const side = signed >= 0 ? 'S' : 'P';
  let nearest = 0;
  for (const a of heelAnglesDeg) if (Math.abs(abs - a) < Math.abs(abs - nearest)) nearest = a;
  return nearest === 0 ? '0.0°' : `${nearest.toFixed(1)}°${side}`;
}

function speedColumn(stwKn, columns) {
  let nearest = columns[0];
  for (const s of columns) if (Math.abs(stwKn - s) < Math.abs(stwKn - nearest)) nearest = s;
  return nearest;
}

function toAirmarRuns(runs, opts) {
  const o = Object.assign({ rollSign: 1, speedColumns: AIRMAR_SPEED_COLUMNS, heelAngles: AIRMAR_HEEL_ANGLES, minSogKn: DEFAULTS.minSogKn }, opts);
  const lines = [];
  for (const r of runs) {
    if (typeof r.sog !== 'number' || typeof r.stw !== 'number') continue;
    if (r.sog < o.minSogKn || r.stw < o.minSogKn) continue;
    lines.push(
      JSON.stringify({
        kind: 'calm',
        ts: r.ts,
        heelRow: heelRow(r.roll, o.heelAngles, o.rollSign),
        speedCol: speedColumn(r.stw, o.speedColumns),
        stw: r.stw,
        sog: r.sog,
        corr: r.sog - r.stw,
        via: 'signalk-autopolar',
      })
    );
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

// La même chose lue comme une table : une ligne par colonne de vitesse du
// DST810, à recopier dans l'appli Airmar. Une colonne jamais parcourue reste
// vide — on ne remplit pas une case qu'on n'a pas mesurée.
function toCalibrationCsv(analysis, columns) {
  const cols = columns || AIRMAR_SPEED_COLUMNS;
  const lines = ['stw_shown_kn,real_speed_kn,factor,error_kn,n'];
  for (const c of cols) {
    const bin = analysis.table.find((t) => c >= t.lo && c < t.hi && t.enough);
    if (!bin) {
      lines.push(`${c},,,,0`);
      continue;
    }
    const f = factorAt(analysis.curve, c);
    lines.push(`${c},${(c * f).toFixed(2)},${f.toFixed(4)},${(c * f - c).toFixed(2)},${bin.n}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  analyse,
  factorAt,
  correct,
  concentration,
  impliedCurrent,
  toAirmarRuns,
  toCalibrationCsv,
  AIRMAR_SPEED_COLUMNS,
  DEFAULTS,
};
