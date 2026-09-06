// Demander un coup de pouce — une fois, au bon moment, et jamais deux fois de
// trop.
//
// Le plugin est gratuit et le restera ; les serveurs, les noms de domaine et
// les abonnements qui le font vivre, non. Reste à le dire sans devenir une de
// ces applications qui mendient à chaque ouverture. Tout tient dans decide(),
// et pas dans le texte du bandeau :
//
//   1. On ne demande rien avant d'avoir servi à quelque chose. Le déclencheur
//      est un jalon de valeur livrée — pour la polaire, le moment où elle
//      devient exploitable — jamais une horloge, jamais un nombre
//      d'ouvertures de la webapp. Une demande qui suit une preuve n'est pas
//      la même demande.
//   2. Une seule réponse ferme la porte pour de bon : « ne plus me demander ».
//      Cliquer sur l'étoile ou sur le café ne prouve RIEN — l'onglet a pu être
//      refermé aussitôt, et rien ici ne peut le savoir. Traiter ces deux
//      clics comme définitifs reviendrait à punir exactement le geste qu'on
//      espérait : ils valent « plus tard », comme le reste.
//   3. « Plus tard » n'est pas « dans cinq minutes » : il faut du temps OU un
//      nouveau jalon — l'un des deux suffit, parce qu'il n'y a rien à gagner
//      à se taire devant quelqu'un à qui on a du neuf à montrer. Ne pas
//      répondre du tout vaut « plus tard » aussi. Et quoi qu'il arrive, deux
//      apparitions au maximum sur la vie de l'installation : c'est ce
//      plafond-là qui empêche le OU de devenir bavard.
//
// L'état vit sur le serveur, pas dans le localStorage du navigateur : à bord
// la webapp s'ouvre depuis le téléphone, la tablette et le portable, et un
// stockage par navigateur poserait la question trois fois — puis une
// quatrième après un vidage de cache Safari. Une demande par bateau.
//
// Ce fichier ne connaît rien à la polaire : `progress` est un nombre quelconque
// que le plugin appelant juge représentatif de ce qu'il a livré. Il est donc
// recopiable tel quel dans les autres plugins.

const fs = require('fs');

const DAY = 86400000;

const DEFAULTS = {
  minProgress: 1000, // le jalon : ce qu'il faut avoir livré avant d'ouvrir la bouche
  againAfterDays: 90,
  againAfterProgress: 1000,
  maxAsks: 2,
};

// Une seule réponse est définitive. Les deux autres (« star », « donate »)
// sont enregistrées pour ce qu'elles valent — une intention, pas une preuve —
// et laissent simplement agir la mise en sommeil posée à l'affichage.
const FINAL = new Set(['never']);

const blank = () => ({
  shown: 0,
  lastShownAt: 0,
  snoozeUntil: 0,
  snoozeProgress: 0,
  outcome: null,
  answeredAt: 0,
  lastGesture: null, // « star » / « donate » / « later » : ce qui a été cliqué
});

// Décision pure : pas de disque, pas de réseau, pas d'horloge implicite. C'est
// la seule règle qui décide qu'on interrompt quelqu'un, elle se teste nue.
function decide(st, progress, now, o) {
  const opts = Object.assign({}, DEFAULTS, o || {});
  if (!(opts.maxAsks > 0)) return { ask: false, why: 'disabled' };
  if (st.outcome) return { ask: false, why: `already answered: ${st.outcome}` };
  if ((st.shown || 0) >= opts.maxAsks) return { ask: false, why: 'asked enough' };
  if (!(progress >= opts.minProgress)) return { ask: false, why: 'milestone not reached' };
  // L'une OU l'autre des deux conditions suffit à faire revenir le bandeau :
  // du temps a passé, ou il y a du neuf à montrer. Exiger les deux tenait la
  // langue à l'app devant quelqu'un dont la polaire venait de faire un bond,
  // ce qui est précisément le moment où elle a quelque chose à dire.
  if (st.shown) {
    const timeUp = now >= (st.snoozeUntil || 0);
    const newMilestone = progress >= (st.snoozeProgress || 0);
    if (!timeUp && !newMilestone) return { ask: false, why: 'snoozed, and nothing new since' };
  }
  return { ask: true, why: 'milestone reached' };
}

function createSupport(file, o) {
  const opts = Object.assign({}, DEFAULTS, o || {});
  let st = blank();

  if (file && fs.existsSync(file)) {
    try {
      st = Object.assign(blank(), JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      /* état illisible : au pire on repose la question une fois, rien de grave */
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.writeFileSync(file, JSON.stringify(st));
    } catch (e) {
      // Si l'état ne peut pas s'écrire, on préfère ne plus rien demander du
      // tout : redemander à chaque chargement de page serait pire que se taire.
      st.outcome = 'unwritable';
    }
  }

  return {
    // `enabled` est le réglage de configuration : coupé, plus rien n'est
    // évalué ni stocké.
    status(progress, enabled) {
      const d = enabled === false ? { ask: false, why: 'turned off' } : decide(st, progress, Date.now(), opts);
      return Object.assign({}, d, {
        shown: st.shown,
        lastShownAt: st.lastShownAt || null,
        outcome: st.outcome,
        remaining: Math.max(0, opts.maxAsks - (st.shown || 0)),
        milestone: opts.minProgress,
        progress,
      });
    },

    // Appelé quand le bandeau est RÉELLEMENT affiché, pas quand le serveur
    // décide qu'il pourrait l'être : hors ligne, un lien vers Ko-fi ouvre un
    // onglet mort, et l'occasion serait brûlée sans que personne n'ait rien vu.
    markShown(progress) {
      const now = Date.now();
      st.shown = (st.shown || 0) + 1;
      st.lastShownAt = now;
      // La mise en sommeil est posée dès l'affichage : fermer l'onglet sans
      // répondre doit valoir « plus tard », pas « repose-moi la question au
      // prochain rechargement ».
      st.snoozeUntil = now + opts.againAfterDays * DAY;
      st.snoozeProgress = (Number(progress) || 0) + opts.againAfterProgress;
      save();
      return st;
    },

    answer(kind) {
      if (kind) st.lastGesture = kind;
      if (FINAL.has(kind)) {
        st.outcome = kind;
        st.answeredAt = Date.now();
      }
      save();
      return st;
    },

    state: () => Object.assign({}, st),
  };
}

module.exports = { createSupport, decide, DEFAULTS, DAY };
