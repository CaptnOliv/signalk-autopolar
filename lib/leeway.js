// La dérive : l'angle entre là où le bateau pointe et là où il va vraiment.
//
// Le problème qu'il résout, en une phrase : c'est bien beau d'être à 35° du
// vent, si la route sur le fond est à 45° ça ne vaut pas mieux qu'un bateau
// qui navigue à 42° sans déraper. Une polaire qui ignore la dérive fait
// gagner au pinçage un avantage qu'il n'a pas — et c'est précisément quand on
// pince que le bateau dérive le plus.
//
// La mesure existe déjà dans chaque point collecté : `cog - hdg`. Rien à
// collecter de neuf, c'est une lecture de plus des mêmes données, comme les
// quatre polaires de lib/polar.js.
//
// Mais cet écart mélange TROIS causes, dont une seule nous intéresse :
//
//   — la DÉRIVE du bateau. Elle est perpendiculaire à la quille, donc elle
//     CHANGE DE SIGNE AVEC L'AMURE : bâbord amure le bateau part sur la
//     droite de son cap, tribord amure sur la gauche.
//   — le COURANT. Vecteur fixe dans le repère terrestre : il pousse du même
//     côté quelle que soit l'amure, donc il apparaît comme un décalage
//     COMMUN aux deux amures.
//   — l'ERREUR DE COMPAS (déviation, alignement, déclinaison non appliquée).
//     Constante elle aussi, donc indiscernable du courant sur une seule nav —
//     et indiscernable tout court, mais ça n'a pas d'importance : les deux se
//     retirent de la même façon.
//
// D'où la décomposition par symétrie d'amure, seul moyen de séparer ce qui
// appartient au bateau de ce qui appartient à l'endroit où il navigue :
//
//     dérive = (offset bâbord − offset tribord) / 2      ← le bateau
//     biais  = (offset bâbord + offset tribord) / 2      ← le lieu + le compas
//
// Sur un corpus long, le courant finit par s'annuler de lui-même (il tourne,
// on change de zone) et le biais converge vers l'erreur de compas. C'est ce
// qui rend la correction transportable d'un bateau à l'autre : on partage la
// dérive, jamais le biais.
//
// Tout est pur : aucun accès SignalK, aucun état global.

const { wrap180, median, mean, stdev } = require('./geom');

const DEFAULTS = {
  // Au-delà, ce n'est plus de la dérive : c'est un virement pris dans la
  // fenêtre, un GPS qui a décroché, ou un cap qui vient d'une autre source
  // que celle qu'on croit. 25° est large pour un voilier — un dériveur
  // intégral au près serré plafonne vers 10°.
  maxOffsetDeg: 25,
  // Sous cette vitesse, la route fond n'a plus de direction : le GPS rend un
  // cap au hasard et l'écart mesuré n'est que du bruit.
  minSogKn: 1.5,
  minPerCell: 4,
  // Les tranches d'allure du tableau de diagnostic. Larges, parce qu'on les
  // veut peuplées des DEUX amures : c'est la comparaison entre les deux qui
  // porte toute l'information.
  bands: [
    [30, 50],
    [50, 70],
    [70, 100],
    [100, 140],
    [140, 180],
  ],
  // La courbe utilisée pour corriger : fine là où la dérive compte (au près),
  // inutile de raffiner au portant où elle tend vers zéro.
  curveStep: 5,
  curveFrom: 25,
  curveTo: 100,
};

// Une valeur de cap issue d'un compas magnétique dont la déclinaison n'a pas
// été appliquée décale TOUTES les mesures d'un même angle. Le biais l'absorbe,
// donc la dérive reste juste — mais autant le dire, parce que ça se corrige.
const HDG_SOURCES = new Set(['true', 'variation', 'magnetic']);

// Au-delà de cet angle, la dérive est trop petite pour que son signe veuille
// dire quoi que ce soit : c'est le domaine où l'on ne teste plus rien.
const CONSISTENCY_MAX_TWA = 90;

