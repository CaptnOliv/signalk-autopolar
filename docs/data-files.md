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

All plain text, inspectable and repairable by hand from a cockpit with no
network. A line truncated by a power cut is skipped and the rest of the history
stays usable.
