// Webapp de la polaire. Deux temps bien séparés :
//   — l'état en direct, rafraîchi toutes les 2 s, qui répond à la seule
//     question qui compte en nav (« est-ce que ça enregistre, sinon pourquoi ») ;
//   — la polaire, recalculée par le serveur à chaque changement de réglage.
//     Aucune donnée n'est agrégée ici : le client ne fait que dessiner.
//
// registerWithRouter est toujours monté sur /plugins/<id>/, quelle que soit
// l'URL depuis laquelle la page est servie : on fixe donc la base en dur.
const API = '/plugins/signalk-autopolar';
const $ = (s) => document.querySelector(s);

// Rampes ordinales validées (cf. style.css). Cinq marches au maximum : au-delà
// deux forces voisines ne se distinguent plus à l'œil.
const RAMP = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#b7d3f6'];
const RAMP2 = ['#8a3712', '#c4501d', '#e06a35', '#ee8a63', '#f8bfa9'];
const MAX_SERIES = 5;

const ui = {
  speed: 'sog',
  wind: 'true',
  stat: 'mean',
  tack: 'merged',
  compare: 'none',
  cloud: 'off',
  smooth: 'on',
  bins: null, // null = choix automatique
  sel: null, // case inspectée { ws, twa }
  // Filtre de voilure : null = tout confondu. C'est ce qui donne son sens au
  // marquage — sans lui, l'étiquette posée en nav ne se relit jamais.
  sailFilter: null, // { main, head }
};

const MAIN_SAILS = [['', '—'], ['full', 'full'], ['r1', '1 reef'], ['r2', '2 reefs'], ['r3', '3 reefs']];
// Une seule voile d'avant à la fois. Le génois et la trinquette se réduisent,
// le gennaker non : le second segment disparaît quand il n'a pas de sens,
// plutôt que d'offrir des combinaisons qui n'existent pas sur le bateau.
const HEAD_SAILS = [['', '—'], ['genoa', 'genoa'], ['jib', 'jib'], ['gennaker', 'gennaker']];
const HEAD_REEFS = [['full', 'full'], ['r1', '1 reef'], ['r2', '2 reefs'], ['furled', 'furled']];
const REEFABLE = new Set(['genoa', 'jib']);
const LABEL = (list, v) => (list.find(([k]) => k === v) || [null, v])[1];

// Une voilure lue en clair : « Main 1 reef + Genoa full ». C'est cette
// phrase-là qu'on veut voir dans l'inspection, pas le seul mot « r1 » — sans
// la voile d'avant, l'étiquette ne décrit pas le bateau.
function sailLabel(sail) {
  if (!sail || (!sail.main && !sail.head)) return '—';
  const parts = [];
  if (sail.main) parts.push(`Main ${LABEL(MAIN_SAILS, sail.main)}`);
  if (sail.head) {
    const { sail: h, reef } = splitHead(sail.head);
    parts.push(REEFABLE.has(h) ? `${LABEL(HEAD_SAILS, h)} ${LABEL(HEAD_REEFS, reef)}` : LABEL(HEAD_SAILS, h));
  }
  return parts.join(' + ');
}

const composeHead = (sail, reef) => (!sail ? '' : REEFABLE.has(sail) ? `${sail}-${reef || 'full'}` : sail);
const splitHead = (head) => {
  const [sail, reef] = String(head || '').split('-');
  return { sail: sail || '', reef: reef || 'full' };
};

const fmt = (v, d = 1) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d));

// L'état de la mer est mesuré, pas saisi : c'est l'amplitude du tangage sur la
// fenêtre. Le seuil qui en fait un mot est réglable, donc le mot se calcule à
// l'affichage — jamais à l'enregistrement.
function seaLabel(pitchSpread, th) {
  if (pitchSpread == null || !th) return '—';
  if (pitchSpread >= th.rough) return 'rough';
  if (pitchSpread >= th.moderate) return 'moderate';
  return 'calm';
}

// ── État en direct ──────────────────────────────────────────────────────────
const RECORDING = new Set(['stable', 'accumulating', 'ok']);

