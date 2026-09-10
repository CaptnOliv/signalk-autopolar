// L'ébauche depuis le History API. Ce qui se teste ici n'est pas « est-ce
// que ça lit du JSON », c'est la poignée de décisions qui font qu'une ébauche
// vaut quelque chose ou salit la polaire : les angles qu'on refuse de
// moyenner, le moteur qu'on entoure d'une bande de garde, la résolution qu'on
// mesure au lieu de la supposer, et les périodes qu'on laisse tranquilles.

const assert = require('assert');
const h = require('../lib/history');
const { MS_TO_KN, D2R } = require('../lib/geom');

// ── Instants : pas de dépendance pour trois champs ─────────────────────────
const t0 = Date.UTC(2026, 8, 10, 9, 55, 0);
const inst = h.instant(t0);
assert.strictEqual(String(inst), '2026-09-10T09:55:00.000Z');
assert.strictEqual(inst.epochMilliseconds, t0);
assert.strictEqual(inst.epochNanoseconds, BigInt(t0) * 1000000n, 'un fournisseur qui lit Temporal doit être servi aussi');
assert.strictEqual(new Date(h.instant(t0).toString()).getTime(), t0, 'aller-retour sans perte');

// ── Les angles ne se moyennent pas ─────────────────────────────────────────
// C'est la raison d'être de `first` sur les chemins angulaires. Si on laissait
// la moyenne par défaut, au vent arrière (+179° et -179°) la tranche
// renverrait 0° : la mesure serait retournée bord pour bord, et le point
// atterrirait au près.
for (const c of h.CANDIDATES) {
  if (c.unit === 'angle' || c.unit === 'angle360') {
    if (c.key === 'rot') continue; // la vitesse de rotation est une dérivée, pas une direction
    assert.strictEqual(c.aggregate, 'first', `${c.path} doit être lu tel quel, jamais moyenné`);
  }
  if (c.unit === 'speed') assert.strictEqual(c.aggregate, 'average', `${c.path} gagne à être moyenné`);
}

// ── Les chemins moteur se découvrent, ils ne se devinent pas ───────────────
assert.ok(h.ENGINE_RE.test('propulsion.Engine1.state'));
assert.ok(h.ENGINE_RE.test('propulsion.port.revolutions'));
assert.ok(!h.ENGINE_RE.test('propulsion.Engine1.temperature'));
assert.ok(!h.ENGINE_RE.test('navigation.speedOverGround'));

// ── Colonnes : c'est values[] qui fait foi, pas l'ordre demandé ────────────
const specs = h.planSpecs(['awa', 'aws', 'sog'], ['propulsion.Engine1.state'], false);
assert.deepStrictEqual(
  specs.map((s) => s.key),
  ['awa', 'aws', 'sog', 'eng:propulsion.Engine1.state']
);
const shuffled = {
  values: [
    { path: 'navigation.speedOverGround', method: 'average' },
    { path: 'propulsion.Engine1.state', method: 'first' },
    { path: 'environment.wind.angleApparent', method: 'first' },
    { path: 'environment.wind.speedApparent', method: 'average' },
  ],
  data: [],
};
const cols = h.readResponse(shuffled, specs).cols;
assert.strictEqual(cols.sog, 1, 'un fournisseur qui réordonne les colonnes ne doit pas décaler les mesures');
assert.strictEqual(cols.awa, 3);
assert.strictEqual(cols['eng:propulsion.Engine1.state'], 2);

// min/max seulement sur les vitesses, et seulement si on les demande
const withSpread = h.planSpecs(['awa', 'aws', 'sog'], [], true).map((s) => s.key);
assert.deepStrictEqual(withSpread, ['awa', 'aws', 'awsMin', 'awsMax', 'sog', 'sogMin', 'sogMax']);
assert.ok(!withSpread.includes('awaMin'), 'une amplitude d\'angle sur une tranche ne se lit pas comme un écart');

