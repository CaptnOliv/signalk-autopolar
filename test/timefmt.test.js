// Les heures de la webapp, testées sur le code RÉELLEMENT livré.
//
// public/app.js est un script de navigateur : il touche `document` et `fetch`
// dès le chargement, donc on ne peut pas l'exiger tel quel. On en extrait donc
// les deux helpers par leur nom et on les évalue. L'extraction échoue bruyamment
// si elle ne trouve rien : un test de fuseau qui passe contre du vide serait
// pire que pas de test du tout, parce qu'un décalage d'une heure ne se voit pas
// à l'œil dans une liste d'horaires plausibles.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extract(name) {
  const i = src.indexOf(`const ${name} = `);
  assert.ok(i >= 0, `${name} introuvable dans public/app.js — le test ne teste plus rien`);
  // Jusqu'à la ligne `};` en colonne 0 qui ferme la fonction.
  const end = src.indexOf('\n};', i);
  assert.ok(end > i, `fin de ${name} introuvable`);
  return src.slice(i, end + 3);
}

const localInput = eval(`(${extract('localInput').replace(/^const \w+ = /, '').replace(/;$/, '')})`);

// L'heure murale d'un instant, dans le fuseau de la machine. C'est ce qu'un
// `datetime-local` doit contenir, et c'est ce que l'utilisateur lit.
const wall = (ts) =>
  new Date(ts).toLocaleString('sv-SE', { hour: '2-digit', minute: '2-digit', hour12: false });

if (process.env.TZ !== 'Europe/Athens') {
  // Le bug ne se voit qu'avec un fuseau à changement d'heure : sous UTC, les
  // deux calculs donnent la même chose et le test passerait quoi qu'il arrive.
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, [__filename], {
    env: Object.assign({}, process.env, { TZ: 'Europe/Athens' }),
    stdio: 'inherit',
  });
  process.exit(0); // l'enfant a déjà annoncé le résultat
}

// Deux instants qui encadrent le changement d'heure grec : l'un en EEST
// (UTC+3), l'autre en EET (UTC+2). Le préremplissage doit suivre l'instant
// visé, pas la date du jour où l'on clique.
for (const iso of ['2026-09-21T09:00:00Z', '2026-11-21T09:00:00Z', '2026-03-01T12:00:00Z', '2026-07-04T23:30:00Z']) {
  const ts = Date.parse(iso);
  const got = localInput(ts).slice(11);
  assert.strictEqual(got, wall(ts), `préremplissage de ${iso} : ${got}, heure murale ${wall(ts)}`);

  // Et le tour complet : ce que Date.parse relit du champ doit désigner le
  // MÊME instant. Sans ça, corriger une plage viserait à côté des points.
  assert.strictEqual(Date.parse(localInput(ts)), ts - (ts % 60000), `aller-retour de ${iso}`);
}

// Le cas qui a motivé le correctif, énoncé nu : un instant d'hiver préparé
// depuis l'été. L'ancien code rendait 12:00 là où la pendule d'Athènes dit 11:00.
assert.strictEqual(localInput(Date.parse('2026-11-21T09:00:00Z')).slice(11), '11:00');
assert.strictEqual(localInput(Date.parse('2026-09-21T09:00:00Z')).slice(11), '12:00');

console.log('timefmt: ok');
