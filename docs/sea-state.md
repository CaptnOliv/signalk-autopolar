[← README](../README.md)

# Sea state

Sea state moves a polar as much as a reef does — a boat loses the best part of
a knot in a short chop — but nobody types it in from a cockpit at three in the
morning. So it is **measured, not entered**: the peak-to-peak pitch over the
window, which is exactly what a wave does to a hull. It is stored raw on every
point, and turned into a word (calm / moderate / rough) only for display, with
configurable thresholds — the measurement never depends on today's opinion of
where "moderate" starts.

Two caveats. Pitch also depends on point of sail, so the index compares best
within a similar angle range. And routing software will not use it: the `.pol`
format has no sea-state dimension at all, and most routers apply a generic wave
penalty rather than your boat's. Which is precisely why it is worth recording —
so you can tell a flat-water polar from a rough-water one yourself, instead of
averaging them together without knowing.
