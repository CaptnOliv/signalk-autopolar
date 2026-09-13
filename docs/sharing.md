[← README](../README.md)

# Sharing your polar

This plugin is free and stays free. In exchange, the polar it learns from your
boat goes back into a shared pool.

Most production designs have no honest measured polar anywhere. What circulates
is the builder's brochure figure, produced by a velocity prediction program on
a clean hull with a new sail wardrobe and no crew luggage — and every owner
quietly discovers it is optimistic. A polar measured over real passages, with
real sails and a real waterline, is worth more; the only way to get one per
design is for owners to pool them.

**It happens on its own.** Every 500 new points the plugin posts the current
polar to the collector, and each send replaces the previous one for your boat —
so the pool holds your best version, not your first one. Nothing to click,
nothing to remember. Nothing goes out on a clock either: no new points, no
send. Offshore, a failed send is not lost — it is retried on its own once the
link comes back.

Two things make it easy to say yes to:

- **Nothing collected here contains a position.** Not one latitude, not one
  longitude — check `runs.jsonl` yourself. A shared polar says what your boat
  does at a given wind and angle, and nothing whatsoever about where you have
  been or when you were there. There is no track, and no raw log leaves the
  boat.
- **The name is free text.** Your boat's name if you like, a pseudonym if you
  would rather stay anonymous. Nothing verifies it. What matters for the corpus
  is the *model*, as precisely as you can give it: "Beneteau Oceanis 48" is
  useful, "sloop" is not — add the year or the rig variant if the design changed
  during its production run.

The model and the name are asked once, in the plugin configuration, and
**nothing is collected until they are filled in** — a polar nobody can attach to
a design helps nobody, including you. Sharing itself is on by default and can
be switched off in the same place; the plugin then works exactly as before, and
only the pool stops growing.

What is sent is fixed — speed over ground, true wind, median per cell — so that
polars from different boats can be compared, and your display settings never
change it. Points recorded on a "sailing" declaration are left out: nobody else
can check a declaration. The web app shows the whole payload at any time
(**See exactly what is sent**), which is the point: a contribution you cannot
read is one you end up switching off.

The payload also carries **what decided the engine was off**, point by point —
measured state, RPM, both agreeing, autostate, or a declaration. That one field
is what makes a received polar readable. On the first polar the pool got from
another boat, a handful of cells were plainly impossible (5.1 kn in 4 kn of
wind); the question "was this boat declaring, or measuring?" had no answer in
the file. It does now. The number of measurements behind each cell travels with
the polar for the same reason: every one of those impossible cells rested on
one or two samples, while the body of the table — eight samples and up — was
perfectly consistent.

For now there is no frontend to download the built polars, because there is not
enough polars shared (actually only mine as per September 2026), but as soon as
it gets some polar to share, I will make the frontend so everyone can consult
them!