// ── Fabrication d'un jeu d'essai ───────────────────────────────────────────
// Une nav au largue, régime établi : 20 min à 5 nd, AWA 110°, AWS 8 nd,
// moteur arrêté et publié une fois par minute — la cadence observée sur
// Jazzy, où l'état moteur vient du Cerbo par MQTT.
const RES = 2; // secondes par tranche
function makeRows(o = {}) {
  const rows = [];
  const n = Math.round((o.minutes || 20) * 60 / RES);
  for (let i = 0; i < n; i++) {
    const ts = t0 + i * RES * 1000;
    const sog = (o.sogAt ? o.sogAt(i) : 5) / MS_TO_KN;
    const aws = (o.awsAt ? o.awsAt(i) : 8) / MS_TO_KN;
    const awa = (o.awaAt ? o.awaAt(i) : 110) * D2R;
    // L'état moteur n'est présent qu'une tranche sur trente : c'est tout le
    // problème que la bande de garde résout.
    const engine = i % Math.round(60 / RES) === 0 ? (o.engineAt ? o.engineAt(ts) : 'stopped') : null;
    rows.push([new Date(ts).toISOString(), awa, aws, sog, engine]);
  }
  return rows;
}
const COLS = { awa: 1, aws: 2, sog: 3, 'eng:propulsion.Engine1.state': 4 };

// ── Unités et vent vrai ────────────────────────────────────────────────────
const { snaps, engine } = h.toSnapshots(makeRows(), COLS);
assert.strictEqual(snaps.length, 600, '20 min de tranches de 2 s');
const s0 = snaps[0];
assert.ok(Math.abs(s0.sog - 5) < 0.01, 'les m/s du magasin deviennent des nœuds');
assert.ok(Math.abs(s0.awa - 110) < 0.01, 'les radians deviennent des degrés signés');
assert.ok(s0.tws > 8 && s0.tws < 12, `vent vrai recalculé, pas inventé (${s0.tws.toFixed(2)} kn)`);
assert.ok(s0.twa > 110, 'au largue le vent vrai est plus ouvert que l\'apparent');
assert.strictEqual(s0.twSource, 'calculé/SOG', 'sans vitesse surface, le vent vrai est un vent sol, et ça se dit');
assert.strictEqual(s0.stw, null);
assert.strictEqual(s0.pitch, null, 'aucun magasin n\'archive l\'attitude : null, pas une valeur inventée');
assert.strictEqual(s0.rpm, 0, 'moteur arrêté, tranché par la bande de garde');
assert.strictEqual(engine.cadence, 60000, 'la cadence de publication est mesurée, pas configurée');

// Le vent vrai déjà publié par le serveur est préféré au calcul : deux
// vérités qui divergent, c'est une case de polaire qui ne veut plus rien dire.
{
  const rows = [[new Date(t0).toISOString(), 110 * D2R, 8 / MS_TO_KN, 5 / MS_TO_KN, 'stopped', 12 / MS_TO_KN, 140 * D2R]];
  const c = { awa: 1, aws: 2, sog: 3, 'eng:propulsion.Engine1.state': 4, tws: 5, twa: 6 };
  const one = h.toSnapshots(rows, c).snaps[0];
  assert.ok(Math.abs(one.tws - 12) < 0.01, 'le vent vrai du serveur passe devant');
  assert.ok(Math.abs(one.twa - 140) < 0.01);
  assert.strictEqual(one.twSource, 'history');
}

// ── Une tranche trouée n'est pas comblée ───────────────────────────────────
{
  const rows = makeRows({ minutes: 1 });
  rows[10][2] = null; // plus de vent apparent sur cette tranche
  const out = h.toSnapshots(rows, COLS).snaps;
  assert.strictEqual(out.length, rows.length - 1, 'la tranche trouée disparaît au lieu d\'être extrapolée');
  assert.ok(!out.some((x) => x.ts === Date.parse(rows[10][0])));
}

// ── Le moteur, dans les deux sens ──────────────────────────────────────────
// Le cas qui compte : le moteur démarre entre deux publications. Avec un
// simple prolongement vers l'avant, la demi-minute d'avant l'échantillon
// « started » passerait pour de la voile et entrerait dans la polaire.
{
  const startAt = t0 + 10 * 60000; // 'started' apparaît à la 10e minute
  const rows = makeRows({ minutes: 20, engineAt: (ts) => (ts >= startAt ? 'started' : 'stopped') });
  const tl = h.engineTimeline(rows, COLS);
  assert.strictEqual(tl.guard, 60000, 'la bande de garde vaut la cadence observée');
  assert.strictEqual(h.engineAt(tl, startAt - 5000), 'running', 'les secondes juste AVANT le premier « started » sont déjà suspectes');
  assert.strictEqual(h.engineAt(tl, startAt - 59000), 'running', 'toute la bande de garde amont est refusée');
  assert.strictEqual(h.engineAt(tl, startAt - 90000), 'stopped', 'au-delà de la bande, la lecture arrêtée reprend ses droits');
  assert.strictEqual(h.engineAt(tl, startAt + 3600000), null, 'hors de portée de toute lecture : on ne sait pas, et on le dit');

  // Et sur les instantanés : rpm null = le filtre refusera (engine_unknown),
  // rpm 1 = motoring. Jamais un « à la voile » par défaut.
  const built = h.toSnapshots(rows, COLS).snaps;
  const near = built.find((x) => x.ts === startAt - 4000);
  assert.strictEqual(near.rpm, 1, 'moteur en marche : le point est disqualifié');
  assert.strictEqual(near.fresh.rpm, true);
}