async function refreshLive() {
  let live;
  try {
    live = await (await fetch(`${API}/api/live`)).json();
  } catch (e) {
    $('#stateLabel').textContent = 'server unreachable';
    return;
  }
  const v = live.values || {};
  const f = live.fresh || {};
  // Deux questions distinctes, deux badges. Les confondre est ce qui fait lire
  // « au mouillage » (décision normale du filtre) comme « les données ne
  // rentrent pas » (panne). La santé des entrées se juge sur leur fraîcheur,
  // indépendamment de ce que le filtre décide d'en faire.
  const rec = RECORDING.has(live.reason);
  const el = $('#state');
  el.className = 'state ' + (live.reason === 'stable' || live.reason === 'accumulating' ? 'rec' : rec ? 'wait' : 'off');
  $('#stateLabel').textContent =
    live.reason === 'accumulating' || live.reason === 'stable' ? 'recording' : live.reasonLabel || live.reason;

  const keys = Object.keys(f);
  const ok = keys.filter((k) => f[k]).length;
  const allOk = ok === keys.length && keys.length > 0;
  const inputs = $('#inputs');
  inputs.className = 'state ' + (allOk ? 'ok' : ok ? 'wait' : 'bad');
  inputs.innerHTML = `<span class="dot"></span><span>${
    allOk ? `${ok} of ${keys.length} inputs up to date` : `${ok}/${keys.length} inputs up to date — ${keys.filter((k) => !f[k]).join(', ')}`
  }</span>`;

  renderDeclare(live.engine);

  // Dire explicitement qu'une collecte à l'arrêt n'est pas une panne, quand
  // c'est le cas : c'est la lecture qui prête à confusion, pas l'état.
  $('#stateWhy').textContent = allOk && !rec ? 'data is coming in fine — collecting will resume under sail' : '';

  const pct = live.windowS ? Math.min(100, (100 * (live.bufferLen || 0)) / live.windowS) : 0;
  $('#progress').style.width = pct + '%';
  $('#progressLabel').textContent = rec
    ? `${live.bufferLen || 0} / ${live.windowS} s of steady state`
    : live.metrics && live.metrics.n
    ? 'window discarded'
    : '';

  // La fraîcheur est écrite en toutes lettres : une valeur cohérente mais
  // périmée (source morte qui a figé sa dernière mesure) est indiscernable
  // d'une valeur vivante si on ne le dit pas.
  // L'âge de la donnée est écrit sous la valeur dès qu'il dépasse 3 s. Une
  // valeur parfaitement cohérente peut être celle d'une source morte il y a
  // dix minutes : sans l'âge affiché, les deux cas sont indiscernables à
  // l'écran, et « c'est grisé alors que la valeur est bonne » n'est pas
  // diagnosticable.
  const age = (ms) => (ms == null ? '' : ms < 3000 ? '' : ms < 90000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);
  const tile = (k, val, unit, fresh, ms, extra) => {
    const a = age(ms);
    return `<div class="tile${fresh === false ? ' stale' : ''}">
      <div class="k">${k}${fresh === false ? ' <em>stale</em>' : ''}</div>
      <div class="v">${val}<span class="u">${unit || ''}</span></div>
      ${extra ? `<div class="age">${extra}</div>` : ''}
      ${a ? `<div class="age">${a} ago</div>` : ''}</div>`;
  };
  const g = live.ages || {};
  const ENGINE_STATE = { running: 'running', off: 'off', unknown: '—' };
  const ENGINE_VIA = {
    rpm: 'via rpm',
    state: 'via engine state',
    'state+rpm': 'via engine state',
    autostate: 'via navigation.state',
    declared: 'declared by crew',
  };
  const engineTile = (e, fresh, ms) => {
    if (!e) return tile('Engine', '—', '', fresh, ms);
    return tile('Engine', ENGINE_STATE[e.state] || e.state, '', e.state === 'unknown' ? false : fresh, ms, ENGINE_VIA[e.source] || '');
  };
  $('#tiles').innerHTML = [
    tile('SOG', fmt(v.sog, 2), 'kn', f.sog, g.sog),
    tile('STW', fmt(v.stw, 2), 'kn', f.stw, g.stw),
    tile('TWA', fmt(v.twa, 0), '°', f.twa, g.twa),
    tile('TWS', fmt(v.tws, 1), 'kn', f.tws, g.tws),
    tile('AWA', fmt(v.awa, 0), '°', f.awa, g.awa),
    tile('AWS', fmt(v.aws, 1), 'kn', f.aws, g.aws),
    tile('Heel', fmt(v.roll, 0), '°'),
    tile('Sea', seaLabel(live.metrics && live.metrics.pitchSpread, live.seaStateThresholds), ''),
    // Le verdict, pas le régime. Un compte-tours numérique est loin d'être
    // universel, et là où il existe la valeur peut arriver mal mise à
    // l'échelle : ce qui décide de la collecte est « tourne / ne tourne pas »,
    // et c'est donc ça qu'on affiche, avec le témoin qui l'a tranché.
    engineTile(live.engine, f.rpm || f.engineState, g.rpm),
    tile('Since restart', (live.counters && live.counters.accepted) || 0, 'pts'),
    tile('Polar total', state.quality ? state.quality.points : '—', 'pts'),
  ].join('');

  // Ce que le filtre voit de la fenêtre en cours : la dérive (le régime
  // change-t-il ?) séparée de la dispersion (la mer bouge, c'est normal).
  const m = live.metrics;
  $('#metrics').innerHTML = m && m.awaSpread != null
    ? [
        ['point of sail', `drift ${fmt(m.awaDrift, 0)}°`, `swings ±${fmt(m.awaSpread / 2, 0)}°`],
        ['wind', `drift ${fmt(m.twsDrift, 1)} kn`, `swings ±${fmt(m.twsSpread / 2, 1)} kn`],
        ['speed', `drift ${fmt(m.sogDrift, 1)} kn`, `swings ±${fmt(m.sogSpread / 2, 1)} kn`],
        ['heading', `turned ${fmt(m.hdgDrift, 0)}°`, `rate of turn ${fmt(m.rotMean, 1)}°/s`],
      ]
        .map(([k, a, b]) => `<span class="metric"><b>${k}</b> ${a} <span class="k">· ${b}</span></span>`)
        .join('')
    : '';

  const parts = [];
  if (live.idle && live.idle.sailSecs > 120)
    parts.push(
      `${Math.round(live.idle.sailSecs / 60)} min sailing with no point recorded` +
        (live.idle.alertAtMin ? ` (ntfy alert at ${live.idle.alertAtMin} min${live.idle.alerted ? ', sent' : ''})` : '')
    );
  if (v.twSource && v.twSource !== 'signalk') parts.push(`true wind ${v.twSource} (the server does not publish it)`);
  if (v.navState) parts.push(`navigation.state: ${v.navState}`);
  // Le témoin moteur : la plus forte valeur brute jamais vue. Il ne sert que
  // si la conversion est douteuse, donc on ne l'affiche qu'à ce moment-là.
  const eng = live.engine;
  if (eng && eng.source === 'autostate') parts.push('engine state inferred from navigation.state — no engine data on the bus');
  if (eng && eng.witness)
    parts.push(
      `engine peak seen: raw ${fmt(eng.witness.raw, 2)} → ${fmt(eng.witness.raw * eng.factor, 0)} rpm ` +
        `(${eng.witness.source || 'unknown source'}, ×${eng.factor})`
    );
  if (live.counters && live.counters.errors) parts.push(`⚠ ${live.counters.errors} error(s): ${live.counters.lastError}`);
  if (live.counters && live.counters.rejected) {
    const top = Object.entries(live.counters.rejected).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top.length) parts.push('rejections: ' + top.map(([k, n]) => `${k} ×${n}`).join(', '));
  }
  $('#liveHint').textContent = parts.join(' · ');

  // Une file d'alertes bloquée mérite mieux qu'un compteur : la raison du
  // dernier échec, et un moyen de s'en débarrasser. Sans ça on lit
  // « 4 en attente » pendant des jours sans savoir quoi en faire.
  renderNtfy(live.idle && live.idle.ntfy);

  if (live.sail) syncSail(live.sail);

  // Le vent du moment sert à choisir les forces affichées au chargement.
  // L'état en direct et la polaire sont chargés en parallèle : selon lequel
  // répond le premier, le choix automatique des forces pourrait se faire sans
  // connaître le vent. On redemande donc la polaire la première fois qu'on
  // apprend le vent, si le choix n'a pas encore pu être fait.
  const firstWind = state.liveTws == null && v.tws != null;
  if (v.tws != null) state.liveTws = v.tws;
  if (firstWind && !ui.bins && state.polar) refreshPolar();

  // Un point vient de tomber : inutile d'attendre le prochain tour d'horloge
  // pour le voir. C'est le seul moment où la polaire change vraiment, donc
  // c'est le bon déclencheur — et ça évite de la recalculer toutes les 10 s
  // pour rien le reste du temps.
  const acc = (live.counters && live.counters.accepted) || 0;
  if (state.lastAccepted != null && acc !== state.lastAccepted) {
    refreshPolar();
    refreshStatus();
  }
  state.lastAccepted = acc;
}

