// Le filtre d'admission : c'est LUI qui fait la différence entre une polaire
// exploitable et le nuage informe que produisent la plupart des enregistreurs.
//
// La distinction qui structure tout ce fichier : **dérive** contre
// **dispersion**.
//
//   Un voilier ne tient JAMAIS un cap, une vitesse et un vent constants
//   pendant 60 s. La mer le fait rouler, les rafales le lancent, le pilote
//   chasse. Exiger la constance reviendrait à ne rien collecter — ou à ne
//   collecter que par temps plat, c'est-à-dire précisément là où la polaire
//   n'apprend rien.
//
//   Ce qui invalide un point, ce n'est pas que les valeurs bougent, c'est
//   qu'elles s'en aillent : que le régime de fin de fenêtre ne soit plus
//   celui du début. On mesure donc la DÉRIVE (moyenne du dernier tiers moins
//   moyenne du premier tiers) et on la refuse ; la DISPERSION autour de cette
//   moyenne est tolérée largement, et c'est justement elle qu'on moyenne.
//
// Corollaire : le cap n'est pas un critère. Sous pilote en mode vent, une
// bascule de 30° fait tourner le bateau de 30° alors que l'allure — donc la
// performance — n'a pas changé d'un poil. C'est l'angle du vent apparent qui
// définit l'allure, et c'est lui qu'on surveille. Les vraies manœuvres
// (virement, empannage) se voient au changement d'amure et à la giration.
//
// Deux étages, tous les deux purs (aucun accès SignalK, aucun état global) :
//   1. classify()    — sur un instantané : sous voile, en marche, données là ?
//   2. assessWindow() — sur la fenêtre : régime unique ou régime qui change ?

const { spread, spreadAngle, mean, meanAngle, median, wrap180 } = require('./geom');

// Jusqu'où « au près » va, pour la règle « plus vite que le vent » plus bas.
// 70° et pas 90° : au travers, une risée rentrée dans les voiles peut encore
// lancer un bateau léger au-delà du vent vrai le temps d'une fenêtre, alors
// qu'à 70° et moins il n'y a plus d'explication que le moteur.
const UPWIND_TWA_DEG = 70;

