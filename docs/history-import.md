[← README](../README.md)

# Drafting a polar from the server history

If the server already keeps history — [signalk-history-sqlite][hsq],
signalk-to-influxdb2, or any other plugin that implements the
[Signal K History API][hapi] — then months of wind and speed may already be on
disk from before autopolar was ever installed. **Export & maintenance → Check
history data** reads it and tells you what it would give. Nothing is written
until you press the second button.

[hsq]: https://github.com/meri-imperiumi/signalk-history-sqlite
[hapi]: https://github.com/SignalK/specification

The points it produces are marked as drafts (`origin: "history"`), live in
their own file, and can be dropped in one click. Three rules make them safe to
mix with real measurements.

**The filter does not change.** Draft points go through the same
`lib/gate.js`, with the same thresholds, as a point recorded live. What differs
is the raw material, not the judgement passed on it. A separate "history mode"
filter would drift from the real one, and a cell of the polar would no longer
mean the same thing depending on where it came from.

**The degradation is measured, not assumed.** A history store aggregates into
time buckets, and asking for 60-second buckets would smooth away exactly the
scatter the filter exists to reject. So autopolar measures the resolution
instead of guessing it: it tries 1, 2, 3, 5 then 10-second buckets on the
busiest stretch of the range and keeps the finest one whose buckets come back
full. On a real store sampling at roughly 1 Hz this lands on 2 s — at 1 s more
than a quarter of the buckets are empty, and every window would break on a
hole. Two further guards follow from the same idea: below six readings per
window the import is **refused** (drift and scatter mean nothing on two
samples), and from 5 s upwards the bucket's own min/max are requested as well,
so the scatter the average erased is still there to be rejected.

Angles are read with `first`, never averaged. Dead downwind, the mean of +179°
and −179° is 0° — the measurement would come back inverted, and the point would
land close-hauled.

**A period the plugin watched itself is never overwritten.** The raw log says
which seconds autopolar has already seen at full rate; the import fills the
gaps and leaves the rest alone. Otherwise a smoothed reading could quietly
overturn a deliberate rejection.

## What it needs, and what it does without

Apparent wind angle, apparent wind speed and speed over ground are required.
`propulsion.<engine>.state` (or `.revolutions`) is required too, and this one is
not negotiable: without it nothing tells a sail from a motor leg after the
fact. There is no retroactive "trust me, I was sailing" — the declaration for
boats with no engine data at all (see [Never under engine, never at
anchor](engine-detection.md)) is bounded in time and expires, which is what
makes it acceptable; the same promise spread over three months of archive would
not be.

Engine state is often published only once a minute. The last known value is
therefore carried forward — **and backward**. If the engine starts at 10:36:00
and the next sample lands at 10:36:30, the half minute in between would look
like sailing, so every "running" reading is surrounded by a guard band the
width of the measured publishing interval. Same prudence as the live filter:
collecting one point under engine dirties the polar for good, missing one costs
only that point.

Everything else is a bonus. No speed through water: the SOG polar only, which
is [the honest axis anyway](speedo.md). No true wind: it is computed from the
apparent, as on any boat without a derived-data plugin. No heading or rate of
turn: manoeuvres are read from the wind angle alone — a tack shows as a change
of tack, and a turn that keeps the wind angle constant was never a criterion in
the first place. No attitude: sea state is not measured on those points, and
says so rather than carrying an invented number.

## It is drafted, not guessed

The count on the button is not an estimate. The check really builds the points
and then throws them away, so the number announced is the number written.

Draft points count in [the shared polar](sharing.md), and the payload says how
many of them there are — the collector can weight them or set them aside, but
they are never passed off as measurements taken live. A segmented control in
the web app hides them from the diagram without deleting anything, which is
how you see the polar of your own measurements alone.
