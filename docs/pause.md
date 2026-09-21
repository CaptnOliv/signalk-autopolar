[← README](../README.md)

# Pausing Autopolar

Some passages have nothing to teach the polar, and you know it before they
start. A delivery under a borrowed rig. A tow. A day of sail trim tests where
the point is to try things that do not work. An afternoon of showing a friend
how the boat handles, at the helm, badly.

The filter cannot see any of that. It checks the engine, the anchor, the
steadiness of wind and course — and a badly sailed boat in a steady breeze
passes every one of those checks. So there is a switch: **Pause recording**, in
the live card, above the sail plan selector.

## What a pause actually stops

Everything. Not just the polar points: **the raw log too**.

That is the whole design decision, and it is worth being explicit about.
Stopping only the points would have been easier, and it would have been a lie:
`runs.jsonl` is rebuilt from `samples.jsonl` whenever you replay the raw log or
change the gate settings, so anything left in the raw log comes back. A pause
that does not survive a replay is not a pause, it is a display filter.

Nothing is deleted either. A pause is about what gets written from now on; the
points you already have are untouched.

## Durations, and why they are offered first

The first click pauses for **one hour**, because the ordinary gesture is *stop,
I am fiddling with something*, not *let me pick a duration*. Once paused, the
banner offers **1 h**, **4 h** and **until I resume**, so the first click is
never a commitment.

"Until I resume" exists because a season of rig testing exists. But it is not
the default, and it should not be: the only real way to get a pause wrong is to
forget about it, sail beautifully for two days, and come home to an empty log.
A timed pause lifts itself — there is nothing to click on the way back.

The pause survives a restart of the SignalK server: restarting is not
resuming, and a plugin that quietly started recording again after a reboot
would be worse than one that stayed paused. A timed pause that expired while
the server was down does not come back.

## While paused

The state pill reads **paused — nothing is being recorded**, and the banner
stays put, in warning colours, for as long as the pause lasts. It never folds
away and never becomes discreet. The usual "data is coming in fine —
collecting will resume under sail" reassurance is suppressed, because while
paused it would be false, and a false reassurance is exactly what would send
you looking for the fault somewhere else.

## What it is not

It is not a way of keeping bad points out after the event — for that, see
[fixing the sail plan after the fact](sail-plan-history.md), which can exclude
a stretch you have already sailed.

It is not a way of sailing an unusual configuration on purpose and studying it
afterwards — for that, see [test rigs](test-rigs.md), which keep the points and
merely keep them out of the polar you route with.

Pause is for the passages you want no trace of at all.
