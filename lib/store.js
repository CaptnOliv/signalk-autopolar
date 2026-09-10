// Persistance. Cinq fichiers dans le dossier de données du plugin, tous
// inspectables et réparables à la main depuis un cockpit sans réseau.
//
//   samples.jsonl   — TOUT ce qui a été vu sous voile, une ligne par seconde,
//                     avant tout filtre de stabilité. C'est le filet de
//                     sécurité : si les seuils du filtre se révèlent mal
//                     réglés après coup, on rejoue ce fichier et on
//                     reconstruit les points sans avoir à re-naviguer.
//                     ~150 octets/s, soit ~15 Mo pour 30 h de nav.
//   runs.jsonl      — les points retenus (une fenêtre stable condensée).
//   overrides.json  — les corrections faites à la main dans la webapp :
//                     points exclus, cases forcées. Volontairement séparé,
//                     pour qu'aucune retouche ne détruise une mesure.
//   history.jsonl   — les points d'ébauche reconstruits depuis le History API
//                     du serveur (lib/history.js). Dans un fichier à part, et
//                     pas au bout de runs.jsonl, pour deux raisons : le rejeu
//                     du brut réécrit runs.jsonl intégralement et effacerait
//                     l'ébauche sans le dire ; et un ré-import doit pouvoir
//                     remplacer ce qu'il avait posé au lieu de l'empiler.
//   history.json    — ce qui a été importé (plage, résolution, décompte) et
//                     l'index de couverture du direct, mis en cache.

const fs = require('fs');
const path = require('path');

