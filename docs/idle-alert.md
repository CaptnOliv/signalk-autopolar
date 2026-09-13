[← README](../README.md)

# Idle alert (ntfy)

The real risk with this plugin is not that it crashes — it is that it runs
quietly refusing everything, and you find out 30 h later on the dock. A
threshold too tight for the day's sea state shows up in no other way.

After `idleAlertMin` minutes **actually spent sailing** without a single point
being kept (20 min by default), a notification goes out over ntfy with the
dominant rejection reasons — usually enough to know which threshold to relax.
The counter follows sailing time, not wall-clock time: a night at anchor
triggers nothing.

A failed send — no Internet offshore, satellite link down — is queued and
retried until delivered, never silently dropped. The queue is flushed on every
tick, independently of what the gate decides about the current sailing, so it
still drains once you are back at anchor and the network returns. Recovery is
only announced if an alert had genuinely gone out.

Set `ntfyUrl` (topic included) and, if your server needs one, `ntfyToken` in
the plugin configuration. Leave `ntfyUrl` empty to disable the whole thing.