// ── Étage 1 : l'instantané est-il exploitable ? ─────────────────────────────
//
// snap : { stw, sog, awa, aws, twa, tws, hdg, cog, roll, rot, rpm,
//          engineState, navState, fresh:{...}, rpmEverSeen }
// Retourne { usable, reason, engineSource }.
function classify(snap, opts) {
  const f = snap.fresh || {};

  // Le vent apparent est la seule mesure vraiment indispensable : c'est la
  // seule donnée d'entrée qu'on ne peut reconstruire à partir de rien.
  if (!f.awa || !f.aws) return { usable: false, reason: 'no_wind_data' };
  if (!f.sog) return { usable: false, reason: 'no_sog' };

  // ── Moteur ──
  // Ordre de préférence délibéré. Le RPM (ou l'état moteur) est la vérité ;
  // navigation.state n'est qu'un repli, parce que signalk-autostate le dérive
  // de ces mêmes RPM. Ce repli n'est PAS circulaire pour autant : autostate
  // est « collant », il conserve le dernier état connu. Si le lien MQTT avec
  // le Cerbo meurt en pleine nav à la voile, il reste sur « sailing » et on
  // continue de collecter au lieu de perdre la nav — tandis que s'il meurt au
  // moteur, il reste sur « motoring » et on ne collecte pas. Le repli se
  // trompe donc du bon côté.
  //
  // On ne cherche PAS à savoir à quel régime tourne le moteur, seulement s'il
  // tourne. C'est ce qui rend la détection robuste : `propulsion.*.state`
  // répond directement à la question, et pour `propulsion.*.revolutions` on ne
  // lit qu'un booléen déguisé — toute valeur non nulle = en marche. Peu importe
  // alors l'unité ou l'échelle qu'emploie la passerelle : zéro ou rien = à
  // l'arrêt, le reste = en marche. `state` passe devant parce qu'il ne peut pas
  // être ambigu.
  //
  // Et quand les deux sont là et se contredisent, on prend la lecture
  // prudente : « en marche ». Collecter un point au moteur salit la polaire
  // pour toujours ; en rater un ne coûte que ce point-là.
  const hasRpm = f.rpm && typeof snap.rpm === 'number';
  const hasState = f.engineState && typeof snap.engineState === 'string';
  let engineSource = null;
  if (hasState || hasRpm) {
    const runningByState = hasState && snap.engineState !== 'stopped';
    const runningByRpm = hasRpm && snap.rpm > 0;
    if (runningByState || runningByRpm) return { usable: false, reason: 'motoring' };
    engineSource = hasState ? (hasRpm ? 'state+rpm' : 'state') : 'rpm';
  } else if (snap.declaredSailing) {
    // Aucun signal moteur sur ce bateau, et l'équipage a déclaré naviguer à la
    // voile. C'est la seule branche où la machine croit un humain sur parole,
    // donc elle est bornée dans le temps (la déclaration expire) et les points
    // sont marqués : ils restent identifiables, filtrables, et hors du partage.
    //
    // Le sens de l'oubli compte. Oublier de renouveler la déclaration fait
    // perdre des points, ce qui ne coûte rien ; il n'existe pas d'oubli qui
    // ferait entrer du moteur dans la polaire — c'est pour ça qu'elle expire
    // au lieu d'être un simple interrupteur.
    engineSource = 'declared';
  } else if (opts.autostateFallback && snap.navState === 'sailing' && snap.rpmEverSeen) {
    // rpmEverSeen : sans lui, autostate annonce « sailing » par défaut quand
    // il n'a JAMAIS vu de donnée moteur (defaultPropulsion) — ce qui voudrait
    // dire « on ne sait rien » et non « le moteur est à l'arrêt ».
    engineSource = 'autostate';
  } else {
    return { usable: false, reason: 'engine_unknown' };
  }

  if (snap.navState === 'anchored' || snap.navState === 'moored') {
    // navigation.state est collant et parfois en retard de plusieurs minutes ;
    // s'il dit « au mouillage » alors qu'on avance franchement, c'est lui qui
    // a tort. On ne le croit que si la vitesse le confirme.
    if (snap.sog < opts.minSogKn * 2) return { usable: false, reason: 'anchored' };
  }

  if (snap.sog < opts.minSogKn) return { usable: false, reason: 'too_slow' };
  if (snap.aws < opts.minAwsKn) return { usable: false, reason: 'no_wind' };

  // Un |TWA| sous ~25° = on remonte au moteur ou on fait du surplace face au
  // vent : rien à apprendre, et le calcul du vent vrai y est très bruité.
  if (Math.abs(snap.twa) < opts.minTwaDeg) return { usable: false, reason: 'in_irons' };

  // ── Plus vite que le vent, au près ──
  //
  // Le seul contrôle PHYSIQUE du filtre, et le seul qui ne demande rien au
  // bateau : au près, sous voile, une coque habitable ne dépasse pas la vitesse
  // du vent vrai. Au portant c'est différent (un surf, un multi qui part), d'où
  // la limite d'angle ; au près, l'écoulement sur les voiles impose que le vent
  // apparent reste devant, et le vent apparent ne peut pas pousser plus vite
  // que ça.
  //
  // Il existe parce que tout ce qui précède croit le bateau sur parole. Les
  // deux premières polaires étrangères du fonds commun où cette règle mord —
  // 1,26× et 1,29× le vent vrai au près, dans leur bande 4 nœuds — portaient
  // chacune un verdict moteur du rang le plus solide : `state` sur 995 points
  // pour l'une, `rpm` sur 3500 pour l'autre. Un signal moteur peut être
  // présent, frais, et pourtant constant : une passerelle qui publie
  // `stopped` en permanence, ou un compte-tours jamais câblé qui publie zéro,
  // ne se distingue pas d'un moteur vraiment à l'arrêt — sauf par ce que fait
  // le bateau. Ici, on regarde ce que fait le bateau.
  //
  // Se tromper coûte un point ; ne pas le faire salit la polaire pour toujours,
  // et le fonds commun avec elle. Réglable, parce qu'un foiler dépasse
  // vraiment le vent au près : `maxUpwindSpeedRatio: 0` désactive la règle.
  if (
    opts.maxUpwindSpeedRatio > 0 &&
    typeof snap.tws === 'number' &&
    snap.tws > 0 &&
    Math.abs(snap.twa) <= UPWIND_TWA_DEG &&
    snap.sog > snap.tws * opts.maxUpwindSpeedRatio
  )
    return { usable: false, reason: 'faster_than_wind' };

  return { usable: true, reason: 'ok', engineSource };
}