// L'écart brut route fond − cap, signé. null quand il n'est pas mesurable ou
// quand il sort du domaine du plausible : mieux vaut un trou qu'un chiffre
// faux, ici comme ailleurs.
function offsetOf(run, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!run || typeof run.cog !== 'number' || typeof run.hdg !== 'number') return null;
  if (typeof run.sog === 'number' && run.sog < o.minSogKn) return null;
  // Un cap magnétique brut porte la déclinaison en plus de tout le reste.
  // Il reste utilisable — le biais l'absorbe — mais pas mélangeable avec des
  // caps vrais dans le même corpus : deux sources, deux constantes.
  if (run.hdgSrc === 'magnetic') return null;
  const off = wrap180(run.cog - run.hdg);
  if (!Number.isFinite(off) || Math.abs(off) > o.maxOffsetDeg) return null;
  return off;
}

// L'amure telle que la lit la polaire : angle de vent négatif = vent de
// bâbord = bâbord amure. Le portant plein axe n'a pas d'amure exploitable ici.
function tackOf(twa) {
  if (typeof twa !== 'number') return null;
  const a = wrap180(twa);
  if (Math.abs(a) < 5 || Math.abs(a) > 175) return null;
  return a < 0 ? 'port' : 'starboard';
}

// Le signe attendu de la dérive pour une amure donnée : bâbord amure, le vent
// vient de gauche et pousse le bateau vers la droite de son cap.
const expectedSign = (tack) => (tack === 'port' ? 1 : -1);

function pick(runs, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const out = [];
  for (const r of runs) {
    const off = offsetOf(r, o);
    if (off == null) continue;
    const tack = tackOf(r.twa);
    if (!tack) continue;
    out.push({
      off,
      tack,
      twa: Math.abs(wrap180(r.twa)),
      heel: typeof r.roll === 'number' ? Math.abs(r.roll) : null,
      tws: r.tws,
      sog: r.sog,
      ts: r.ts,
    });
  }
  return out;
}

// Décompose un groupe de points en (dérive du bateau, biais commun), à
// condition d'avoir les deux amures. Avec une seule, on ne peut rien séparer
// et on le dit — c'est le même genre d'angle mort que celui de lib/speedo.js
// sur un bateau qui n'a tenu qu'un seul bord.
function split(points, minPerCell) {
  const p = points.filter((x) => x.tack === 'port').map((x) => x.off);
  const s = points.filter((x) => x.tack === 'starboard').map((x) => x.off);
  const row = {
    n: points.length,
    nPort: p.length,
    nStarboard: s.length,
    port: p.length ? median(p) : null,
    starboard: s.length ? median(s) : null,
    leeway: null,
    bias: null,
    se: null,
    both: false,
  };
  if (p.length >= minPerCell && s.length >= minPerCell) {
    row.leeway = (row.port - row.starboard) / 2;
    row.bias = (row.port + row.starboard) / 2;
    // L'incertitude de l'estimation, sans laquelle « 0,8° de dérive au
    // portant » se lit comme une mesure alors que c'est un zéro bruité.
    // Erreur type de chaque amure, composée : c'est ce qui permet d'écrire
    // « 5,1 ± 0,4° » plutôt qu'un chiffre nu.
    const se = (arr) => stdev(arr) / Math.sqrt(arr.length);
    row.se = Math.hypot(se(p), se(s)) / 2;
    row.both = true;
  }
  return row;
}

