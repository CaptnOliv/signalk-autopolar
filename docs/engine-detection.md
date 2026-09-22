[← README](../README.md)

# Never under engine, never at anchor

A polar describes what the sails do. One hour of motoring folded into it lifts
every number and there is no way to tell afterwards which points were honest.
So the rule is deliberately blunt: **no evidence that the engine is off, no
collection.** The plugin would rather record nothing than record something
wrong.

## What counts as evidence

Two standard SignalK paths, either of which is enough:

| path | what it is |
|---|---|
| `propulsion.<engine>.state` | `started` / `stopped` |
| `propulsion.<engine>.revolutions` | any non-zero value means the engine is turning |

**`state` is preferred**, for a simple reason: it answers the question
directly and cannot be ambiguous. `revolutions` is only ever read as a
yes/no — anything other than zero means the engine is running — so it makes
no difference what unit the gateway sends it in or how it is scaled. When both
paths are present and they disagree, the plugin assumes the engine is
*running*. Losing one point costs one point; letting a motoring point into the
polar costs the polar.

If you have several engines, any one of them running is enough to stop
collection.

## When the engine data is present, fresh — and says nothing

Everything above believes the boat. That is the right default: `state` and
`revolutions` answer the question directly. But they also answer it when they
know nothing. A gateway that publishes `stopped` because its discrete-status
field was never wired, or a `revolutions` path that reads zero because there is
no tacho input behind it, is indistinguishable from an engine that really is
off — in any single snapshot.

It is not a theoretical worry. Two of the first polars shared to the common
pool carried whole wind bands of engine while reporting the *strongest* kind of
evidence: `state` on 995 of 1000 points for one, `revolutions` on all 3500 for
the other. Both sailed upwind at more than 1.25× the true wind in light air,
which no keelboat does under sail.

So the plugin does two things about it, neither of which second-guesses your
instruments:

**It watches what your sensor is capable of saying.** Over the life of the
install, has this signal *ever* reported the engine running? The counter is
persisted, and it counts engine-data time rather than uptime. If ten hours of
engine data have gone by without a single "running", the web app says so in the
Engine tile — a reading that never changes is not a measurement. It is
deliberately phrased as a doubt, because the innocent explanation ("I have not
started the engine in three weeks") is a real one, and no measurement can tell
the two apart. The answer travels with your shared polar, as `engineWitness`,
so the pool can read a table the same way you do.

**And it checks the physics, which needs no sensor at all.** Below 70° of true
wind angle, a keelboat does not outrun the true wind. A point that does is
refused, whatever the engine data says, with the reason `faster than the true
wind, close-hauled`. The raw log keeps it, so a replay can always revisit the
call, and `maxUpwindSpeedRatio: 0` switches the rule off for boats that really
do exceed it — foilers. Getting it wrong costs one point; not having it costs
the polar, and the common pool with it.

Points already recorded before this existed are not left alone either: the web
app shows what it finds in your own log and offers to **exclude** them — kept
on disk, out of the polar, reversible, and a fresh copy is shared straight away
so the pool gets the corrected table rather than waiting for the next 500
points.

## Do I need the autostate plugin? No.

`signalk-autostate` is a fine plugin, but it will not solve this problem,
because **it reads the same two paths** — `propulsion.*.state` and
`propulsion.*.revolutions`. On a boat with no engine data it does not deduce
anything: it answers with the fixed value you set in its own configuration,
`default_propulsion`, which ships as `sailing`. Installing it on an engineless
data setup would therefore declare "sailing" all day, motoring included, and
quietly poison your polar. That is worse than collecting nothing.

Where it does help is as a **safety net for boats that already have engine
data**. If your engine feed dies mid-passage — a bridge that drops, a NMEA
device that stops talking — autostate keeps reporting the last state it knew.
Die under sail and it stays on `sailing`, so the passage is not lost; die under
engine and it stays on `motoring`, so nothing is collected. It errs on the safe
side in both directions. This plugin uses that as a last resort only, and only
if it has seen real engine data at least once during the session — otherwise
"sailing" would mean "no idea". Points collected that way are tagged
`engineSource: "autostate"` and stay filterable afterwards.

## My boat has no engine data at all

Then by default nothing is collected, and the web app says `engine state
unknown` rather than pretend. That is the honest outcome — but it is fixable,
usually cheaply. **You do not need a tachometer, only a signal that says
*running*.** An oil-pressure switch, the alternator's D+ terminal or the
ignition line, wired to any input that can publish
`propulsion.<engine>.state`, is enough. That one boolean unlocks everything,
permanently.

Until then, you can say it yourself: the web app offers a **"I am sailing"
declaration**, good for 90 minutes and renewable. It is the only place where
the plugin takes a human's word for it, so it is bounded in two ways. The
declaration expires on its own — forgetting to renew it costs you a few points,
and there is no way to forget to switch it off and quietly feed an hour of
motoring into your polar. And every point recorded that way is tagged
`engineSource: "declared"`, stays filterable, and is **left out of any polar
you share**: nobody else can check a declaration.

## At anchor and alongside

`navigation.state` set to `anchored` or `moored` also blocks collection — but
only if boat speed agrees. That state is often minutes behind reality, and a
boat clearly making way is not moored whatever the flag says.

## One setting to know about: slow engine data

Wind and boat speed arrive several times a second off the NMEA 2000 bus. Engine
data often does not: bridged over MQTT from a Cerbo GX, for instance, it lands
**once a minute**. Judged by the same freshness rule as the rest, the engine
would read "unknown" 54 seconds out of every 60 and nothing would ever be
collected. Hence a separate `engineStaleMs`, 180 seconds by default. If your
engine feed is slow, that is the first setting to look at.
