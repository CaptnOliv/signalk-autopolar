[← README](../README.md)

# Polar Management hand-off

[signalk-polar-management](https://github.com/Asw1n/signalk-polar-management)
stores, names and activates polar tables as a Signal K `polars` resource that
other apps consume. When it is running on the same server, autopolar's Export
card shows a **Send to Polar Management** button.

It hands over the current polar in the canonical
[polar-format](https://github.com/Asw1n/polar-format) document (SI units, TWS ×
TWA matrix, VMG targets) straight through the Signal K resources API — no file,
no copy-paste, no import step. It sends **the reading you have selected**,
defaulting to SOG against true wind — the axes a miscalibrated sensor cannot
falsify — and the confirmation message says which one went. Display *filters*
(sail plan, hidden points) do not follow: what is handed over is the boat's
polar, not a working view. You are the only one who knows whether your speed
sensor tells the truth, so the choice stays yours; it is simply never made
silently.

The polar lands under a **stable id** (`autopolar`, or `autopolar-<share name>`
when a share name is set), so every send **replaces** the previous one instead
of piling up dated copies. Pick it as the active polar once in Polar
Management; from then on, pressing the button keeps it current. Nothing else in
Polar Management is touched — your other stored polars and the active-polar
choice are left alone.