function renderNtfy(n) {
  const el = $('#ntfyBox');
  if (!el) return;
  if (!n || !n.pending) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<span class="warn">⚠ ${n.pending} notification(s) waiting to be sent</span>
    <span class="k">${n.lastError ? `last attempt failed: ${n.lastError}` : 'retrying every minute'}</span>
    <button class="act" id="btnNtfyClear">Discard them</button>`;
  $('#btnNtfyClear').onclick = async () => {
    await post('/api/ntfy-clear', {});
    el.innerHTML = '';
  };
}

// Sur un bateau sans aucun signal moteur, la machine ne peut pas distinguer la
// voile du moteur — et refuse donc tout, ce qui est la bonne réponse mais ne
// laisse rien. On propose alors de le déclarer soi-même. La déclaration expire
// seule : oublier de la renouveler coûte quelques points, et il n'existe aucun
// oubli qui ferait entrer du moteur dans la polaire.
function renderDeclare(e) {
  const el = $('#declare');
  if (!el) return;
  if (!e || !e.canDeclare) {
    el.innerHTML = '';
    return;
  }
  const left = e.declaredUntil ? Math.round((e.declaredUntil - Date.now()) / 60000) : 0;
  el.innerHTML =
    left > 0
      ? `<span class="msg">sailing declared · <b>${left} min</b> left</span>
         <button class="act" data-mins="${e.declaredMinutes}">renew</button>
         <button class="act danger" data-mins="0">under engine</button>`
      : `<span class="msg warn">No engine data on this boat, so nothing can be collected until you say so.</span>
         <button class="act" data-mins="${e.declaredMinutes}">I am sailing (${e.declaredMinutes} min)</button>`;
  for (const b of el.querySelectorAll('button'))
    b.addEventListener('click', async () => {
      await post('/api/declare', { minutes: Number(b.dataset.mins) });
      refreshLive();
    });
}

// ── Voilure ─────────────────────────────────────────────────────────────────
let sailState = { main: '', head: '' };
function buildSail() {
  const fill = (id, list) => ($(id).innerHTML = list.map(([v, label]) => `<button data-v="${v}">${label}</button>`).join(''));
  fill('#segMain', MAIN_SAILS);
  fill('#segHead', HEAD_SAILS);
  fill('#segReef', HEAD_REEFS);

  const onPick = (id, apply) =>
    $(id).addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      apply(b.dataset.v);
      await post('/api/sail', sailState);
      $('#sailMsg').textContent = 'sail plan saved';
      setTimeout(() => ($('#sailMsg').textContent = ''), 2000);
      syncSail(sailState);
    });

  onPick('#segMain', (v) => (sailState = Object.assign({}, sailState, { main: v })));
  onPick('#segHead', (v) => {
    const { reef } = splitHead(sailState.head);
    sailState = Object.assign({}, sailState, { head: composeHead(v, reef) });
  });
  onPick('#segReef', (v) => {
    const { sail } = splitHead(sailState.head);
    sailState = Object.assign({}, sailState, { head: composeHead(sail, v) });
  });
}
function syncSail(s) {
  sailState = s;
  const { sail, reef } = splitHead(s.head);
  const press = (id, val) => {
    for (const b of document.querySelectorAll(`${id} button`)) b.setAttribute('aria-pressed', String(b.dataset.v === val));
  };
  press('#segMain', s.main || '');
  press('#segHead', sail);
  press('#segReef', reef);
  $('#reefGroup').style.display = REEFABLE.has(sail) ? '' : 'none';
}

// ── Requêtes ────────────────────────────────────────────────────────────────
function query(over) {
  const q = Object.assign({ speed: ui.speed, wind: ui.wind, stat: ui.stat, min: '1', smooth: ui.smooth === 'on' ? '1' : '0' }, over || {});
  if (ui.tack !== 'split' && !(over && over.tack)) q.tack = 'merged';
  if (ui.sailFilter) {
    if (ui.sailFilter.main) q.main = ui.sailFilter.main;
    if (ui.sailFilter.head) q.head = ui.sailFilter.head;
  }
  return new URLSearchParams(q).toString();
}
const getJson = (path, over) => fetch(`${API}${path}?${query(over)}`).then((r) => r.json());
const post = (path, body) =>
  fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

// ── Rendu du diagramme ──────────────────────────────────────────────────────
const CX = 360, CY = 372, R = 300;

function pos(twa, r, side) {
  const a = (twa * Math.PI) / 180;
  return [CX + side * r * Math.sin(a), CY - r * Math.cos(a)];
}

function svgEl(tag, attrs, text) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

let state = { polar: null, polar2: null, port: null, clouds: {}, vmax: 8, liveTws: null, lastAccepted: null, quality: null };

async function refreshPolar() {
  const jobs = [];
  if (ui.tack === 'split') {
    jobs.push(getJson('/api/polar', { tack: 'starboard' }), getJson('/api/polar', { tack: 'port' }));
  } else {
    jobs.push(getJson('/api/polar'), Promise.resolve(null));
  }
  if (ui.compare === 'speed') jobs.push(getJson('/api/polar', { speed: ui.speed === 'sog' ? 'stw' : 'sog' }));
  else if (ui.compare === 'wind') jobs.push(getJson('/api/polar', { wind: ui.wind === 'true' ? 'apparent' : 'true' }));
  else jobs.push(Promise.resolve(null));

  const [main, port, cmp] = await Promise.all(jobs);
  state.polar = main;
  state.port = port;
  state.polar2 = cmp;

  if (ui.cloud === 'on') {
    state.clouds = {};
    await Promise.all(
      shownBins().map(async (ws) => {
        state.clouds[ws] = await getJson('/api/scatter', { ws });
      })
    );
  } else state.clouds = {};

  autoSelectBins();
  renderChips();
  draw();
  renderTable();
  renderTargets();
}

// Au chargement, on veut voir la polaire du vent qu'il fait — pas celle où on
// a le plus de mesures. C'est la différence entre « des chiffres » et « ma
// cible de VMG maintenant ». On ne retient que des cases qui contiennent des
// données : centrer sur 14 nd pour afficher cinq courbes vides n'aiderait
// personne.
//
// Le choix est fait UNE fois, puis figé : si la sélection suivait le vent en
// continu, le diagramme changerait sous les yeux à chaque risée.
function autoSelectBins() {
  if (ui.bins || !state.polar || state.liveTws == null) return;
  const withData = state.polar.bins.filter((b) => b.cells.some((c) => c.n > 0));
  if (!withData.length) return;
  ui.bins = withData
    .map((b) => ({ ws: b.ws, d: Math.abs(b.ws - state.liveTws) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_SERIES)
    .map((b) => b.ws)
    .sort((a, b) => a - b);
}

// Bins réellement affichés : ceux choisis à la main, sinon les cinq plus
// peuplés — l'automatisme évite d'ouvrir sur un diagramme vide en début de nav.
function shownBins() {
  if (!state.polar) return [];
  const withData = state.polar.bins.filter((b) => b.cells.some((c) => c.n > 0));
  if (ui.bins) return ui.bins.filter((ws) => state.polar.bins.some((b) => b.ws === ws)).slice(0, MAX_SERIES);
  return withData
    .map((b) => ({ ws: b.ws, n: b.cells.reduce((a, c) => a + c.n, 0) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_SERIES)
    .map((b) => b.ws)
    .sort((a, b) => a - b);
}

function colorFor(ws, ramp) {
  const shown = shownBins();
  const i = shown.indexOf(ws);
  const n = Math.max(shown.length - 1, 1);
  return ramp[Math.round((i / n) * (ramp.length - 1))] || ramp[ramp.length - 1];
}

function draw() {
  const svg = $('#polar');
  svg.innerHTML = '';
  const shown = shownBins();
  if (!state.polar || !shown.length) {
    svg.appendChild(svgEl('text', { x: CX, y: CY, 'text-anchor': 'middle', class: 'axistext' }, 'No data yet.'));
    $('#legend').innerHTML = '';
    return;
  }

  // Échelle : le rayon porte la vitesse. On cale sur la valeur max affichée,
  // arrondie au nœud supérieur, pour que la grille tombe juste.
  let vmax = 0;
  const scan = (p) => {
    if (!p) return;
    for (const b of p.bins)
      if (shown.includes(b.ws)) for (const c of b.cells) if (c.value != null) vmax = Math.max(vmax, c.value);
  };
  scan(state.polar);
  scan(state.port);
  scan(state.polar2);
  for (const ws of shown) for (const p of state.clouds[ws] || []) vmax = Math.max(vmax, p.speed);
  vmax = Math.max(2, Math.ceil(vmax));
  state.vmax = vmax;
  const rOf = (v) => (v / vmax) * R;

  const g = svgEl('g', {});
  svg.appendChild(g);

  // Grille : cercles de vitesse et rayons d'angle, hairlines pleines.
  const stepV = vmax <= 6 ? 1 : vmax <= 12 ? 2 : 5;
  for (let v = stepV; v <= vmax + 1e-9; v += stepV) {
    g.appendChild(svgEl('circle', { cx: CX, cy: CY, r: rOf(v), class: 'gridline' }));
    g.appendChild(svgEl('text', { x: CX + 4, y: CY - rOf(v) - 3, class: 'axistext' }, `${v} kn`));
  }
  for (let a = 0; a <= 180; a += 30) {
    for (const side of [1, -1]) {
      if (a === 0 || a === 180) {
        if (side === -1) continue;
      }
      const [x, y] = pos(a, R, side);
      g.appendChild(svgEl('line', { x1: CX, y1: CY, x2: x, y2: y, class: 'axisline' }));
      const [lx, ly] = pos(a, R + 22, side);
      g.appendChild(
        svgEl('text', { x: lx, y: ly + 4, 'text-anchor': 'middle', class: 'axistext' }, a === 0 || a === 180 ? `${a}°` : `${a}°`)
      );
    }
  }
  g.appendChild(svgEl('text', { x: CX, y: CY - R - 34, 'text-anchor': 'middle', class: 'axistext' }, 'wind'));
  if (ui.tack === 'split') {
    g.appendChild(svgEl('text', { x: CX - R * 0.75, y: CY + R + 34, 'text-anchor': 'middle', class: 'axistext' }, 'port tack'));
    g.appendChild(svgEl('text', { x: CX + R * 0.75, y: CY + R + 34, 'text-anchor': 'middle', class: 'axistext' }, 'starboard tack'));
  }

  // Nuage de points sous les courbes : c'est la matière première, la courbe
  // n'en est que le résumé.
  if (ui.cloud === 'on') {
    for (const ws of shown) {
      const col = colorFor(ws, RAMP);
      for (const p of state.clouds[ws] || []) {
        const side = ui.tack === 'split' ? (p.wa < 0 ? -1 : 1) : 1;
        const [x, y] = pos(Math.abs(p.wa), rOf(p.speed), side);
        g.appendChild(svgEl('circle', { cx: x, cy: y, r: 2.5, fill: col, class: 'cloud' }));
        if (ui.tack !== 'split') {
          const [x2, y2] = pos(Math.abs(p.wa), rOf(p.speed), -1);
          g.appendChild(svgEl('circle', { cx: x2, cy: y2, r: 2.5, fill: col, class: 'cloud' }));
        }
      }
    }
  }

  const drawCurves = (polar, ramp, side, opts) => {
    if (!polar) return;
    for (const bin of polar.bins) {
      if (!shown.includes(bin.ws)) continue;
      const pts = bin.cells.filter((c) => c.value != null);
      if (pts.length < 2) continue;
      const col = colorFor(bin.ws, ramp);
      // Le trait ne saute PAS les cases vides. Relier 60° à 120° parce qu'il
      // n'y a rien entre les deux dessine une droite qui n'a jamais été
      // mesurée, et qui se lit pourtant comme une mesure. On coupe donc la
      // courbe dès que le trou dépasse une case : franchir 5° de vide est une
      // interpolation raisonnable, franchir 60° est une invention. Les trous
      // restants se voient, ce qui est justement l'information utile quand on
      // cherche où il reste à naviguer.
      const step = polar.twaStep || 5;
      const d = pts
        .map((c, i) => {
          const jump = i > 0 && c.twa - pts[i - 1].twa > step * 2.5;
          return `${i === 0 || jump ? 'M' : 'L'}${pos(c.twa, rOf(c.value), side).map((n) => n.toFixed(1)).join(',')}`;
        })
        .join('');
      g.appendChild(svgEl('path', { d, class: 'curve' + (opts.ghost ? ' ghost' : ''), stroke: col, 'stroke-width': opts.ghost ? 1.5 : 2, 'stroke-dasharray': opts.ghost ? '5 4' : null }));
      if (opts.ghost) continue;
      for (const c of pts) {
        const [x, y] = pos(c.twa, rOf(c.value), side);
        // Marqueur discret : il porte la valeur mesurée et sert de repère,
        // la cible de clic est le disque transparent bien plus large en dessous.
        g.appendChild(svgEl('circle', { cx: x, cy: y, r: c.overridden ? 4.5 : 2.4, fill: c.overridden ? '#fab219' : col, class: 'pt', 'stroke-width': c.overridden ? 2 : 1.2 }));
        const hit = svgEl('circle', { cx: x, cy: y, r: 11, class: 'hit' });
        hit.addEventListener('mouseenter', (e) => showTip(e, bin, c, polar));
        hit.addEventListener('mouseleave', hideTip);
        hit.addEventListener('click', () => inspect(bin.ws, c.twa));
        g.appendChild(hit);
      }
    }
  };

  if (ui.tack === 'split') {
    drawCurves(state.polar, RAMP, 1, {});
    drawCurves(state.port, RAMP, -1, {});
    drawCurves(state.polar2, RAMP2, 1, { ghost: true });
  } else {
    drawCurves(state.polar, RAMP, 1, {});
    drawCurves(state.polar, RAMP, -1, { mirror: true });
    drawCurves(state.polar2, RAMP2, 1, { ghost: true });
    drawCurves(state.polar2, RAMP2, -1, { ghost: true });
  }

  renderLegend(shown);
}

function renderLegend(shown) {
  const label = (p) =>
    `${{ sog: 'SOG', stw: 'STW', stwc: 'STW corrected' }[p.speed] || p.speed} / ${p.wind === 'true' ? 'true' : 'apparent'} wind`;
  let html = shown
    .map((ws) => `<span class="item"><span class="line" style="background:${colorFor(ws, RAMP)}"></span>${ws} kn</span>`)
    .join('');
  if (state.polar2) {
    html += `<span class="item" style="margin-left:auto"><span class="line" style="background:${RAMP2[2]};height:0;border-top:2px dashed ${RAMP2[2]}"></span>${label(state.polar2)} (comparison)</span>`;
    html = `<span class="item"><b>${label(state.polar)}</b></span>` + html;
  }
  $('#legend').innerHTML = html;
  $('#plotSub').textContent =
    `— ${label(state.polar)}, ${{ mean: 'mean', median: 'median', p90: 'p90', max: 'max' }[ui.stat]} per cell · ${state.polar.used} points used` +
    (ui.sailFilter ? ` · ${sailLabel(ui.sailFilter)} only` : '');
}

function showTip(e, bin, c, polar) {
  const tip = $('#tip');
  const rect = $('#polar').getBoundingClientRect();
  const raw = c.raw != null && Math.abs(c.raw - c.value) > 0.005 ? ` · measured ${fmt(c.raw, 2)}` : '';
  tip.innerHTML = `<b>${fmt(c.value, 2)} kn</b> <span class="k">at</span> <b>${c.twa}°</b> <span class="k">in</span> <b>${bin.ws} kn</b><br>
    <span class="k">n=${c.n}${c.sd ? ' · sd ' + fmt(c.sd, 2) : ''}${raw}${c.overridden ? ' · overridden' : ''}</span><br>
    <span class="k">VMG ${fmt(Math.abs(c.vmg), 2)} kn</span>`;
  tip.style.left = e.clientX - rect.left + 14 + 'px';
  tip.style.top = e.clientY - rect.top - 10 + 'px';
  tip.style.opacity = 1;
}
const hideTip = () => ($('#tip').style.opacity = 0);

// ── Cibles VMG ──────────────────────────────────────────────────────────────
function renderTargets() {
  if (!state.polar) return;
  const cell = (x) => (x ? `<b>${fmt(x.twa, 0)}°</b> <span class="k">at ${fmt(x.speed, 2)} kn</span> <span class="vmg">VMG ${fmt(x.vmg, 2)}</span>` : '<span class="k">—</span>');
  const shown = shownBins();
  const rows = state.polar.bins
    .filter((b) => shown.includes(b.ws) && (b.targets.upwind || b.targets.downwind))
    .map(
      (b) => `<tr><td class="a"><span class="swatch" style="background:${colorFor(b.ws, RAMP)}"></span> ${b.ws} kn</td>
        <td class="t">${cell(b.targets.upwind)}</td><td class="t">${cell(b.targets.downwind)}</td></tr>`
    )
    .join('');
  $('#targets').innerHTML = rows
    ? `<table class="targets"><thead><tr><th class="a">wind</th><th class="t">best upwind</th><th class="t">best downwind</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">No target yet.</div>';
  renderVmgAround();
}

