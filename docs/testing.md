[← README](../README.md)

# Tests

```bash
npm test
```

`geom` (circular statistics, true wind), `gate` (the admission filter, case by
case), `polar` (binning, statistics, smoothing, exclusions, VMG neighbourhood,
sail filter, exports), `now` (the live reading interpolates between measured
wind bands, refuses to extrapolate past them, and the sail comparison groups
only the neighbourhood — ignoring the sail filter, which would empty the very
question it answers), `speedo` (synthetic worlds where the answer is known:
pure sensor error, pure current, single tack, and the check that correcting a
lying sensor's STW recovers SOG), `sailchange` (a known step is found where it
happened, noise alone triggers nothing, and a retro-fitted sail plan moves the
right points), `notify` (the alert fires once, recovery is announced once, and
a queued alert still gets out at anchor), `share` (nothing leaves the boat
without consent and a boat identity, one send per threshold, and a failed send
is retried rather than lost), `usage` (the daily ping cannot grow a field
without the configuration text growing with it, nothing goes out in the first
hour, and the install ID survives a restart), `update` (a pre-release is never
offered, a scoped package name is escaped so the registry does not answer 404
forever in silence, and being offline leaves the last known answer standing
instead of raising an alarm), `habits` (a point falls in exactly one point of
sail whichever tack it is on, and no attitude sensor means no heel line rather
than a 0° that would pass for a measurement), `history` (angles are never
averaged, the engine guard band works in both directions, the resolution is
measured on a store whose 1-second buckets are one-third empty, and an
already-watched period is left alone) and `smoke` — which runs the whole plugin
against a fake SignalK server over a simulated passage: starboard beat, tack,
port beat, then a leg under engine. It checks that points come out of the
steady legs, that none comes out of the tack or the engine leg, and that
replaying the raw log gives the same result back. It then plugs a fake history
store into the same running instance and checks the four properties that make a
draft harmless: it lands in its own file, a replay of the raw log does not wipe
it, a period already watched live is not re-imported, and the points stay
recognisable, filterable and counted in the share. The smoke test also asserts
that **no HTTP request whatsoever** goes out during a test run: a `npm test`
must never land in the collector's counter.

The collector that receives shared polars lives in its own repository, with its
own tests.

Preview the web app with no boat and no server:

```bash
node test/preview.js   # http://localhost:8099/plugins/signalk-autopolar/
```

The preview shares its polar, so the banner that offers to put it in the pool
never shows there — which is precisely the thing you want to look at when you
change it. Start it in the state the banner is written for:

```bash
PREVIEW_ASK=off node test/preview.js            # sharing switched off
PREVIEW_ASK=unconfigured node test/preview.js   # no boat model, no name
```

The preview's fake server answers `savePluginOptions` like the real one, so the
banner's **Share my polar** button really does write a configuration and really
does send the polar — to `/dev/collect`, on the preview itself, never to the
pool.
