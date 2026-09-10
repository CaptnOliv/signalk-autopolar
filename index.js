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
const { createSupport } = require('./lib/support');
const { createUsage, pingEndpointFrom } = require('./lib/usage');

// Les liens du pied de page et du bandeau « un coup de pouce ». En dur, et
// pas dans la configuration : ce n'est pas un réglage du bateau, et un lien de
// don modifiable dans un formulaire serait une porte ouverte pour détourner
// les cafés de quelqu'un d'autre.
const LINKS = {
  github: 'https://github.com/CaptnOliv/signalk-autopolar',
  kofi: 'https://ko-fi.com/captnoliv',
  issues: 'https://github.com/CaptnOliv/signalk-autopolar/issues',
};

// Seuils plancher de l'enregistrement brut : délibérément plus permissifs que
// ceux de la collecte, pour que le rejeu puisse explorer des réglages plus
// larges que ceux du jour. Le seul critère non négociable reste le moteur.
const RAW_OPTS = {
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
  let buffer = [];
  let live = { reason: 'starting', ts: Date.now() };
  let counters = { samples: 0, accepted: 0, rejected: {} };

  // Surveillance de l'inactivité : on compte les secondes réellement passées
  // sous voile depuis le dernier point retenu — pas le temps qui passe. Ainsi
  // une nuit au mouillage ne déclenche rien, et 20 min de vraie nav sans un
  // seul point déclenchent tout de suite.
  let notifier = null;
  let sharer = null;
  let supporter = null;
  let usage = null;
  let sailSecs = 0;
  let idleAlerted = false;
  let idleRejects = {};

  plugin.schema = {
    type: 'object',
    properties: {
      sources: {
        type: 'object',
        title: 'Data sources — SignalK paths',
        description:
          'The defaults match a standard SignalK installation. Change a path only if this boat publishes that data somewhere else — for instance a derived-data plugin under a different key, or a wind instrument that only feeds apparent wind.',
        properties: {
          sogPath: { type: 'string', title: 'Speed over ground', default: 'navigation.speedOverGround' },
          stwPath: { type: 'string', title: 'Speed through water', default: 'navigation.speedThroughWater' },
          awsPath: { type: 'string', title: 'Apparent wind speed', default: 'environment.wind.speedApparent' },
          awaPath: { type: 'string', title: 'Apparent wind angle', default: 'environment.wind.angleApparent' },
          twsPath: {
            type: 'string',
            title: 'True wind speed',
            description: 'Only read if fresh — recomputed internally from apparent wind otherwise, so a boat with no true-wind source still works.',
            default: 'environment.wind.speedTrue',
          },
          twaPath: {
            type: 'string',
            title: 'True wind angle',
            description: 'Same fallback as true wind speed above.',
            default: 'environment.wind.angleTrueWater',
          },
          cogPath: { type: 'string', title: 'Course over ground', default: 'navigation.courseOverGroundTrue' },
          headingTruePath: { type: 'string', title: 'Heading (true)', default: 'navigation.headingTrue' },
          headingMagPath: {
            type: 'string',
            title: 'Heading (magnetic)',
            description: 'Used only when the true heading above is stale.',
            default: 'navigation.headingMagnetic',
          },
          rotPath: { type: 'string', title: 'Rate of turn', default: 'navigation.rateOfTurn' },
          navStatePath: { type: 'string', title: 'Navigation state', default: 'navigation.state' },
          attitudePath: {
            type: 'string',
            title: 'Attitude (roll/pitch, for sea state)',
            default: 'navigation.attitude',
          },
        },
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
      shareEveryPoints: {
        type: 'number',
        title: 'Send an updated polar every N new points',
        description:
          'A polar frozen at its first 500 points is worth much less than the same one at 3000, so each send replaces the previous one for your boat. Sending is never on a clock: nothing goes out unless new points came in.',
        default: 500,
      },
      usageStats: {
        type: 'boolean',
        title: 'Let me know this install exists',
        description:
          'Once a day this sends, and nothing else: a random ID drawn once on this install (tied to nothing \u2014 not your boat name, not your hardware, not your network), the plugin version, the Node version, the SignalK version, the date that ID was drawn, and whether polar sharing is on. No position, no boat name, no polar, no IP address kept by the server. It is the only way I have of knowing whether anyone out there is running this plugin. The exact payload is readable at any time in the web app, under Share. The same ID travels with a shared polar as its key, so that your sends replace each other instead of colliding with another boat of the same name \u2014 turning this off stops the daily ping, not that key.',
        default: true,
      },
      publishPerformance: {
        type: 'boolean',
        title: 'Publish performance.* into SignalK (target speed, ratio)',
        description:
          'Leave off until the polar has proved itself, and off entirely if another polar plugin is installed: they would all write to the same paths.',
        default: false,
      },
      supportPrompt: {
        type: 'boolean',
        title: 'Let the web app ask for a star or a coffee, once',
        description:
          'The plugin is free and has no account, no telemetry and no nag screen on startup. Once the polar it built for you is actually usable, the web app shows a single dismissible banner offering to star the repository or buy the author a coffee — at most twice in the life of the installation, never again once you have answered. Turn this off and it never appears at all.',
        default: true,
      },
      polarBins: {
        type: 'object',
        title: 'Wind speed columns of the polar (kn)',
        description: 'Rarely needs to change — the default already matches the resolution routing software expects.',
        properties: {
          twsBins: {
            type: 'array',
            title: 'Bin centres (kn)',
            description:
              'Boundaries fall halfway between two centres. A 2 kn step keeps enough resolution for routing software; wider bins gather more points per cell but blur the curve.',
            items: { type: 'number' },
            default: [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 30],
          },
        },
      },
      advanced: {
        type: 'object',
        title: 'Advanced settings — do not change unless you know exactly what you are doing',
        description: 'The defaults below were tuned on real passages. Loosening them lets in noise; tightening them starves the polar of points.',
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
              'Much longer than the rest, and it matters: engine data often arrives on a slow bridge (once a minute over MQTT from a Cerbo GX, for instance) while wind and speed come off the NMEA 2000 bus several times a second. With one common threshold the engine would read "unknown" 54 s out of every 60 and nothing would ever be collected.',
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
              'Sea state is measured, not typed in: it is the peak-to-peak pitch over the window. These two thresholds turn that number into a word, and they are a starting guess for a 15 m boat — check them against a day you remember and adjust. The measurement itself is stored raw either way. Defaults are 3 (moderate) and 8 (rough); with a DST810 the recommended pair is 0.8 and 2.0 — its attitude sensor reports smaller, cleaner pitch swings.',
            default: 3,
          },
          seaStateRoughDeg: {
            type: 'number',
            title: 'Pitch swing above which the sea counts as rough (deg)',
            description:
              'Default 8. With a DST810, use 2.0 (its attitude sensor reads smaller, cleaner pitch swings than a typical IMU).',
            default: 8,
          },
        },
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
          // On ne lit `revolutions` que comme un booléen : non nul = le moteur
          // tourne. On ne convertit rien et on ne dépend d'aucune unité — que
          // la passerelle envoie des hertz, des tr/min ou un compte de pulses,
          // zéro reste zéro et le reste reste « en marche ». Plusieurs lignes
          // d'arbre : on garde la plus forte lecture, une seule qui tourne
          // suffit à disqualifier le point.
          const raw = eng.revolutions.value;
          const age = eng.revolutions.timestamp ? Date.now() - Date.parse(eng.revolutions.timestamp) : null;
          const fresh = age == null || age < opts.engineStaleMs;
          if (fresh) rpmEverSeen = true;
          if (rpm == null || raw > rpm) {
            rpm = raw;
            rpmFresh = fresh;
            rpmAge = age;
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
    return { rpm, rpmFresh, rpmAge, state, stateFresh, stateAge };
  }

  function snapshot() {
    const sog = num(opts.sogPath, kn);
    const stw = num(opts.stwPath, kn);
    const aws = num(opts.awsPath, kn);
    const awa = num(opts.awaPath, (v) => wrap180(deg(v)));
    let tws = num(opts.twsPath, kn);
    let twa = num(opts.twaPath, (v) => wrap180(deg(v)));
    const cog = num(opts.cogPath, deg);
    let hdg = num(opts.headingTruePath, deg);
    if (!hdg.fresh) hdg = num(opts.headingMagPath, deg);
    const rot = num(opts.rotPath, deg);

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
    const navStateNode = read(opts.navStatePath);

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
        const a = read(opts.attitudePath);
        const v = a && a.value ? a.value : null;
        return {
          roll: v && typeof v.roll === 'number' ? deg(v.roll) : null,
          pitch: v && typeof v.pitch === 'number' ? deg(v.pitch) : null,
        };
      })(),
      rot: rot.v,
      rpm: eng.rpm,
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
      // Une fois par jour au plus, et pour la même raison qu'au-dessus : hors
      // de toute branche de la collecte, sinon un bateau qui ne navigue pas ne
      // serait jamais compté — alors que c'est précisément une installation.
      if (usage) usage.maybeSend(usageOpts(), usagePayload);
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
        title: 'Autopolar: collecting again',
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
      title: 'Autopolar: nothing is coming in',
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
        navState: snap.navState,
        twSource: snap.twSource,
      },
      fresh: snap.fresh,
      ages: snap.ages,
      seaStateThresholds: { moderate: opts.seaStateModerateDeg, rough: opts.seaStateRoughDeg },
      // Ce qui compte pour la collecte n'est pas le régime moteur mais le
      // verdict : tourne / ne tourne pas / on ne sait pas — et QUI l'a rendu.
      // Beaucoup de bateaux n'ont aucun compte-tours numérique ; on ne montre
      // donc jamais un chiffre, seulement le verdict et son témoin.
      engine: {
        state: verdict && verdict.reason === 'motoring' ? 'running' : verdict && verdict.engineSource ? 'off' : 'unknown',
        source: (verdict && verdict.engineSource) || null,
        // Un bateau qui n'a AUCUN signal moteur ne peut rien collecter. Plutôt
        // que de le laisser deviner pourquoi, la webapp lui propose de
        // déclarer — mais seulement dans ce cas-là.
        canDeclare: opts.allowDeclaredSailing && !snap.fresh.rpm && !snap.fresh.engineState,
        declaredUntil: snap.declaredUntil,
        declaredMinutes: opts.declaredSailingMinutes,
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
      // La clé de la polaire chez le collecteur. Le nom seul ne suffit pas :
      // deux Oceanis 48 dont les propriétaires écrivent « Jazzy » s'écrasaient
      // l'un l'autre en silence, et changer de shareName laissait un doublon
      // orphelin derrière soi au lieu de remplacer sa propre polaire.
      installId: usage ? usage.id() : null,
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

  // Le corps exact du ping quotidien. Il doit rester champ pour champ celui
  // que décrit la configuration : c'est la seule chose qui autorise à
  // l'envoyer. Aucune donnée de nav n'entre ici, pas même le nombre de points.
  function usagePayload() {
    const st = usage ? usage.state() : {};
    return {
      schema: 1,
      plugin: 'signalk-autopolar',
      installId: st.installId || null,
      version: require('./package.json').version,
      node: process.version,
      signalk: (app && app.config && app.config.version) || null,
      firstSeen: st.firstSeen || null,
      sharing: Boolean(opts.sharePolar && opts.boatModel && opts.shareName),
    };
  }

  // Réglages passés à lib/usage.js. L'URL du ping se déduit de celle de la
  // polaire : qui héberge son propre collecteur ne ping que le sien.
  function usageOpts() {
    return {
      usageStats: Boolean(opts.usageStats),
      usageEndpoint: pingEndpointFrom(opts.shareEndpoint),
    };
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
    // SignalK sert lui-même public/ sous /<packageName>/ (keyword
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

    // Construire la polaire coûte un parcours de tous les points. La webapp
    // demande « où en suis-je » toutes les deux secondes : sans mémo, on la
    // reconstruirait 30 fois par minute pour un résultat identique. La clé
    // porte à la fois les réglages et l'état du stock — un point qui tombe ou
    // une retouche à la main doit être vu immédiatement.
    let polarCache = { key: null, value: null };
    const polarCached = (o) => {
      const runs = store.runs();
      const key = JSON.stringify([
        o.speed, o.wind, o.tack, o.stat, o.twsBins, o.twaStep, o.minSamples, o.smooth, o.sail, o.excludeDeclared,
        runs.length, runs.length ? runs[runs.length - 1].id : 0, store.overrides(), [...store.excluded()].length,
      ]);
      if (polarCache.key !== key) polarCache = { key, value: polarLib.buildPolar(runs, o) };
      return polarCache.value;
    };

    // ── Où en est-on, là, tout de suite ──────────────────────────────────
    // La polaire dit ce que le bateau sait faire ; en nav on veut l'autre
    // moitié de la phrase — ce qu'il fait en ce moment, et l'écart entre les
    // deux. Le repère est lu sur la courbe AFFICHÉE (même vitesse, même vent,
    // même statistique) : comparer une mesure SOG à une courbe STW ferait
    // mentir l'écart de 10 % sans que rien ne le signale.
    router.get('/api/now', (req, res) => {
      const v = live.values || {};
      const f = live.fresh || {};
      const apparent = req.query.wind === 'apparent';
      // « auto » = l'amure sur laquelle on est vraiment. Quand le diagramme
      // sépare les amures il montre deux courbes : le repère doit être lu sur
      // celle qu'on barre, pas sur la moyenne des deux.
      const wa0 = apparent ? v.awa : v.twa;
      const q =
        req.query.tack === 'auto'
          ? Object.assign({}, req.query, { tack: typeof wa0 === 'number' && wrap180(wa0) < 0 ? 'port' : 'starboard' })
          : req.query;
      const o = polarOpts(q);
      const ws = apparent ? v.aws : v.tws;
      const wa = apparent ? v.awa : v.twa;
      const speed = o.speed === 'sog' ? v.sog : o.speed === 'stwc' ? speedo.correct(o.stwCal, v.stw) : v.stw;
      const windFresh = apparent ? !!(f.aws && f.awa) : !!(f.tws && f.twa);
      const speedFresh = o.speed === 'sog' ? !!f.sog : !!f.stw;
      const has = typeof ws === 'number' && typeof wa === 'number' && typeof speed === 'number';
      const polar = has ? polarCached(o) : null;
      const ref = polar ? polarLib.referenceAt(polar, ws, wa) : null;
      const bin = has ? polarLib.findWindBin(polarLib.windBinEdges(o.twsBins), ws) : null;
      const binPolar = bin && polar ? polar.bins.find((b) => b.ws === bin.ws) : null;
      const rad = has ? (Math.abs(wrap180(wa)) * Math.PI) / 180 : 0;
      res.json({
        ts: live.ts,
        reason: live.reason,
        reasonLabel: REASONS[live.reason] || live.reason,
        recording: ['stable', 'accumulating', 'ok'].includes(live.reason),
        speedKey: o.speed,
        windKey: o.wind,
        stat: o.stat,
        has,
        fresh: has && windFresh && speedFresh,
        speed,
        ws,
        wa: has ? wrap180(wa) : null,
        twa: has ? Math.abs(wrap180(wa)) : null,
        tack: has ? (wrap180(wa) < 0 ? 'port' : 'starboard') : null,
        bin,
        ref,
        // L'écart, dans les deux unités qui se lisent : des nœuds (ce qu'on
        // gagne ou perd) et un pourcentage (est-on dans les clous).
        delta: ref ? speed - ref.value : null,
        ratio: ref && ref.value ? speed / ref.value : null,
        vmg: has ? speed * Math.cos(rad) : null,
        refVmg: ref ? ref.value * Math.cos(rad) : null,
        // La cible de VMG de la bande de vent du moment : savoir qu'on tient
        // 94 % de la polaire ne dit pas si on la tient au bon angle.
        targets: binPolar ? binPolar.targets : null,
      });
    });

    // ── Est-ce que ça vaut le coup de changer de voilure ? ────────────────
    // Le filtre de voilure trace déjà une courbe par configuration, mais en
    // nav la question n'est pas « à quoi ressemble la polaire sous un ris » :
    // c'est « ici, dans ce vent, à cette allure, qu'ont donné les autres ».
    // On regroupe donc le seul voisinage du point courant, et on renvoie de
    // quoi juger la comparaison (mesures, vent réellement rencontré, date)
    // plutôt qu'un classement qui aurait l'air sûr parce qu'il est court.
    router.get('/api/sail-compare', (req, res) => {
      const o = polarOpts(req.query);
      const v = live.values || {};
      const apparent = o.wind === 'apparent';
      const liveWs = apparent ? v.aws : v.tws;
      const liveWa = apparent ? v.awa : v.twa;
      const ws = req.query.ws != null && req.query.ws !== '' ? Number(req.query.ws) : liveWs;
      const wa = req.query.twa != null && req.query.twa !== '' ? Number(req.query.twa) : liveWa;
      const fromLive = !(req.query.ws != null && req.query.ws !== '');
      if (typeof ws !== 'number' || typeof wa !== 'number' || isNaN(ws) || isNaN(wa))
        return res.json({ rows: [], center: null, n: 0, live: fromLive, has: false });
      const out = polarLib.sailCompare(store.runs(), o, {
        ws,
        twa: wa,
        dws: req.query.dws != null ? Number(req.query.dws) : 2,
        dtwa: req.query.dtwa != null ? Number(req.query.dtwa) : 20,
      });
      const ns = polarLib.normalizeSail(sail);
      out.has = true;
      out.live = fromLive;
      out.speedKey = o.speed;
      out.windKey = o.wind;
      out.stat = o.stat;
      // La voilure gréée en ce moment : c'est la ligne de référence, celle
      // dont les autres sont l'écart. Sans elle, un tableau de vitesses ne
      // répond pas à la question posée (« et si je changeais ? »).
      out.current = `${ns.main}|${ns.head}`;
      res.json(out);
    });

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

    // ── Le ping quotidien ──────────────────────────────────────────────────
    // Il est lisible exactement comme la polaire l'est, et pour la même
    // raison : il n'a le droit d'exister que parce qu'on peut le lire.
    router.get('/api/usage', (req, res) => {
      const st = usage ? usage.state() : {};
      const endpoint = pingEndpointFrom(opts.shareEndpoint);
      res.json({
        enabled: Boolean(opts.usageStats),
        endpoint,
        installId: st.installId || null,
        firstSeen: st.firstSeen || null,
        lastSentAt: st.lastSentAt || null,
        nextAt: usage ? usage.nextAt() : null,
        sent: st.sent || 0,
        failures: st.failures || 0,
        lastError: st.lastError || null,
      });
    });

    router.get('/api/usage.json', (req, res) => {
      res.type('application/json');
      res.send(JSON.stringify(usagePayload(), null, 2));
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

    // ── Un coup de pouce ───────────────────────────────────────────────────
    // Le plugin est gratuit, sans compte et sans télémétrie ; les serveurs qui
    // le font vivre, eux, se paient. La règle d'affichage vit dans
    // lib/support.js — ici on ne fait que la servir, avec de quoi écrire une
    // phrase qui dise CE QUI VIENT D'ÊTRE LIVRÉ avant de demander quoi que ce
    // soit.
    router.get('/api/support', (req, res) => {
      if (!supporter || !store) return res.json({ ask: false, why: 'not started', links: LINKS });
      const q = qualitySummary();
      res.json(
        Object.assign(supporter.status(q.solidCells, opts.supportPrompt), {
          links: LINKS,
          points: q.points,
          solidCells: q.solidCells,
          windBands: q.windBands,
          grade: q.grade,
        })
      );
    });

    // Consommé à l'affichage RÉEL, pas à la décision : hors ligne la webapp
    // n'affiche rien (un lien Ko-fi ouvrirait un onglet mort) et l'occasion ne
    // doit pas être brûlée pour autant.
    router.post('/api/support/seen', (req, res) => {
      if (!supporter || !store) return res.json({ ok: false });
      supporter.markShown(qualitySummary().solidCells);
      res.json({ ok: true });
    });

    router.post('/api/support/answer', (req, res) => {
      if (!supporter) return res.json({ ok: false });
      res.json({ ok: true, state: supporter.answer(String(body(req).outcome || '')) });
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
    router.get('/api/export.jieter', (req, res) => {
      res.type('text/plain');
      res.send(polarLib.toJieter(polarLib.buildPolar(store.runs(), polarOpts(req.query))));
    });

    // ── Envoi direct vers signalk-polar-management ──────────────────────────
    // S'il tourne sur le même serveur, il stocke les polaires en ressource
    // SignalK « polars ». On lui passe la nôtre au format canonique
    // polar-format via l'API de ressources, sans passer par un fichier. Un
    // seul id stable : chaque envoi remplace le précédent au lieu d'empiler
    // des copies datées.
    const PM_PLUGIN = 'signalk-polar-management';
    function polarMgmtProvider() {
      try {
        const api = app.resourcesApi;
        if (!api || typeof api.checkForProvider !== 'function') return null;
        return api.checkForProvider('polars', PM_PLUGIN) || api.checkForProvider('polars') || null;
      } catch (e) {
        return null;
      }
    }
    function polarMgmtId() {
      const slug = String(opts.shareName || '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return slug ? `autopolar-${slug}` : 'autopolar';
    }

    router.get('/api/polar-management', (req, res) => {
      const provider = polarMgmtProvider();
      res.json({ available: !!provider, provider: provider || null, id: polarMgmtId() });
    });

    router.post('/api/polar-management/send', async (req, res) => {
      const provider = polarMgmtProvider();
      if (!provider) {
        return res.json({ ok: false, error: 'signalk-polar-management is not installed on this server' });
      }
      // La lecture honnête et comparable — SOG, vent vrai — comme la polaire
      // partagée. Les réglages d'affichage de la webapp ne la regardent pas.
      const polar = polarLib.buildPolar(store.runs(), polarOpts({ speed: 'sog', wind: 'true' }));
      const bandsWithData = polar.bins.filter((b) => b.cells.some((c) => c.value != null)).length;
      let doc;
      try {
        doc = polarLib.toCanonical(polar, {
          name: opts.shareName || 'Autopolar',
          boatType: opts.boatModel || '',
          notes: 'Auto-learned from sailing by signalk-autopolar',
        });
      } catch (e) {
        return res.json({ ok: false, error: e.message });
      }
      // toCanonical écarte les bandes de vent sans mesures des deux bords (voir
      // lib/polar.js) — on le dit plutôt que de le taire.
      const bandsDropped = bandsWithData - doc.axes.tws.length;
      const id = polarMgmtId();
      try {
        await app.resourcesApi.setResource('polars', id, doc, PM_PLUGIN);
      } catch (e) {
        return res.json({ ok: false, error: String((e && e.message) || e) });
      }
      // setResource du serveur SignalK n'attend pas le fournisseur et avale son
      // rejet : on relit la ressource pour confirmer qu'elle a bien été écrite.
      let confirmed = false;
      try {
        const back = await app.resourcesApi.getResource('polars', id);
        confirmed = !!(back && back.values && Array.isArray(back.values.boatSpeedMatrix));
      } catch (e) {
        confirmed = false;
      }
      const cells = doc.values.boatSpeedMatrix.reduce((n, r) => n + r.filter((v) => v > 0).length, 0);
      const dropNote =
        bandsDropped > 0
          ? ` ${bandsDropped} wind band(s) left out — only upwind or only downwind data.`
          : '';
      res.json({
        ok: true,
        id,
        provider,
        confirmed,
        twsBands: doc.axes.tws.length,
        bandsDropped,
        cells,
        note:
          (confirmed
            ? `Sent to Polar Management as '${id}'.`
            : `Write submitted as '${id}', but read-back could not confirm it — check the Polar Management page.`) +
          dropNote,
      });
    });

    router.get('/api/samples.jsonl', (req, res) => {
      res.type('text/plain');
      fs.createReadStream(store.files().samplesFile).on('error', () => res.end()).pipe(res);
    });
  };

  // ── Cycle de vie ───────────────────────────────────────────────────────────
  plugin.start = function (options) {
    // Le formulaire de config envoie les réglages "avancés" imbriqués sous
    // sources / polarBins / advanced (voir plugin.schema) — mais tout le
    // reste du fichier lit opts.xxx à plat, sans savoir dans quel groupe le
    // champ vit dans le schéma. On aplatit donc ici, une fois, plutôt que de
    // réécrire une quarantaine de références. Les tests qui appellent
    // plugin.start() avec des options déjà plates (sans ces groupes)
    // continuent de marcher tels quels : il n'y a alors simplement rien à
    // aplatir.
    const raw = options || {};
    const flatOptions = Object.assign({}, raw, raw.sources, raw.polarBins, raw.advanced);
    delete flatOptions.sources;
    delete flatOptions.polarBins;
    delete flatOptions.advanced;

    opts = Object.assign(
      {
        sogPath: 'navigation.speedOverGround',
        stwPath: 'navigation.speedThroughWater',
        awsPath: 'environment.wind.speedApparent',
        awaPath: 'environment.wind.angleApparent',
        twsPath: 'environment.wind.speedTrue',
        twaPath: 'environment.wind.angleTrueWater',
        cogPath: 'navigation.courseOverGroundTrue',
        headingTruePath: 'navigation.headingTrue',
        headingMagPath: 'navigation.headingMagnetic',
        rotPath: 'navigation.rateOfTurn',
        navStatePath: 'navigation.state',
        attitudePath: 'navigation.attitude',
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
        shareEndpoint: 'https://autopolar.quicky.app/v1/polars',
        shareEveryPoints: 500,
        usageStats: true,
        publishPerformance: false,
        supportPrompt: true,
      },
      flatOptions
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
    // Le jalon n'est pas un nombre de points ni un nombre d'ouvertures de la
    // webapp, mais le moment où la polaire devient exploitable : 15 cases
    // étayées par au moins trois mesures. Avant ça, il n'y a rien à remercier.
    supporter = createSupport(path.join(dir, 'support.json'), { minProgress: 15, againAfterProgress: 15 });
    // En debug : un ping raté n'est la panne de personne (voir lib/usage.js).
    usage = createUsage(path.join(dir, 'usage.json'), (m) => app.debug(`[polar] ${m}`));

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
