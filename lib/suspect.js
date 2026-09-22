// Rattraper le coup : les points déjà enregistrés que le filtre d'aujourd'hui
// n'accepterait plus.
//
// Le garde-fou physique de lib/gate.js (plus vite que le vent vrai, au près)
// ne protège que ce qui entre APRÈS lui. Les points déjà dans `runs.jsonl` —
// et, s'ils ont été reversés, la polaire déjà dans le fonds commun — restent
// tels quels. Un filtre qu'on durcit sans regarder derrière soi laisse la
// pollution exactement là où elle était, et personne ne la retrouve : elle
// n'est visible que comme une case un peu rapide, six mois plus tard, dans un
// routage.
//
// Ce module relit le journal avec la règle du jour et rend la liste des
// coupables, par case, avec leurs identifiants. Ce qu'on en fait est une
// décision d'équipage — on propose de les EXCLURE (overrides.json, réversible,
// conservé par un rejeu du brut) plutôt que de les effacer : la mesure a eu
// lieu, c'est son interprétation qui était fausse.

const { UPWIND_TWA_DEG } = require('./gate');

// `runs` tels que le store les garde, en unités marines (voir lib/habits.js).
function findSuspect(runs, opts) {
  const o = Object.assign({ ratio: 1, maxTwa: UPWIND_TWA_DEG }, opts);
  const excluded = o.excluded instanceof Set ? o.excluded : new Set(o.excluded || []);
  const out = { points: 0, seconds: 0, ids: [], alreadyExcluded: 0, worst: null, bands: [] };
  if (!(o.ratio > 0)) return out;

  const byBand = new Map();
  for (const r of runs || []) {
    if (!r || typeof r.tws !== 'number' || typeof r.sog !== 'number' || typeof r.twa !== 'number') continue;
    if (!(r.tws > 0)) continue;
    if (Math.abs(r.twa) > o.maxTwa) continue;
    if (!(r.sog > r.tws * o.ratio)) continue;
    // Un point déjà écarté à la main n'est plus un problème ; il reste compté
    // à part, pour que « il n'en reste plus » ne se confonde pas avec « il n'y
    // en a jamais eu ».
    if (excluded.has(r.id)) {
      out.alreadyExcluded++;
      continue;
    }
    const ratio = r.sog / r.tws;
    out.points++;
    out.seconds += r.n || 0;
    out.ids.push(r.id);
    if (!out.worst || ratio > out.worst.ratio)
      out.worst = { ratio, sog: r.sog, tws: r.tws, twa: Math.round(Math.abs(r.twa)), ts: r.ts };
    // Le vent arrondi au nœud : ce qu'on veut lire est « c'est toute la bande
    // 4 nœuds », pas une liste de points.
    const band = Math.round(r.tws);
    byBand.set(band, (byBand.get(band) || 0) + 1);
  }
  out.bands = [...byBand.entries()].map(([tws, points]) => ({ tws, points })).sort((a, b) => a.tws - b.tws);
  return out;
}

module.exports = { findSuspect, UPWIND_TWA_DEG };
