// lib/engine-witness.js — « ce signal moteur a-t-il déjà dit quelque chose ? »
//
// Ce qui se teste ici n'est pas l'arithmétique d'un compteur mais la seule
// distinction que le module existe pour tenir : un capteur ABSENT n'est pas un
// capteur MUET. Le premier ne dit rien de ce bateau ; le second dit que le
// verdict moteur repose sur une valeur qui n'a jamais changé.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWitness, verdict, ENOUGH_S, EMPTY } = require('../lib/engine-witness');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-'));
const file = (n) => path.join(tmp, n + '.json');

// ── Pas de recul, pas de verdict ───────────────────────────────────────────
assert.strictEqual(verdict(null), null);
assert.strictEqual(verdict(EMPTY()), null, 'aucun signal vu : rien à dire');

// Un capteur muet depuis une heure ne prouve rien : c'est un bateau qui n'a
// pas démarré son moteur depuis une heure.
const young = Object.assign(EMPTY(), { observedS: 3600, state: { seen: true, everRunning: false } });
assert.strictEqual(verdict(young), null);

// ── Le capteur muet ────────────────────────────────────────────────────────
const mute = Object.assign(EMPTY(), { observedS: ENOUGH_S, state: { seen: true, everRunning: false } });
assert.deepStrictEqual(verdict(mute).signals, ['state']);
assert.strictEqual(verdict(mute).code, 'never_running');

// Une seule mise en marche vue, et il n'y a plus rien à signaler : le capteur
// a prouvé qu'il savait le dire.
const proven = Object.assign(EMPTY(), { observedS: 10 * ENOUGH_S, state: { seen: true, everRunning: true } });
assert.strictEqual(verdict(proven), null);

// Les deux témoins sont suivis séparément : un bateau peut avoir un `state`
// qui fonctionne et un compte-tours jamais câblé.
const half = Object.assign(EMPTY(), {
  observedS: ENOUGH_S,
  state: { seen: true, everRunning: true },
  rpm: { seen: true, everRunning: false },
});
assert.deepStrictEqual(verdict(half).signals, ['rpm']);

// ── Absent ≠ muet ──────────────────────────────────────────────────────────
const w1 = createWitness(file('absent'));
for (let i = 0; i < ENOUGH_S; i++) w1.observe({ rpm: null, rpmFresh: false, state: null, stateFresh: false }, 1);
assert.strictEqual(w1.state().observedS, 0, "un bateau sans capteur ne cumule aucune observation");
assert.strictEqual(w1.verdict(), null, "on ne reproche pas à un bateau de ne pas avoir de capteur");

const w2 = createWitness(file('mute'));
for (let i = 0; i < ENOUGH_S; i++) w2.observe({ rpm: 0, rpmFresh: true, state: 'stopped', stateFresh: true }, 1);
assert.strictEqual(w2.state().observedS, ENOUGH_S);
assert.deepStrictEqual(w2.verdict().signals, ['rpm', 'state'], 'deux capteurs présents, aucun qui ait jamais bougé');

// Le tout premier démarrage éteint le doute, pour toujours.
w2.observe({ rpm: 850, rpmFresh: true, state: 'started', stateFresh: true }, 1);
assert.strictEqual(w2.verdict(), null);
assert.ok(w2.state().lastRunningAt > 0);

// ── Le disque ──────────────────────────────────────────────────────────────
// Le témoin ne vaut que s'il survit aux redémarrages : ce qu'il mesure est
// justement ce qu'on ne peut pas voir dans une session.
w2.flush();
const again = createWitness(file('mute'));
assert.strictEqual(again.state().rpm.everRunning, true, 'le témoin survit au redémarrage');
assert.ok(again.state().observedS >= ENOUGH_S);

// Un fichier illisible ne doit jamais empêcher le plugin de démarrer.
fs.writeFileSync(file('broken'), '{ pas du json');
const broken = createWitness(file('broken'));
assert.strictEqual(broken.state().observedS, 0);

// Un trou de plusieurs heures (SignalK arrêté) ne se compte pas comme du
// temps d'observation : le delta est borné.
const w3 = createWitness(file('gap'));
w3.observe({ rpm: 0, rpmFresh: true }, 86400);
assert.strictEqual(w3.state().observedS, 60, "un trou ne fabrique pas de l'observation");

fs.rmSync(tmp, { recursive: true, force: true });
console.log('engine-witness: ok');
