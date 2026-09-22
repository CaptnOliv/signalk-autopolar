// lib/suspect.js — les points déjà enregistrés que le filtre d'aujourd'hui
// refuserait.

const assert = require('assert');
const { findSuspect } = require('../lib/suspect');

const run = (o) => Object.assign({ id: Math.random(), ts: 1, n: 60, sog: 5, tws: 12, twa: 50 }, o);

// Rien à signaler sur une nav normale.
assert.strictEqual(findSuspect([run(), run({ twa: 140, sog: 9, tws: 8 })]).points, 0);

// Le cas réel : une bande de vent faible où le bateau va plus vite que le vent
// au près. C'est ce qu'ont montré les deux premières polaires polluées du
// fonds commun, à 1,26× et 1,29× le vent vrai.
const polluted = [run({ id: 1, tws: 4, sog: 5.1, twa: 45 }), run({ id: 2, tws: 4, sog: 4.8, twa: 60 }), run({ id: 3 })];
const found = findSuspect(polluted);
assert.strictEqual(found.points, 2);
assert.deepStrictEqual(found.ids, [1, 2]);
assert.strictEqual(found.seconds, 120, 'le temps de nav concerné, pas seulement le nombre de points');
assert.deepStrictEqual(found.bands, [{ tws: 4, points: 2 }]);
assert.ok(Math.abs(found.worst.ratio - 1.275) < 1e-9, 'le pire point porte le rapport, pas la vitesse brute');
assert.strictEqual(found.worst.twa, 45);

// Un point déjà écarté à la main ne compte plus comme un problème — mais il se
// dit, sinon « plus rien à faire » et « il n'y a jamais rien eu » se
// ressemblent trop.
const cleaned = findSuspect(polluted, { excluded: new Set([1, 2]) });
assert.strictEqual(cleaned.points, 0);
assert.strictEqual(cleaned.alreadyExcluded, 2);
assert.strictEqual(cleaned.worst, null);

// Au portant, la règle ne s'applique pas : un surf dépasse vraiment le vent.
assert.strictEqual(findSuspect([run({ tws: 4, sog: 8, twa: 120 })]).points, 0);

// Les mêmes réglages que le filtre, donc les mêmes échappatoires.
assert.strictEqual(findSuspect(polluted, { ratio: 0 }).points, 0, 'règle désactivée : rien à reprocher à personne');
assert.strictEqual(findSuspect(polluted, { ratio: 2 }).points, 0);

// Des runs incomplets (vieux journal, champ manquant) ne font rien planter et
// ne sont jamais accusés sur une donnée absente.
assert.strictEqual(findSuspect([run({ tws: null }), run({ sog: null }), run({ twa: null }), run({ tws: 0 }), null]).points, 0);

console.log('suspect: ok');