// Aucune lecture moteur du tout : le doute n'est pas tranché en faveur de la
// collecte. Pas de déclaration rétroactive possible — une parole vaut pour
// maintenant et expire, elle ne se pose pas sur trois mois d'archive.
{
  const rows = makeRows({ minutes: 2 }).map((r) => [r[0], r[1], r[2], r[3], null]);
  const out = h.toSnapshots(rows, COLS).snaps;
  assert.ok(out.every((x) => x.rpm === null && x.fresh.rpm === false), 'sans donnée moteur, chaque instantané reste inconnu');
}

// ── La dispersion effacée par la moyenne ───────────────────────────────────
// À résolution grossière, la moyenne d'une tranche lisse ce que le filtre a
// justement pour métier de refuser. On récupère min/max et on applique les
// mêmes plafonds : une seule tranche plus dispersée que ce qu'on tolère sur
// une fenêtre entière, c'est du chaos, pas un régime établi.
{
  const o = { sogSpreadMaxKn: 2.5, twsSpreadMaxKn: 8 };
  const calm = [{ sogBand: 0.4, awsBand: 1 }, { sogBand: 0.5, awsBand: 2 }];
  assert.strictEqual(h.windowSpreadOk(calm, o), true);
  assert.strictEqual(h.windowSpreadOk(calm.concat([{ sogBand: 4, awsBand: 1 }]), o), false, 'une tranche qui contient 4 nd d\'écart n\'est pas un régime');
  assert.strictEqual(h.windowSpreadOk([{ sogBand: null, awsBand: null }], o), true, 'non mesuré ne veut pas dire mauvais');
}

// ── Ne jamais repasser sur ce que le plugin a vu lui-même ──────────────────
{
  const stamps = [1000, 2000, 3000, 500000, 501000];
  const iv = h.toIntervals(stamps, 60000);
  assert.deepStrictEqual(iv, [{ from: 1000, to: 3000 }, { from: 500000, to: 501000 }], 'un trou de plus d\'une fenêtre sépare deux veilles');
  assert.strictEqual(h.toIntervals([], 60000).length, 0);

  assert.strictEqual(h.inIntervals(iv, 2000), true);
  assert.strictEqual(h.inIntervals(iv, 4000), false);

  // Ce qui reste à importer : les trous, et rien d'autre.
  assert.deepStrictEqual(h.subtract({ from: 0, to: 600000 }, iv), [
    { from: 0, to: 1000 },
    { from: 3000, to: 500000 },
    { from: 501000, to: 600000 },
  ]);
  assert.deepStrictEqual(h.subtract({ from: 1500, to: 2500 }, iv), [], 'une plage intégralement surveillée ne laisse rien à faire');
  assert.deepStrictEqual(h.subtract({ from: 0, to: 600000 }, []), [{ from: 0, to: 600000 }], 'aucune veille passée : tout est à prendre');
}