// Ce que coûte de s'écarter de l'optimum.
//
// Le meilleur angle tout seul ne se barre pas : ce qui se barre, c'est la
// forme de la cloche autour de lui. Si lofer de 10° ne coûte que 1 % de VMG,
// on le fait volontiers pour prendre une risée ou soulager l'équipage ; si ça
// en coûte 8 %, il faut tenir l'angle. Les deux cas se ressemblent sur un
// diagramme polaire et se distinguent d'un coup d'œil ici.
function renderVmgAround() {
  const el = $('#vmgAround');
  if (!el || !state.polar) return;
  const shown = shownBins();
  // Un seul bin à la fois : c'est une lecture fine, pas un tableau de bord.
  const bin =
    state.polar.bins.find((b) => b.ws === ui.vmgBin && shown.includes(b.ws)) ||
    state.polar.bins.filter((b) => shown.includes(b.ws) && (b.targets.upwind || b.targets.downwind)).sort(
      (a, b) => b.cells.reduce((x, c) => x + c.n, 0) - a.cells.reduce((x, c) => x + c.n, 0)
    )[0];
  if (!bin) {
    el.innerHTML = '';
    return;
  }
  ui.vmgBin = bin.ws;

  const side = (t, name) => {
    if (!t) return '';
    const row = (x, best) => {
      const cls = best ? ' best' : x.dVmg >= -0.001 ? ' gain' : '';
      const d = best ? '<b>best</b>' : `${x.delta > 0 ? '+' : ''}${x.delta}°`;
      const dv = best ? '' : `${x.dVmg >= 0 ? '+' : ''}${fmt(x.dVmg, 2)} kn · ${x.dPct >= 0 ? '+' : ''}${fmt(x.dPct, 1)}%`;
      return `<tr class="${cls}"><td class="a">${d}</td><td>${fmt(x.twa, 0)}°</td>
        <td>${fmt(x.speed, 2)}</td><td><b>${fmt(x.vmg, 2)}</b></td><td class="k">${dv}</td></tr>`;
    };
    const all = [...(t.around || []), { twa: t.twa, delta: 0, speed: t.speed, vmg: t.vmg, dVmg: 0, dPct: 0, best: true }].sort(
      (a, b) => a.twa - b.twa
    );
    return `<div class="vmgblock"><h3>${name}</h3>
      <table class="targets around"><thead><tr><th class="a"></th><th>TWA</th><th>kn</th><th>VMG</th><th></th></tr></thead>
      <tbody>${all.map((x) => row(x, !!x.best)).join('')}</tbody></table></div>`;
  };

  const picker = state.polar.bins
    .filter((b) => shown.includes(b.ws) && (b.targets.upwind || b.targets.downwind))
    .map((b) => `<button class="chip" data-ws="${b.ws}" aria-pressed="${b.ws === bin.ws}">${b.ws} kn</button>`)
    .join('');

  el.innerHTML = `<h3 class="vmghead">Around the optimum <span class="sub">— what luffing or bearing away costs you</span></h3>
    <div class="chips">${picker}</div>
    <div class="vmgcols">${side(bin.targets.upwind, 'Upwind')}${side(bin.targets.downwind, 'Downwind')}</div>`;
  for (const b of el.querySelectorAll('.chip'))
    b.addEventListener('click', () => {
      ui.vmgBin = Number(b.dataset.ws);
      renderVmgAround();
    });
}

