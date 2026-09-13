[← README](../README.md)

# Is it worth changing sail?

The sail-plan filter can already draw one curve per configuration, but in
navigation that answers the wrong question. You do not want to know what the
polar looks like under one reef — you want to know what the *other* sail plans
did **here**, in this wind, at this angle, and whether the difference is worth
the manoeuvre.

So the card under the VMG targets groups the measurements in the neighbourhood
of where you are right now by sail plan, and shows the gap in knots against
what is rigged. The window is adjustable (±10° / ±20° / ±30° of angle, ±1 /
±2 / ±4 knots of wind): tighten it when you have plenty of data, widen it when
the table is thin.

![Change sails](./change-sail2.png)

It is an observation, not an experiment, and the table is built to say so:

- **Every row carries its evidence** — how many measurements, the wind it
  actually saw, the mean angle it actually sailed, and when it was last sailed.
  A row measured in 17 knots does not compare with one measured in 14, and you
  can see that without leaving the table.
- **Anything under three measurements sits below a line**, unranked. A single
  point can be the fastest row in the table without proving anything, and a
  short ranking looks confident precisely because it is short.
- **Speed only.** Whether one reef is worth taking for the comfort of the crew,
  the state of the sea or the night ahead is a sailor's call, not a number's.

Nothing is controlled here: those sail plans were not sailed at the same
moment, nor in the same sea, and nobody can replay the day with the other sail
up. The plugin gives you the measurements and their circumstances; the
judgement stays yours.