// ── Le filtre est le même que celui du direct ──────────────────────────────
// Le point de tout l'exercice : les instantanés reconstruits passent par
// lib/gate.js sans adaptation, et une fenêtre de 60 s se juge sur 30 tranches
// de 2 s exactement comme sur 60 lectures d'une seconde.
{
  const { classify, assessWindow, condense } = require('../lib/gate');
  const o = {
    windowS: Math.round(60 / RES),
    minSogKn: 1,
    minAwsKn: 1.5,
    minTwaDeg: 25,
    awaDriftMaxDeg: 15,
    awaSpreadMaxDeg: 45,
    twsDriftMaxKn: 3,
    twsSpreadMaxKn: 8,
    sogDriftMaxKn: 1.5,
    sogSpreadMaxKn: 2.5,
    rotMaxDegS: 6,
    autostateFallback: true,
  };
  const steady = h.toSnapshots(makeRows({ minutes: 2 }), COLS).snaps;
  assert.ok(steady.every((x) => classify(x, o).usable), 'un régime établi passe l\'étage 1');
  const w = assessWindow(steady.slice(0, o.windowS), o);
  assert.strictEqual(w.stable, true, 'et l\'étage 2, sur 30 tranches');
  const rec = condense(steady.slice(0, o.windowS), { origin: 'history', res: RES });
  assert.strictEqual(rec.origin, 'history', 'le point porte son origine : il restera reconnaissable et filtrable');
  assert.strictEqual(rec.res, RES);
  assert.ok(Math.abs(rec.sog - 5) < 0.05);

  // Une accélération franche est refusée ici comme en direct.
  // La dérive se juge sur la MOYENNE des tiers, pas sur l'écart brut : une
  // montée de 0,08 nd par tranche reste sous le plafond de dispersion mais
  // emmène la fin de fenêtre 1,6 nd au-dessus du début, et c'est ça qu'on
  // refuse — le bateau de la fin n'est plus celui du début.
  const ramping = h.toSnapshots(makeRows({ minutes: 2, sogAt: (i) => 3 + i * 0.08 }), COLS).snaps;
  const rw = assessWindow(ramping.slice(0, o.windowS), o);
  assert.strictEqual(rw.stable, false, 'le régime s\'en va : pas de point');
  assert.strictEqual(rw.reason, 'accelerating');

  // Un virement au milieu de la fenêtre : l'amure change, la fenêtre est
  // jetée. Sans cap ni vitesse de rotation dans l'historique, c'est le signe
  // du vent apparent qui reste le témoin de la manœuvre.
  const tacking = h.toSnapshots(makeRows({ minutes: 2, awaAt: (i) => (i < 15 ? 110 : -110) }), COLS).snaps;
  assert.strictEqual(assessWindow(tacking.slice(0, o.windowS), o).reason, 'tack_change');

  // Et le garde-fou qui borne tout : sous 6 tranches par fenêtre, la dérive
  // et la dispersion ne veulent plus rien dire — d'où le refus d'importer.
  assert.strictEqual(h.MIN_WINDOW_SAMPLES, 6);
  assert.ok(Math.round(60 / 10) >= h.MIN_WINDOW_SAMPLES, 'des tranches de 10 s restent jugeables');
  assert.ok(Math.round(60 / 15) < h.MIN_WINDOW_SAMPLES, 'des tranches de 15 s, non');
}