// ── Table ───────────────────────────────────────────────────────────────────
function renderTable() {
  const p = state.polar;
  if (!p) return;
  const angles = p.bins[0].cells.map((c) => c.twa).filter((twa) => p.bins.some((b) => b.cells.find((c) => c.twa === twa && c.value != null)));
  if (!angles.length) {
    $('#tableWrap').innerHTML = '<div class="empty">No data yet.</div>';
    return;
  }
  let h = `<table><thead><tr><th class="a">TWA</th>${p.bins.map((b) => `<th>${b.ws}</th>`).join('')}</tr></thead><tbody>`;
  for (const twa of angles) {
    h += `<tr><td class="a">${twa}°</td>`;
    for (const b of p.bins) {
      const c = b.cells.find((x) => x.twa === twa);
      const cls = c.value == null ? 'n0' : c.overridden ? 'ov' : '';
      h += `<td class="v ${cls}" data-ws="${b.ws}" data-twa="${twa}">${c.value == null ? '·' : fmt(c.value, 2)}${c.n ? `<span class="n">${c.n}</span>` : ''}</td>`;
    }
    h += '</tr>';
  }
  $('#tableWrap').innerHTML = h + '</tbody></table>';
  for (const td of document.querySelectorAll('#tableWrap td.v')) {
    td.addEventListener('click', () => inspect(Number(td.dataset.ws), Number(td.dataset.twa)));
    td.addEventListener('dblclick', () => forceCell(Number(td.dataset.ws), Number(td.dataset.twa)));
  }
}

async function forceCell(ws, twa) {
  const cur = state.polar.bins.find((b) => b.ws === ws).cells.find((c) => c.twa === twa);
  const v = prompt(`Override value for ${ws} kn / ${twa}° (empty = back to the measurement)`, cur.value == null ? '' : fmt(cur.value, 2));
  if (v === null) return;
  await post('/api/cell-override', { ws, twa, value: v === '' ? null : Number(v) });
  refreshPolar();
}

