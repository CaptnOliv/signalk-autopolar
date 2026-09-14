[← README](../README.md)

# Data files

In the plugin data directory (`~/.signalk/plugin-config-data/signalk-autopolar/`):

| file | contents |
|---|---|
| `samples.jsonl` | all raw data under sail, 1 line/s, before the gate |
| `runs.jsonl` | the accepted points (one condensed stable window each) |
| `overrides.json` | hand-made exclusions and overridden values |
| `history.jsonl` | the draft points read back from the server history store |
| `history.json` | what has been imported (range, resolution), and the cached live-coverage index |
| `sail.json` | the current sail plan |
| `declare.json` | the running "I am sailing" declaration, if any |
| `share.json` | what has already been sent to the pool, and when |
| `usage.json` | the random install ID, and when the daily ping last went out |

Two fields are worth knowing about if you read those files by hand:

- `runs.jsonl` carries `hdgSrc` — where the heading came from: `true`,
  `variation` (magnetic, corrected with the published variation), or
  `magnetic` (raw). The leeway analysis drops the last kind rather than mixing
  two references in one corpus. Older lines have no such field and are read as
  true headings.
- `samples.jsonl` carries `hs` only when the heading was **not** a true one.
  The raw log runs to about 15 MB per 30 h and a field repeated on every line
  to say "normal" would add 3 MB of nothing. Absent means `true`; that is the
  only implicit convention in the file.

All plain text, inspectable and repairable by hand from a cockpit with no
network. A line truncated by a power cut is skipped and the rest of the history
stays usable.
