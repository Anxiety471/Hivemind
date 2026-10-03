---
name: ascii-flow
description: Turn ASCII diagrams into interactive nodes, arrows, and animated flow.
---

# ASCII Flow

Convert diagram notation into selectable nodes and real connections. Preserve the
source's labels, direction, branches and layout; never invent missing relationships.

## Hivemind replies

Use Hivemind's existing ASCII renderer. Return a closed `ascii` or `ascii-diagram`
fence in the agent reply; the Web UI performs conversion. Keep explanations outside
the fence. Do not return a table or merely describe the animation when a visual is
requested. Do not ask the user to run JavaScript.

Use `[Label]` for nodes and `->` or `-->` for directed edges. Use `<--` for reverse
edges and `<->` for bidirectional edges. Unicode `→`, `←`, `↔` and complete
ASCII/Unicode rectangular boxes also work. Keep labels short; retain their meaning.

```ascii
[Browser] --> [API] --+--> [Database]
                      |
                      v
                   [Cache]
```

Keep connectors aligned in a monospace grid. Count character columns before
returning a branch; do not eyeball whitespace. In the template above, `+`, `|`,
and `v` are in zero-based column 22; indent `|` and `v` by exactly 22 spaces
and start `[Cache]` in column 19. Copy the template without changing its spacing. Use `|` or `│` with `v`/`↓` for down
and `^`/`↑` for up. Use one explicit source per branching junction, with an arrow
at every target. Prefer brackets over complicated shapes. Put edge explanations
outside the diagram rather than embedding text inside connectors. Avoid tabs,
crossings, dangling marks, partial boxes and disconnected notes.

Use the normal diagram fence for interactive flow: node selection highlights
connections, Animate moves particles along arrows, Pause stops flow, and Zoom/Fit
control the view. Preserve the original reply through Source and Copy. Keep
selection and zoom available under reduced motion; disable animation. Leave
streaming fences as source until closed.

For an explicit flipbook request, use `ascii-animation` and separate complete
frames with a line containing exactly `---frame---`. Keep frame spacing consistent;
playback is 4 fps. This is text-frame playback, separate from SVG diagram flow.
Do not require multiple frames for a normal interactive diagram.

## Other frontends

Reuse an existing converter if available. Otherwise parse supported ASCII into a
node/edge scene and render native SVG; draw arrowheads with markers and motion
along the actual paths. Add keyboard-accessible node selection, connection
highlighting, zoom/fit, playback controls and original-source access. Escape labels
as text. Never execute source HTML or JavaScript. Prefer native APIs; add a library
only when it provides needed functionality.

Keep ambiguous or unsupported drawings as readable source instead of guessing.
For Hivemind, keep converted drawings within 20,000 characters, 100 nodes, 200
edges, 200 rows, 300 columns and 30,000 grid cells. Split larger drawings into
independent diagrams without changing their meaning.

## Verify

Check every label and directed connection against the source. Confirm branch
alignment and close every fence. When changing a renderer, test conversion,
selection, keyboard controls, zoom, playback, reduced motion, streaming and source
fidelity in the actual UI. Use the user's or agent's real output when supplied.
Capture actual browser interactions for a requested before/after GIF or video;
label fixtures and do not present a mockup as tested behavior. Report any fallback
or unverified behavior plainly.
