[← README](../README.md)

# Letting me know this install exists

There is no honest way to find out whether anyone is running a SignalK plugin.
npm download is not reliable. The collector only ever sees the boats that share
a polar.

So, once a day, the plugin says that it exists. It sends this and nothing else:

| field | why |
|---|---|
| a random ID | drawn once on this install, tied to nothing — not your boat name, not your hardware, not your network. Without it the count would be based on IP addresses, which over CGNAT satellite links means nothing at all |
| plugin version | so I know which versions are actually out there before breaking anything |
| Node and SignalK versions | same reason |
| the date the ID was drawn | to tell a new install from an old one |
| where sharing stands — `on`, `off` or `unconfigured` | the only way to know how many people keep the plugin but decline the pool. It used to be a yes/no, which could not tell *"I switched it off"* from *"I never filled the form in"* — and those are not the same person. The first made a decision; the second was never really shown the question, and is running a plugin that collects nothing at all |

No position. No boat name. No polar. **No IP address is kept by the server.**
The exact payload is readable at any time in the web app, under Share → *See
exactly what that ping contains*, and served raw at `/api/usage.json`.

One more thing this ID also does: it travels with a shared polar as its key.
The boat name alone could not do that job — two Oceanis 48 whose owners both
typed "Jazzy" used to overwrite each other's polar in the pool, in silence, and
renaming your boat left an orphan copy behind instead of replacing your own.
Turning the ping off stops the daily ping, not that key.
