// COPIE PARTAGÉE — le fichier de référence vit dans signalk-autopolar, comme
// lib/usage.js et lib/support.js. Il ne connaît rien à la polaire et se
// recopie tel quel dans les autres plugins ; `cmp` doit rester silencieux
// entre les copies.

// « Il existe une version plus récente. »
//
// Motif chiffré, pas une intuition : sur les installations qui pinguent le
// collecteur, près de la moitié tournaient sur une version dépassée alors que
// l'appstore SignalK affiche déjà les mises à jour disponibles. Personne n'y va
// sans raison. La webapp, elle, est ouverte en nav.
//
// Ce module n'a RIEN à voir avec lib/usage.js, et la distinction est le cœur du
// sujet :
//
//   - le ping d'usage envoie une donnée dont l'équipage ne tire aucun bénéfice,
//     avec un identifiant persistant. Il doit donc être annoncé champ par champ
//     et rester coupable jusqu'à preuve du contraire ;
//   - ceci est un GET anonyme vers le registre npm d'où le plugin a été
//     installé, qui ne transporte aucun corps, aucun identifiant, aucune donnée
//     du bord, et dont le seul bénéficiaire est celui qui le déclenche. C'est
//     exactement ce que fait l'appstore SignalK à chaque ouverture.
//
// Ce qui ne dispense pas de le dire, ni de pouvoir le couper.
//
// Deux règles de tenue :
//   - le nom du paquet vient du package.json de l'appelant, jamais d'une
//     constante. Un fork interroge son propre nom, pas le mien ;
//   - hors ligne, on n'affiche rien. Pas « échec de la vérification », pas de
//     pastille rouge : au large l'absence de réseau est l'état normal et ce
//     n'est la panne de personne.

const fs = require('fs');

const DAY = 86400000;
// Après un échec on retente dans l'heure, pas le lendemain : au mouillage le
// réseau revient souvent dans la journée.
const RETRY_MS = 3600000;
// Rien au démarrage : le serveur a mieux à faire que d'ouvrir une socket vers
// l'extérieur pendant qu'il monte ses connexions au bus.
const MIN_UPTIME_MS = 120000;
const REGISTRY = 'https://registry.npmjs.org';

const blank = () => ({ latest: null, checkedAt: 0, lastTry: 0, lastError: null });

// Décision pure : ni disque, ni réseau, ni horloge implicite.
function isDue(st, now, everyMs, sinceStart) {
  if (!(everyMs > 0)) return false;
  if ((sinceStart != null ? sinceStart : Infinity) < MIN_UPTIME_MS) return false;
  if (now - (st.checkedAt || 0) < everyMs) return false;
  if (now - (st.lastTry || 0) < RETRY_MS) return false;
  return true;
}

// L'URL du registre pour un nom de paquet. Un paquet scopé porte un `/` dans
// son nom, qui doit être encodé — sans quoi le registre répond 404 et on
// conclurait tranquillement « pas de mise à jour » pour toujours.
function registryUrl(name, registry) {
  if (!name) return '';
  return `${(registry || REGISTRY).replace(/\/+$/, '')}/${name.replace('/', '%2F')}/latest`;
}

// Comparaison de versions, réduite à ce dont on a besoin : major.minor.patch.
// Une version portant un suffixe de préversion (`1.2.0-rc1`) est traitée comme
// ANTÉRIEURE à la version nue — on ne propose jamais une préversion à un
// bateau, et on ne signale pas non plus une mise à jour à qui en fait tourner
// une plus récente que le registre.
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] || null };
}
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (!!pa.pre === !!pb.pre) return 0;
  return pa.pre ? -1 : 1;
}
// Ne rien dire vaut mieux que dire une bêtise : sans version lisible des deux
// côtés, pas de proposition.
function isNewer(latest, current) {
  if (!parse(latest) || !parse(current)) return false;
  return compare(latest, current) > 0;
}

function createUpdate(file, log) {
  let st = blank();
  let inFlight = false;
  const startedAt = Date.now();

  if (file && fs.existsSync(file)) {
    try {
      st = Object.assign(blank(), JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      /* état illisible : on revérifiera, c'est tout ce que ça coûte */
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.writeFileSync(file, JSON.stringify(st));
    } catch (e) {
      if (log) log(`update check: cannot write state: ${e.message}`);
    }
  }

  async function fetchLatest(url) {
    // Un timeout court : cette requête ne doit jamais peser sur le plugin, et
    // au large elle n'aboutira de toute façon pas.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body || !body.version) throw new Error('no version in registry answer');
      return String(body.version);
    } finally {
      clearTimeout(t);
    }
  }

  // `opts` : { checkForUpdates, name, registry, everyMs }
  function maybeCheck(opts) {
    if (!opts || !opts.checkForUpdates) return false;
    const url = registryUrl(opts.name, opts.registry);
    if (!url) return false;
    if (inFlight) return false;
    const now = Date.now();
    if (!isDue(st, now, opts.everyMs || DAY, now - startedAt)) return false;

    st.lastTry = now;
    inFlight = true;
    fetchLatest(url)
      .then((v) => {
        st.latest = v;
        st.checkedAt = Date.now();
        st.lastError = null;
      })
      .catch((e) => {
        // En debug seulement. Un bateau au large échouerait une fois par heure,
        // et le journal du serveur n'a pas à s'en encombrer.
        st.lastError = e.name === 'AbortError' ? 'timeout' : e.message;
        if (log) log(`update check: ${st.lastError}`);
      })
      .finally(() => {
        inFlight = false;
        save();
      });
    return true;
  }

  // Ce que la webapp affiche. `latest` n'est renvoyé que s'il est réellement
  // plus récent : ainsi la webapp n'a aucune règle de version à réimplémenter,
  // et il n'y a qu'un seul endroit où l'on peut se tromper.
  function status(current, enabled) {
    const available = isNewer(st.latest, current);
    return {
      enabled: Boolean(enabled),
      current: current || null,
      latest: available ? st.latest : null,
      checkedAt: st.checkedAt || null,
      // Utile en diagnostic, jamais affiché comme une erreur.
      lastError: st.lastError || null,
    };
  }

  return { maybeCheck, status, state: () => Object.assign({ inFlight }, st) };
}

module.exports = { createUpdate, isDue, isNewer, compare, registryUrl, DAY, RETRY_MS, MIN_UPTIME_MS };
