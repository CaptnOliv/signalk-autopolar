[← README](../README.md)

# Web app

`http://<server>:3000/@captnoliv/signalk-autopolar/` — SignalK mounts `public/`
under the package name; `/plugins/signalk-autopolar/` is reserved for plugin
metadata and serves only the API (`/api/...`).

- **Live state** — recording or not, and exactly why; progress of the current
  window; every input with its freshness and age.
- **Sail plan** — a manual selector attached to the recorded points. Main:
  full, 1 / 2 / 3 reefs. Headsail (one at a time): genoa or jib, each
  full / 1 reef / 2 reefs / furled, or gennaker — the reef selector disappears
  for the gennaker, which does not reef. Optional. Changing it flushes the
  current window, which described a different boat.
- **Sail-plan filter** — built from the combinations you have *actually*
  sailed, with their point counts. This is what makes the tagging worth doing:
  "full main + genoa" against "one reef + genoa" at the same wind and angle is
  a directly readable answer.
- **Diagram** — up to 5 wind speeds at once (beyond that neighbouring curves
  stop being distinguishable; the table takes over), tacks merged or split
  (port/starboard asymmetry shows up immediately), a second polar overlaid for
  comparison, raw scatter underneath.
- **Inspect** — click a cell: the scatter of the measurements behind it, each
  timestamped with its sail plan, exclusion by checkbox, or a hand-set value.
  Edits live in `overrides.json`, separate from the measurements: no correction
  ever destroys data.
- **Where I am now** — your position on the polar, live, with the gap to the
  curve at that angle. See [Where you are right now](live-reading.md). Switch
  it off when you are analysing at anchor, where "now" means nothing.
- **Worth changing sail?** — what the other sail plans did in this wind at this
  angle, with the evidence behind each row. See
  [Is it worth changing sail?](sail-compare.md).
- **How you sail** — where your points actually come from: the split by point
  of sail and by wind strength, the tack balance, the hours of sailing kept,
  median and best speed, heel, how much of it was after dark. It is there
  because half an empty diagram is almost never a collection problem — it is
  the sailing you did, and no threshold will fill it in. Read it next to the
  quality band: that one says which cells are missing, this one says why.
  These are the *kept* points, not your logbook: engine time, manoeuvres and
  time at anchor never entered.
- **Export** — `.pol` (qtVlm, OpenCPN, Expedition), Jieter text (semicolon
  matrix with VMG target rows, the format the ORC world and Polar Management
  read), CSV with the sample count per cell, full JSON backup, and the raw
  `.jsonl`. **Send to Polar Management** appears when that plugin is installed
  on the same server — see [Polar Management hand-off](polar-management.md).

  **What is in the file is what the diagram shows** — SOG or STW, true or
  apparent wind, mean or median, smoothed or raw, sail-plan filter included.
  There is no fixed answer to "is this polar in SOG or STW?"; it is whichever
  button was pressed. That matters: on a boat whose paddlewheel over-reads by
  10 %, the same polar exported twice five minutes apart gives two files that
  look identical and differ by 10 %. So the card spells out the current
  projection above the buttons, the file name repeats it
  (`Jazzy-sog-true-mean.pol`), and the CSV and Jieter files carry it as a
  header comment. The `.pol` does not — the format is a bare matrix read by
  third-party routers that expect no comment line. The JSON backup has no
  projection at all: it is the raw data.

  The one place nothing is chosen for you is the automatic share (see
  [Sharing your polar](sharing.md)), which is fixed to SOG / true wind / median
  so that polars from different boats can be compared.
