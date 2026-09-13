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

- **mean** (default) — what the boat does on average in those conditions;
- **median** — immune to a single wild measurement;
- **p90** / **max** — what the boat *can* do, closer to the classical idea of
  a polar (a performance envelope, not an average). Keep it for well-filled
  cells: over three measurements, the max is just the most flattering noise.
