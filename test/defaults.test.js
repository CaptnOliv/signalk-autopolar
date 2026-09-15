// Le schéma de configuration et les défauts de plugin.start() doivent dire la
// même chose.
//
// Ce n'est pas du zèle : le serveur SignalK passe à plugin.start() la
// configuration *enregistrée*, telle quelle, sans y injecter les `default:` du
// schéma (doPluginStart, signalk-server). Le formulaire d'administration, lui,
// les injecte — mais seulement quand quelqu'un ouvre le formulaire et
// enregistre. Sur toute installation dont la configuration a été écrite avant
// l'ajout d'une option, cette option arrive donc `undefined`.
//
// Pour un booléen, `undefined` c'est « coupé ». C'est exactement ce qui est
// arrivé à `checkForUpdates` en 0.10.0 : annoncé `default: true` dans le
// schéma, absent de la table de start(), donc la vérification de version ne
// s'est jamais déclenchée sur aucune installation existante — sans le moindre
// message, puisqu'un module qui ne vérifie rien n'a rien à signaler.

const assert = require('assert');

const pluginFactory = require('../index.js');
const DEFAULTS = pluginFactory.DEFAULTS;

const app = {
  getDataDirPath: () => '/tmp',
  debug() {},
  error() {},
  setPluginStatus() {},
  setPluginError() {},
};
const schema = pluginFactory(app).schema;

// Le formulaire groupe certaines options sous sources / polarBins / advanced ;
// start() les aplatit. On compare donc à plat, comme le code les lit.
function flatten(props, out = {}) {
  for (const [key, spec] of Object.entries(props)) {
    if (spec.type === 'object' && spec.properties) flatten(spec.properties, out);
    else out[key] = spec;
  }
  return out;
}

const options = flatten(schema.properties);
const missing = [];
const disagree = [];

for (const [key, spec] of Object.entries(options)) {
  if (!('default' in spec)) continue;
  if (!(key in DEFAULTS)) {
    missing.push(key);
    continue;
  }
  const a = JSON.stringify(DEFAULTS[key]);
  const b = JSON.stringify(spec.default);
  if (a !== b) disagree.push(`${key}: start() dit ${a}, le schéma dit ${b}`);
}

assert.deepStrictEqual(missing, [], `options du schéma sans défaut dans plugin.start(): ${missing.join(', ')}`);
assert.deepStrictEqual(disagree, [], `défauts contradictoires:\n  ${disagree.join('\n  ')}`);

// L'inverse n'est pas une erreur : start() porte aussi des réglages internes
// qui n'ont pas à encombrer le formulaire. On vérifie seulement que les
// options réellement offertes à l'utilisateur sont couvertes.
assert.ok(Object.keys(options).length > 40, 'le schéma semble ne pas avoir été lu');

// Le cas concret qui a motivé ce fichier.
assert.strictEqual(DEFAULTS.checkForUpdates, true);
assert.strictEqual(DEFAULTS.usageStats, true);

console.log(`defaults: ok (${Object.keys(options).length} options du schéma)`);
