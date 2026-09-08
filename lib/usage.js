// Savoir si quelqu'un fait tourner ce plugin — en le disant.
//
// Un plugin publié sur npm ne donne aucun chiffre honnête : les compteurs de
// téléchargement comptent surtout les miroirs et les scanners de sécurité, et
// un bateau qui a installé une fois puis navigue trois ans sans mettre à jour
// n'apparaît plus jamais. Le collecteur de polaires, lui, ne voit que ceux qui
// partagent. Reste ce fichier : un identifiant tiré une fois, un ping par
// jour, et c'est tout.
//
// Ce module a une contrainte que les autres n'ont pas : il envoie une donnée
// dont l'utilisateur ne tire aucun bénéfice direct. Il n'a donc le droit
// d'exister que s'il est *annoncé* — pas dissimulé derrière un test de
// connectivité, ce qui serait à la fois un mensonge et, dans du JavaScript
// lisible publié sous MIT, un mensonge découvert. Trois conséquences dans le
// code :
//
//   1. La charge utile est exactement celle que décrit la configuration, champ
//      pour champ, et rien de plus. Ajouter un champ ici oblige à modifier la
//      description — c'est voulu.
//   2. Elle est lisible à tout moment sur /api/usage.json, comme la polaire
//      l'est sur /api/share.json. Ce qu'on ne peut pas relire finit coupé, et
//      mérite de l'être.
//   3. Un ping perdu est perdu. Pas de file d'attente, pas de reprise
//      obstinée : contrairement à une alerte de collecte muette (lib/notify.js),
//      une statistique n'a pas le droit d'être mieux traitée que ce qui sert
//      vraiment l'équipage. Au pire, un bateau au large compte un jour de
//      moins.
//
// L'identifiant est tiré au hasard et n'est dérivé de rien : ni du nom du
// bateau, ni du matériel, ni du réseau. Il ne sert qu'à ne pas compter deux
// fois la même installation — sans lui on compterait des adresses IP, ce qui
// sur du Starlink en CGNAT ne veut rigoureusement rien dire.
//
// Ce fichier ne connaît rien à la polaire : il est recopiable tel quel dans
// les autres plugins, comme lib/support.js.

const fs = require('fs');
const crypto = require('crypto');

const DAY = 86400000;
// Après un échec, on retente dans l'heure plutôt que le lendemain : au
// mouillage le réseau revient souvent dans la journée, et c'est le seul
// rattrapage qu'on s'autorise.
const RETRY_MS = 3600000;
// Rien ne part dans la première heure de fonctionnement. Deux raisons, et la
// première est de fond : une installation essayée cinq minutes puis retirée
// n'est pas une installation, et la compter gonflerait le chiffre exactement
// là où il doit être sobre. La seconde est pratique — un `npm test`, un CI,
// un développeur qui démarre le plugin pour voir ne doivent jamais atterrir
// dans le compteur.
const MIN_UPTIME_MS = 3600000;

const blank = () => ({
  installId: null,
  firstSeen: 0,
  lastSentAt: 0,
  lastTry: 0,
  sent: 0,
  failures: 0,
  lastError: null,
});

// Décision pure : ni disque, ni réseau, ni horloge implicite.
function isDue(st, now, everyMs, sinceStart) {
  if (!(everyMs > 0)) return false;
  if ((sinceStart != null ? sinceStart : Infinity) < MIN_UPTIME_MS) return false;
  if (now - (st.lastSentAt || 0) < everyMs) return false;
  // `lastTry` ne freine que les échecs : après un succès il vaut lastSentAt,
  // donc c'est la condition du dessus qui gouverne.
  if (now - (st.lastTry || 0) < RETRY_MS) return false;
  return true;
}

// L'endpoint du ping se déduit de celui de la polaire. Quelqu'un qui héberge
// son propre collecteur ne doit pas se retrouver à pinger le mien sans l'avoir
// demandé ; et si le chemin n'est pas celui qu'on attend, on n'envoie rien du
// tout plutôt que de poster à l'aveugle sur une URL inconnue.
function pingEndpointFrom(shareEndpoint) {
  if (!shareEndpoint) return '';
  let u;
  try {
    u = new URL(shareEndpoint);
  } catch (e) {
    return '';
  }
  const p = u.pathname.replace(/\/+$/, '');
  if (!/\/v1\/polars$/.test(p)) return '';
  u.pathname = p.replace(/\/v1\/polars$/, '/v1/ping');
  u.search = '';
  return u.toString();
}

function createUsage(file, log) {
  let st = blank();
  let inFlight = false;
  const startedAt = Date.now();

  if (file && fs.existsSync(file)) {
    try {
      st = Object.assign(blank(), JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      /* état illisible : nouvel identifiant, une installation comptée deux fois */
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.writeFileSync(file, JSON.stringify(st));
    } catch (e) {
      if (log) log(`usage: cannot write state: ${e.message}`);
    }
  }

  // L'identifiant est tiré au démarrage, indépendamment du réglage : il sert
  // aussi de clé à la polaire partagée (deux bateaux du même modèle appelés
  // « Jazzy » s'écrasaient l'un l'autre chez le collecteur). Tiré ne veut pas
  // dire envoyé : il ne quitte le bord que si le partage ou le ping est actif.
  if (!st.installId) {
    st.installId = crypto.randomUUID();
    st.firstSeen = Date.now();
    save();
  }

  async function post(endpoint, payload) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  function maybeSend(opts, build) {
    if (!opts.usageStats || !opts.usageEndpoint) return false;
    if (inFlight) return false;
    const now = Date.now();
    if (!isDue(st, now, opts.usageEveryMs || DAY, now - startedAt)) return false;

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
    post(opts.usageEndpoint, payload)
      .then(() => {
        st.lastSentAt = Date.now();
        st.sent++;
        st.lastError = null;
      })
      .catch((e) => {
        st.failures++;
        st.lastError = e.message;
        // En debug seulement, à la différence du partage : un ping qui ne part
        // pas n'est la panne de personne, et le journal du serveur n'a pas à
        // s'en encombrer une fois par heure au mouillage sans réseau.
        if (log) log(`usage ping: ${e.message}`);
      })
      .finally(() => {
        inFlight = false;
        save();
      });
    return true;
  }

  return {
    maybeSend,
    id: () => st.installId,
    firstSeen: () => st.firstSeen || null,
    nextAt: (everyMs) =>
      Math.max((st.lastSentAt || 0) + (everyMs || DAY), startedAt + MIN_UPTIME_MS),
    state: () => Object.assign({ inFlight }, st),
  };
}

module.exports = { createUsage, isDue, pingEndpointFrom, DAY, RETRY_MS, MIN_UPTIME_MS };
