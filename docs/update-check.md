[← README](../README.md)

# Telling you a new version is out

The SignalK Appstore already shows plugin updates. Nobody opens it without a
reason — on the installs that ping the collector, close to half were running a
version behind. The web app, on the other hand, is open while you sail.

So once a day the plugin asks the npm registry — the same place the Appstore
installs from — what the latest published version is, and shows one discreet
line at the top of the web app if you are behind. One line, never a banner,
never a modal, and it never updates anything by itself: installing stays a
decision you make in the Appstore, at a moment that suits you.

This has nothing in common with the install ping (see [Letting me know this
install exists](usage-ping.md)), and the difference is the whole point. The
ping carries a persistent identifier and buys you nothing, so it has to be
enumerated field by field and stay switchable. This is a plain `GET`: no body,
no identifier, nothing about you or your boat, and the only person it serves is
the one who triggered it. The package name comes from the plugin's own
`package.json`, so a fork asks about itself, not about me.

Offline it gives up quietly. No "update check failed", no red dot: at sea,
having no network is the normal state, not an incident. 