// ── Outils de fenêtre ───────────────────────────────────────────────────────

// Dérive d'une grandeur : ce qu'elle vaut à la fin moins ce qu'elle valait au
// début, en moyennant chaque extrémité sur un tiers de la fenêtre pour ne pas
// lire du bruit. C'est la mesure de « le régime a-t-il changé ».
function drift(vals) {
  const k = Math.max(1, Math.floor(vals.length / 3));
  return mean(vals.slice(-k)) - mean(vals.slice(0, k));
}

// `spread` sur un tableau vide vaut NaN (Math.max() - Math.min()). Un bateau
// sans centrale d'attitude est un cas parfaitement normal : on renvoie null,
// qui se lit « pas mesuré », plutôt qu'un NaN qui contaminerait le JSON.
function spreadOrNull(arr) {
  const v = arr.filter((x) => typeof x === 'number');
  return v.length >= 2 ? spread(v) : null;
}

function driftAngle(degs) {
  const k = Math.max(1, Math.floor(degs.length / 3));
  return wrap180(meanAngle(degs.slice(-k)) - meanAngle(degs.slice(0, k)));
}

// ── Étage 2 : la fenêtre décrit-elle un seul régime ? ───────────────────────
//
// win : tableau d'instantanés acceptés, consécutifs, un par seconde.
// Retourne { stable, reason, metrics }.
function assessWindow(win, opts) {
  if (win.length < opts.windowS) {
    // L'état de la mer n'a pas à attendre la fin de la fenêtre pour être
    // affiché : c'est une lecture d'instrument, pas un verdict sur le point.
    return {
      stable: false,
      reason: 'accumulating',
      metrics: {
        n: win.length,
        pitchSpread: spreadOrNull(win.map((s) => s.pitch)),
        rollSpread: spreadOrNull(win.map((s) => s.roll)),
      },
    };
  }

  const awa = win.map((s) => s.awa);
  const twa = win.map((s) => s.twa);
  const tws = win.map((s) => s.tws);
  const hdg = win.map((s) => s.hdg);
  const sog = win.map((s) => s.sog);

  const metrics = {
    n: win.length,
    awaDrift: driftAngle(awa),
    awaSpread: spreadAngle(awa),
    twsDrift: drift(tws),
    twsSpread: spread(tws),
    sogDrift: drift(sog),
    sogSpread: spread(sog),
    hdgDrift: driftAngle(hdg),
    hdgSpread: spreadAngle(hdg),
    rotMean: mean(win.map((s) => Math.abs(s.rot || 0))),
    // État de la mer, mesuré plutôt que saisi.
    //
    // Il pèse autant sur la polaire que la voilure — un bateau perd facilement
    // un nœud dans un clapot court — mais personne ne pense à le renseigner
    // depuis un cockpit à 3 h du matin. Or le bord le mesure déjà : c'est
    // l'amplitude du tangage sur la fenêtre. Le roulis est moins parlant (il
    // dépend surtout de l'allure et de la gîte), on le garde quand même parce
    // qu'une donnée non enregistrée est perdue pour toujours, et que le brut
    // ne pourra pas la reconstruire.
    pitchSpread: spreadOrNull(win.map((s) => s.pitch)),
    rollSpread: spreadOrNull(win.map((s) => s.roll)),
  };

  // ── Manœuvres : les seuls rejets vraiment durs ──
  // Changement d'amure en cours de fenêtre. Près du lit du vent (0°) et du
  // plein vent arrière (180°), le signe de l'angle vacille naturellement sans
  // qu'on ait viré : on ne regarde donc l'amure que là où elle a un sens.
  const sided = awa.filter((a) => Math.abs(a) > 20 && Math.abs(a) < 160);
  if (sided.length) {
    const sgn = Math.sign(sided[0]);
    if (sided.some((a) => Math.sign(a) !== sgn)) {
      return { stable: false, reason: 'tack_change', metrics };
    }
  }

  // Giration : on regarde la vitesse de rotation MOYENNE, pas un pic. Un
  // à-coup de barre ou une lame qui fait embarder donne un pic sans rien
  // invalider ; c'est une rotation soutenue qui trahit une manœuvre.
  if (metrics.rotMean > opts.rotMaxDegS) return { stable: false, reason: 'turning', metrics };

  // ── Dérive : le régime change en cours de fenêtre ──
  // L'angle du vent apparent définit l'allure. S'il s'en va, on a loffé,
  // abattu, ou le pilote a changé de consigne : début et fin de fenêtre ne
  // décrivent plus le même bateau. Le CAP, lui, n'est pas un critère : sous
  // pilote en mode vent, une bascule le fait tourner sans que l'allure bouge.
  if (Math.abs(metrics.awaDrift) > opts.awaDriftMaxDeg) return { stable: false, reason: 'course_changed', metrics };
  if (Math.abs(metrics.twsDrift) > opts.twsDriftMaxKn) return { stable: false, reason: 'wind_shifting', metrics };
  if (Math.abs(metrics.sogDrift) > opts.sogDriftMaxKn) return { stable: false, reason: 'accelerating', metrics };

  // ── Dispersion : plafonds larges, garde-fous contre le chaos ──
  // Au-delà, ce n'est plus « la mer bouge » mais « on ne mesure plus rien » :
  // anémo qui bat dans un roulis bord sur bord, série de surfs, molle totale.
  // En dessous, on tolère et on moyenne — c'est le bruit normal d'un voilier.
  if (metrics.awaSpread > opts.awaSpreadMaxDeg) return { stable: false, reason: 'wind_erratic', metrics };
  if (metrics.twsSpread > opts.twsSpreadMaxKn) return { stable: false, reason: 'wind_gusty', metrics };
  if (metrics.sogSpread > opts.sogSpreadMaxKn) return { stable: false, reason: 'speed_erratic', metrics };

  // Note de confiance : à quel point la fenêtre était calme par rapport aux
  // plafonds tolérés. 1 = régime de bassin, 0 = à la limite du rejet. Elle
  // est enregistrée sur chaque point, ce qui permet plus tard de ne garder
  // que les meilleures mesures sans avoir à tout re-collecter.
  const ratio = (v, max) => Math.max(0, 1 - Math.abs(v) / max);
  metrics.quality =
    (ratio(metrics.awaSpread, opts.awaSpreadMaxDeg) +
      ratio(metrics.twsSpread, opts.twsSpreadMaxKn) +
      ratio(metrics.sogSpread, opts.sogSpreadMaxKn)) /
    3;

  return { stable: true, reason: 'stable', metrics };
}

