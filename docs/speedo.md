[← README](../README.md)

# Is your speed sensor telling the truth?

Speed through the water and speed over ground almost never agree. The gap has
two very different causes, they call for opposite responses, and they decide
which of the two polars is worth exporting.

**Current.** The gap is the set you are carrying. Nothing is wrong with the
sensor, and **STW is the axis to trust**: it describes the boat moving through
the water her sails are actually working in. SOG, carrying the set with it, is
not a property of the boat at all.

**A sensor error.** The paddlewheel reads high or low. The gap then lies along
the hull's fore-and-aft axis and grows with boat speed. Here **SOG is the axis
to trust** — provided there is not much current.

![Speed sensor check](speed-sensor.png)

## What actually separates them

The textbook answer is that current is fixed in the earth frame while a sensor
error is fixed in the boat frame. That is true instant by instant, and it is
the basis of the first test the plugin runs — but on its own it is not enough,
and it is worth being honest about why:

- **Current is not one vector for a whole passage.** It turns with the tide, it
  accelerates round headlands and through narrows and estuaries, and it changes
  with the hour of the day. Fifteen hours of sailing may have carried three
  different sets. The direction test needs a stretch over which the current can
  reasonably be treated as steady, and legs on genuinely different headings.
- **Leeway also lies in the boat frame.** The water track is drawn along the
  heading, but the boat crabs a few degrees to leeward. On a passage sailed
  mostly on one tack that consistent sideways offset can look like a fixed
  boat-frame vector and flatter the "sensor" verdict. It is athwartships rather
  than fore-and-aft, which is why the test measures concentration rather than a
  bearing — but it is a reason not to lean on this test alone.
- **A compass error** rotates the water track, and with it the implied current,
  without changing its length at all.

So the plugin runs a second test that ignores direction entirely:

> **Does the gap grow with boat speed?** A current sets you by roughly the same
> number of knots whether you are making three or nine. A scale error in the
> sensor offsets you *in proportion* to your speed. Both models are fitted to
> your own points and compared, and the better fit wins.

This one still works on a single tack, which is often all a passage gives you.
When the two tests agree the verdict is solid. When they disagree, or when
neither has enough variety to speak, the plugin says so instead of picking one.

## The test you can run yourself, and it beats both

**A sensor error is permanent. Current is not.** Sail the same water on the
opposite tide and a current reverses; a paddlewheel that reads 10 % high reads
10 % high on every passage, in every sea, for ever. That is the real proof, and
no single outing can provide it.

Which is why every point is kept. Collect over several passages, in different
places and at different states of the tide, and look at whether the discrepancy
keeps the same shape. If it does, it is the sensor. If it comes and goes with
the water you were in, it was the water — and your sensor was fine all along.

## The correction table

Permanent does not mean constant. On the boat this plugin was written for, the
error runs from about 2 % at 2.5 kn to 14 % at 10 kn. A single calibration
figure would be wrong nearly everywhere, which is exactly why speed sensors
such as the Airmar DST810 offer a multi-point calibration table rather than one
number.

When the verdict points at the sensor you get:

- a **CSV correction table** from 1 to 10 kn — indicated speed, measured real
  speed, factor and error — in the shape the DST810's advanced speed
  calibration table expects. Speed bands you have never sailed are left blank
  rather than invented;
- a fourth boat-speed reading in the diagram, **STW corrected**, so you can
  check that the corrected curve falls on the SOG curve.

Two honest caveats before you type anything into an instrument. The table is
only as good as the assumption that nothing else moved the water while you
collected it, so it deserves several passages behind it. And the DST810's
advanced table has a heel axis as well as a speed axis: this export fills the
speed axis only. Points do carry heel, but splitting them by heel as well
would leave too few measurements in each cell to be worth trusting.

Nothing here ever rewrites a measurement. The corrected polar is one more
reading of the same raw data, alongside the other three.

## True wind

Read from `environment.wind.angleTrueWater` / `speedTrue` when the server
publishes them (`signalk-derived-data` does): source priorities and leeway are
already resolved there, and two diverging truths help nobody. Only otherwise
is it recomputed from apparent wind and boat speed. The web app says which
source is in use.

The **AWS/AWA** polar is a direct anemometer measurement — it depends on
neither speed-sensor nor compass calibration. The **TWS/TWA** polar is a
computation: if STW or the compass are out, it is wrong *consistently*.
Comparing the two in the web app is a calibration diagnostic as much as a
performance reading.
