[← README](../README.md)

# Smoothing and the statistic per cell

## Smoothing

On a single passage a cell often holds only two or three measurements: the
curve comes out saw-toothed and a raw `.pol` would give erratic routing. The
smoothing (on by default, switchable) is a moving average over neighbouring
cells weighted by their sample count — a well-filled cell pulls its neighbours,
not the other way round. Nothing is invented: an empty cell stays empty, a
hand-overridden cell is left alone, and the measured value stays readable in
the tooltip ("measured …") and in the JSON export.

The curve is also **cut wherever there is a real hole**. Bridging one missing
5° cell is fair interpolation; drawing a straight line across 60° of nothing is
an invention that reads like a measurement. The gaps you see are the angles
still left to sail.

## Statistic per cell

- **median** (default) — the value a single bad point cannot move;
- **mean** — uses every measurement in the cell, and is moved by any of them;
- **p90** / **max** — what the boat *can* do, closer to the classical idea of
  a polar (a performance envelope, not an average). Keep it for well-filled
  cells: over three measurements, the max is just the most flattering noise.

**Why median and not mean.** On 1500 points from a real boat the two agree to
within 0.003 kn on the typical cell — there is no systematic bias either way,
so this is not about the polar being optimistic or pessimistic. But on one cell
in ten they differ by 0.25 kn, about 4 % of boat speed, and those are exactly
the cells where something happened: a surf down a wave, a gust, a window that
ended half a boat-length into a tack. The scatter inside a cell is the sea, not
a change in what the boat can do — so the honest summary is the one that does
not move when a point is wrong.

The other half of the argument is that a polar is read to plan a passage. The
median is *what you hold*, which is what an ETA needs. `p90` and `max` are the
builder's brochure, and they are one click away when that is what you want.

The shared pool has always used the median, for the same reasons. The web app
used to default to the mean, so the polar you looked at was not the polar you
sent; that is fixed.
