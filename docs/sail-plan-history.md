[← README](../README.md)

# Fixing the sail plan after the fact

You reef when the boat needs reefing, not when it suits an app. By the time you
remember the selector, an hour of points has already gone in under the wrong
label — and often you never remember at all. So the sail plan can be set on a
whole stretch of time, after the event, in two ways:

- **You remember roughly when.** Type the two times, pick the sail plan, apply.
  Nothing beats that when you know it.
- **You have no idea.** The plugin suggests boundaries. A sail change leaves a
  measurable trace: at the same wind and angle, the boat no longer goes at the
  same speed or sits at the same heel. It looks for *steps* in the gap between
  measured speed and what the polar predicts for those conditions — going
  through the residual, not raw speed, is what stops "we reefed" being confused
  with "the wind dropped". Long gaps in the record are flagged too: you rarely
  sail 45 minutes without a single point by accident.

![Sail plan over time](sail-plan.png)

Three limits, worth stating rather than discovering:

- it tells you **when** something changed, never **what**. Reef or furled
  genoa is your call;
- a change that did not affect performance is invisible by construction;
- a change at the same moment as a wind shift is confused with it. Hence the
  score on each suggestion, and the sensitivity control — the suggestions are
  candidates to review, never a verdict.

On a 15-hour passage with four known sail changes, the balanced setting found
three of them and offered two false candidates. That is the right order of
magnitude to expect: you glance at five timestamps instead of scrubbing 500
points. It also tends to be *earlier* than the label you set by hand, because
you label once things have settled and it sees the change itself.

Corrections live in `overrides.json`, beside the measurements and never inside
them. Replaying the raw log keeps them — which would not be true if the points
themselves had been rewritten, since a replay rebuilds them from the raw log
where the original label is stored.

A stretch you have corrected or confirmed stops asking for attention once it
is a few days old (configurable, `sailHistoryDays`) — the list is meant to grow
one open question at a time, not accumulate every decision ever made. Nothing
is deleted; a toggle in the web app brings the handled stretches back.

## Why "handled" is counted in points, not in minutes

Segment boundaries are not data, they are deductions: they come out of a
comparison against the polar, and the polar grows with every passage. A stretch
confirmed as `12:47 → 13:08` meets, three sails later, a segment cut at
`12:45 → 12:57` — the same measurements, two minutes earlier.

Matching those by the clock fails, and it fails silently in the worst
direction: the stored range no longer starts before the segment, so a stretch
that was settled comes back and asks again, for ever. Measured on the boat this
was written for: **24 of 31 stored ranges no longer matched any segment**, and
four stretches whose points were 100 % labelled were still on the list twelve
days later.

So a stretch counts as handled when this share of **its points** (90 % by
default, `sailHandledCoverage`) falls inside what you have already corrected or
confirmed — the union of them, since two "ok" clicks posted on two successive
cuts must add up. What the crew confirmed is that the label on those
*measurements* is right; the time range was only ever a way of pointing at
them.

Below the threshold the stretch stays on the list **and says what is missing**
("20 of 32 points already confirmed"). Hiding half a stretch nobody ever
labelled would be worse than asking again.

## Leaving a stretch out of the polar

Correcting a label is not always the answer. Some stretches carry the right
sail plan and are still worth nothing: the fifteen minutes it took to get the
reef in, a tow, a passage with a fouled prop, an afternoon of sail trim tests.
`ok` and `set…` both say *this label is right*; neither says *these
measurements should not count*.

So each stretch also has **exclude**. The points stay on the disk — nothing is
deleted, and `restore` puts them straight back — they simply stop being counted
in the polar, in the quality score and in what gets shared. The row dims and
the sail plan is struck through, because the one real way to get this wrong is
to forget you did it.

It is deliberately orthogonal to *corrected* and *confirmed*: a stretch can be
relabelled **and** excluded, which is exactly the case of a reef that took a
quarter of an hour. A partly excluded stretch says so ("6 of 32 points
excluded") rather than offering a `restore` that would put back more than you
ever took out.

The same points can also be excluded one by one from the polar diagram, by
unticking them in cell inspection. That works when you have already found the
offending cell; it does not, when what you know is *"Tuesday afternoon was
rubbish"*.
