// lib/habits.js — comment ce bateau navigue.
//
// Ce qui compte ici n'est pas l'arithmétique des pourcentages mais ce qu'ils
// prétendent décrire : des POINTS RETENUS, jamais du temps passé en mer. Les
// tests verrouillent donc surtout les bornes (une allure ne doit pas changer de
// case selon l'amure), le temps de nav (les fenêtres ne se recouvrent pas, donc
// la somme est du vrai temps) et l'absence de mesure (pas de capteur
// d'attitude : pas de ligne de gîte, plutôt qu'un zéro qui passerait pour une
// mesure).

const assert = require('assert');
const { summarise, bandOf, isNight, POINTS_OF_SAIL, WIND_BANDS } = require('../lib/habits');

// ── Les bornes ─────────────────────────────────────────────────────────────
assert.strictEqual(bandOf(POINTS_OF_SAIL, 0).key, 'close_hauled');
assert.strictEqual(bandOf(POINTS_OF_SAIL, 49.9).key, 'close_hauled');
assert.strictEqual(bandOf(POINTS_OF_SAIL, 50).key, 'close_reach', 'la borne appartient à la bande du dessus');
assert.strictEqual(bandOf(POINTS_OF_SAIL, 140).key, 'running');
assert.strictEqual(bandOf(POINTS_OF_SAIL, 180).key, 'running', 'plein vent arrière reste une allure');
assert.strictEqual(bandOf(WIND_BANDS, 0).key, 'light');
assert.strictEqual(bandOf(WIND_BANDS, 45).key, 'heavy', 'aucun coup de vent ne tombe hors des bandes');

// ── Rien à décrire ─────────────────────────────────────────────────────────
assert.deepStrictEqual(summarise([]), { points: 0 });
assert.deepStrictEqual(summarise(null), { points: 0 });
// Un point sans vent vrai n'est pas une allure : il ne compte nulle part.
assert.strictEqual(summarise([{ ts: 1, twa: null, tws: 5 }]).points, 0);

// ── Un bateau qui ne fait que du portant ───────────────────────────────────
// Le cas qui motive tout le module : la polaire de près est vide, et ce n'est
// pas la collecte qui est en cause.
// UN RUN EST EN UNITÉS MARINES. C'est la convention de `runs.jsonl`, et le
// piège de ce module : il a longtemps reconverti m/s → nœuds des valeurs qui
// étaient déjà des nœuds, et ce test fabriquait ses runs en m/s, donc il
// confirmait le bug au lieu de l'attraper. Les vitesses ci-dessous sont donc
// écrites en nœuds tels qu'ils sortent de la collecte, et relues telles quelles
// dans les assertions : si les deux côtés se remettent à diverger, ça se voit.
const run = (twa, twsKn, over) =>
  Object.assign({ ts: Date.UTC(2026, 8, 2, 12, 0, 0), n: 60, twa, tws: twsKn, sog: 6 }, over);
const downwind = [];
for (let i = 0; i < 80; i++) downwind.push(run(i % 2 ? 150 : -120, 20));
for (let i = 0; i < 20; i++) downwind.push(run(45, 12));

const h = summarise(downwind);
assert.strictEqual(h.points, 100);
assert.strictEqual(h.hours, (100 * 60) / 3600, 'les fenêtres ne se recouvrent pas : la somme est du vrai temps');
const pos = Object.fromEntries(h.pointsOfSail.map((b) => [b.key, b.points]));
assert.deepStrictEqual(pos, { close_hauled: 20, close_reach: 0, beam_reach: 0, broad_reach: 40, running: 40 });
// Une amure ou l'autre, c'est la même allure : -120° est un grand largue.
assert.strictEqual(h.pointsOfSail.find((b) => b.key === 'broad_reach').share, 0.4);
assert.strictEqual(h.tacks.port, 40, 'les twa négatifs sont bâbord amure');
assert.strictEqual(h.tacks.starboard, 60);
assert.ok(Math.abs(h.balance.downwind - 0.8) < 1e-9, 'quatre points sur cinq au portant');
assert.ok(Math.abs(h.balance.upwind - 0.2) < 1e-9);
const wind = Object.fromEntries(h.wind.map((b) => [b.key, b.points]));
assert.deepStrictEqual(wind, { light: 0, moderate: 0, fresh: 20, strong: 80, heavy: 0 });

// ── Gîte : pas de capteur, pas de ligne ────────────────────────────────────
assert.strictEqual(h.heel, null, "sans attitude, on n'invente pas une gîte de 0°");
const heeled = summarise([run(45, 12, { roll: -12 }), run(45, 12, { roll: 4 }), run(45, 12, { roll: 8 })]);
assert.strictEqual(heeled.heel.median, 8, 'la gîte est prise en valeur absolue, les deux bords confondus');

// ── Vitesses ───────────────────────────────────────────────────────────────
const speeds = summarise([run(90, 12, { sog: 4 }), run(90, 12, { sog: 7 }), run(90, 12, { sog: 11 })]);
assert.strictEqual(speeds.speed.median, 7);
assert.strictEqual(speeds.speed.best, 11);
assert.strictEqual(speeds.windSeen.median, 12);
assert.strictEqual(speeds.windSeen.strongest, 12);
// Le garde-fou de non-régression : 12 nœuds de vent doivent tomber dans
// « fresh » (12-18), jamais dans « heavy » — ce que donnait la conversion en
// trop. Même chose pour la vitesse, lue à l'identique.
assert.strictEqual(speeds.wind.find((b) => b.key === 'fresh').points, 3, 'aucune conversion ne doit être appliquée à un run');
assert.strictEqual(speeds.wind.find((b) => b.key === 'heavy').points, 0);

// ── La nuit, à l'heure du bord ─────────────────────────────────────────────
const night = new Date(2026, 8, 2, 23, 30, 0).getTime();
const day = new Date(2026, 8, 2, 14, 0, 0).getTime();
assert.ok(isNight(night) && !isNight(day));
assert.ok(isNight(new Date(2026, 8, 2, 5, 59, 0).getTime()), '05:59 est encore la nuit');
assert.ok(!isNight(new Date(2026, 8, 2, 6, 0, 0).getTime()), '06:00 ne l\'est plus');
const mixed = summarise([run(90, 12, { ts: night }), run(90, 12, { ts: day }), run(90, 12, { ts: day })]);
assert.strictEqual(mixed.night.points, 1);
assert.ok(Math.abs(mixed.night.share - 1 / 3) < 1e-9);

console.log('habits: ok');
