[← README](../README.md)

# Why this one

Existing polar recorders take too much on trust. Four decisions set this one
apart.

## 1. A point is kept only on one single regime — which is not the same as a constant one

A sailing boat never holds a course, a speed and a wind steady for 60 s: the
sea rolls her, gusts fire her up, the pilot hunts. Demanding steadiness would
collect nothing at all, or collect only in flat calm — precisely where a polar
learns nothing.

So what invalidates a point is not that the numbers *move*, it is that they
*go away*. The gate separates the two:

- **drift** — the mean of the last third of the window minus the mean of the
  first third. If the point of sail, the wind strength or the boat speed has
  drifted, the end of the window no longer describes the same boat as the
  start: rejected.
- **spread** — the swing around that mean. Tolerated generously (±22° of
  apparent wind angle, ±4 kn of wind, ±1.25 kn of boat speed by default), and
  it is exactly what gets averaged. The ceilings are guard rails only: past
  them nothing is being measured any more (a wind that really is all over the
  place, a run of surfs).

**The masthead swing is averaged out before the apparent wind is judged.**
Downwind in a swell the wind vane measures its own motion as well as the wind:
the masthead sweeps several metres with every roll. Measured over 70 h of raw
log, that motion is worth about 2.4 kn sideways *whatever the wind strength* —
the signature of a sensor that moves, not of a wind that wanders — so it is
±10° in 16 kn of apparent wind and ±50° in 7 kn. Read raw, it rejected 98 % of
the minutes sailed between 140° and 160° true, and showed a gybe a minute dead
downwind. The tack test and the spread ceiling therefore look at the apparent
wind averaged over one roll period (`awaSmoothS`, 5 s by default): a running
average cancels a swing only when it lasts a full period, so shorter leaves
part of it and longer adds nothing. The recorded point is still the mean of the
raw readings over the whole window.

**The window slides, it is not flushed.** One second out of bounds does not
cost you the previous 59: as soon as it drops off the far end, the window
becomes valid again on its own. Only a manoeuvre justifies throwing the lot
away — a tack does not "leave" the window, it cuts it into two different
regimes.

Every point carries a **confidence score** (`quality`, 0 to 1) saying how calm
the window was relative to the tolerated ceilings, so you can keep only the
best measurements later without collecting again.

And the gate always says **why** it refuses, live in the web app, with drift
and spread shown side by side.

## 2. The raw data is kept

Everything seen under sail is written second by second to `samples.jsonl`,
*before* the gate. If the thresholds turn out to be wrong for the day's sea
state, you replay the file ("Replay the raw log") instead of sailing the
passage again. About 15 MB per 30 h.

## 3. Nothing is frozen at collection time

Every point carries SOG *and* STW, true *and* apparent wind. The four polars
(SOG|STW × true|apparent) are four readings of the same measurements,
recomputed on demand — as are the choice of statistic, the bin widths, and the
tack and sail-plan filters.

## 4. It tells you whether to believe your speed sensor

See [Is your speed sensor telling the truth?](speedo.md) — this is what
decides which of the SOG and STW curves is the trustworthy one, and most
recorders never ask the question.
