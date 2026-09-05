// ── Polaire — apprentissage automatique ──────────────────────────────────────
//
// Observe la nav en tâche de fond et construit la polaire du bateau. Le pari
// de ce plugin, par rapport aux enregistreurs existants, tient en trois
// décisions :
//
//  1. On n'enregistre un point QUE sur un régime établi. Une polaire décrit
//     un état d'équilibre ; un point pris pendant un virement, une
//     accélération, une risée ou un surf ne décrit rien et tire la courbe
//     vers le haut. Le filtre (lib/gate.js) est donc volontairement sévère,
//     et il DIT toujours pourquoi il refuse (webapp, panneau « en direct »).
//
//  2. On garde le brut. Tout ce qui est vu sous voile est écrit seconde par
//     seconde dans samples.jsonl, avant tout filtre. Si les seuils étaient
//     mal réglés, on rejoue le fichier au lieu de refaire la nav.
//
//  3. Rien n'est figé à la collecte. Chaque point porte à la fois SOG et STW,
//     vent vrai et vent apparent : les quatre polaires sont quatre lectures
//     des mêmes mesures, recalculées à la demande.

const fs = require('fs');
const path = require('path');
const { MS_TO_KN, R2D, wrap180, trueWind } = require('./lib/geom');
const { classify, assessWindow, condense } = require('./lib/gate');
const polarLib = require('./lib/polar');
const { createStore } = require('./lib/store');
const { createNotifier } = require('./lib/notify');
const speedo = require('./lib/speedo');
const sailchange = require('./lib/sailchange');
const { createShare } = require('./lib/share');

// Seuils plancher de l'enregistrement brut : délibérément plus permissifs que
// ceux de la collecte, pour que le rejeu puisse explorer des réglages plus
// larges que ceux du jour. Le seul critère non négociable reste le moteur.
const RAW_OPTS = {
  engineOffRpm: 50,
  autostateFallback: true,
  minSogKn: 0.3,
  minAwsKn: 0.2,
  minTwaDeg: 5,
};

