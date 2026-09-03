// Primitives numériques partagées : conversions d'unités, statistiques
// circulaires (un cap ou un angle de vent ne se moyenne pas comme un nombre :
// 350° et 10° font 0°, pas 180°) et calcul du vent vrai.
//
// Tout ce fichier est pur et sans dépendance : c'est la partie qu'on teste
// hors bateau, sans SignalK.

const MS_TO_KN = 1.94384;
const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

// Ramène un angle en degrés dans ]-180, 180] — la convention utilisée partout
// ici pour les angles de vent (négatif = bâbord amure, vent venant de gauche).
// Le plein vent arrière vaut donc +180 et jamais -180 : sans ça, le vent
// dans l'axe bascule de signe d'une seconde à l'autre et déclenche de faux
// changements d'amure.
function wrap180(deg) {
  const r = ((((deg + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
}

// Ramène dans [0, 360[ — pour les caps.
function wrap360(deg) {
  return ((deg % 360) + 360) % 360;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Percentile par interpolation linéaire (p entre 0 et 1).
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
}

function spread(arr) {
  return Math.max(...arr) - Math.min(...arr);
}

// Moyenne circulaire : on moyenne les vecteurs unitaires, pas les nombres.
function meanAngle(degs) {
  const x = mean(degs.map((d) => Math.cos(d * D2R)));
  const y = mean(degs.map((d) => Math.sin(d * D2R)));
  return Math.atan2(y, x) * R2D;
}

// Étendue circulaire : le plus grand écart à la moyenne circulaire, doublé.
// C'est ce qu'on veut pour dire « le cap n'a pas bougé de plus de X° sur la
// fenêtre » sans se faire piéger par un passage par le nord.
function spreadAngle(degs) {
  if (degs.length < 2) return 0;
  const m = meanAngle(degs);
  let maxDev = 0;
  for (const d of degs) maxDev = Math.max(maxDev, Math.abs(wrap180(d - m)));
  return maxDev * 2;
}

// Vent vrai à partir de l'apparent et de la vitesse du bateau.
// Utilisé UNIQUEMENT en repli, quand le serveur ne publie pas déjà
// environment.wind.angleTrueWater / speedTrue (signalk-derived-data le fait
// sur JazzyPI). Convention : awaDeg signé, résultat signé du même bord.
//   boatKn = STW  -> vent vrai « surface » (angleTrueWater / speedTrue)
//   boatKn = SOG  -> vent vrai « sol »     (angleTrueGround / speedOverGround)
function trueWind(awaDeg, awsKn, boatKn) {
  const a = awaDeg * D2R;
  const x = awsKn * Math.cos(a) - boatKn; // composante axiale
  const y = awsKn * Math.sin(a); // composante latérale
  return {
    tws: Math.hypot(x, y),
    twa: Math.atan2(y, x) * R2D,
  };
}

module.exports = {
  MS_TO_KN,
  R2D,
  D2R,
  wrap180,
  wrap360,
  mean,
  median,
  percentile,
  stdev,
  spread,
  meanAngle,
  spreadAngle,
  trueWind,
};