// ── Inspection d'une case ───────────────────────────────────────────────────
async function inspect(ws, twa) {
  ui.sel = { ws, twa };
  $('#inspectSub').textContent = `— ${ws} kn / ${twa}°`;
  const pts = await getJson('/api/cell', { ws, twa });
  const excluded = new Set();
  if (!pts.length) {
    $('#inspect').innerHTML = '<div class="empty">No point in this cell.</div>';
    return;
  }
  const speeds = pts.map((p) => p.speed);
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;

  // Petit nuage cartésien : vitesse de chaque point, dans l'ordre du temps,
  // avec la moyenne — c'est là qu'un aberrant saute aux yeux.
  const W = 320, H = 110, PAD = 22;
  const lo = Math.min(...speeds), hi = Math.max(...speeds);
  const span = Math.max(hi - lo, 0.5);
  const y = (v) => H - PAD - ((v - lo + span * 0.1) / (span * 1.2)) * (H - PAD * 1.4);
  const x = (i) => PAD + (i / Math.max(pts.length - 1, 1)) * (W - PAD * 1.6);
  const dots = pts
    .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.speed).toFixed(1)}" r="4" fill="${colorFor(ws, RAMP)}" class="pt" data-id="${p.id}"><title>${fmt(p.speed, 2)} kn — ${new Date(p.ts).toLocaleString()}</title></circle>`)
    .join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="max-height:130px">
      <line x1="${PAD}" y1="${y(mean).toFixed(1)}" x2="${W - PAD * 0.6}" y2="${y(mean).toFixed(1)}" class="axisline" stroke-dasharray="0"/>
      <text x="${W - PAD * 0.6}" y="${(y(mean) - 5).toFixed(1)}" text-anchor="end" class="axistext">mean ${fmt(mean, 2)} kn</text>
      ${dots}
    </svg>`;

  const rows = pts
    .map(
      (p) => `<div class="row" data-id="${p.id}">
        <input type="checkbox" data-id="${p.id}" title="Untick to exclude this point" checked />
        <span class="meta">${new Date(p.ts).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          · ${fmt(p.tws, 1)} kn / ${fmt(p.twa, 0)}° · ${sailLabel(p.sail)}${p.engineSource === 'autostate' ? ' · engine via autostate' : ''}</span>
        <span class="sp">${fmt(p.speed, 2)} kn</span>
      </div>`
    )
    .join('');

  $('#inspect').innerHTML = `${svg}<div class="pointlist">${rows}</div>
    <div class="row-actions">
      <button class="act" id="btnApplyEx">Apply exclusions</button>
      <button class="act" id="btnForce">Override value…</button>
      <span class="msg" id="inspectMsg"></span>
    </div>`;

  $('#btnApplyEx').addEventListener('click', async () => {
    const off = [...document.querySelectorAll('#inspect input[type=checkbox]')].filter((c) => !c.checked).map((c) => Number(c.dataset.id));
    const on = [...document.querySelectorAll('#inspect input[type=checkbox]')].filter((c) => c.checked).map((c) => Number(c.dataset.id));
    if (off.length) await post('/api/exclude', { ids: off, excluded: true });
    if (on.length) await post('/api/exclude', { ids: on, excluded: false });
    $('#inspectMsg').textContent = `${off.length} point(s) excluded`;
    refreshPolar();
  });
  $('#btnForce').addEventListener('click', () => forceCell(ws, twa));
}

// ── Chips de sélection des forces ───────────────────────────────────────────
function renderChips() {
  if (!state.polar) return;
  const shown = shownBins();
  $('#binChips').innerHTML =
    '<span class="chiplabel">Wind (5 max)</span>' +
    state.polar.bins
      .map((b) => {
        const n = b.cells.reduce((a, c) => a + c.n, 0);
        const on = shown.includes(b.ws);
        return `<button class="chip${n ? '' : ' dim'}" data-ws="${b.ws}" aria-pressed="${on}">
          <span class="swatch" style="background:${on ? colorFor(b.ws, RAMP) : 'var(--axis)'}"></span>${b.ws} kn<span class="n">${n}</span></button>`;
      })
      .join('');
  for (const c of document.querySelectorAll('#binChips .chip'))
    c.addEventListener('click', () => {
      const ws = Number(c.dataset.ws);
      let sel = [...shownBins()];
      if (sel.includes(ws)) sel = sel.filter((x) => x !== ws);
      else {
        sel.push(ws);
        if (sel.length > MAX_SERIES) sel.shift();
      }
      ui.bins = sel.sort((a, b) => a - b);
      refreshPolar();
    });
}

// ── Voilure a posteriori ────────────────────────────────────────────────────
//
// Deux façons d'y arriver, parce qu'elles servent deux moments différents :
// la liste de segments pour « je sais à peu près quand j'ai pris le ris », et
// les frontières suggérées pour « je ne sais plus du tout ». Les suggestions
// sont présentées comme des candidates à vérifier, jamais comme un verdict :
// sur une nav de 15 h, le détecteur retrouve les vrais changements mais sort
// aussi des marches qui n'en sont pas.
const fmtTime = (ts, withDay) =>
  new Date(ts).toLocaleString(undefined, withDay ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

// La sensibilité est un réglage de l'utilisateur, pas une constante : selon
// qu'on cherche « le gros changement que j'ai oublié » ou « toutes les
// nuances », le bon seuil n'est pas le même, et personne ne peut le deviner
// à sa place.
const SENSITIVITY = [
  ['0.8', 'few'],
  ['0.5', 'balanced'],
  ['0.3', 'many'],
];
let sailHist = { data: null, editing: null, draft: { main: '', head: '' }, minStep: '0.5', manual: false, mFrom: '', mTo: '', showAll: false };

async function refreshSailHistory() {
  const el = $('#sailHistory');
  if (!el) return;
  try {
    sailHist.data = await (await fetch(`${API}/api/sail-suggest?minStep=${sailHist.minStep}`)).json();
  } catch (e) {
    el.innerHTML = '<div class="empty">Could not load.</div>';
    return;
  }
  renderSailHistory();
}

function renderSailHistory() {
  const el = $('#sailHistory');
  const d = sailHist.data;
  if (!d || !d.segments || !d.segments.length) {
    el.innerHTML = '<div class="empty">No points to work with yet.</div>';
    return;
  }
  // Une période traitée — corrigée ou simplement confirmée — n'a plus rien à
  // demander. On la garde visible le temps de la nav en cours, puis on la
  // range : sans ça la liste ne fait que croître d'une sortie à l'autre, et
  // les périodes qui attendent vraiment une décision se noient dedans.
  const cutoff = d.hideHandledAfterDays == null ? 2 : d.hideHandledAfterDays;
  const isHidden = (seg) => seg.handled && seg.ageDays > cutoff;
  const hidden = d.segments.filter(isHidden).length;
  const shown = sailHist.showAll ? d.segments : d.segments.filter((seg) => !isHidden(seg));

  const rows = shown
    .map((seg, i) => {
      const b = d.boundaries.find((x) => x.ts === seg.from);
      const why = !b
        ? ''
        : b.kind === 'gap'
        ? `${b.gapMin} min gap`
        : `${b.step > 0 ? '+' : ''}${fmt(b.step, 2)} kn vs polar${
            b.heelStep == null ? '' : `, heel ${b.heelStep > 0 ? '+' : ''}${fmt(b.heelStep, 1)}°`
          }`;

      // Un segment peut contenir plusieurs voilures — c'est justement ce qu'on
      // vient corriger. On le dit en points, pas en nombre de configurations :
      // « 4 +1 other » à côté de « 6 pts » ne s'additionne pas et fait douter.
      const sails = seg.sails || [];
      const total = sails.reduce((a, x) => a + x.n, 0);
      const plan = !sails.length
        ? '<span class="k">not set</span>'
        : sails.length === 1
        ? sailLabel(sails[0])
        : `${sailLabel(sails[0])} <span class="mix">mixed · ${sails[0].n} of ${total} pts</span>`;

      const open = sailHist.editing === seg.from;
      const cls = seg.handled === 'corrected' ? ' fixed' : seg.handled === 'reviewed' ? ' okd' : '';
      return `<div class="seg-row${open ? ' open' : ''}${cls}">
        <div class="seg-head">
          <span class="t">${fmtTime(seg.from, true)} → ${fmtTime(seg.to)}</span>
          <span class="k">${seg.n} pts</span>
          <span class="cur">${plan}</span>
          <span class="acts">${
            seg.handled
              ? `<span class="done">${seg.handled === 'corrected' ? 'corrected' : 'confirmed'}</span>
                 <button class="act danger" data-undo="${seg.handled}" data-idx="${seg.handledIndex}">undo</button>`
              : `<button class="act" data-seg="${seg.from}">${open ? 'cancel' : 'set…'}</button>
                 <button class="act" data-ok="${seg.from}" data-to="${seg.to}" title="This stretch is already labelled correctly">ok</button>`
          }</span>
        </div>
        ${why || sails.length > 1 ? `<div class="why">${[why, sails.length > 1 ? sails.slice(1).map((x) => `${x.n} × ${sailLabel(x)}`).join(', ') : ''].filter(Boolean).join(' · ')}</div>` : ''}
        ${open ? sailEditor() : ''}
      </div>`;
    })
    .join('');

  const sens = SENSITIVITY.map(
    ([v, label]) => `<button data-sens="${v}" aria-pressed="${v === sailHist.minStep}">${label}</button>`
  ).join('');

  el.innerHTML =
    `<div class="row-actions">
       <div class="group"><label>Split</label><div class="seg" id="segSens">${sens}</div></div>
       <button class="act" id="btnManual">${sailHist.manual ? 'cancel' : 'enter times by hand…'}</button>
     </div>` +
    (sailHist.manual ? manualEditor() : '') +
    `<div class="seglist">${rows}</div>` +
    (hidden
      ? `<div class="row-actions"><button class="act" id="btnShowAll">${
          sailHist.showAll ? 'hide handled' : `show ${hidden} handled`
        }</button></div>`
      : '') +
    `<div class="hint">Rows are cut where performance stepped up or down once wind and angle are accounted for,
      so this says <b>when</b> something changed, never <b>what</b> — and a wind shift can look like a sail change.
      Corrections sit beside the measurements, so replaying the raw log keeps them.</div>`;

  for (const b of el.querySelectorAll('#segSens button'))
    b.addEventListener('click', async () => {
      sailHist.minStep = b.dataset.sens;
      sailHist.editing = null;
      await refreshSailHistory();
    });
  const man = $('#btnManual');
  if (man)
    man.addEventListener('click', () => {
      sailHist.manual = !sailHist.manual;
      sailHist.editing = null;
      renderSailHistory();
    });
  bindManual();
  const showAll = $('#btnShowAll');
  if (showAll)
    showAll.addEventListener('click', () => {
      sailHist.showAll = !sailHist.showAll;
      renderSailHistory();
    });
  for (const b of el.querySelectorAll('button[data-seg]'))
    b.addEventListener('click', () => {
      const from = Number(b.dataset.seg);
      sailHist.editing = sailHist.editing === from ? null : from;
      sailHist.draft = { main: '', head: '' };
      renderSailHistory();
    });
  // « ok » : rien à corriger ici. Ce n'est pas une correction, donc ça ne
  // touche à aucune mesure — seulement à ce que la liste continue de demander.
  for (const b of el.querySelectorAll('button[data-ok]'))
    b.addEventListener('click', async () => {
      await post('/api/sail-reviewed', { from: Number(b.dataset.ok), to: Number(b.dataset.to) });
      await refreshSailHistory();
    });
  for (const b of el.querySelectorAll('button[data-undo]'))
    b.addEventListener('click', async () => {
      const route = b.dataset.undo === 'corrected' ? '/api/sail-range/clear' : '/api/sail-reviewed/clear';
      await post(route, { index: Number(b.dataset.idx) });
      await refreshSailHistory();
      refreshPolar();
      refreshStatus();
    });
  bindSailEditor();
}

// La saisie à la main reste le chemin le plus court quand on se souvient de
// l'heure : « j'ai pris le ris vers 17 h ». Aucune détection ne bat ça.
function manualEditor() {
  const d = sailHist.data;
  const iso = (ts) => {
    const x = new Date(ts - new Date().getTimezoneOffset() * 60000);
    return x.toISOString().slice(0, 16);
  };
  // Les deux dates vivent dans l'état, pas dans le DOM : choisir une voile
  // redessine le panneau, et une heure saisie ne doit pas disparaître à ce
  // moment-là.
  if (!sailHist.mFrom) sailHist.mFrom = iso(d.segments[0].from);
  if (!sailHist.mTo) sailHist.mTo = iso(d.segments[d.segments.length - 1].to);
  return `<div class="seg-row open"><div class="seg-edit">
      <div class="group"><label>From</label><input type="datetime-local" id="mFrom" value="${sailHist.mFrom}"></div>
      <div class="group"><label>To</label><input type="datetime-local" id="mTo" value="${sailHist.mTo}"></div>
    </div>
    ${sailEditor('btnManualApply')}
    <div class="hint">Applies to every point recorded between those two times.</div></div>`;
}

function bindManual() {
  const btn = $('#btnManualApply');
  if (!btn) return;
  for (const id of ['mFrom', 'mTo'])
    $('#' + id).addEventListener('change', (e) => (sailHist[id] = e.target.value));
  btn.addEventListener('click', async () => {
    const from = Date.parse($('#mFrom').value);
    const to = Date.parse($('#mTo').value);
    if (isNaN(from) || isNaN(to) || to <= from) {
      alert('Check the two times: the end must come after the start.');
      return;
    }
    await post('/api/sail-range', { from, to, main: sailHist.draft.main, head: sailHist.draft.head });
    sailHist.manual = false;
    sailHist.mFrom = '';
    sailHist.mTo = '';
    await refreshSailHistory();
    refreshPolar();
    refreshStatus();
  });
}

function sailEditor(applyId) {
  const seg = (id, list, val) =>
    `<div class="seg" data-edit="${id}">${list
      .map(([v, label]) => `<button data-v="${v}" aria-pressed="${v === val}">${label}</button>`)
      .join('')}</div>`;
  const { sail, reef } = splitHead(sailHist.draft.head);
  return `<div class="seg-edit">
    <div class="group"><label>Mainsail</label>${seg('main', MAIN_SAILS, sailHist.draft.main)}</div>
    <div class="group"><label>Headsail</label>${seg('head', HEAD_SAILS, sail)}</div>
    ${REEFABLE.has(sail) ? `<div class="group"><label>Reef</label>${seg('reef', HEAD_REEFS, reef)}</div>` : ''}
    <button class="act" id="${applyId || 'btnSegApply'}">Apply to these points</button>
  </div>`;
}

function bindSailEditor() {
  const el = $('#sailHistory');
  for (const g of el.querySelectorAll('[data-edit]'))
    g.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const kind = g.dataset.edit;
      const { sail, reef } = splitHead(sailHist.draft.head);
      if (kind === 'main') sailHist.draft.main = b.dataset.v;
      else if (kind === 'head') sailHist.draft.head = composeHead(b.dataset.v, reef);
      else sailHist.draft.head = composeHead(sail, b.dataset.v);
      renderSailHistory();
    });
  const apply = $('#btnSegApply');
  if (!apply) return;
  apply.addEventListener('click', async () => {
    const seg = sailHist.data.segments.find((x) => x.from === sailHist.editing);
    if (!seg) return;
    await post('/api/sail-range', { from: seg.from, to: seg.to, main: sailHist.draft.main, head: sailHist.draft.head });
    sailHist.editing = null;
    await refreshSailHistory();
    refreshPolar();
    refreshStatus();
  });
}

// ── Diagnostic du capteur de vitesse ────────────────────────────────────────
//
// La question n'est pas « de combien STW et SOG diffèrent » — ça, un simple
// écart le dit — mais « pourquoi ». Un courant et un speedo déréglé donnent
// le même écart moyen et appellent des réponses opposées : ne rien toucher
// dans un cas, recalibrer le capteur dans l'autre. Le panneau montre donc
// d'abord le verdict et ce qui l'appuie, la table de correction ensuite.
const VERDICTS = {
  speedo: {
    cls: 'bad',
    title: 'The speed sensor is reading wrong',
    why: 'The gap follows the boat, not the sea: it stays in line with the hull and grows with speed. That is a calibration error, not current.',
  },
  current: {
    cls: 'ok',
    title: 'Looks like current',
    why: 'The gap keeps a fixed direction over the ground and does not grow with boat speed. Nothing to correct on the sensor — the STW polar is the trustworthy one.',
  },
  conflicting: {
    cls: 'wait',
    title: 'The two tests disagree',
    why: 'One test points at the sensor, the other at current. Most likely both are at play. Sail a few legs on varied headings before trusting either.',
  },
  mixed: { cls: 'wait', title: 'Inconclusive', why: 'Neither cause stands out clearly.' },
  inconclusive: {
    cls: 'wait',
    title: 'Not enough variety yet',
    why: 'Telling a sensor error from current needs legs on different headings and at different speeds. Keep sailing.',
  },
};

async function refreshSpeedo() {
  const el = $('#speedo');
  if (!el) return;
  let a;
  try {
    a = await (await fetch(`${API}/api/speedo`)).json();
  } catch (e) {
    return;
  }
  if (!a || !a.n || a.n < 10) {
    el.innerHTML = '<div class="empty">Not enough data yet — a few legs under sail are needed.</div>';
    return;
  }
  const d = a.diagnosis;
  const v = VERDICTS[d.verdict] || VERDICTS.inconclusive;
  const pct = (f) => `${f >= 1 ? '+' : ''}${((f - 1) * 100).toFixed(1)}%`;

  // Les deux tests sont montrés séparément, avec ce que chacun a conclu : un
  // verdict qu'on ne peut pas recouper ne se discute pas, et celui-ci mérite
  // de l'être avant qu'on aille toucher au réglage d'un capteur.
  const sc = d.scaling;
  const evidence = `<ul class="ev">
    <li><b>Direction of the gap.</b> ${
      d.frames === null
        ? `not usable here — the boat held too few different headings (spread ${fmt(d.headingSpread * 100, 0)}%)`
        : `concentration ${fmt(d.boatFrame, 2)} in the boat frame vs ${fmt(d.earthFrame, 2)} over the ground → <b>${
            d.frames === 'tie' ? 'no winner' : d.frames === 'speedo' ? 'sensor' : 'current'
          }</b>`
    }</li>
    <li><b>Does the gap grow with speed?</b> ${
      sc
        ? `a constant offset explains it to ±${fmt(sc.rmseConstant, 2)} kn, a gap proportional to speed to ±${fmt(
            sc.rmseProportional,
            2
          )} kn → <b>${sc.favours === 'tie' ? 'no winner' : sc.favours === 'speedo' ? 'sensor' : 'current'}</b>`
        : 'not enough spread in boat speed'
    }</li>
  </ul>`;

  const rows = a.table
    .filter((t) => t.enough)
    .map(
      (t) => `<tr><td class="a">${fmt(t.stw, 1)}</td><td>${fmt(t.sog, 2)}</td>
        <td><b>${pct(t.factor)}</b></td><td class="k">${t.n}</td></tr>`
    )
    .join('');

  el.innerHTML = `<div class="verdict ${v.cls}"><span class="dot"></span><b>${v.title}</b></div>
    <div class="hint">${v.why}</div>
    ${evidence}
    <div class="hint">Overall, STW reads <b>${pct(1 / a.gain)}</b> against GPS (fit to ±${fmt(a.gainRmse, 2)} kn over ${a.n} points).
      The error is rarely a single number — that is exactly what a multi-point sensor table is for.</div>
    ${
      d.verdict === 'speedo'
        ? `<div class="advice"><b>Worth calibrating the speed sensor.</b> The table below is a starting proposal, not gospel:
             it is only as good as the assumption that nothing else moved the water. Residual current, a big swell or a
             persistent sea state will all end up in these numbers. Collect over several passages, on varied headings, and
             sanity-check the shape before you type it into the sensor. Keep a copy — some units drop the advanced table on reset.</div>`
        : ''
    }
    <div class="tablewrap"><table class="speedo"><thead><tr><th class="a">STW shown</th><th>real speed</th><th>error</th><th>n</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="k">no speed band has enough points yet</td></tr>'}</tbody></table></div>
    <div class="row-actions">
      <button class="act" id="btnCalCsv">Correction table (CSV)</button>
    </div>
    <div class="hint">Indicated speed, real speed, factor and error — the shape a multi-point speed calibration
      table expects. Speed bands you have never sailed are left blank rather than invented, and the heel axis
      some instruments offer is not filled: there would be too few points per cell to trust. Nothing here ever
      rewrites your measurements — the corrected polar is one more reading of the same data.</div>`;

  $('#btnCalCsv').onclick = () => window.open(`${API}/api/speedo/calibration.csv`, '_blank');
}

// ── Partage ─────────────────────────────────────────────────────────────────
//
// Une issue GitHub pré-remplie, et le fichier téléchargé dans la foulée. Pas
// de jeton dans le plugin, pas de service à héberger, et surtout : on voit
// exactement ce qu'on envoie avant de l'envoyer. Une contribution qui se fait
// à l'aveugle ne se fait pas deux fois.
async function refreshShare() {
  const el = $('#share');
  if (!el) return;
  let d;
  try {
    d = await (await fetch(`${API}/api/share?${query()}`)).json();
  } catch (e) {
    return;
  }
  const missing = [];
  if (!d.model) missing.push('the boat model');
  if (!d.name) missing.push('a name to publish under');
  if (d.points < 100) missing.push(`more points (${d.points} of 100)`);

  const dim = (k, u) => (d.dims && d.dims[k] != null ? `${fmt(d.dims[k], 2)} ${u}` : null);
  const facts = [
    d.model || null,
    dim('length', 'm') ? `${dim('length', 'm')} LOA` : null,
    `${d.points} points`,
    `${d.cells} cells`,
    `${d.bands} wind bands`,
  ].filter(Boolean);

  el.innerHTML =
    `<div class="hint">This plugin is free. The one thing that would make it better for everyone is the polar of
      your own boat: most production designs have no honest measured polar anywhere, only the builder's optimistic
      one. <b>Nothing collected here contains a position</b> — not one latitude, not one longitude — so a shared
      polar says nothing about where you have been. The name is free text; a pseudonym is fine.</div>
     <div class="sharefacts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>
     ${
       d.declaredExcluded
         ? `<div class="hint">${d.declaredExcluded} point(s) recorded on a "sailing" declaration are left out —
            nobody else can check a declaration.</div>`
         : ''
     }
     ${
       missing.length
         ? `<div class="hint warn">Still needed: ${missing.join(', ')}.${
             d.model && d.name ? '' : ' Set them in the plugin configuration (SignalK → Server → Plugin Config).'
           }</div>`
         : `<div class="row-actions">
              <button class="act" id="btnShare">Download and open a submission</button>
            </div>
            <div class="hint">The file downloads, then a pre-filled issue opens on
              <code>${d.repo}</code>. Drag the file into it and send — you will see the whole message first.</div>`
     }`;

  const btn = $('#btnShare');
  if (!btn) return;
  btn.onclick = () => {
    window.open(`${API}/api/share.pol?${query()}`, '_blank');
    const when = (t) => (t ? new Date(t).toLocaleDateString() : '?');
    const body = [
      `**Boat model:** ${d.model}`,
      `**Published as:** ${d.name}`,
      d.dims && d.dims.length != null ? `**Length overall:** ${fmt(d.dims.length, 2)} m` : null,
      d.dims && d.dims.beam != null ? `**Beam:** ${fmt(d.dims.beam, 2)} m` : null,
      d.dims && d.dims.draft != null ? `**Draught:** ${fmt(d.dims.draft, 2)} m` : null,
      '',
      `**Points:** ${d.points} (over ${d.cells} cells, ${d.bands} wind bands)`,
      `**Collected:** ${when(d.first)} → ${when(d.last)}`,
      `**Axes:** ${d.speed === 'sog' ? 'speed over ground' : d.speed === 'stwc' ? 'corrected speed through water' : 'speed through water'}, ${
        d.wind === 'true' ? 'true wind' : 'apparent wind'
      }, ${d.stat} per cell`,
      `**Plugin version:** ${d.version}`,
      '',
      '_The `.pol` file has just been downloaded — please attach it to this issue._',
      '',
      '_No position data of any kind is collected or shared._',
    ]
      .filter((x) => x !== null)
      .join('\n');
    const url =
      `https://github.com/${d.repo}/issues/new?title=` +
      encodeURIComponent(`Polar: ${d.model} — ${d.name}`) +
      '&body=' +
      encodeURIComponent(body);
    window.open(url, '_blank');
  };
}

