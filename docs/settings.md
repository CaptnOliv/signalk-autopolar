[← README](../README.md)

# Settings

Everything lives in the plugin configuration, laid out in three tiers. **Data
sources**, at the top, lists the SignalK path read for each of SOG, STW,
apparent/true wind, heading, magnetic variation, rate of turn, navigation state
and attitude — the
defaults match a standard installation, so only touch this if your boat
publishes one of them somewhere else (a derived-data plugin under a different
key, a wind instrument with apparent wind only, and so on). The middle of the
page is the settings worth knowing about day to day: engine detection, ntfy,
sharing. **Advanced settings** and **Wind speed columns of the polar**, at the
bottom, hold the admission-filter thresholds and the polar grid — tuned
already, and grouped out of the way on purpose. The stability thresholds in
there are the ones worth understanding if you do go in: on autopilot, 10-15°
of heading variation; hand steering in a swell, more like 20-25°. When in
doubt, collect wide and **replay the raw log** afterwards with tighter
thresholds — the operation is reversible as many times as you like.

`sailHandledCoverage` decides when a sail-plan stretch counts as already dealt
with: segment boundaries move as the polar grows, so the match is made on the
stretch's points rather than on clock times. See [Fixing the sail plan after
the fact](sail-plan-history.md).

`variationPath` is only read when the true heading is missing: a raw magnetic
heading is off by the local variation, which would land whole in the leeway
measurement (course over ground minus heading). With the variation published,
the plugin applies it and the points count normally; without it, they are
dropped from the leeway analysis rather than silently corrected. See
[Leeway](leeway.md).

`publishPerformance` is left off until the polar has proved itself, and should
stay off if another polar plugin is installed: they would all write to the same
`performance.*` paths.

`historyProvider` and `historyResolutionS` only affect [drafting a polar from
the server history](history-import.md): which store is read, and whether to
override the resolution autopolar measures for itself. Neither reads anything
until you press the button.

`sailHistoryDays` controls how long a corrected or confirmed stretch in [Fixing
the sail plan after the fact](sail-plan-history.md) keeps showing before it
drops out of the list (2 days by default). Nothing is deleted — a toggle in the
web app brings the handled stretches back regardless of age.

`supportPrompt` controls the one banner described in [Supporting the
plugin](support.md). Off means it never appears. `usageStats` controls the
daily "this install exists" ping described in [Letting me know this install
exists](usage-ping.md); off means nothing counts your installation anywhere.
`checkForUpdates` controls the daily npm lookup described in [Telling you a new
version is out](update-check.md); off means the web app never mentions
versions.
