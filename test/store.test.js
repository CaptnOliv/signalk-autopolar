const assert = require('assert');
const { carryExcluded } = require('../lib/store');

// Un point = la fin de sa fenêtre (`ts`, qui est aussi son identifiant) et sa
// durée en secondes (`n`).
const run = (endS, n = 60) => ({ id: endS * 1000, ts: endS * 1000, n });

// Trois points d'origine, celui du milieu écarté à la main.
const old = [run(60), run(120), run(180)];
const excluded = new Set([run(120).id]);

// Rejeu à l'identique : l'exclusion retombe sur le même point, et sur lui seul.
assert.deepStrictEqual(carryExcluded(old, excluded, old), [run(120).id]);

// Rejeu avec d'autres réglages : les fenêtres ont glissé de 25 s. Aucun
// identifiant ne correspond plus, mais deux nouveaux points recouvrent le
// moment écarté (61 → 120 s) — ils héritent tous deux de l'exclusion. Celui
// d'avant et celui d'après n'y touchent pas.
const shifted = [run(35, 30), run(95), run(155), run(215)];
assert.deepStrictEqual(carryExcluded(old, excluded, shifted), [run(95).id, run(155).id]);

// Deux fenêtres bout à bout ne se recouvrent pas : la première seconde de
// l'une suit la dernière de l'autre.
assert.deepStrictEqual(carryExcluded(old, excluded, [run(60), run(180)]), []);

// Rien d'exclu, ou une exclusion qui vise un point absent du journal rejoué
// (une ébauche d'historique, par exemple) : rien à reporter.
assert.deepStrictEqual(carryExcluded(old, new Set(), shifted), []);
assert.deepStrictEqual(carryExcluded(old, new Set([999]), shifted), []);

// L'ordre d'entrée ne compte pas.
assert.deepStrictEqual(carryExcluded(old, excluded, [...shifted].reverse()), [run(95).id, run(155).id]);

console.log('store: ok');
