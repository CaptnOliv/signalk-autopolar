[← README](../README.md)

# Supporting the plugin

It is free, MIT, with no account, no telemetry and no nag screen on startup.
What it does cost is a domain, a server for the shared pool and the time that
goes into it. So the web app asks, once:

- **when** the polar it built for you has actually become usable — 15 cells
  standing on three measurements or more, not a number of days or a number of
  app launches. A request that follows a result is not the same request;
- **at most twice** in the life of the installation. Only *don't ask again*
  closes the door for good: tapping the star or the coffee proves nothing —
  the tab may well have been shut straight away — and treating it as final
  would punish the one gesture the banner was hoping for. Those two count as
  *later*;
- **later means later**: it comes back once 90 days have passed *or* the polar
  has gained another 15 solid cells, whichever happens first. There is nothing
  to gain by staying quiet in front of someone who has something new to see;
  the two-appearance cap is what keeps that from turning chatty;
- **never offline**, because a Ko-fi link tapped fifty miles out opens a dead
  tab and burns the one chance for nothing;
- **as a banner, never a modal**. This screen gets read at night under way; no
  amount of gratitude justifies covering the polar.

One more rule, and it is not about the money: if sharing is off and the same
milestone has just been reached, the *shared pool* banner
([sharing your polar](sharing.md)) goes first and this one stays quiet.
Contributing a polar costs nothing and serves everyone; asking for a coffee can
wait for the next milestone. The two never appear on the same screen.

The state lives on the server, in `support.json`, not in the browser: the web
app gets opened from the phone, the tablet and the laptop, and browser storage
would ask three times. One boat, one request.

Set `supportPrompt` to false in the plugin configuration and the banner never
appears at all. The two link bars — one under the title, one at the foot of
the page — stay put: they are permanent, tied to no milestone, and interrupt
nobody.

★ [Star the repository](https://github.com/CaptnOliv/signalk-autopolar) ·
☕ [Buy me a coffee](https://ko-fi.com/captnoliv)
