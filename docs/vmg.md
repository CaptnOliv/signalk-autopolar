[← README](../README.md)

# VMG targets, and what leaving them costs

Best VMG is the angle that makes the most ground towards (or away from) the
wind, not the most knots. Knowing that angle is not enough, though: what you
actually steer is the shape of the curve around it. If luffing 10° costs 1 % of
VMG you will happily do it to take a gust or spare the crew; if it costs 8 %
you hold the angle. The two cases look alike on a polar diagram, so the plugin
tabulates the neighbouring angles either side of the optimum (±5° and ±10° by
default) with the VMG loss in knots and in percent.

![VMG](vmg.png)

## Two angles per target

Each target reads twice over:

```
42° at 5.89 kn   VMG 4.34
over ground 48° · VMG 3.92   (5.8° leeway)
```

The first line is what you steer. The second is where the boat actually ends
up, once the leeway it makes has been subtracted — and it is the one that
decides between pinching and footing, because it is the one that gets you to
the mark. On the boat this was written for, the honest upwind VMG runs 5 to 8 %
below the usual figure, and the gap widens the harder you pinch: leeway grows
from 4.1° at 48° off the wind to 6.8° at 32°.

The second line only appears once leeway has actually been measured, on both
tacks, and separated from the current — see [Leeway](leeway.md). Guessing it
would be worse than leaving it out, because it would look measured.