function createStore(dataDir, opts = {}) {
  const runsFile = path.join(dataDir, 'runs.jsonl');
  const samplesFile = path.join(dataDir, 'samples.jsonl');
  const overridesFile = path.join(dataDir, 'overrides.json');
  const historyFile = path.join(dataDir, 'history.jsonl');
  const historyMetaFile = path.join(dataDir, 'history.json');
  const maxSampleBytes = (opts.maxSampleMB || 500) * 1024 * 1024;

  let runs = [];
  let histRuns = [];
  let histMeta = { imports: [], coverage: null };
  // Vue fusionnée (mesures + ébauche), triée par horodatage. Reconstruite à
  // la demande : tous les lecteurs passent par runs(), et un point ajouté en
  // pleine nav ne doit pas obliger à retrier 3000 points à chaque seconde.
  let merged = null;
  let overrides = { excluded: [], cells: {}, sailRanges: [], sailReviewed: [] };
  let excludedSet = new Set();
  let sampleBytes = 0;
  let sampleCount = 0;
  let samplesFull = false;

  const readLines = (file) => {
    const out = [];
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        // Ligne tronquée par une coupure d'alim en pleine écriture : on la
        // laisse tomber, tout le reste de l'historique reste bon.
      }
    }
    return out;
  };

  function load() {
    runs = readLines(runsFile);
    histRuns = readLines(historyFile);
    merged = null;
    if (fs.existsSync(historyMetaFile)) {
      try {
        const m = JSON.parse(fs.readFileSync(historyMetaFile, 'utf8'));
        histMeta = { imports: m.imports || [], coverage: m.coverage || null };
      } catch (e) {
        /* méta illisible : les points d'ébauche restent, on refera l'index */
      }
    }
    if (fs.existsSync(overridesFile)) {
      try {
        const o = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
        overrides = {
          excluded: o.excluded || [],
          cells: o.cells || {},
          sailRanges: o.sailRanges || [],
          sailReviewed: o.sailReviewed || [],
        };
      } catch (e) {
        /* fichier illisible : on repart d'aucune retouche, les mesures sont intactes */
      }
    }
    excludedSet = new Set(overrides.excluded);
    if (fs.existsSync(samplesFile)) {
      sampleBytes = fs.statSync(samplesFile).size;
      samplesFull = sampleBytes >= maxSampleBytes;
    }
  }

  // Une écriture qui échoue (disque plein, système de fichiers en lecture
  // seule) est comptée et signalée, jamais propagée : la collecte continue en
  // mémoire et le reste du serveur n'en sait rien.
  let writeErrors = 0;
  let lastWriteError = null;

  function appendRun(rec) {
    runs.push(rec);
    merged = null;
    try {
      fs.appendFileSync(runsFile, JSON.stringify(rec) + '\n');
      return true;
    } catch (e) {
      writeErrors++;
      lastWriteError = String((e && e.message) || e);
      return false;
    }
  }

  function appendSample(rec) {
    if (samplesFull) return false;
    const line = JSON.stringify(rec) + '\n';
    try {
      fs.appendFileSync(samplesFile, line);
    } catch (e) {
      writeErrors++;
      lastWriteError = String((e && e.message) || e);
      return false;
    }
    sampleBytes += Buffer.byteLength(line);
    sampleCount++;
    if (sampleBytes >= maxSampleBytes) samplesFull = true;
    return true;
  }

  // Rejoue le brut ligne par ligne sans jamais tout charger en mémoire : le
  // fichier peut peser des centaines de Mo après plusieurs longues navs.
  function eachSample(fn) {
    if (!fs.existsSync(samplesFile)) return 0;
    const data = fs.readFileSync(samplesFile, 'utf8');
    let n = 0;
    let start = 0;
    while (start < data.length) {
      let end = data.indexOf('\n', start);
      if (end === -1) end = data.length;
      const line = data.slice(start, end);
      start = end + 1;
      if (!line) continue;
      try {
        fn(JSON.parse(line));
        n++;
      } catch (e) {
        /* ligne corrompue, ignorée */
      }
    }
    return n;
  }

  // Remplace intégralement les points par ceux issus d'un rejeu. Le brut n'est
  // pas touché : l'opération est rejouable autant de fois qu'on veut.
  function replaceRuns(newRuns) {
    fs.writeFileSync(runsFile, newRuns.map((r) => JSON.stringify(r)).join('\n') + (newRuns.length ? '\n' : ''));
    runs = newRuns;
    merged = null;
  }

  // ── Points d'ébauche (History API) ────────────────────────────────────────
  //
  // Un import REMPLACE ce qui recouvre sa plage au lieu de s'ajouter : sans
  // ça, deux clics sur le même bouton doubleraient chaque point, et un
  // ré-import après un réglage de seuil laisserait l'ancienne version
  // derrière lui. Le reste de l'ébauche (d'autres plages) est conservé.
  function replaceHistory(recs, range, meta) {
    const keep = range ? histRuns.filter((r) => r.ts < range.from || r.ts > range.to) : [];
    histRuns = keep.concat(recs).sort((a, b) => a.ts - b.ts);
    fs.writeFileSync(historyFile, histRuns.map((r) => JSON.stringify(r)).join('\n') + (histRuns.length ? '\n' : ''));
    if (range) {
      histMeta.imports = histMeta.imports
        .filter((im) => im.from < range.from || im.to > range.to)
        .concat([Object.assign({ from: range.from, to: range.to, at: Date.now(), points: recs.length }, meta || {})])
        .sort((a, b) => a.from - b.from);
    }
    saveHistoryMeta();
    merged = null;
    return histRuns.length;
  }

  function saveHistoryMeta() {
    fs.writeFileSync(historyMetaFile, JSON.stringify(histMeta, null, 2));
  }

  function setCoverage(cov) {
    histMeta.coverage = cov;
    saveHistoryMeta();
    return cov;
  }

  // Les périodes que le plugin a observées LUI-MÊME, à pleine fréquence.
  // Elles viennent du brut : c'est le seul témoignage de « j'étais là et je
  // regardais », y compris pour les secondes que le filtre a refusées — ce
  // qu'un simple relevé des points retenus ne dirait pas.
  //
  // Le balayage coûte quelques centaines de millisecondes sur un brut de
  // plusieurs dizaines de Mo : on le garde en cache, indexé sur la taille du
  // fichier, qui ne fait que croître.
  function coverage(gapMs, buildIntervals) {
    const size = sampleBytes;
    const cached = histMeta.coverage;
    if (cached && cached.bytes === size && cached.gapMs === gapMs) return cached;
    const stamps = [];
    eachSample((s) => stamps.push(s.t));
    stamps.sort((a, b) => a - b);
    return setCoverage({ bytes: size, gapMs, intervals: buildIntervals(stamps, gapMs), samples: stamps.length });
  }

  function saveOverrides() {
    overrides.excluded = [...excludedSet];
    fs.writeFileSync(overridesFile, JSON.stringify(overrides, null, 2));
  }

  function setExcluded(ids, excluded) {
    for (const id of ids) {
      if (excluded) excludedSet.add(id);
      else excludedSet.delete(id);
    }
    saveOverrides();
  }

  // Voilure affectée après coup à une plage de temps.
  //
  // Rien n'est réécrit dans runs.jsonl : la voilure corrigée vit ici, à part
  // des mesures, et s'applique à la lecture. Deux raisons. Une correction ne
  // doit jamais détruire ce qui a été observé ; et le rejeu du brut
  // reconstruit les points depuis samples.jsonl, où l'étiquette d'origine est
  // écrite — une correction faite dans les points serait perdue au premier
  // rejeu, celle-ci survit.
  function setSailRange(range) {
    if (!range || !range.from || !range.to) return overrides.sailRanges;
    overrides.sailRanges.push({
      from: Number(range.from),
      to: Number(range.to),
      main: range.main || '',
      head: range.head || '',
      at: Date.now(),
    });
    overrides.sailRanges.sort((a, b) => a.at - b.at); // la dernière posée gagne
    saveOverrides();
    return overrides.sailRanges;
  }

  // « Cette période est bonne telle quelle ». Une confirmation n'est pas une
  // correction — elle ne change aucune donnée — mais elle doit se garder au
  // même endroit et survivre au même rejeu, sinon la liste des périodes à
  // revoir repart de zéro à chaque nav et on la relit indéfiniment.
  function setSailReviewed(range) {
    if (!range || !range.from || !range.to) return overrides.sailReviewed;
    overrides.sailReviewed.push({ from: Number(range.from), to: Number(range.to), at: Date.now() });
    saveOverrides();
    return overrides.sailReviewed;
  }

  function clearSailReviewed(index) {
    if (index == null) overrides.sailReviewed = [];
    else overrides.sailReviewed.splice(index, 1);
    saveOverrides();
    return overrides.sailReviewed;
  }

  function clearSailRanges(index) {
    if (index == null) overrides.sailRanges = [];
    else overrides.sailRanges.splice(index, 1);
    saveOverrides();
    return overrides.sailRanges;
  }

  function setCellOverride(key, value) {
    if (value == null) delete overrides.cells[key];
    else overrides.cells[key] = value;
    saveOverrides();
  }

  function reset(what) {
    if (what === 'all' || what === 'runs') {
      runs = [];
      merged = null;
      if (fs.existsSync(runsFile)) fs.unlinkSync(runsFile);
    }
    if (what === 'all' || what === 'history') {
      histRuns = [];
      merged = null;
      histMeta = { imports: [], coverage: histMeta.coverage };
      if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile);
      saveHistoryMeta();
    }
    if (what === 'all' || what === 'samples') {
      if (fs.existsSync(samplesFile)) fs.unlinkSync(samplesFile);
      sampleBytes = 0;
      sampleCount = 0;
      samplesFull = false;
    }
    if (what === 'all' || what === 'overrides') {
      overrides = { excluded: [], cells: {}, sailRanges: [], sailReviewed: [] };
      excludedSet = new Set();
      if (fs.existsSync(overridesFile)) fs.unlinkSync(overridesFile);
    }
  }

  return {
    load,
    appendRun,
    appendSample,
    eachSample,
    replaceRuns,
    replaceHistory,
    coverage,
    setExcluded,
    setCellOverride,
    setSailRange,
    clearSailRanges,
    setSailReviewed,
    clearSailReviewed,
    reset,
    // La vue par défaut est la vue fusionnée : tout ce qui lit la polaire doit
    // voir l'ébauche, c'est toute la raison de l'importer. Ceux qui doivent
    // s'en passer (le partage, le rejeu) le disent explicitement.
    runs: () => {
      if (!merged) merged = histRuns.length ? runs.concat(histRuns).sort((a, b) => a.ts - b.ts) : runs;
      return merged;
    },
    liveRuns: () => runs,
    historyRuns: () => histRuns,
    historyMeta: () => histMeta,
    overrides: () => overrides,
    excluded: () => excludedSet,
    files: () => ({ runsFile, samplesFile, overridesFile, historyFile }),
    diskInfo: () => ({
      sampleBytes,
      sampleCount,
      samplesFull,
      maxSampleBytes,
      runCount: runs.length + histRuns.length,
      liveCount: runs.length,
      historyCount: histRuns.length,
      writeErrors,
      lastWriteError,
    }),
  };
}

module.exports = { createStore };
