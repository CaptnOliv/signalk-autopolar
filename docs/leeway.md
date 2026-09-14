[← README](../README.md)

# Leeway, and why 35° off the wind can be worth less than 45°

Pointing high is not the same as going high. A boat that holds 35° off the
true wind while sliding 8° sideways is making 43° over the ground — and a boat
that holds 42° with 4° of leeway is making 46°, at a speed that is very likely
higher. On the water the first one *feels* better. On the chart, after two
hours, there is often nothing in it.

Every polar recorder measures the first number. This one measures both.

## The measurement already existed

Every collected point carries the heading and the course over ground. The gap
between them is what the boat does not do:

```
offset = COG − HDG
```

Nothing new is collected. This is one more reading of the same points, exactly
like the four polars (SOG/STW × true/apparent wind) are four readings of the
same measurements.

## Except that gap is not leeway

It mixes three things, and only one of them belongs to the boat:

| Cause | Behaviour | Belongs to |
|---|---|---|
| **Leeway** | perpendicular to the keel, so it **flips sign when you tack** | the boat |
| **Current** | fixed in the earth frame, so it pushes the same way on both tacks | the place |
| **Compass error** | deviation, alignment, variation not applied — a constant | the installation |

Which gives the only separation that works, and it needs both tacks:

```
leeway = (offset on port − offset on starboard) / 2      ← the boat
bias   = (offset on port + offset on starboard) / 2      ← the place, and the compass
```

Over a long enough corpus the current cancels itself (it turns, you move on)
and the bias converges towards the compass error. That is what makes the
leeway figure portable from one boat to another — and it is why **the leeway
is shared with the pool and the bias never is**: the bias describes where you
sail, not what your boat does.

With only one tack, a 5° leeway and a 5° current are the same number. The
plugin says so and corrects nothing.

## What it looks like on a real boat

From 1500 points on an Oceanis 48, over two months:

| Wind angle | port tack | starboard | leeway | heel |
|---|---|---|---|---|
| 30–50° | +3.8° | −6.5° | **5.1° ± 0.2** | 11° |
| 50–70° | +5.2° | −4.6° | **4.9° ± 0.3** | 7° |
| 70–100° | +1.5° | −1.1° | **1.3° ± 0.2** | 13° |
| 100–140° | −1.4° | −0.8° | −0.3° ± 0.1 | 5° |
| 140–180° | −2.3° | −0.4° | −0.9° ± 0.1 | 3° |

The sign flips with the tack close-hauled, the amount fades as you bear away,
and downwind it is zero within noise — which is exactly what leeway is
supposed to do, and the reason to believe the figure. What does *not* flip
(−1.1° here) is current plus compass, and it is subtracted before anything
else happens.

Measured against wind angle, the same data says the thing that matters:

| TWA steered | 32° | 38° | 42° | 48° | 58° |
|---|---|---|---|---|---|
| leeway | 6.8° | 6.5° | 5.8° | 4.1° | 5.4° |
| track over ground | 39° | 44° | 48° | 52° | 63° |

**The boat grips better as it goes faster.** Pinching costs speed *and* costs
grip, and only the second half of that sentence is invisible on an ordinary
polar.

## What the plugin does with it

- **VMG targets carry both angles.** Every target reads `42° at 5.9 kn, VMG
  4.34 → over ground 48°, VMG 3.92`. On this boat the honest upwind VMG is 5
  to 8 % below the figure everyone else prints.
- **A `Wind angle` switch** redraws the whole polar against the track actually
  made — same points, same speeds, angles reread. The best-VMG cell moves one
  bin open, and the card tells you which angle to steer to get it.
- **The live reading** shows the ground VMG next to the other one, under way.
- **Nothing is rewritten on disk.** Ever. The raw log keeps the measurement;
  the correction is a projection, undone by clicking the other button.

## When it is not available

The switch does not appear, rather than appearing and doing nothing:

- **No compass on the bus.** Leeway is COG minus HDG; without a heading there
  is nothing to subtract. The polar stays exactly as it was — which is what
  every other recorder gives you anyway.
- **Only one tack so far**, or too little sailing close-hauled (downwind there
  is nothing to measure).
- **The two tacks disagree** — the gap does not flip the way leeway must.
  Usually a current that turned during the passage, or a heading that is not
  what it claims to be. Nothing is corrected.
- **A raw magnetic heading with no variation published.** Those points are
  dropped, not silently corrected: the local variation would land whole in the
  leeway. Publishing `navigation.magneticVariation` brings them back, and the
  plugin applies it itself.

Above 25° of offset the point is dropped too. That is not leeway any more —
that is a tack caught inside the window, or a GPS that lost its fix.

## The naming trap

`lib/gate.js` already uses *drift* for something else entirely: the way a
measurement wanders across the collection window (the end of the window no
longer being the beginning), which is what disqualifies a point. The sideways
kind is called **leeway** everywhere in the code, and lives in
`lib/leeway.js`.
