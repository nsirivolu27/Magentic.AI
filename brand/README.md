# Magentic brand

`tokens.css` is the source of truth for colour, type, space and depth across
every Magentic surface: this server's catalog page, the console, and anything
built from it elsewhere.

Three rules the file cannot enforce and the system depends on:

**Magenta is reserved.** It marks the one primary action, the focus ring, and
nothing else. A panel is never magenta and a heading is never magenta. The
moment a second thing on a screen is magenta, neither is the answer.

**Depth is a lighter surface plus a hairline.** Shadow appears only when
something genuinely left the page, which means an overlay and nothing else.
No gradient washes, no grid overlays, no glow that is not doing work.

**Hierarchy comes from scale and weight.** The scale jumps hard on purpose,
72 to 40 to 24, so one element per screen can lead. A page where everything
sits between thirteen and fifteen pixels is one size with rounding error.
Uppercase is rare enough that it means something when it appears.

One thing worth knowing before you use the accent: white on `#E84BA3` is
3.5:1 and fails. Text on magenta is `--on-accent`, which is near-black on
dark. It reads better anyway.

The catalog page in `http.ts` inlines these values rather than linking this
file, because it is one static page served with no runtime file dependency.
When they diverge, this file is right.
