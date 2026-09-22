// Le témoin moteur : est-ce que le signal moteur de ce bateau a DÉJÀ dit
// quelque chose ?
//
// Le filtre d'admission croit la donnée moteur sur parole, et c'est le bon
// choix : `propulsion.*.state` et `propulsion.*.revolutions` répondent
// directement à la seule question qui compte. Mais ils y répondent aussi quand
// ils n'en savent rien. Une passerelle qui publie `stopped` en permanence, un
// compte-tours jamais câblé qui publie zéro : la valeur est là, elle est
// fraîche, elle est constante — et rien, dans un instantané, ne la distingue
// d'un moteur vraiment à l'arrêt.
//
// Ce que le fonds commun a montré : les deux premières polaires étrangères
// visiblement polluées au moteur portaient chacune le verdict le plus solide
// de l'échelle (`state` sur 995 points, `rpm` sur 3500). Une seule chose les
// trahissait, et elle demande de la durée plutôt que de la finesse : sur toute
// la vie de l'installation, leur signal moteur n'a jamais pris qu'une valeur.
//
// D'où ce module, qui ne décide de RIEN. Il compte, il persiste, et il dit
// « jamais vu tourner » — au bateau dans sa webapp, et au fonds commun dans la
// polaire partagée. C'est au lecteur de trancher entre « je n'ai pas démarré le
// moteur depuis trois semaines » et « ce capteur ne mesure rien », parce que
// c'est exactement la distinction qu'aucune mesure ne peut faire.

const fs = require('fs');

// En dessous, « jamais vu tourner » ne veut rien dire : c'est un manque de
// recul, pas un renseignement. Dix heures de signal moteur observé, c'est
// déjà plusieurs sorties — et un bateau qui ne démarre jamais son moteur
// pendant dix heures de nav reste parfaitement plausible, raison pour laquelle
// le verdict se lit comme un doute et pas comme un défaut.
const ENOUGH_S = 10 * 3600;

// Persister à chaque seconde pour un compteur qui avance d'une seconde serait
// une écriture disque par tick pendant des années.
const SAVE_EVERY_MS = 300000;

const EMPTY = () => ({
  observedS: 0,
  firstAt: 0,
  lastRunningAt: 0,
  rpm: { seen: false, everRunning: false },
  state: { seen: false, everRunning: false },
});

// La lecture, isolée de tout : ce que l'état accumulé permet de dire, et rien
// de plus. Testable sans disque et sans horloge.
function verdict(st, enoughS = ENOUGH_S) {
  if (!st) return null;
  const silent = ['rpm', 'state'].filter((k) => st[k] && st[k].seen && !st[k].everRunning);
  if (!silent.length) return null;
  if ((st.observedS || 0) < enoughS) return null;
  return { code: 'never_running', signals: silent, observedS: st.observedS };
}

function createWitness(file, log) {
  let st = EMPTY();
  let lastSave = 0;
  let dirty = false;

  if (file && fs.existsSync(file)) {
    try {
      st = Object.assign(EMPTY(), JSON.parse(fs.readFileSync(file, 'utf8')));
      st.rpm = Object.assign({ seen: false, everRunning: false }, st.rpm);
      st.state = Object.assign({ seen: false, everRunning: false }, st.state);
    } catch (e) {
      /* état illisible : on recommence à compter, ce n'est qu'un témoin */
    }
  }

  function save(force) {
    if (!file || !dirty) return;
    const now = Date.now();
    if (!force && now - lastSave < SAVE_EVERY_MS) return;
    lastSave = now;
    dirty = false;
    try {
      fs.writeFileSync(file, JSON.stringify(st));
    } catch (e) {
      if (log) log(`engine witness: cannot write state: ${e.message}`);
    }
  }

  // `reading` est ce que readEngine() vient de lire, brut :
  //   { rpm, rpmFresh, state, stateFresh }
  // `dtS` est le temps écoulé depuis l'appel précédent, en secondes.
  function observe(reading, dtS, now) {
    const r = reading || {};
    now = now || Date.now();
    let flipped = false;

    const mark = (key, seen, running) => {
      if (!seen) return;
      if (!st[key].seen) {
        st[key].seen = true;
        flipped = true;
      }
      if (running && !st[key].everRunning) {
        st[key].everRunning = true;
        flipped = true;
      }
      if (running) st.lastRunningAt = now;
    };

    // Un compte-tours à zéro est une mesure ; un compte-tours absent n'en est
    // pas une. La distinction est tout l'intérêt du module : le premier peut
    // être un capteur muet, le second n'est qu'un bateau sans capteur.
    mark('rpm', r.rpmFresh && typeof r.rpm === 'number', r.rpmFresh && r.rpm > 0);
    mark('state', r.stateFresh && typeof r.state === 'string', r.stateFresh && r.state !== 'stopped');

    if (st.rpm.seen || st.state.seen) {
      if (!st.firstAt) {
        st.firstAt = now;
        flipped = true;
      }
      // Le temps compté est celui pendant lequel un signal moteur était là,
      // pas celui pendant lequel le plugin tournait : sur un bateau dont la
      // passerelle ne s'allume qu'au contact, dix heures de signal veulent
      // dire dix heures de moteur sous les yeux.
      st.observedS += Math.max(0, Math.min(60, dtS || 0));
      dirty = true;
    }
    if (flipped) save(true);
    else save(false);
  }

  return {
    observe,
    state: () => JSON.parse(JSON.stringify(st)),
    verdict: (enoughS) => verdict(st, enoughS),
    flush: () => save(true),
  };
}

module.exports = { createWitness, verdict, ENOUGH_S, EMPTY };