// Réduit une fenêtre à un point unique. Médiane pour les vitesses : sur 60
// mesures, elle donne le même résultat que la moyenne quand tout va bien, mais
// elle ignore le surf de trois secondes ou le fix GPS aberrant, là où la
// moyenne les incorpore. Moyenne circulaire pour les angles.
function condense(win, extra) {
  const num = (key) => win.map((s) => s[key]).filter((v) => typeof v === 'number');
  const med = (key) => {
    const v = num(key);
    return v.length ? median(v) : null;
  };
  const ang = (key) => {
    const v = num(key);
    return v.length ? meanAngle(v) : null;
  };
  return Object.assign(
    {
      ts: win[win.length - 1].ts,
      n: win.length,
      sog: med('sog'),
      stw: med('stw'),
      twa: ang('twa'),
      tws: med('tws'),
      awa: ang('awa'),
      aws: med('aws'),
      hdg: ang('hdg'),
      // D'où vient ce cap : vrai, magnétique redressé par la déclinaison, ou
      // magnétique brut. Sans ça, l'écart `cog - hdg` n'est pas interprétable
      // (voir lib/leeway.js). On prend la provenance de la dernière seconde,
      // comme l'horodatage — une fenêtre qui change de source de cap en cours
      // de route est déjà exclue par la dérive de cap.
      hdgSrc: win[win.length - 1].hdgSrc || null,
      cog: ang('cog'),
      roll: win.some((s) => typeof s.roll === 'number') ? mean(num('roll')) : null,
      pitch: win.some((s) => typeof s.pitch === 'number') ? mean(num('pitch')) : null,
    },
    extra
  );
}

module.exports = { UPWIND_TWA_DEG, classify, assessWindow, condense, drift, driftAngle };
