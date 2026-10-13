[← README](../README.md)

# Data files

In the plugin data directory (`~/.signalk/plugin-config-data/signalk-autopolar/`):

| file | contents |
|---|---|
| `samples-YYYY-MM.jsonl` | the raw log for the current month: all raw data under sail, 1 line/s, before the gate |
| `samples-YYYY-MM.jsonl.gz` | the raw log of a month that is over, gzipped |
| `runs.jsonl` | the accepted points (one condensed stable window each) |
| `overrides.json` | hand-made exclusions and overridden values |
| `history.jsonl` | the draft points read back from the server history store |
| `history.json` | what has been imported (range, resolution), and the cached live-coverage index |
| `sail.json` | the current sail plan |
| `declare.json` | the running "I am sailing" declaration, if any |
| `pause.json` | the running pause, if any — `{ since, until }`, `until: null` meaning "until I resume" |
| `share.json` | what has already been sent to the pool, and when |
| `usage.json` | the random install ID, and when the daily ping last went out |
| `support.json` | whether the star-and-coffee banner has been shown, and what was answered |
| `share-prompt.json` | same, for the banner that offers to put the polar in the pool |

Two fields are worth knowing about if you read those files by hand:

- `runs.jsonl` carries `hdgSrc` — where the heading came from: `true`,
  `variation` (magnetic, corrected with the published variation), or
  `magnetic` (raw). The leeway analysis drops the last kind rather than mixing
  two references in one corpus. Older lines have no such field and are read as
  true headings.
- the raw log carries `hs` only when the heading was **not** a true one.
  The raw log runs to about 15 MB per 30 h and a field repeated on every line
  to say "normal" would add 3 MB of nothing. Absent means `true`; that is the
  only implicit convention in the file.

All plain text, inspectable and repairable by hand from a cockpit with no
network — the closed months of the raw log through `zcat` or `gunzip`. A line
truncated by a power cut is skipped and the rest of the history stays usable.

## The raw log, one file per month

The raw log is split by **calendar month, in UTC**, taken from each line's own
timestamp `t` rather than from the clock at the time of writing:
`samples-2026-09.jsonl`. The current month is plain text, appended to every
second under sail. Once a month is over it is gzipped in the background
(`samples-2026-09.jsonl.gz`) — about six times smaller: 95 MB of raw log
became 15.5 MB on the author's boat. A month can briefly have both files; the
`.gz` holds the older lines and is read first.

To get the whole log back as one file, either download it from the web app
(**Export → raw `.jsonl`**: every month, in order, decompressed on the fly) or:

```bash
cd ~/.signalk/plugin-config-data/signalk-autopolar
zcat -f $(ls samples-*.jsonl* | sort) > all-samples.jsonl
```

**Size cap.** `maxSampleMB` (500 MB by default — roughly 4,000 hours of sailing
once compressed) counts what the raw log really takes on disk, compressed
months included. When it is reached, raw logging **stops** — points are still
collected, the web app shows `raw log … MB on disk (FULL — raw logging
stopped)` and the server log says so once. Compressing a month that has just
ended frees room, and logging picks up again on its own. If you would rather
keep logging at the cost of old data, turn on `dropOldestSamples`: whole
closed months are then deleted, oldest first, until the log fits again — never
the current month, and every deletion is written to the server log and listed
in the web app. Nothing is ever deleted without that option.

**Upgrading from a single `samples.jsonl`.** Versions before the split kept
everything in one `samples.jsonl`. On the first start after upgrading it is
split into monthly files in the background, without holding up the server:
every month is written to a temporary file, read back and counted (same number
of lines before and after), and only then are the new files put in place and
the old one deleted. A power cut at any moment is safe: at the next start the
plugin either finishes the job or starts it over, without losing or doubling a
line. Lines truncated by an earlier power cut are dropped on the way (they
were already skipped at every replay). Raw logging and replays carry on
normally while it runs. Taking a copy of `samples.jsonl` before upgrading
costs nothing and is still a good idea.

**Power cuts in general.** Every operation on the raw log (splitting,
compressing a month, deleting one for room) writes temporary `*.tmp` files
first, then a small `samples-commit.json` describing what to rename and
delete. If you find either after a crash, leave them: the next start finishes
or discards the operation.