// ── Contrôles ───────────────────────────────────────────────────────────────
function bindControls() {
  for (const seg of document.querySelectorAll('#controls .seg')) {
    const key = seg.dataset.key;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      ui[key] = b.dataset.v;
      syncControls();
      refreshPolar();
    });
  }
  syncControls();
}
function syncControls() {
  for (const seg of document.querySelectorAll('#controls .seg'))
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === ui[seg.dataset.key]));
}

// ── Export & maintenance ────────────────────────────────────────────────────
function bindActions() {
  const dl = (path) => () => window.open(`${API}${path}?${query()}`, '_blank');
  $('#btnPol').onclick = dl('/api/export.pol');
  $('#btnCsv').onclick = dl('/api/export.csv');
  $('#btnJson').onclick = dl('/api/export.json');
  $('#btnRaw').onclick = () => window.open(`${API}/api/samples.jsonl`, '_blank');

  const say = (t) => ($('#maintMsg').textContent = t);
  $('#btnRebuildDry').onclick = async () => {
    say('replaying…');
    const r = await post('/api/rebuild', { dryRun: true });
    say(`a replay would give ${r.count} points (nothing has been changed)`);
  };
  $('#btnRebuild').onclick = async () => {
    if (!confirm('Rebuild every point from the raw log, using the current plugin settings?')) return;
    say('replaying…');
    const r = await post('/api/rebuild', {});
    say(`${r.count} points rebuilt`);
    refreshPolar();
  };
  $('#btnResetOv').onclick = async () => {
    if (!confirm('Clear every exclusion and overridden value? The measurements themselves are untouched.')) return;
    await post('/api/reset', { what: 'overrides' });
    refreshPolar();
    say('edits cleared');
  };
  $('#btnResetRuns').onclick = async () => {
    if (!confirm('Clear every point? The raw log is kept, so a replay will rebuild them.')) return;
    await post('/api/reset', { what: 'runs' });
    refreshPolar();
    say('points cleared');
  };
}