module.exports = function (app) {
  const plugin = {
    id: 'signalk-autopolar',
    name: 'Polar — automatic learning',
    description:
      'Learns your boat polar by watching how she is actually sailed — never under engine, never at anchor. Ships a web app to plot it, compare SOG against STW and true against apparent wind, weed out outliers and export to routing software.',
  };

  let store = null;
  let timer = null;
  let opts = {};
  let sail = { main: '', head: '' };
  let sailFile = null;
  // Déclaration « je navigue à la voile » pour les bateaux sans aucune donnée
  // moteur. Persistée : un redémarrage de SignalK en pleine nav ne doit pas
  // obliger à la reposer. Elle expire de toute façon.
  let declaredUntil = 0;
  let declareFile = null;
  let startedAt = null;
  let rpmEverSeen = false;
  // La plus forte valeur brute de `revolutions` jamais observée, conservée
  // pour diagnostiquer l'échelle de la source (voir readEngine).
  let engineWitness = null;
  let buffer = [];
  let live = { reason: 'starting', ts: Date.now() };
  let counters = { samples: 0, accepted: 0, rejected: {} };

  // Surveillance de l'inactivité : on compte les secondes réellement passées
  // sous voile depuis le dernier point retenu — pas le temps qui passe. Ainsi
  // une nuit au mouillage ne déclenche rien, et 20 min de vraie nav sans un
  // seul point déclenchent tout de suite.
  let notifier = null;
  let sharer = null;
  let sailSecs = 0;
  let idleAlerted = false;
  let idleRejects = {};

  plugin.schema = {
    type: 'object',
    properties: {
      windowS: {
        type: 'number',
        title: 'Steady state required before a point is recorded (s)',
        description:
          'The boat must hold these conditions without a break. Longer means cleaner but rarer points. 60 s is a good trade-off over a 24 h passage.',
        default: 60,
      },
      awaDriftMaxDeg: {
        type: 'number',
        title: 'Max apparent wind angle drift across the window (deg)',
        description:
          'THE point-of-sail criterion. The mean of the last third of the window is compared with the mean of the first third: beyond this, you have luffed, borne away or changed the autopilot setting, and the point no longer describes one single regime. Not to be confused with the spread below — apparent wind can swing widely without drifting.',
        default: 15,
      },
      awaSpreadMaxDeg: {
        type: 'number',
        title: 'Max apparent wind angle spread (deg)',
        description:
          'A ceiling, not a demand for steadiness: in a seaway the masthead unit swings 20-30 deg without the point of sail changing at all, and that swing is exactly what gets averaged. Past the ceiling nothing is being measured any more (rolling gunwale to gunwale).',
        default: 45,
      },
      twsDriftMaxKn: {
        type: 'number',
        title: 'Max wind speed drift across the window (kn)',
        description: 'The wind is clearly building or dying: the start and the end of the window no longer belong to the same polar cell.',
        default: 3,
      },
      twsSpreadMaxKn: {
        type: 'number',
        title: 'Max wind speed spread (kn)',
        description: 'A ceiling: gusts are normal and get averaged, but a huge spread means a squall or a rogue reading.',
        default: 8,
      },
      sogDriftMaxKn: {
        type: 'number',
        title: 'Max boat speed drift across the window (kn)',
        description: 'The boat is still accelerating or slowing down: she has not reached the steady state a polar describes.',
        default: 1.5,
      },
      sogSpreadMaxKn: {
        type: 'number',
        title: 'Max boat speed spread (kn)',
        description: 'A ceiling: surfing down a swell is normal and gets averaged.',
        default: 2.5,
      },
      rotMaxDegS: {
        type: 'number',
        title: 'Max mean rate of turn (deg/s)',
        description:
          'Catches manoeuvres. This is the mean over the window, not a peak: one slew off a wave invalidates nothing, a sustained turn does.',
        default: 6,
      },
      minSogKn: { type: 'number', title: 'Minimum boat speed to record (kn)', default: 1 },
      minAwsKn: { type: 'number', title: 'Minimum apparent wind speed (kn)', default: 1.5 },
      minTwaDeg: {
        type: 'number',
        title: 'Minimum true wind angle (deg)',
        description: 'Below this you are head to wind: nothing to learn, and the true wind computation is very noisy.',
        default: 25,
      },
      engineOffRpm: {
        type: 'number',
        title: 'Engine considered stopped below this RPM',
        default: 50,
      },
      allowDeclaredSailing: {
        type: 'boolean',
        title: 'Let the crew declare "sailing" when the boat has no engine data at all',
        description:
          'Without any engine signal nothing can be collected, which is the safe answer but leaves some boats with nothing. This lets you say so yourself. The declaration expires on its own, so forgetting to renew it only costs you points — there is no way to forget to switch it off and quietly feed motoring into the polar. Points recorded this way are tagged and are left out of shared polars.',
        default: true,
      },
      declaredSailingMinutes: {
        type: 'number',
        title: 'How long a "sailing" declaration lasts (minutes)',
        default: 90,
      },
      engineRpmFactor: {
        type: 'number',
        title: 'Multiplier from propulsion.*.revolutions to RPM',
        description:
          'The SignalK spec says revolutions are in hertz, so 60 converts to RPM — that is the default. Some gateways publish RPM straight into that path, which then reads 60x too high; others publish a raw pulse rate. The live panel shows the raw value next to the converted one, so you can read the true ratio off the display while the engine runs and set this once. Collection is unaffected either way: any positive multiplier still tells a running engine from a stopped one.',
        default: 60,
      },
      autostateFallback: {
        type: 'boolean',
        title: 'Fall back on navigation.state when engine data is missing',
        description:
          'If RPM stops arriving (broken MQTT link), accept navigation.state = sailing as proof the engine is off. Safe in practice: signalk-autostate keeps the last known state, so it stays on "motoring" if the outage happens under engine. Affected points are tagged and can be filtered out afterwards.',
        default: true,
      },
      staleMs: { type: 'number', title: 'Max age for a reading to count as fresh (ms)', default: 6000 },
      engineStaleMs: {
        type: 'number',
        title: 'Max age for engine data (ms)',
        description:
          'Much longer than the rest, and it matters: engine RPM often arrives on a slow bridge (once a minute over MQTT from a Cerbo GX, for instance) while wind and speed come off the NMEA 2000 bus several times a second. With one common threshold the engine would read "unknown" 54 s out of every 60 and nothing would ever be collected.',
        default: 180000,
      },
      rawSamples: {
        type: 'boolean',
        title: 'Also log raw data, second by second',
        description:
          'The safety net: lets you rebuild every point with different thresholds without sailing the passage again. About 15 MB per 30 h, and only while sailing.',
        default: true,
      },
      maxSampleMB: { type: 'number', title: 'Max size of the raw log (MB)', default: 500 },
      twsBins: {
        type: 'array',
        title: 'Wind speed columns of the polar (kn)',
        description:
          'Bin centres. Boundaries fall halfway between two centres. A 2 kn step keeps enough resolution for routing software; wider bins gather more points per cell but blur the curve.',
        items: { type: 'number' },
        default: [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 30],
      },
      twaStep: { type: 'number', title: 'Angle step of the polar (deg)', default: 5 },
      minSamples: {
        type: 'number',
        title: 'Minimum points before a polar cell is shown',
        default: 1,
      },
      sailHistoryDays: {
        type: 'number',
        title: 'Hide handled sail-plan stretches older than (days)',
        description:
          'A stretch you have corrected or confirmed stops asking for attention once it is this old. Without it the list only ever grows, one passage after another, and the periods that still need a decision get lost among those that do not. Nothing is deleted — a toggle brings them all back.',
        default: 2,
      },
      sailChangeSide: {
        type: 'number',
        title: 'Points compared each side of a candidate sail change',
        description:
          'Used by the sail-change suggester. Wider is less noisy but blind to short-lived configurations — a sail plan that only lasted 40 minutes disappears into the averages. 6 works well on a day-long passage.',
        default: 6,
      },
      sailChangeMinStepKn: {
        type: 'number',
        title: 'Minimum performance step to flag a sail change (kn)',
        description:
          'How big a jump in "faster or slower than the polar predicts" is worth flagging. Lower catches more real changes and a lot of noise with them; the suggestions are candidates to review, never a verdict.',
        default: 0.5,
      },
      seaStateModerateDeg: {
        type: 'number',
        title: 'Pitch swing above which the sea counts as moderate (deg)',
        description:
          'Sea state is measured, not typed in: it is the peak-to-peak pitch over the window. These two thresholds turn that number into a word, and they are a starting guess for a 15 m boat — check them against a day you remember and adjust. The measurement itself is stored raw either way.',
        default: 3,
      },
      seaStateRoughDeg: {
        type: 'number',
        title: 'Pitch swing above which the sea counts as rough (deg)',
        default: 8,
      },
      vmgOffsetsDeg: {
        type: 'array',
        title: 'Angles compared either side of best VMG (deg)',
        description:
          'Knowing the best angle does not tell you what it costs to leave it. These offsets are shown either side of the optimum so you can see what you give up by luffing or bearing away.',
        items: { type: 'number' },
        default: [5, 10],
      },
      idleAlertMin: {
        type: 'number',
        title: 'Alert over ntfy after N minutes of sailing with nothing recorded (0 = never)',
        description:
          'Counts minutes actually spent sailing since the last accepted point, not wall-clock time. The message names the dominant rejection reasons, which is usually enough to know which threshold to relax — instead of finding out on the dock that nothing was collected.',
        default: 20,
      },
      ntfyUrl: { type: 'string', title: 'ntfy URL (topic included)', default: '' },
      ntfyToken: { type: 'string', title: 'ntfy token', default: '' },
      boatModel: {
        type: 'string',
        title: 'Boat model — required',
        description:
          'Nothing is collected until this and the name below are filled in. The model is what makes a polar useful to anyone else: "Beneteau Oceanis 48 (2013)" is useful, "sloop" is not. Add the year or the rig variant if the design changed during its production run.',
        default: '',
      },
      shareName: {
        type: 'string',
        title: 'Name to publish the polar under — required',
        description:
          'Free text: your boat name, or a pseudonym if you would rather stay anonymous — nothing checks it. The collected data contains no position of any kind, not one latitude, so a shared polar says nothing about where you sail.',
        default: '',
      },
      sharePolar: {
        type: 'boolean',
        title: 'Contribute my polar to the shared pool',
        description:
          'This plugin is free and stays free. In exchange it sends the polar it has learned to a shared pool, on its own, every few hundred new points — nothing to click, nothing to remember. Only the polar, the boat model and the name above leave the boat: no position, no track, no raw log. The exact payload is readable at any time in the webapp, under Share. Turning this off leaves the plugin fully working; it just stops the pool from growing.',
        default: true,
      },
      shareEndpoint: {
        type: 'string',
        title: 'Where shared polars are sent',
        default: 'https://polars.quicky.app/v1/polars',
      },
      shareEveryPoints: {
        type: 'number',
        title: 'Send an updated polar every N new points',
        description:
          'A polar frozen at its first 500 points is worth much less than the same one at 3000, so each send replaces the previous one for your boat. Sending is never on a clock: nothing goes out unless new points came in.',
        default: 500,
      },
      publishPerformance: {
        type: 'boolean',
        title: 'Publish performance.* into SignalK (target speed, ratio)',
        description:
          'Leave off until the polar has proved itself, and off entirely if another polar plugin is installed: they would all write to the same paths.',
        default: false,
      },
    },
  };

  // ── Lecture de l'arbre SignalK ─────────────────────────────────────────────
  // On lit à chaque tick plutôt que de s'abonner : la fraîcheur est alors
  // jugée sur le timestamp réel de la donnée (posé par le serveur à la
  // réception), et non sur la date à laquelle un delta nous est parvenu.
  function read(p) {
    const node = app.getSelfPath(p);
    if (!node) return null;
    const v = node.value !== undefined ? node.value : node;
    if (v === null || v === undefined) return null;
    const ts = node.timestamp ? Date.parse(node.timestamp) : null;
    const age = ts ? Date.now() - ts : null;
    return { value: v, age, source: node.$source };
  }

  function num(p, conv) {
    const r = read(p);
    if (!r || typeof r.value !== 'number') return { v: null, fresh: false, age: null };
    return { v: conv ? conv(r.value) : r.value, fresh: r.age == null || r.age < opts.staleMs, age: r.age };
  }

  const kn = (x) => x * MS_TO_KN;
  const deg = (x) => x * R2D;

  // Le nom de la ligne d'arbre (Engine1 sur Jazzy) n'est pas garanti : on
  // prend n'importe quelle propulsion qui tourne. Un seul moteur qui tourne
  // suffit à disqualifier le point.
  function readEngine() {
    const prop = app.getSelfPath('propulsion');
    let rpm = null;
    let rpmRaw = null;
    let rpmSource = null;
    let rpmFresh = false;
    let rpmAge = null;
    let state = null;
    let stateFresh = false;
    let stateAge = null;
    if (prop && typeof prop === 'object') {
      for (const key of Object.keys(prop)) {
        const eng = prop[key];
        if (!eng || typeof eng !== 'object') continue;
        if (eng.revolutions && typeof eng.revolutions.value === 'number') {
          // La spec SignalK dit que `revolutions` est en Hz (tours/seconde),
          // d'où le facteur 60 par défaut. Mais rien n'oblige la source à la
          // respecter, et une passerelle qui publie directement des tr/min
          // donne un affichage 60 fois trop grand sans que rien ne proteste.
          // Le facteur est donc réglable — et surtout, on garde la valeur
          // BRUTE : sans elle, impossible de savoir de combien on se trompe.
          const raw = eng.revolutions.value;
          const r = raw * opts.engineRpmFactor;
          const age = eng.revolutions.timestamp ? Date.now() - Date.parse(eng.revolutions.timestamp) : null;
          const fresh = age == null || age < opts.engineStaleMs;
          if (fresh) rpmEverSeen = true;
          if (rpm == null || r > rpm) {
            rpm = r;
            rpmRaw = raw;
            rpmSource = eng.revolutions.$source || null;
            rpmFresh = fresh;
            rpmAge = age;
          }
          // Le moteur tourne rarement pendant qu'on regarde l'écran. On retient
          // donc la plus forte valeur brute jamais vue, avec sa source et son
          // heure : c'est la mesure qui permettra de trancher le facteur, sans
          // avoir à rallumer le moteur exprès pour observer.
          if (raw > 0 && (!engineWitness || raw > engineWitness.raw)) {
            engineWitness = {
              raw,
              at: Date.now(),
              source: eng.revolutions.$source || null,
              path: `propulsion.${key}.revolutions`,
              units: (eng.revolutions.meta && eng.revolutions.meta.units) || null,
            };
          }
        }
        if (eng.state && typeof eng.state.value === 'string') {
          const age = eng.state.timestamp ? Date.now() - Date.parse(eng.state.timestamp) : null;
          const fresh = age == null || age < opts.engineStaleMs;
          if (fresh) rpmEverSeen = true;
          if (state == null || eng.state.value !== 'stopped') {
            state = eng.state.value;
            stateFresh = fresh;
            stateAge = age;
          }
        }
      }
    }
    return { rpm, rpmRaw, rpmSource, rpmFresh, rpmAge, state, stateFresh, stateAge };
  }

  function snapshot() {
    const sog = num('navigation.speedOverGround', kn);
    const stw = num('navigation.speedThroughWater', kn);
    const aws = num('environment.wind.speedApparent', kn);
    const awa = num('environment.wind.angleApparent', (v) => wrap180(deg(v)));
    let tws = num('environment.wind.speedTrue', kn);
    let twa = num('environment.wind.angleTrueWater', (v) => wrap180(deg(v)));
    const cog = num('navigation.courseOverGroundTrue', deg);
    let hdg = num('navigation.headingTrue', deg);
    if (!hdg.fresh) hdg = num('navigation.headingMagnetic', deg);
    const rot = num('navigation.rateOfTurn', deg);

    // Vent vrai : on préfère celui du serveur (signalk-derived-data résout
    // déjà les priorités de source et applique la dérive), et on ne le
    // recalcule que s'il manque — pour ne pas avoir deux vérités qui divergent.
    let twSource = 'signalk';
    if ((!tws.fresh || !twa.fresh) && awa.fresh && aws.fresh) {
      const ref = stw.fresh && stw.v > 0 ? stw.v : sog.v;
      if (typeof ref === 'number') {
        const t = trueWind(awa.v, aws.v, ref);
        tws = { v: t.tws, fresh: true };
        twa = { v: wrap180(t.twa), fresh: true };
        twSource = stw.fresh && stw.v > 0 ? 'calculé/STW' : 'calculé/SOG';
      }
    }

    const eng = readEngine();
    const navStateNode = read('navigation.state');

    return {
      ts: Date.now(),
      sog: sog.v,
      stw: stw.v,
      awa: awa.v,
      aws: aws.v,
      twa: twa.v,
      tws: tws.v,
      hdg: hdg.v,
      cog: cog.v,
      ...(() => {
        const a = read('navigation.attitude');
        const v = a && a.value ? a.value : null;
        return {
          roll: v && typeof v.roll === 'number' ? deg(v.roll) : null,
          pitch: v && typeof v.pitch === 'number' ? deg(v.pitch) : null,
        };
      })(),
      rot: rot.v,
      rpm: eng.rpm,
      rpmRaw: eng.rpmRaw,
      rpmSource: eng.rpmSource,
      engineState: eng.state,
      navState: navStateNode ? navStateNode.value : null,
      declaredSailing: opts.allowDeclaredSailing && Date.now() < declaredUntil,
      declaredUntil,
      rpmEverSeen,
      twSource,
      fresh: {
        sog: sog.fresh,
        stw: stw.fresh,
        awa: awa.fresh,
        aws: aws.fresh,
        twa: twa.fresh,
        tws: tws.fresh,
        hdg: hdg.fresh,
        rpm: eng.rpmFresh,
        engineState: eng.stateFresh,
      },
      // L'âge en clair, en plus du booléen : « frais » et « périmé » sont des
      // verdicts, et un verdict qu'on ne peut pas recouper ne se diagnostique
      // pas. Avec l'âge, on voit immédiatement si une source est morte, si
      // elle est simplement lente (le RPM arrive toutes les 60 s) ou si c'est
      // le seuil qui est mal réglé.
      ages: {
        sog: sog.age,
        stw: stw.age,
        awa: awa.age,
        aws: aws.age,
        twa: twa.age,
        tws: tws.age,
        hdg: hdg.age,
        rpm: eng.rpmAge,
        engineState: eng.stateAge,
      },
    };
  }

  // ── Boucle de collecte ─────────────────────────────────────────────────────
  // Enveloppe de sûreté : une donnée inattendue dans l'arbre ou un disque
  // plein ne doit jamais faire remonter une exception jusqu'au serveur. Sur
  // une nav de 30 h, perdre la collecte est ennuyeux ; perdre SignalK (donc
  // l'alarme de mouillage, le pilote, les instruments) ne l'est pas du tout.
  function safeTick() {
    try {
      // Avant tout le reste, et surtout AVANT le moindre `return` de tick() :
      // une file d'alertes ne doit pas dépendre de ce que le filtre décide de
      // la nav en cours. Branchée sur la seule branche « sous voile », elle
      // gelait au retour au mouillage — c'est-à-dire à l'instant précis où le
      // réseau redevient disponible.
      if (notifier) notifier.flush();
      // Même raisonnement pour le reversement : il ne part pas d'une branche
      // de la collecte, sinon il ne partirait qu'en nav — c'est-à-dire pas au
      // mouillage, là où le réseau est le meilleur.
      if (sharer && store) sharer.maybeSend(opts, store.diskInfo().runCount, sharePayload);
      tick();
    } catch (e) {
      counters.errors = (counters.errors || 0) + 1;
      counters.lastError = String((e && e.message) || e);
      buffer = [];
      app.error(`[polar] tick: ${counters.lastError}`);
    }
  }

  function tick() {
    // Le consentement se donne une fois, dans la configuration, et il est
    // indissociable de ce qui rend une polaire partageable : le modèle du
    // bateau et un nom. Sans eux le plugin ne collecte rien plutôt que
    // d'accumuler en silence une polaire que personne ne pourra rattacher à
    // quoi que ce soit.
    if (!opts.boatModel || !opts.shareName) {
      live = { reason: 'needs_setup', ts: Date.now() };
      buffer = [];
      updateStatus();
      return;
    }
    const snap = snapshot();

    // Deux verdicts distincts : le permissif décide de l'archivage brut, le
    // configuré décide de la collecte. Ainsi un seuil trop serré aujourd'hui
    // ne fait pas perdre la donnée pour toujours.
    const raw = classify(snap, RAW_OPTS);
    if (raw.usable && opts.rawSamples) {
      const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : null);
      store.appendSample({
        t: snap.ts,
        sog: r2(snap.sog),
        stw: r2(snap.stw),
        awa: r2(snap.awa),
        aws: r2(snap.aws),
        twa: r2(snap.twa),
        tws: r2(snap.tws),
        hdg: r2(snap.hdg),
        cog: r2(snap.cog),
        roll: r2(snap.roll),
        pit: r2(snap.pitch),
        rot: r2(snap.rot),
        eng: raw.engineSource,
        tw: snap.twSource,
        sail: `${sail.main}|${sail.head}`,
      });
      counters.samples++;
    }

    const verdict = classify(snap, opts);
    if (!verdict.usable) {
      buffer = [];
      counters.rejected[verdict.reason] = (counters.rejected[verdict.reason] || 0) + 1;
      setLive(snap, verdict.reason, null, verdict);
      return;
    }

    // À partir d'ici on est sous voile : le compteur d'inactivité tourne.
    sailSecs++;
    checkIdle();

    buffer.push(Object.assign({}, snap, { engineSource: verdict.engineSource, sailTag: `${sail.main}|${sail.head}` }));
    // La fenêtre doit être homogène : un changement de voilure en cours de
    // route décrit un autre bateau.
    if (buffer.length > 1 && buffer[0].sailTag !== buffer[buffer.length - 1].sailTag) {
      buffer = [buffer[buffer.length - 1]];
    }
    if (buffer.length > opts.windowS) buffer = buffer.slice(-opts.windowS);

    const w = assessWindow(buffer, opts);
    setLive(snap, w.reason, w.metrics, verdict);
    if (!w.stable) {
      if (w.reason !== 'accumulating') {
        counters.rejected[w.reason] = (counters.rejected[w.reason] || 0) + 1;
        idleRejects[w.reason] = (idleRejects[w.reason] || 0) + 1;
      }
      // La fenêtre GLISSE au lieu d'être vidée : une seconde qui sort des
      // clous ne doit pas coûter les 59 précédentes. Dès que la seconde
      // fautive sort par l'autre bout, la fenêtre redevient valide toute
      // seule. Seule une manœuvre pollue la fenêtre entière et justifie de
      // tout jeter — un virement ne « sort » pas de la fenêtre, il la coupe
      // en deux régimes différents.
      if (w.reason === 'tack_change' || w.reason === 'turning') buffer = [];
      return;
    }

    const rec = condense(buffer, {
      id: buffer[buffer.length - 1].ts,
      engineSource: verdict.engineSource,
      sail: { main: sail.main, head: sail.head },
      metrics: w.metrics,
    });
    store.appendRun(rec);
    counters.accepted++;
    buffer = [];

    // On ne signale le retour à la normale que si une alerte était vraiment
    // partie : pas de notification pour un creux qui s'est résorbé tout seul.
    if (idleAlerted && notifier) {
      notifier.enqueue({
        title: 'Polar — collecting again',
        body: `A point has just been recorded (${store.runs().length} in total).`,
        tags: 'white_check_mark',
      });
      idleAlerted = false;
    }
    sailSecs = 0;
    idleRejects = {};
    updateStatus();
  }

  function checkIdle() {
    if (!notifier || !opts.idleAlertMin || idleAlerted) return;
    if (sailSecs < opts.idleAlertMin * 60) return;

    const top = Object.entries(idleRejects)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, n]) => `${REASONS[k] || k} (${n} s)`);
    notifier.enqueue({
      title: 'Polar — nothing is coming in',
      body:
        `${opts.idleAlertMin} min of sailing without a single accepted point.\n` +
        (top.length ? `Main reasons: ${top.join(', ')}.` : 'No dominant reason.') +
        `\nRaw logging continues, so nothing is lost — everything can be replayed on your return.`,
      priority: 'default',
      tags: 'warning',
    });
    idleAlerted = true;
  }

  function setLive(snap, reason, metrics, verdict) {
    live = {
      ts: snap.ts,
      reason,
      metrics: metrics || null,
      bufferLen: buffer.length,
      windowS: opts.windowS,
      sail,
      values: {
        sog: snap.sog,
        stw: snap.stw,
        twa: snap.twa,
        tws: snap.tws,
        awa: snap.awa,
        aws: snap.aws,
        hdg: snap.hdg,
        roll: snap.roll,
        pitch: snap.pitch,
        rpm: snap.rpm,
        rpmRaw: snap.rpmRaw,
        rpmSource: snap.rpmSource,
        navState: snap.navState,
        twSource: snap.twSource,
      },
      fresh: snap.fresh,
      ages: snap.ages,
      seaStateThresholds: { moderate: opts.seaStateModerateDeg, rough: opts.seaStateRoughDeg },
      // Ce qui compte pour la collecte n'est pas le régime moteur mais le
      // verdict : tourne / ne tourne pas / on ne sait pas — et QUI l'a rendu.
      // Beaucoup de bateaux n'ont aucun compte-tours numérique, et sur ceux
      // qui en ont un la valeur peut arriver mal mise à l'échelle. Le chiffre
      // reste disponible pour diagnostiquer, mais il n'est plus ce qu'on
      // montre en premier.
      engine: {
        state: verdict && verdict.reason === 'motoring' ? 'running' : verdict && verdict.engineSource ? 'off' : 'unknown',
        source: (verdict && verdict.engineSource) || null,
        // Un bateau qui n'a AUCUN signal moteur ne peut rien collecter. Plutôt
        // que de le laisser deviner pourquoi, la webapp lui propose de
        // déclarer — mais seulement dans ce cas-là.
        canDeclare: opts.allowDeclaredSailing && !snap.fresh.rpm && !snap.fresh.engineState,
        declaredUntil: snap.declaredUntil,
        declaredMinutes: opts.declaredSailingMinutes,
        rpm: snap.rpm,
        rpmRaw: snap.rpmRaw,
        rpmSource: snap.rpmSource,
        factor: opts.engineRpmFactor,
        witness: engineWitness,
      },
      counters,
      idle: {
        sailSecs,
        alerted: idleAlerted,
        alertAtMin: opts.idleAlertMin,
        ntfy: notifier ? notifier.stats() : null,
      },
    };
  }

  const REASONS = {
    ok: 'steady state',
    stable: 'steady state',
    accumulating: 'building up',
    motoring: 'under engine',
    engine_unknown: 'engine state unknown',
    declared: 'sailing (declared)',
    anchored: 'at anchor or alongside',
    too_slow: 'too slow',
    no_wind: 'no wind',
    no_wind_data: 'no wind instrument data',
    no_sog: 'no GPS fix',
    in_irons: 'head to wind',
    tack_change: 'tack change',
    turning: 'turning (manoeuvre)',
    course_changed: 'point of sail is changing',
    wind_shifting: 'wind building or dying',
    accelerating: 'speed not settled yet',
    wind_erratic: 'apparent wind too erratic',
    wind_gusty: 'wind strength too irregular',
    speed_erratic: 'boat speed too irregular (surfing)',
    starting: 'starting up',
    needs_setup: 'set the boat model and name in the plugin config',
  };

  function updateStatus() {
    const d = store.diskInfo();
    app.setPluginStatus(
      `${d.runCount} points · ${REASONS[live.reason] || live.reason} · raw ${(d.sampleBytes / 1048576).toFixed(1)} MB`
    );
  }

  // ── Qualité de la polaire ──────────────────────────────────────────────────
  //
  // « 480 points » ne dit pas grand-chose tout seul : 480 points tous pris au
  // même largue dans le même vent ne font pas une polaire. Ce qui compte est
  // le nombre de cases réellement étayées, le nombre de forces de vent
  // parcourues, et l'étendue d'allures. On expose les trois, plus la note de
  // confiance médiane des fenêtres, et une appréciation qui les résume — en
  // disant toujours ce qui manque pour passer au cran suivant.
  let qualityCache = { key: null, value: null };
  function qualitySummary() {
    const runs = store.runs();
    const key = `${runs.length}|${runs.length ? runs[runs.length - 1].id : 0}|${store.excluded().size}`;
    if (qualityCache.key === key) return qualityCache.value;

    const polar = polarLib.buildPolar(runs, polarOpts({}));
    let cells = 0;
    let solid = 0;
    const bands = new Set();
    let minTwa = null;
    let maxTwa = null;
    for (const b of polar.bins)
      for (const c of b.cells) {
        if (!c.n) continue;
        cells++;
        if (c.n >= 3) solid++;
        bands.add(b.ws);
        if (minTwa == null || c.twa < minTwa) minTwa = c.twa;
        if (maxTwa == null || c.twa > maxTwa) maxTwa = c.twa;
      }
    const qs = runs.map((r) => (r.metrics && r.metrics.quality) || 0).filter((q) => q > 0).sort((a, b) => a - b);
    const medianConfidence = qs.length ? qs[qs.length >> 1] : null;

    let grade = 'good';
    let missing = null;
    if (runs.length < 50) {
      grade = 'starting';
      missing = 'keep sailing — a polar needs a few hundred points';
    } else if (solid < 15) {
      grade = 'thin';
      missing = 'most cells rest on one or two measurements';
    } else if (solid < 50 || bands.size < 4) {
      grade = 'usable';
      missing = bands.size < 4 ? `only ${bands.size} wind band(s) covered` : 'more points per cell would tighten it';
    } else if (minTwa != null && minTwa > 50) {
      grade = 'usable';
      missing = `nothing recorded below ${minTwa}° — upwind is missing`;
    }

    const value = {
      points: runs.length,
      cells,
      solidCells: solid,
      windBands: bands.size,
      twaFrom: minTwa,
      twaTo: maxTwa,
      medianConfidence,
      grade,
      missing,
    };
    qualityCache = { key, value };
    return value;
  }

  // ── Diagnostic speedo ──────────────────────────────────────────────────────
  // L'analyse porte sur tous les points et n'est refaite que quand ils
  // changent : la webapp l'interroge à chaque rafraîchissement, et rien ne
  // justifie de rejouer 500 régressions toutes les deux secondes.
  let speedoCache = { key: null, value: null };
  function speedoAnalysis() {
    const runs = store.runs();
    const key = `${runs.length}|${runs.length ? runs[runs.length - 1].id : 0}|${store.excluded().size}`;
    if (speedoCache.key !== key) speedoCache = { key, value: speedo.analyse(runs) };
    return speedoCache.value;
  }

  // ── Options de calcul issues d'une requête HTTP ────────────────────────────
  function polarOpts(q) {
    // 'stwc' = vitesse surface corrigée par la courbe mesurée. C'est une
    // lecture de plus des mêmes mesures, jamais une réécriture : le disque ne
    // contient que du brut.
    const speedMode = ['stw', 'stwc'].includes(q.speed) ? q.speed : 'sog';
    return {
      speed: speedMode,
      stwCal: speedMode === 'stwc' ? speedoAnalysis().curve : null,
      vmgOffsets: opts.vmgOffsetsDeg,
      wind: q.wind === 'apparent' ? 'apparent' : 'true',
      tack: ['port', 'starboard', 'merged'].includes(q.tack) ? q.tack : 'merged',
      stat: ['mean', 'median', 'p90', 'max'].includes(q.stat) ? q.stat : 'mean',
      twsBins: q.bins ? String(q.bins).split(',').map(Number).filter((n) => !isNaN(n)) : opts.twsBins,
      twaStep: q.step ? Number(q.step) : opts.twaStep,
      minSamples: q.min ? Number(q.min) : opts.minSamples,
      excluded: store.excluded(),
      overrides: store.overrides().cells,
      excludeDeclared: q.shared === '1',
      sail: q.main || q.head ? { main: q.main || '', head: q.head || '' } : null,
      sailRanges: store.overrides().sailRanges,
      smooth: q.smooth !== '0',
    };
  }

  // ── Rejeu du brut ──────────────────────────────────────────────────────────
  // Reconstruit tous les points depuis samples.jsonl avec les seuils courants.
  // C'est ce qui rend les réglages du filtre réversibles.
  function rebuild(overrideOpts) {
    const o = Object.assign({}, opts, overrideOpts || {});
    const out = [];
    let win = [];
    let last = 0;
    store.eachSample((s) => {
      const snap = {
        ts: s.t,
        sog: s.sog,
        stw: s.stw,
        awa: s.awa,
        aws: s.aws,
        twa: s.twa,
        tws: s.tws,
        hdg: s.hdg,
        cog: s.cog,
        roll: s.roll,
        pitch: s.pit,
        rot: s.rot,
        navState: null,
        rpm: null,
        engineState: null,
        rpmEverSeen: true,
        // Le brut n'a été archivé que si le moteur était déjà jugé à l'arrêt :
        // on n'a donc pas à re-statuer là-dessus, seulement à re-filtrer.
        fresh: { sog: s.sog != null, stw: s.stw != null, awa: s.awa != null, aws: s.aws != null, rpm: false, engineState: false },
      };
      const engineOk = { usable: true, engineSource: s.eng };
      // Trou dans le temps = rupture de continuité, la fenêtre ne vaut plus.
      if (last && s.t - last > 3000) win = [];
      last = s.t;

      const v = classify(Object.assign({}, snap, { rpm: 0, fresh: Object.assign({}, snap.fresh, { rpm: true }) }), o);
      if (!v.usable) {
        win = [];
        return;
      }
      const sailTag = s.sail || '|';
      win.push(Object.assign({}, snap, { engineSource: engineOk.engineSource, sailTag }));
      if (win.length > 1 && win[0].sailTag !== sailTag) win = [win[win.length - 1]];
      if (win.length > o.windowS) win = win.slice(-o.windowS);
      const w = assessWindow(win, o);
      if (!w.stable) {
        if (w.reason === 'tack_change' || w.reason === 'turning') win = [];
        return;
      }
      const [main, head] = sailTag.split('|');
      out.push(
        condense(win, {
          id: win[win.length - 1].ts,
          engineSource: s.eng,
          sail: { main: main || '', head: head || '' },
          metrics: w.metrics,
        })
      );
      win = [];
    });
    return out;
  }

  // ── Ce qui part dans le fonds commun ───────────────────────────────────────
  //
  // Un seul endroit construit le contenu partagé : celui qui s'envoie tout
  // seul tous les N points et celui qu'on lit à l'écran sont le même objet,
  // sinon la transparence n'est qu'un affichage.
  //
  // Axes figés (SOG, vent vrai, médiane) : le corpus doit être comparable
  // d'un bateau à l'autre, et les réglages d'affichage ne le regardent pas.
  // SOG parce que c'est la seule vitesse qu'aucun capteur mal calibré ne
  // fausse — voir lib/speedo.js.
  function shareBundle() {
    const polar = polarLib.buildPolar(store.runs(), polarOpts({ shared: '1', speed: 'sog', wind: 'true', stat: 'median' }));
    const runs = store.runs();
    const declared = runs.filter((r) => r.engineSource === 'declared').length;

    // La taille et le gréement, si le serveur les connaît : c'est ce qui
    // permet de comparer deux bateaux du même modèle.
    const design = app.getSelfPath('design') || {};
    const val = (n) => (n && n.value !== undefined ? n.value : n);
    const dims = {};
    for (const k of ['length', 'beam', 'draft', 'displacement']) {
      const v = val(design[k]);
      if (v != null) dims[k] = typeof v === 'object' ? v.overall || v.maximum || v.hull || null : v;
    }

    let bands = 0;
    let cells = 0;
    for (const b of polar.bins) {
      let any = false;
      for (const c of b.cells) if (c.n) { cells++; any = true; }
      if (any) bands++;
    }

    const info = {
      model: opts.boatModel,
      name: opts.shareName,
      dims,
      version: require('./package.json').version,
      points: polar.used,
      totalPoints: runs.length,
      declaredExcluded: declared,
      cells,
      bands,
      first: runs.length ? runs[0].ts : null,
      last: runs.length ? runs[runs.length - 1].ts : null,
      speed: 'sog',
      wind: 'true',
      stat: 'median',
    };
    return { polar, info };
  }

  // Le corps exact envoyé au collecteur. Rien de plus que ce que l'écran
  // affiche, plus la polaire elle-même sous deux formes : le .pol tel quel
  // (utilisable dans n'importe quel routeur) et la grille avec le nombre de
  // mesures par case, sans lequel on ne peut pas pondérer une agrégation.
  function sharePayload() {
    const { polar, info } = shareBundle();
    return Object.assign({ schema: 1 }, info, {
      pol: polarLib.toPol(polar),
      bins: polar.bins.map((b) => ({
        tws: b.ws,
        cells: b.cells.map((c) => (c.n ? { twa: c.twa, v: c.value, n: c.n } : null)).filter(Boolean),
      })),
    });
  }

  // ── API + webapp ───────────────────────────────────────────────────────────
  plugin.registerWithRouter = function (router) {
    const pub = path.join(__dirname, 'public');
    // Le corps JSON est normalement déjà décodé par le serveur ; on se rabat
    // sur la query string si ce n'est pas le cas, plutôt que de laisser une
    // action de la webapp échouer en silence.
    const body = (req) => (req.body && Object.keys(req.body).length ? req.body : req.query || {});
    const serve = (file, type) => (req, res) => {
      res.type(type);
      fs.createReadStream(path.join(pub, file)).pipe(res);
    };
    // SignalK sert lui-même public/ sous /signalk-autopolar/ (keyword
    // « signalk-webapp ») et réserve /plugins/<id>/ pour les métadonnées du
    // plugin : la racine ci-dessous n'est donc jamais atteinte, elle n'est là
    // que pour l'aperçu hors serveur (test/preview.js).
    router.get('/webapp', serve('index.html', 'html'));
    router.get('/app.js', serve('app.js', 'application/javascript'));
    router.get('/style.css', serve('style.css', 'text/css'));

    // Que voit-on VRAIMENT dans l'arbre ? La forme exacte renvoyée par
    // getSelfPath varie selon le chemin (nœud enveloppé ou sous-arbre brut) ;
    // plutôt que de le deviner, on l'expose.
    router.get('/api/debug', (req, res) => {
      const paths = [
        'propulsion',
        'propulsion.Engine1.revolutions',
        'propulsion.Engine1.state',
        'navigation.state',
        'navigation.speedOverGround',
      ];
      const out = {};
      for (const p of paths) {
        try {
          out[p] = app.getSelfPath(p);
        } catch (e) {
          out[p] = { error: String(e) };
        }
      }
      res.json(out);
    });

    router.get('/api/live', (req, res) => res.json(Object.assign({ reasonLabel: REASONS[live.reason] || live.reason }, live)));

    router.get('/api/status', (req, res) => {
      const runs = store.runs();
      const d = store.diskInfo();
      res.json({
        version: require('./package.json').version,
        startedAt,
        staleMs: opts.staleMs,
        engineStaleMs: opts.engineStaleMs,
        disk: d,
        excluded: store.excluded().size,
        overrides: Object.keys(store.overrides().cells).length,
        quality: qualitySummary(),
        first: runs.length ? runs[0].ts : null,
        last: runs.length ? runs[runs.length - 1].ts : null,
        sail,
        // Les combinaisons de voilure RÉELLEMENT navigées, avec leur poids.
        // La webapp construit son filtre là-dessus : on ne propose pas de
        // trier sur une configuration qui n'a jamais été enregistrée.
        sailTags: (() => {
          const m = new Map();
          for (const r of runs) {
            const t = polarLib.effectiveSail(r, store.overrides().sailRanges);
            if (!t.main && !t.head) continue;
            const k = `${t.main}|${t.head}`;
            m.set(k, (m.get(k) || 0) + 1);
          }
          return [...m.entries()]
            .map(([k, n]) => {
              const [main, head] = k.split('|');
              return { main, head, n };
            })
            .sort((x, y) => y.n - x.n);
        })(),
        opts: {
          windowS: opts.windowS,
          twsBins: opts.twsBins,
          twaStep: opts.twaStep,
          minSamples: opts.minSamples,
          seaStateModerateDeg: opts.seaStateModerateDeg,
          seaStateRoughDeg: opts.seaStateRoughDeg,
        },
        counters,
      });
    });

    router.get('/api/polar', (req, res) => res.json(polarLib.buildPolar(store.runs(), polarOpts(req.query))));

    router.get('/api/scatter', (req, res) =>
      res.json(polarLib.scatter(store.runs(), polarOpts(req.query), Number(req.query.ws)))
    );

    router.get('/api/cell', (req, res) =>
      res.json(polarLib.cellPoints(store.runs(), polarOpts(req.query), Number(req.query.ws), Number(req.query.twa)))
    );

    router.get('/api/runs', (req, res) => res.json(store.runs()));

    // Diagnostic speedo : STW contre SOG, et surtout laquelle des deux causes
    // possibles explique l'écart (voir lib/speedo.js).
    router.get('/api/speedo', (req, res) => res.json(speedoAnalysis()));

    // Les mêmes points au format du journal de
    // airmar-dst810-auto-calibration, à concaténer à son runs.jsonl : nos
    // points de nav sont exactement la matière qu'il attend, et il n'y a
    // aucune raison de les recopier à la main.
    router.get('/api/speedo/airmar.jsonl', (req, res) => {
      res.type('text/plain');
      res.send(speedo.toAirmarRuns(store.runs(), { rollSign: Number(req.query.rollSign) || 1 }));
    });

    router.get('/api/speedo/calibration.csv', (req, res) => {
      res.type('text/csv');
      res.send(speedo.toCalibrationCsv(speedoAnalysis()));
    });

    // ── Voilure a posteriori ─────────────────────────────────────────────
    // On prend un ris quand il faut le prendre, pas quand c'est commode pour
    // l'application. Ces deux routes rattrapent l'écart : l'une propose des
    // frontières là où la performance a fait une marche, l'autre affecte une
    // voilure à toute une plage de temps d'un seul geste.
    router.get('/api/sail-suggest', (req, res) => {
      const runs = store.runs();
      const polar = polarLib.buildPolar(runs, polarOpts({}));
      const out = sailchange.suggest(runs, polar, {
        side: Number(req.query.side) || opts.sailChangeSide,
        minStepKn: Number(req.query.minStep) || opts.sailChangeMinStepKn,
      });
      // Chaque segment porte la voilure qui s'y applique aujourd'hui, pour que
      // la webapp montre ce qu'elle va remplacer — et s'il a déjà été traité,
      // par quoi. Sans ça la liste redemande éternellement de statuer sur des
      // périodes déjà réglées, et s'allonge d'une nav à l'autre.
      const ov = store.overrides();
      const covers = (r, seg) => r.from <= seg.from && r.to >= seg.to;
      for (const seg of out.segments) {
        const corrected = ov.sailRanges.findIndex((r) => covers(r, seg));
        const reviewed = corrected < 0 ? ov.sailReviewed.findIndex((r) => covers(r, seg)) : -1;
        seg.handled = corrected >= 0 ? 'corrected' : reviewed >= 0 ? 'reviewed' : null;
        seg.handledIndex = corrected >= 0 ? corrected : reviewed >= 0 ? reviewed : null;
        seg.ageDays = (Date.now() - seg.to) / 86400000;
      }
      out.hideHandledAfterDays = opts.sailHistoryDays;
      for (const seg of out.segments) {
        const inSeg = runs.filter((r) => r.ts >= seg.from && r.ts <= seg.to);
        const tally = new Map();
        for (const r of inSeg) {
          const t = polarLib.effectiveSail(r, store.overrides().sailRanges);
          const k = `${t.main}|${t.head}`;
          tally.set(k, (tally.get(k) || 0) + 1);
        }
        seg.sails = [...tally.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => {
            const [main, head] = k.split('|');
            return { main, head, n };
          });
      }
      res.json(out);
    });

    router.get('/api/sail-ranges', (req, res) => res.json(store.overrides().sailRanges));

    router.post('/api/sail-range', (req, res) => {
      const b = body(req);
      const ranges = store.setSailRange({ from: b.from, to: b.to, main: b.main, head: b.head });
      res.json({ ok: true, ranges });
    });

    router.post('/api/sail-reviewed', (req, res) => {
      const b = body(req);
      res.json({ ok: true, reviewed: store.setSailReviewed({ from: b.from, to: b.to }) });
    });

    router.post('/api/sail-reviewed/clear', (req, res) => {
      const b = body(req);
      res.json({ ok: true, reviewed: store.clearSailReviewed(b.index == null ? null : Number(b.index)) });
    });

    router.post('/api/sail-range/clear', (req, res) => {
      const b = body(req);
      const ranges = store.clearSailRanges(b.index == null ? null : Number(b.index));
      res.json({ ok: true, ranges });
    });

    // Vider la file d'alertes en attente : au retour, une alerte de la veille
    // n'apprend plus rien.
    router.post('/api/ntfy-clear', (req, res) => res.json({ ok: true, cleared: notifier ? notifier.clear() : 0 }));

    router.post('/api/exclude', (req, res) => {
      const b = body(req);
      const ids = b.ids || [];
      store.setExcluded(ids, b.excluded !== false);
      res.json({ ok: true, excluded: store.excluded().size });
    });

    router.post('/api/cell-override', (req, res) => {
      const { ws, twa, value } = body(req);
      store.setCellOverride(`${ws}|${twa}`, value === null || value === '' ? null : Number(value));
      res.json({ ok: true });
    });

    // Déclaration de navigation à la voile, pour les bateaux sans donnée
    // moteur. `minutes: 0` remet le curseur sur « au moteur ».
    router.post('/api/declare', (req, res) => {
      const b = body(req);
      const mins = b.minutes == null ? opts.declaredSailingMinutes : Number(b.minutes);
      declaredUntil = mins > 0 ? Date.now() + mins * 60000 : 0;
      try {
        fs.writeFileSync(declareFile, JSON.stringify({ until: declaredUntil }));
      } catch (e) {
        app.error(`[polar] declare: ${e.message}`);
      }
      buffer = []; // la fenêtre en cours décrivait un autre régime
      res.json({ ok: true, declaredUntil });
    });

    router.post('/api/sail', (req, res) => {
      const b = body(req);
      sail = { main: b.main || '', head: b.head || '' };
      fs.writeFileSync(sailFile, JSON.stringify(sail));
      buffer = []; // la fenêtre en cours décrivait une autre configuration
      res.json({ ok: true, sail });
    });

    router.post('/api/rebuild', (req, res) => {
      const b = body(req);
      const newRuns = rebuild(b.opts);
      if (!b.dryRun) store.replaceRuns(newRuns);
      res.json({ ok: true, count: newRuns.length, applied: !b.dryRun });
    });

    router.post('/api/reset', (req, res) => {
      store.reset(body(req).what || 'runs');
      res.json({ ok: true });
    });

    // ── Partage ────────────────────────────────────────────────────────────
    // Ce plugin est gratuit et le restera ; en échange, la polaire de chaque
    // bateau retourne au fonds commun. L'envoi est automatique (voir
    // lib/share.js) : cette route ne sert qu'à le rendre lisible, et le
    // fichier exact est téléchargeable juste en dessous.
    router.get('/api/share', (req, res) => {
      const { info } = shareBundle();
      const st = sharer ? sharer.state() : {};
      res.json(
        Object.assign(info, {
          enabled: Boolean(opts.sharePolar),
          endpoint: opts.shareEndpoint,
          every: opts.shareEveryPoints,
          configured: Boolean(opts.boatModel && opts.shareName),
          collected: store.diskInfo().runCount,
          nextAt: sharer ? sharer.nextAt(opts.shareEveryPoints) : null,
          lastAt: st.lastAt || null,
          lastCount: st.lastCount || 0,
          sent: st.sent || 0,
          lastError: st.lastError || null,
        })
      );
    });

    // Envoyer sans attendre le prochain palier. Le palier suivant reste calé
    // sur le dernier envoi réussi : appuyer dix fois n'envoie pas dix fois.
    router.post('/api/share/now', (req, res) => {
      if (!sharer) return res.json({ ok: false, error: 'not started' });
      sharer.force();
      const started = sharer.maybeSend(opts, store.diskInfo().runCount, sharePayload);
      res.json({ ok: started, state: sharer.state() });
    });

    // Voir exactement ce qui part. Un partage qu'on ne peut pas relire est un
    // partage qu'on finit par couper.
    router.get('/api/share.json', (req, res) => {
      res.type('application/json');
      res.send(JSON.stringify(sharePayload(), null, 2));
    });

    router.get('/api/share.pol', (req, res) => {
      const name = (opts.shareName || 'polar').replace(/[^A-Za-z0-9_-]+/g, '-');
      res.type('text/plain');
      // setHeader plutôt que la méthode `set` d'Express : elle existe sur la
      // réponse HTTP native, donc la route marche aussi hors serveur SignalK
      // (aperçu, tests) au lieu de lever une exception à l'exécution.
      res.setHeader('Content-Disposition', `attachment; filename="${name}.pol"`);
      res.send(polarLib.toPol(shareBundle().polar));
    });

    router.get('/api/export.pol', (req, res) => {
      res.type('text/plain');
      res.send(polarLib.toPol(polarLib.buildPolar(store.runs(), polarOpts(req.query))));
    });
    router.get('/api/export.csv', (req, res) => {
      res.type('text/csv');
      res.send(polarLib.toCsv(polarLib.buildPolar(store.runs(), polarOpts(req.query))));
    });
    router.get('/api/export.json', (req, res) => {
      res.type('application/json');
      res.send(JSON.stringify({ runs: store.runs(), overrides: store.overrides(), opts }, null, 2));
    });
    router.get('/api/samples.jsonl', (req, res) => {
      res.type('text/plain');
      fs.createReadStream(store.files().samplesFile).on('error', () => res.end()).pipe(res);
    });
  };

  // ── Cycle de vie ───────────────────────────────────────────────────────────
  plugin.start = function (options) {
    opts = Object.assign(
      {
        windowS: 60,
        awaDriftMaxDeg: 15,
        awaSpreadMaxDeg: 45,
        twsDriftMaxKn: 3,
        twsSpreadMaxKn: 8,
        sogDriftMaxKn: 1.5,
        sogSpreadMaxKn: 2.5,
        rotMaxDegS: 6,
        minSogKn: 1,
        minAwsKn: 1.5,
        minTwaDeg: 25,
        engineOffRpm: 50,
        engineRpmFactor: 60,
        allowDeclaredSailing: true,
        declaredSailingMinutes: 90,
        autostateFallback: true,
        staleMs: 6000,
        engineStaleMs: 180000,
        rawSamples: true,
        maxSampleMB: 500,
        twsBins: [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 30],
        twaStep: 5,
        minSamples: 1,
        sailHistoryDays: 2,
        sailChangeSide: 6,
        sailChangeMinStepKn: 0.5,
        seaStateModerateDeg: 3,
        seaStateRoughDeg: 8,
        vmgOffsetsDeg: [5, 10],
        idleAlertMin: 20,
        ntfyUrl: '',
        ntfyToken: '',
        boatModel: '',
        shareName: '',
        sharePolar: true,
        shareEndpoint: 'https://polars.quicky.app/v1/polars',
        shareEveryPoints: 500,
        publishPerformance: false,
      },
      options || {}
    );

    const dir = app.getDataDirPath();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    declareFile = path.join(dir, 'declare.json');
    if (fs.existsSync(declareFile)) {
      try {
        declaredUntil = JSON.parse(fs.readFileSync(declareFile, 'utf8')).until || 0;
      } catch (e) {
        /* pas de déclaration valide, on repart de zéro */
      }
    }
    sailFile = path.join(dir, 'sail.json');
    if (fs.existsSync(sailFile)) {
      try {
        sail = JSON.parse(fs.readFileSync(sailFile, 'utf8'));
      } catch (e) {
        /* on repart sans tag de voilure */
      }
    }
    startedAt = Date.now();
    store = createStore(dir, { maxSampleMB: opts.maxSampleMB });
    store.load();
    // Les échecs d'envoi passent par app.error : une file bloquée est une
    // panne, pas un détail de debug, et personne n'active les logs verbeux
    // avant de partir.
    notifier = createNotifier(opts, (m) => app.error(`[polar] ${m}`));
    sharer = createShare(path.join(dir, 'share.json'), (m) => app.error(`[polar] ${m}`));

    timer = setInterval(safeTick, 1000);
    updateStatus();
  };

  plugin.stop = function () {
    if (timer) clearInterval(timer);
    timer = null;
    buffer = [];
    store = null;
  };

  return plugin;
};