// ── Résolution : mesurée, pas supposée ─────────────────────────────────────
// (dans une fonction : CommonJS n'a pas de top-level await)
async function resolutionTests() {
  // ── Résolution : mesurée, pas supposée ─────────────────────────────────────
  // Ce test rejoue ce qui a été constaté sur le magasin de Jazzy : à 1 s, 44 %
  // des tranches sont vides (les données arrivent toutes les 1 à 2 s) et toutes
  // les fenêtres se briseraient ; à 2 s, elles sont pleines.
  {
    const calls = [];
    const fake = async (q) => {
      const res = q.resolution;
      calls.push(res);
      const from = q.from.epochMilliseconds;
      const to = q.to.epochMilliseconds;
      const rows = [];
      for (let ts = from; ts < to; ts += res * 1000) {
        // Une donnée réelle toutes les 1,5 s : une tranche d'une seconde sur
        // trois tombe donc dans le vide.
        const hasData = res >= 2 || Math.floor((ts - from) / 1500) !== Math.floor((ts - from - res * 1000) / 1500);
        rows.push([new Date(ts).toISOString(), hasData ? 1 : null, hasData ? 2 : null, hasData ? 3 : null]);
      }
      return {
        values: [
          { path: 'environment.wind.angleApparent', method: 'first' },
          { path: 'environment.wind.speedApparent', method: 'average' },
          { path: 'navigation.speedOverGround', method: 'average' },
        ],
        data: rows,
      };
    };
    const picked = await h.pickResolution(fake, t0, t0 + 3600000);
    assert.strictEqual(picked.resolution, 2, 'on garde la plus fine dont les tranches sont pleines');
    assert.deepStrictEqual(calls, [1, 2], 'et on s\'arrête là : pas de requête inutile');
    assert.ok(picked.tried[0].holeRate > 0.2, 'le taux de trous est mesuré et rapporté, pas deviné');
  }

  // Un magasin qui ne remplit aucune résolution candidate : on renonce en le
  // disant, plutôt que d'importer des fenêtres brisées.
  {
    const empty = async (q) => ({
      values: [
        { path: 'environment.wind.angleApparent', method: 'first' },
        { path: 'environment.wind.speedApparent', method: 'average' },
        { path: 'navigation.speedOverGround', method: 'average' },
      ],
      data: [[new Date(t0).toISOString(), null, null, null]],
    });
    const picked = await h.pickResolution(empty, t0, t0 + 3600000);
    assert.strictEqual(picked.resolution, null);
    assert.strictEqual(picked.reason, 'too_sparse');
    assert.strictEqual(picked.tried.length, h.RESOLUTIONS.length, 'toutes les candidates ont été essayées avant de renoncer');
  }

    // ── Repérage : la donnée n'occupe qu'un morceau de son heure ──────────────
  //
  // Le bug qui a mordu deux fois. Le balayage de `survey` est horaire, et une
  // heure « pleine » ne veut dire qu'« au moins une mesure dedans » : son
  // début peut précéder la première mesure de presque une heure, sa fin la
  // dépasser d'autant. Sonder au jugé dans cette heure tombait à côté de la
  // donnée, et un magasin parfaitement fourni s'entendait répondre qu'il
  // était trop pauvre. D'où la descente à la minute.
  //
  // On place ici 40 min de donnée à la FIN d'une heure, deux jours en
  // arrière — le pire cas pour un sondage calé sur le milieu de l'heure.
  {
    const DAY = 86400000;
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    const from = now - 2 * DAY + 20 * 60000; // la donnée démarre à :20
    const to = from + 40 * 60000;
    const store = async (q) => {
      const a = q.from.epochMilliseconds;
      const b = q.to.epochMilliseconds;
      const step = q.resolution * 1000;
      const rows = [];
      for (let t = a; t < b; t += step) {
        // Une mesure toutes les 1,5 s dans la plage, rien en dehors.
        const has = t + step > from && t < to;
        const hole = step <= 1000 && Math.floor((t - from) / 1500) === Math.floor((t - from - step) / 1500);
        const v = has && !hole ? 1 : null;
        rows.push([new Date(t).toISOString(), v, v, v]);
      }
      return {
        values: [
          { path: 'environment.wind.angleApparent', method: 'first' },
          { path: 'environment.wind.speedApparent', method: 'average' },
          { path: 'navigation.speedOverGround', method: 'average' },
        ],
        data: rows,
      };
    };
    const sv = await h.survey(store, { now });
    assert.strictEqual(sv.resolution, 2, `la finesse est trouvée malgré le décalage, obtenu ${sv.resolution}`);
    assert.strictEqual(sv.span.from, from, 'le début annoncé est celui de la donnée, pas celui de son heure');
    // La fenêtre sondée tient entièrement dans la donnée : ni avant, ni après.
    assert.ok(sv.busy.from >= from && sv.busy.to <= to, `fenêtre sondée hors donnée : ${new Date(sv.busy.from).toISOString()}..${new Date(sv.busy.to).toISOString()}`);

    // Et le repérage à la minute, nu.
    const specs = h.planSpecs(['awa', 'aws', 'sog'], [], false);
    const dense = await h.denseRun(store, specs, from - 30 * 60000, to + 30 * 60000);
    assert.ok(dense.from >= from && dense.to <= to + 60000, 'la suite de minutes pleines épouse la donnée');
    assert.ok(dense.to - dense.from >= 39 * 60000, 'et elle en couvre la quasi-totalité');
    assert.strictEqual(await h.denseRun(store, specs, from - 3600000, from - 600000), null, 'aucune minute pleine : on renvoie null plutôt qu\'une fenêtre au hasard');
  }

// Un chemin obligatoire absent se voit tout de suite, sans balayer la plage.
  {
    const partial = async () => ({ values: [{ path: 'navigation.speedOverGround', method: 'average' }], data: [] });
    const picked = await h.pickResolution(partial, t0, t0 + 3600000);
    assert.strictEqual(picked.reason, 'missing_paths');
  }
}

resolutionTests().then(
  () => console.log('history.test.js OK'),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
