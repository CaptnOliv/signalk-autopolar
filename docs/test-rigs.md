[← README](../README.md)

# Sailing without a sail, on purpose

Nobody sails without a mainsail by accident. You do it to find out something:
how she balances under genoa alone, whether the gennaker is worth setting at
that angle, what the boat does with the main down while you sort out a
halyard.

Those are real measurements, and they are worth keeping. They are also exactly
the measurements that must not end up in the table you route with — an
afternoon under genoa alone will hollow out a wind band for good, and the
polar will quietly promise a boat speed you can only hit with the main up.

## "none" is not "not set"

The sail plan selector has always had a **—** entry. It means *nobody put a
label on these points*, which is the state of the overwhelming majority of
points on any boat, and it permits no conclusion whatsoever.

Alongside it there is now **no main** and **no headsail**. These mean something
quite different: *there is no mainsail up*. That is a statement about the boat,
not about your record keeping, and it is enough to act on.

The distinction carries the whole feature. Treating a blank label as "no sail"
would have thrown out nearly every point ever collected.

## What happens to those points

They are collected exactly like any others: recorded, stored, counted on the
disk, visible in the raw log. What changes is that they are left out of:

- the polar diagram and its curve;
- the quality score, the VMG targets and "where am I now";
- every export;
- **what gets shared** — always, with no setting able to override it. The pool
  receives the polar of your boat, not the polar of your test weekend.

## Looking at them anyway

That was the other half of the point: keeping the data out of the way is only
useful if you can still study it.

Two ways, and the second is not a setting:

- **Test rigs → included**, in the controls. The group only appears once you
  have actually sailed one, and it brings them back into the curve alongside
  everything else.
- **Pick that sail plan in the filter.** Asking explicitly to see "no main +
  genoa" *is* asking to see it, so the exclusion lifts itself for that query.
  Without that, selecting it would have returned an empty diagram, which would
  read as a bug and be unbearable.

In the filter, a test configuration is drawn with a dashed border. Not because
it is wrong — it is a deliberate measurement set aside — but because clicking a
chip and getting a count that matches nothing else on the page sends you
hunting for an error that does not exist.

Sail comparison works on them too, which is usually the real question: *what
did I actually lose without the main?*

## Labelling it afterwards

You will forget to set it before the bord, the same way you forget to set the
reef. [Fixing the sail plan after the fact](sail-plan-history.md) accepts
`no main` and `no headsail` like any other label, so a stretch can be marked as
a test rig once you are back on the mooring — and the points drop out of the
polar retroactively.
