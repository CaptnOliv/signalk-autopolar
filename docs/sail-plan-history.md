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