async function refreshStatus() {
  const s = await (await fetch(`${API}/api/status`)).json();
  const mb = (s.disk.sampleBytes / 1048576).toFixed(1);
  $('#diskHint').textContent =
    `${s.disk.runCount} points · raw log ${mb} MB${s.disk.samplesFull ? ' (FULL)' : ''} · ${s.excluded} point(s) excluded · ${s.overrides} cell(s) overridden` +
    (s.disk.writeErrors ? ` · ⚠ ${s.disk.writeErrors} failed write(s): ${s.disk.lastWriteError}` : '');
  $('#headSub').textContent =
    (s.first ? `${s.disk.runCount} points since ${new Date(s.first).toLocaleDateString()}` : 'no points yet') +
    ` · v${s.version || '?'}`;
  state.quality = s.quality || null;
  renderQuality(s.quality);
  renderSailChips(s.sailTags || [], s.disk.runCount);
}

// Un compteur de points ne dit pas si la polaire vaut quelque chose : 500
// points pris au même largue dans le même vent n'en font pas une. On montre
// donc ce qui la rend exploitable — cases étayées, forces parcourues, plage
// d'allures — et surtout ce qu'il manque pour passer au cran suivant.
const GRADES = {
  starting: ['wait', 'getting started'],
  thin: ['wait', 'thin'],
  usable: ['ok', 'usable'],
  good: ['ok', 'solid'],
};
function renderQuality(q) {
  const el = $('#quality');
  if (!el) return;
  if (!q || !q.points) {
    el.innerHTML = '<span class="k">no points yet</span>';
    return;
  }
  const [cls, label] = GRADES[q.grade] || GRADES.usable;
  const bits = [
    `<b>${q.points}</b> points`,
    `<b>${q.solidCells}</b> cells on 3+ measurements <span class="k">(${q.cells} touched)</span>`,
    `<b>${q.windBands}</b> wind band(s)`,
    q.twaFrom != null ? `TWA ${q.twaFrom}–${q.twaTo}°` : null,
    q.medianConfidence != null ? `median confidence <b>${fmt(q.medianConfidence, 2)}</b>` : null,
  ].filter(Boolean);
  el.innerHTML =
    `<span class="verdict ${cls}"><span class="dot"></span><b>${label}</b></span> ` +
    `<span class="k">${bits.join(' · ')}</span>` +
    (q.missing ? `<div class="hint">${q.missing}</div>` : '');
}

// ── Filtre de voilure ───────────────────────────────────────────────────────
// Construit à partir des combinaisons RÉELLEMENT navigées, pas de la liste
// des possibles : proposer de filtrer sur une configuration jamais utilisée
// ne mènerait qu'à des diagrammes vides.
function renderSailChips(tags, total) {
  const el = $('#sailChips');
  if (!el) return;
  if (tags.length < 2) {
    el.innerHTML = '';
    return;
  }
  const active = ui.sailFilter;
  const same = (t) => active && active.main === t.main && active.head === t.head;
  // « All » veut dire « aucun filtre », donc TOUS les points — y compris ceux
  // qui n'ont jamais reçu d'étiquette. Additionner les voilures connues
  // donnerait un compte plus petit que le total affiché en tête, et deux
  // chiffres qui se contredisent font douter des deux.
  const all = total != null ? total : tags.reduce((a, t) => a + t.n, 0);
  el.innerHTML =
    '<span class="chiplabel">Sail plan</span>' +
    `<button class="chip" data-i="-1" aria-pressed="${!active}">All<span class="n">${all}</span></button>` +
    tags
      .map((t, i) => `<button class="chip" data-i="${i}" aria-pressed="${same(t)}">${sailLabel(t)}<span class="n">${t.n}</span></button>`)
      .join('');
  for (const b of el.querySelectorAll('.chip'))
    b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      ui.sailFilter = i < 0 ? null : { main: tags[i].main, head: tags[i].head };
      renderSailChips(tags);
      refreshPolar();
    });
}

// En mode « ajouté à l'écran d'accueil », iOS n'affiche aucune barre d'adresse
// et donc aucun bouton de rechargement : sans ce bouton, la seule façon de
// repartir de zéro serait de fermer l'app. On en profite pour tout recharger
// aussi au retour au premier plan — c'est le geste qu'on fait en vrai, sortir
// le téléphone de sa poche.
function refreshAll(resetBins) {
  if (resetBins) ui.bins = null;
  refreshLive();
  refreshStatus();
  refreshPolar();
  refreshSpeedo();
  refreshSailHistory();
  refreshShare();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAll(false);
});

buildSail();
$('#btnReload').addEventListener('click', () => refreshAll(true));
bindControls();
bindActions();
refreshLive();
refreshStatus();
refreshPolar();
refreshSpeedo();
refreshSailHistory();
refreshShare();
setInterval(refreshLive, 2000);
setInterval(refreshStatus, 15000);
setInterval(refreshPolar, 60000);
setInterval(refreshSpeedo, 60000);
