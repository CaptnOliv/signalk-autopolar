# signalk-autopolar

Learns your boat's polar on its own, by watching the way she is actually
sailed. The more miles you put in, the better it gets — and you never have to
sail a single test run.

![The web app under way](docs/overview.png)

## Features

- 🔥 **Collects while you sail, no test runs.** A point is kept only when the
  boat is in one steady regime — which is not the same as demanding constant
  numbers. → [Why this one](docs/gate.md)
- 🔥 **Nothing is frozen at collection.** Every point carries SOG *and* STW,
  true *and* apparent wind, so all four polars are recomputed on demand from
  the same raw measurements. → [Why this one](docs/gate.md)
- 🔥 **The raw log is kept, not just the verdict.** Get the thresholds wrong for
  the day's sea state and you replay the file instead of sailing the passage
  again. → [Why this one](docs/gate.md)
- 🔥 **Never under engine, never at anchor.** Blunt on purpose: no evidence the
  engine is off, no collection — with a bounded manual declaration for boats
  with no engine data at all. And because engine data can be present, fresh and
  yet constant, one check that needs no sensor at all: a keelboat does not
  outrun the true wind upwind. → [Never under engine, never at
  anchor](docs/engine-detection.md)
- 🔥 **Tells you whether your speed sensor lies.** Current vs. a genuine
  calibration error, with a ready-to-use correction table for the Airmar
  DST810 and similar instruments. → [Is your speed sensor telling the
  truth?](docs/speedo.md)
- 🔥 **Leeway measured, and taken off the VMG.** Pointing 35° while sliding 8°
  sideways makes 43° over the ground. The gap between heading and course over
  ground is split into leeway (flips sign when you tack) and current plus
  compass error (does not), so the polar can be read against the track the boat
  actually makes. → [Leeway](docs/leeway.md)
- 🔥 **VMG targets with the cost of leaving them.** The neighbouring angles
  either side of the optimum, in knots and in percent, so you know whether
  holding the angle is worth it. → [VMG targets](docs/vmg.md)
- 🔥 **A live "where am I now" reading.** Your current angle and speed plotted
  on the polar, interpolated between measured wind bands, never extrapolated
  past them. → [Where you are right now](docs/live-reading.md)
- 🔥 **"Is it worth changing sail?"** — what the other sail plans actually did
  at this wind and this angle, with the evidence behind every row. →
  [Sail comparison](docs/sail-compare.md)
- 🔥 **Sail plan taggable after the fact.** Type the times you remember, or let
  the plugin suggest boundaries from steps in performance — corrections never
  touch the raw measurements. → [Fixing the sail plan after the
  fact](docs/sail-plan-history.md)
- 🔥 **Test rigs stay out of the way.** Sailing with the main down on purpose is
  a measurement, not a mistake: those points are kept and studied, and left out
  of the polar you route with and of everything shared. →
  [Sailing without a sail, on purpose](docs/test-rigs.md)
- 🔥 **Pausable.** A delivery, a tow, an afternoon of trim tests: one click and
  nothing is written — points *or* raw log, so a replay cannot bring it back. →
  [Pausing Autopolar](docs/pause.md)
- 🔥 **Sea state measured, not typed in.** Peak-to-peak pitch over the window,
  stored raw. → [Sea state](docs/sea-state.md)
- 🔥 **Drafts a polar from your server's history**, months before the plugin was
  even installed, through the same admission filter as a live point. →
  [Drafting a polar from the server history](docs/history-import.md)
- 🔥 **Exports and a direct hand-off.** `.pol`, Jieter text, CSV, JSON, raw
  `.jsonl`, and one click to push into
  [Polar Management](https://github.com/Asw1n/signalk-polar-management). →
  [Web app tour](docs/webapp.md), [Polar Management
  hand-off](docs/polar-management.md)
- 🔥 **Free, and the polar goes back into a shared pool** — automatically,
  every 500 points, no position ever collected, both speed readings and what
  is needed to tell them apart. → [Sharing your polar](docs/sharing.md)
- 🔥 **Tells you when it is stuck.** A ntfy alert if sailing goes on for 20 min
  with nothing kept, with the dominant rejection reasons. →
  [Idle alert](docs/idle-alert.md)

## Web app

`http://<server>:3000/@captnoliv/signalk-autopolar/` — live state, polar
diagram, VMG analysis, sail-plan filter, speed-sensor diagnostic, exports.
Full tour of every card: [docs/webapp.md](docs/webapp.md).

## Install

From the SignalK app store, or:

```bash
cd ~/.signalk
npm install @captnoliv/signalk-autopolar
sudo systemctl restart signalk
```

No dependencies: nothing to install on board, so no data used offshore.

Then open the plugin configuration and fill in the **boat model** and the
**name to publish under**. The plugin waits for them before collecting
anything — see [Sharing your polar](docs/sharing.md).

## Reference

- [Settings](docs/settings.md) — the plugin configuration, tier by tier
- [Data files](docs/data-files.md) — what lives in the plugin data directory
- [Is the polar any good yet?](docs/quality.md) — what makes a polar usable
- [Letting me know this install exists](docs/usage-ping.md) — the daily ping
- [Telling you a new version is out](docs/update-check.md) — the update check
- [Tests](docs/testing.md) — `npm test`, and a no-boat preview

## Supporting the plugin

Free, MIT, no account, no telemetry, no nag screen on startup. The web app
asks once the polar it built for you has actually become usable, at most
twice ever, never offline, as a banner and never a modal. Details:
[docs/support.md](docs/support.md).

★ [Star the repository](https://github.com/CaptnOliv/signalk-autopolar) ·
☕ [Buy me a coffee](https://ko-fi.com/captnoliv)

## Licence

MIT. Sharing is the deal, not a legal condition: no licence can compel you to
send data, and one that pretended to would just be ignored. The plugin asks
once, defaults to yes, and makes it effortless — that is the whole enforcement
mechanism.
