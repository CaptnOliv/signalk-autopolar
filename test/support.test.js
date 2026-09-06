// Le seul endroit du plugin qui interrompt l'équipage pour parler d'argent.
// Il vaut donc mieux qu'il soit tenu de près : une demande de trop et c'est
// l'application entière qu'on désinstalle.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSupport, decide, DAY } = require('../lib/support');

const OPTS = { minProgress: 1000, againAfterDays: 90, againAfterProgress: 1000, maxAsks: 2 };
const T0 = 1e12;
const fresh = () => ({ shown: 0, lastShownAt: 0, snoozeUntil: 0, snoozeProgress: 0, outcome: null });

// ── La règle, nue ───────────────────────────────────────────────────────────
assert.strictEqual(decide(fresh(), 999, T0, OPTS).ask, false, "avant le jalon, on n'a encore rien prouvé");
assert.strictEqual(decide(fresh(), 1000, T0, OPTS).ask, true, 'au jalon, on peut demander');
assert.strictEqual(decide(fresh(), 5000, T0, { ...OPTS, maxAsks: 0 }, T0).ask, false, 'réglage coupé : jamais rien');

// Une seule réponse ferme la question pour de bon. Un clic sur l'étoile ou
// sur le café ne prouve rien — l'onglet a pu être refermé aussitôt — et le
// traiter comme définitif punirait le seul geste qu'on espérait.
assert.strictEqual(decide({ ...fresh(), shown: 1, outcome: 'never' }, 99999, T0 + 10 * 365 * DAY, OPTS).ask, false, '« ne plus demander » : plus jamais');

// « Plus tard » : l'une OU l'autre des deux conditions suffit.
const snoozed = { ...fresh(), shown: 1, snoozeUntil: T0 + 90 * DAY, snoozeProgress: 2000 };
assert.strictEqual(decide(snoozed, 1500, T0 + 30 * DAY, OPTS).ask, false, 'ni le temps ni le jalon : on se tait');
assert.strictEqual(decide(snoozed, 5000, T0 + 30 * DAY, OPTS).ask, true, "du neuf à montrer : on n'attend pas les 90 jours");
assert.strictEqual(decide(snoozed, 1500, T0 + 200 * DAY, OPTS).ask, true, 'le temps seul suffit aussi');

// Le plafond dur, quoi qu'il arrive.
const twice = { ...fresh(), shown: 2, snoozeUntil: T0, snoozeProgress: 0 };
assert.strictEqual(decide(twice, 999999, T0 + 10 * 365 * DAY, OPTS).ask, false, 'deux apparitions et on se tait définitivement');

// ── L'objet, avec son disque ────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-test-'));
const file = path.join(dir, 'support.json');

const s = createSupport(file, OPTS);
assert.strictEqual(s.status(500).ask, false);
assert.strictEqual(s.status(1200).ask, true);
assert.strictEqual(s.status(1200, false).ask, false, 'coupé en configuration : rien, sans même regarder le reste');

// Afficher consomme la demande ET pose la mise en sommeil : fermer l'onglet
// sans répondre ne doit pas faire revenir le bandeau au rechargement suivant.
s.markShown(1200);
assert.strictEqual(s.status(1200).ask, false, 'pas deux fois de suite');
assert.strictEqual(s.state().shown, 1);
assert.strictEqual(s.state().snoozeProgress, 2200);
assert.strictEqual(s.status(2200).ask, true, 'mais un nouveau jalon rouvre la porte sans attendre');

// L'état survit à un redémarrage de SignalK — sinon chaque restart en nav
// reposerait la question.
const reopened = createSupport(file, OPTS);
assert.strictEqual(reopened.state().shown, 1, 'le compteur est relu sur disque');
assert.strictEqual(reopened.status(1300).ask, false, 'et la mise en sommeil avec');

// Un clic sur le café est enregistré, mais il ne ferme rien : il vaut « plus
// tard ». C'est le point qui compte le plus ici — quelqu'un qui a ouvert la
// page Ko-fi sans donner ne doit pas se retrouver silencieusement rayé.
reopened.answer('donate');
const afterGesture = createSupport(file, OPTS);
assert.strictEqual(afterGesture.state().lastGesture, 'donate', 'le geste est gardé');
assert.strictEqual(afterGesture.state().outcome, null, 'mais ce n\'est pas une réponse définitive');
assert.strictEqual(afterGesture.status(1300).ask, false, 'il fait patienter comme « plus tard »…');
assert.strictEqual(afterGesture.status(2200).ask, true, '…et le prochain jalon rouvre la porte');

// « Ne plus demander », lui, est définitif.
const never = createSupport(path.join(dir, 'never.json'), OPTS);
never.markShown(1000);
never.answer('never');
assert.strictEqual(createSupport(path.join(dir, 'never.json'), OPTS).status(999999).ask, false, 'et ça vaut pour toujours');

// Le plafond tient malgré le OU : deux apparitions, pas une de plus, même sur
// un bateau qui empile les jalons.
const capped = createSupport(path.join(dir, 'capped.json'), OPTS);
capped.markShown(1000);
capped.markShown(5000);
assert.strictEqual(capped.status(999999).ask, false, 'deux fois et on se tait définitivement');

// Un état illisible ne doit pas planter le plugin ni ouvrir les vannes.
const junk = path.join(dir, 'junk.json');
fs.writeFileSync(junk, '{ pas du json');
assert.strictEqual(createSupport(junk, OPTS).state().shown, 0, 'fichier corrompu : on repart proprement');

console.log('support: ok');
