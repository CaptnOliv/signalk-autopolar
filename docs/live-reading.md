[← README](../README.md)

# Where you are right now

The rest of the app looks backwards: what the boat has already done. This part
looks at now — and it is the only part you steer by, so it fits on one line.

Switch **Where I am now** on (it is on by default) and the diagram gets a
marker at your current angle and speed, with the last few minutes trailing
behind it: a sailing boat is never *on* a point, it swings around one, and
seeing the cloud stops you steering to an oscillation. A dashed marker sits on
the curve at the same angle, and the line between the two is the whole point —
short is good, long is a question worth asking.

![The web app under way](docs/where-am-i.jpg)

Underneath, in words:

```
NOW  7.31 kn SOG  at 116° TWA · starboard  in 16.0 kn TWS   96% of the mean polar · −0.30 kn
Polar here: 7.61 kn — from 14 kn (n=6) + 16 kn (n=18) · VMG 3.26 downwind
```

Three things are deliberate here.

**The reference is the curve you are looking at.** Same speed (SOG / STW / STW
corrected), same wind, same statistic. Comparing a SOG measurement against an
STW curve would be wrong by around 10 % on a boat whose sensor over-reads, and
nothing on screen would say so.

**It is interpolated between measured wind bands, never extrapolated past
them.** Half a knot of wind should not move the target half a knot. But where
you have never sailed, it says **new ground** instead of stretching a
neighbouring cell across the gap — and that is the useful answer: it tells you
where the polar still has a hole.

**There is no red.** The reference is a mean, so being under it happens half
the time by definition; that is an average, not a fault. The percentage always
says which statistic it is comparing against — switch **Value** to `p90` if you
want to measure yourself against your better runs instead.

The VMG target for the wind band is added when, and only when, you are within
30° of it. On a reach you are not trying to go upwind or downwind, you are
trying to get somewhere: showing "3 knots of VMG lost" against a dead-downwind
optimum would be noise on a course you are holding on purpose.
