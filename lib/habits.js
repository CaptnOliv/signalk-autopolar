// Comment ce bateau navigue, en chiffres.
//
// Pourquoi c'est dans le plugin et pas dans un carnet : la polaire ne se lit
// pas sans ça. Une moitié de diagramme vide n'est presque jamais un défaut de
// collecte — c'est la nav qu'on a faite. Un bateau qui a passé 83 % de ses
// points au portant a une polaire de près creuse, et aucun réglage de seuil
// n'y changera quoi que ce soit : il faut aller au près. Le bandeau de qualité
// dit « il manque des cases » ; celui-ci dit pourquoi.
//
// Une seule mise en garde, portée par le module lui-même : ces pourcentages
// sont ceux des POINTS RETENUS, pas du temps passé en mer. Le moteur, les
// manœuvres, le mouillage et les régimes instables n'y sont jamais entrés. Ce
// n'est pas le livre de bord, c'est la matière dont la polaire est faite —
// d'où `hours`, qui dit combien de temps ça représente vraiment.

// UNITÉS — la seule chose à savoir pour lire ce fichier, et la seule qui s'y
// soit déjà trompée : un run de `runs.jsonl` est **déjà en unités marines**.
// La conversion depuis le SI est faite une fois pour toutes à la lecture de
// SignalK (`kn()` / `deg()` dans index.js), donc `tws`, `sog` et `aws` sont des
// nœuds et `twa`, `roll` des degrés. Ce module a longtemps re-multiplié par
// 1,94384 : la carte annonçait 22 nœuds de vent médian et 11 nœuds de vitesse
// médiane sur un Oceanis 48, ce qui aurait été une nav mémorable. La règle,
// valable partout hors des exports : **on ne convertit qu'au contact de
// SignalK, jamais à l'intérieur.**

// Les bandes portent les noms qu'on emploie à bord, pas des numéros. Les
// bornes sont en degrés au vent vrai, valeur absolue : une amure ou l'autre,
// c'est la même allure.
const POINTS_OF_SAIL = [
  { key: 'close_hauled', label: 'close-hauled', from: 0, to: 50 },
  { key: 'close_reach', label: 'close reach', from: 50, to: 70 },
  { key: 'beam_reach', label: 'beam reach', from: 70, to: 100 },
  { key: 'broad_reach', label: 'broad reach', from: 100, to: 140 },
  { key: 'running', label: 'running', from: 140, to: 181 },
];

// Découpage pratique, pas Beaufort : ce sont les paliers auxquels on change
// quelque chose à bord.
const WIND_BANDS = [
  { key: 'light', label: 'light', from: 0, to: 6 },
  { key: 'moderate', label: 'moderate', from: 6, to: 12 },
  { key: 'fresh', label: 'fresh', from: 12, to: 18 },
  { key: 'strong', label: 'strong', from: 18, to: 25 },
  { key: 'heavy', label: 'heavy', from: 25, to: 999 },
];

function bandOf(bands, v) {
  for (const b of bands) if (v >= b.from && v < b.to) return b;
  return null;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

// L'heure locale du serveur, qui est celle du bord : un Raspberry Pi sur le
// bateau est à l'heure du bateau. On ne prétend pas mieux.
function isNight(ts) {
  const h = new Date(ts).getHours();
  return h >= 21 || h < 6;
}

function tally(bands, values) {
  const counts = new Map(bands.map((b) => [b.key, 0]));
  let total = 0;
  for (const v of values) {
    const b = bandOf(bands, v);
    if (!b) continue;
    counts.set(b.key, counts.get(b.key) + 1);
    total++;
  }
  return bands.map((b) => ({
    key: b.key,
    label: b.label,
    from: b.from,
    to: b.to === 181 || b.to === 999 ? null : b.to,
    points: counts.get(b.key),
    share: total ? counts.get(b.key) / total : 0,
  }));
}

function summarise(runs) {
  const usable = (runs || []).filter((r) => r && typeof r.twa === 'number' && typeof r.tws === 'number');
  if (!usable.length) return { points: 0 };

  const twa = usable.map((r) => Math.abs(r.twa));
  const twsSeen = usable.map((r) => r.tws);

  // Chaque point vaut la durée de sa fenêtre, et les fenêtres ne se recouvrent
  // pas (elle est vidée dès qu'un point sort). La somme est donc du vrai temps
  // de nav retenu, pas une estimation.
  const seconds = usable.reduce((a, r) => a + (r.n || 0), 0);

  const sog = usable.map((r) => r.sog || 0).sort((a, b) => a - b);
  const tws = twsSeen.slice().sort((a, b) => a - b);
  const heel = usable
    .filter((r) => typeof r.roll === 'number')
    .map((r) => Math.abs(r.roll))
    .sort((a, b) => a - b);

  const port = usable.filter((r) => r.twa < 0).length;
  const night = usable.filter((r) => isNight(r.ts)).length;

  // Le près et le portant, tels que la polaire les découpe : c'est la même
  // frontière que celle des cibles de VMG, donc la phrase sur la couverture
  // dit bien la même chose que le diagramme.
  const upwind = twa.filter((t) => t < 90).length;

  return {
    points: usable.length,
    hours: seconds / 3600,
    from: usable[0].ts,
    to: usable[usable.length - 1].ts,
    pointsOfSail: tally(POINTS_OF_SAIL, twa),
    wind: tally(WIND_BANDS, twsSeen),
    tacks: { port, starboard: usable.length - port },
    // Sans capteur d'attitude, pas de ligne de gîte — plutôt qu'un zéro qui
    // passerait pour une mesure.
    heel: heel.length ? { median: quantile(heel, 0.5), p90: quantile(heel, 0.9) } : null,
    night: { points: night, share: night / usable.length },
    speed: { median: quantile(sog, 0.5), best: sog[sog.length - 1] },
    windSeen: { median: quantile(tws, 0.5), strongest: tws[tws.length - 1] },
    balance: { upwind: upwind / usable.length, downwind: 1 - upwind / usable.length },
  };
}

module.exports = { summarise, tally, bandOf, isNight, POINTS_OF_SAIL, WIND_BANDS };