function analyse(runs, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const pts = pick(runs || [], o);
  const withHdg = (runs || []).filter((r) => typeof r.hdg === 'number' && typeof r.cog === 'number').length;
  const magnetic = (runs || []).filter((r) => r.hdgSrc === 'magnetic').length;

  const bands = o.bands.map(([from, to]) => {
    const sel = pts.filter((x) => x.twa >= from && x.twa < to);
    const heels = sel.map((x) => x.heel).filter((h) => typeof h === 'number');
    return Object.assign({ from, to, heel: heels.length ? median(heels) : null }, split(sel, o.minPerCell));
  });

  // Le biais global : la médiane des biais de bande, pas leur moyenne
  // pondérée. Une bande sur-représentée (le portant, toujours) ne doit pas
  // imposer son courant du jour à toute la nav.
  const usable = bands.filter((b) => b.both);
  const bias = usable.length ? median(usable.map((b) => b.bias)) : null;

  // Une fois le biais retiré, chaque point rend une dérive orientée par son
  // amure. Elle DOIT être positive : un paquet de valeurs négatives signifie
  // que la décomposition ne tient pas (cap faux, courant qui a tourné en
  // cours de nav, trop peu de points).
  //
  // Le contrôle ne porte QUE sur le près et le petit largue. Au portant la
  // dérive est nulle — c'est de la physique, pas un défaut — donc le signe de
  // ce qui reste est un tirage à pile ou face, et compter ces points-là ferait
  // plafonner n'importe quel bateau sain à 50 % de cohérence.
  const b0 = bias == null ? 0 : bias;
  const mags = pts.map((x) => Object.assign({}, x, { mag: (x.off - b0) * expectedSign(x.tack) }));
  const testable = mags.filter((x) => x.twa < CONSISTENCY_MAX_TWA);
  const consistent = testable.length ? testable.filter((x) => x.mag > 0).length / testable.length : 0;

  const curve = [];
  for (let a = o.curveFrom; a < o.curveTo; a += o.curveStep) {
    const sel = mags.filter((x) => x.twa >= a && x.twa < a + o.curveStep);
    if (sel.length < o.minPerCell) continue;
    curve.push({
      twa: a + o.curveStep / 2,
      n: sel.length,
      leeway: median(sel.map((x) => x.mag)),
      heel: (() => {
        const h = sel.map((x) => x.heel).filter((v) => typeof v === 'number');
        return h.length ? median(h) : null;
      })(),
      sog: median(sel.map((x) => x.sog).filter((v) => typeof v === 'number')),
    });
  }

  let verdict;
  if (!withHdg) verdict = 'no_heading';
  else if (pts.length < o.minPerCell * 2) verdict = 'not_enough';
  else if (!usable.length) verdict = 'one_tack';
  else if (testable.length < o.minPerCell * 2) verdict = 'not_enough_upwind';
  else if (consistent < 0.65) verdict = 'inconsistent';
  else verdict = 'ok';

  // La correction n'est proposée que si elle repose sur quelque chose. En
  // dessous, la polaire « sur le fond » n'est pas affichée du tout — une
  // correction devinée serait pire que pas de correction, parce qu'elle
  // aurait l'air mesurée.
  const usableModel = verdict === 'ok' && curve.length >= 2;

  return {
    verdict,
    usable: usableModel,
    n: pts.length,
    total: (runs || []).length,
    withHeading: withHdg,
    magneticHeading: magnetic,
    bias,
    consistent,
    consistentN: testable.length,
    bands,
    curve,
    // La dérive au près, le chiffre qu'on retient : médiane des tranches
    // d'allure sous 60°, là où elle coûte vraiment quelque chose.
    upwind: (() => {
      const up = curve.filter((c) => c.twa <= 60);
      return up.length ? median(up.map((c) => c.leeway)) : null;
    })(),
    meanAbsOffset: pts.length ? mean(pts.map((x) => Math.abs(x.off))) : null,
  };
}

// La dérive à un angle donné : interpolation entre les tranches mesurées,
// extrapolation PLATE au-delà (on ne prolonge pas une pente là où on n'a pas
// navigué — même règle que la courbe du speedo).
function leewayAt(curve, twa) {
  if (!curve || !curve.length || typeof twa !== 'number') return 0;
  const a = Math.abs(wrap180(twa));
  if (a <= curve[0].twa) return curve[0].leeway;
  if (a >= curve[curve.length - 1].twa) return curve[curve.length - 1].leeway;
  for (let i = 1; i < curve.length; i++) {
    const lo = curve[i - 1];
    const hi = curve[i];
    if (a <= hi.twa) {
      const t = (a - lo.twa) / (hi.twa - lo.twa || 1);
      return lo.leeway + t * (hi.leeway - lo.leeway);
    }
  }
  return 0;
}

// L'angle du vent par rapport à la ROUTE SUR LE FOND, pour un point donné.
//
// On retire le biais commun (courant + compas) et on garde la seule dérive du
// bateau : la polaire doit décrire le bateau, pas le courant qu'il y avait ce
// jour-là. Sans ça, une polaire relevée dans un fleuve côtier ne voudrait rien
// dire ailleurs — et n'aurait rien à faire dans un fonds commun.
//
// Convention identique à celle de twa : signé, négatif = vent de bâbord.
function groundTwa(run, model, opts) {
  if (!run || typeof run.twa !== 'number') return null;
  const off = offsetOf(run, opts);
  if (off == null) return null;
  const bias = model && typeof model.bias === 'number' ? model.bias : 0;
  return wrap180(run.twa - (off - bias));
}

module.exports = {
  analyse,
  offsetOf,
  groundTwa,
  leewayAt,
  tackOf,
  HDG_SOURCES,
  DEFAULTS,
};
