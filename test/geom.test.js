const assert = require('assert');
const g = require('../lib/geom');

// Les angles ne se moyennent pas comme des nombres : c'est le piège classique
// qui fait qu'un bateau au cap 355°/005° se retrouve « au 180 ».
assert.ok(Math.abs(g.meanAngle([350, 10])) < 1e-9, 'moyenne circulaire autour de 0');
assert.ok(Math.abs(g.spreadAngle([350, 10]) - 20) < 1e-9, 'étendue circulaire = 20°');
assert.ok(g.spreadAngle([170, 175, 180, -175]) < 20, 'pas de faux écart au passage par 180');

assert.strictEqual(g.wrap180(190), -170);
assert.strictEqual(g.wrap180(-190), 170);
assert.strictEqual(g.wrap180(180), 180);

// Vent vrai : au près, le vrai est plus faible et plus ouvert que l'apparent.
const t = g.trueWind(35, 20, 7);
assert.ok(t.tws < 20 && t.twa > 35, 'vent vrai plus faible et plus ouvert que l\'apparent au près');
assert.ok(g.trueWind(-35, 20, 7).twa < 0, 'le bord est conservé');

// Vent arrière : le vrai est plus fort que l'apparent.
const d = g.trueWind(170, 10, 6);
assert.ok(d.tws > 10, 'au portant le vent vrai est plus fort que l\'apparent');

assert.strictEqual(g.percentile([1, 2, 3, 4], 0), 1);
assert.strictEqual(g.percentile([1, 2, 3, 4], 1), 4);
assert.strictEqual(g.median([3, 1, 2]), 2);

console.log('geom: ok');
