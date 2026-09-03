// Persistance. Trois fichiers dans le dossier de données du plugin, tous
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

const fs = require('fs');
const path = require('path');

function createStore(dataDir, opts = {}) {
  const runsFile = path.join(dataDir, 'runs.jsonl');
  const samplesFile = path.join(dataDir, 'samples.jsonl');
  const overridesFile = path.join(dataDir, 'overrides.json');
  const maxSampleBytes = (opts.maxSampleMB || 500) * 1024 * 1024;

  let runs = [];
  let overrides = { excluded: [], cells: {}, sailRanges: [] };
  let excludedSet = new Set();
  let sampleBytes = 0;
  let sampleCount = 0;
  let samplesFull = false;

  function load() {
    if (fs.existsSync(runsFile)) {
      for (const line of fs.readFileSync(runsFile, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          runs.push(JSON.parse(line));
        } catch (e) {
          // Ligne tronquée par une coupure d'alim en pleine écriture : on la
          // laisse tomber, tout le reste de l'historique reste bon.
        }
      }
    }
    if (fs.existsSync(overridesFile)) {
      try {
        const o = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
        overrides = { excluded: o.excluded || [], cells: o.cells || {}, sailRanges: o.sailRanges || [] };
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
      if (fs.existsSync(runsFile)) fs.unlinkSync(runsFile);
    }
    if (what === 'all' || what === 'samples') {
      if (fs.existsSync(samplesFile)) fs.unlinkSync(samplesFile);
      sampleBytes = 0;
      sampleCount = 0;
      samplesFull = false;
    }
    if (what === 'all' || what === 'overrides') {
      overrides = { excluded: [], cells: {}, sailRanges: [] };
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
    setExcluded,
    setCellOverride,
    setSailRange,
    clearSailRanges,
    reset,
    runs: () => runs,
    overrides: () => overrides,
    excluded: () => excludedSet,
    files: () => ({ runsFile, samplesFile, overridesFile }),
    diskInfo: () => ({
      sampleBytes,
      sampleCount,
      samplesFull,
      maxSampleBytes,
      runCount: runs.length,
      writeErrors,
      lastWriteError,
    }),
  };
}

module.exports = { createStore };
