// Reversement automatique de la polaire vers le fonds commun.
//
// Le marché est simple : le plugin est gratuit, et ce qu'il apprend de ton
// bateau retourne au pot commun, pour que le prochain propriétaire d'un
// modèle courant ne reparte pas de la polaire optimiste du chantier. Ça ne
// marche que si l'envoi est *invisible* : un bouton « contribuer » se clique
// une fois, jamais la deuxième, et une polaire figée à 500 points ne vaut pas
// grand-chose face à la même à 3000.
//
// D'où trois partis pris :
//   — on envoie tous les N points collectés, pas sur une horloge : la polaire
//     n'a changé que si des points sont entrés ;
//   — l'envoi ne bloque jamais la boucle de collecte, et un échec (large,
//     Starlink coupée) n'est pas perdu : le seuil reste franchi, donc la
//     tentative revient d'elle-même, au plus une fois toutes les 10 minutes ;
//   — rien n'est envoyé qu'on ne puisse lire d'abord : le corps exact part
//     aussi vers /api/share.pol et /api/share, à l'écran.
//
// Aucune position n'entre ici, pour la raison la plus solide qui soit : il
// n'y en a nulle part dans les données collectées.

const fs = require('fs');

const RETRY_MS = 600000; // 10 min

// Décision d'envoi, isolée du réseau et du disque pour être testable telle
// quelle : c'est la seule règle qui décide qu'une donnée quitte le bateau.
function isDue(state, count, every, now) {
  if (!(every > 0)) return false;
  if (count < (state.lastCount || 0) + every) return false;
  // Le délai de reprise ne s'applique qu'après un échec : c'est un
  // anti-martèlement, pas un quota. Deux paliers peuvent tomber coup sur coup
  // après un rejeu du brut, et il n'y a aucune raison d'en perdre un.
  if (state.lastError && now - (state.lastTry || 0) < RETRY_MS) return false;
  return true;
}

function createShare(file, log) {
  let st = { lastCount: 0, lastAt: 0, lastTry: 0, sent: 0, failures: 0, lastError: null };
  let inFlight = false;
  let forced = false;

  if (file && fs.existsSync(file)) {
    try {
      st = Object.assign(st, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      /* état illisible : on repart de zéro, quitte à renvoyer une fois de trop */
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.writeFileSync(file, JSON.stringify(st));
    } catch (e) {
      if (log) log(`share: cannot write state: ${e.message}`);
    }
  }

  async function post(endpoint, payload) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  // `build` n'est appelé que si l'envoi doit vraiment partir : construire la
  // polaire complète coûte cher, et le cas courant est « rien à faire ».
  function maybeSend(opts, count, build) {
    if (!opts.sharePolar || !opts.shareEndpoint) return false;
    if (!opts.boatModel || !opts.shareName) return false;
    if (inFlight) return false;
    const now = Date.now();
    if (!forced && !isDue(st, count, opts.shareEveryPoints, now)) return false;
    forced = false;

    st.lastTry = now;
    inFlight = true;
    let payload;
    try {
      payload = build();
    } catch (e) {
      inFlight = false;
      st.failures++;
      st.lastError = e.message;
      save();
      return false;
    }
    post(opts.shareEndpoint, payload)
      .then(() => {
        st.lastCount = count;
        st.lastAt = Date.now();
        st.sent++;
        st.lastError = null;
      })
      .catch((e) => {
        st.failures++;
        st.lastError = e.message;
        // Visible sans logs verbeux : un partage qui ne part plus depuis trois
        // navs doit se voir, sinon on croit contribuer alors que non.
        if (log) log(`share: ${e.message} (will retry)`);
      })
      .finally(() => {
        inFlight = false;
        save();
      });
    return true;
  }

  return {
    maybeSend,
    isDue: (count, every) => isDue(st, count, every, Date.now()),
    nextAt: (every) => (every > 0 ? (st.lastCount || 0) + every : null),
    state: () => Object.assign({ inFlight }, st),
    // Renvoyer maintenant, sans attendre le prochain palier : sert au bouton
    // « send now » et au premier envoi après un changement de configuration.
    // Envoyer maintenant, sans attendre le prochain palier : sert au bouton
    // « send now ». On ne touche pas à `lastCount` — le palier suivant reste
    // calé sur le dernier envoi réussi, pas sur l'impatience de l'équipage.
    force: () => {
      forced = true;
      st.lastTry = 0;
    },
  };
}

module.exports = { createShare, isDue, RETRY_MS };
