// Alerte ntfy : prévenir en nav quand la collecte ne produit rien.
//
// Le vrai risque de ce plugin n'est pas qu'il se plante — c'est qu'il tourne
// sagement en refusant tout, et qu'on s'en aperçoive au retour, 30 h de nav
// plus tard. Un seuil trop serré pour l'état de la mer du jour ne se voit
// qu'à ça.
//
// Deux principes repris du watchdog réseau du bord :
//   — on ne notifie le retour à la normale que si une alerte était vraiment
//     partie (pas de bruit pour un creux passager) ;
//   — un envoi qui échoue (plus d'Internet au large, Starlink coupé) est mis
//     en file et retenté, jamais perdu en silence.
//
// Corollaire qui a failli coûter la file entière : `flush()` doit être appelé
// à chaque tick, INDÉPENDAMMENT de l'état de la collecte. Branché sur la
// seule branche « sous voile », il gelait la file dès le retour au mouillage
// — soit précisément l'instant où le réseau revient.

function createNotifier(opts, log) {
  const queue = [];
  let lastTry = 0;
  let inFlight = false;
  let lastError = null;
  let failures = 0;
  let sent = 0;

  function enqueue(msg) {
    queue.push(Object.assign({ at: Date.now() }, msg));
    flush();
  }

  async function send(msg) {
    const headers = { Title: msg.title, Priority: msg.priority || 'default', Tags: msg.tags || '' };
    if (opts.ntfyToken) headers.Authorization = `Bearer ${opts.ntfyToken}`;
    const res = await fetch(opts.ntfyUrl, { method: 'POST', headers, body: msg.body });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  }

  // Retentée au plus une fois par minute : inutile de marteler un lien mort,
  // et il ne faut pas non plus que la boucle de collecte attende le réseau.
  //
  // `inFlight` n'est pas une précaution théorique : l'envoi est asynchrone et
  // la file n'est dépilée qu'à sa résolution. Sans verrou, un envoi plus lent
  // que l'intervalle de reprise verrait le même message reparti une deuxième
  // fois — une alerte en double au milieu de la nuit.
  function flush() {
    if (!queue.length || !opts.ntfyUrl || inFlight) return;
    if (Date.now() - lastTry < 60000) return;
    lastTry = Date.now();
    inFlight = true;
    const msg = queue[0];
    send(msg)
      .then(() => {
        queue.shift();
        sent++;
        lastError = null;
      })
      .catch((e) => {
        // L'échec doit être visible sans avoir à activer les logs de debug :
        // une file qui ne part pas est exactement le genre de panne qu'on
        // découvre trois semaines plus tard si personne ne la remonte.
        failures++;
        lastError = e.message;
        if (log) log(`ntfy queued (${queue.length} pending): ${e.message}`);
      })
      .finally(() => {
        inFlight = false;
      });
  }

  return {
    enqueue,
    flush,
    pending: () => queue.length,
    lastError: () => lastError,
    stats: () => ({ pending: queue.length, sent, failures, lastError }),
    // Vider la file à la main : une alerte vieille de deux jours n'apprend
    // plus rien, et on doit pouvoir s'en débarrasser sans redémarrer.
    clear: () => {
      const n = queue.length;
      queue.length = 0;
      lastError = null;
      return n;
    },
  };
}

module.exports = { createNotifier };
