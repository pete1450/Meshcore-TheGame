# Meshcore: The Game

A first-person walk-around game about placing MeshCore-style repeaters on a
procedural mountain map and linking everyone up.

**Play it:** https://pete1450.github.io/Meshcore-TheGame/

<img height="500" alt="image" src="https://github.com/user-attachments/assets/40e8fea0-6420-41c9-8430-79e235058011" />


## The game

You spawn in a trail town on a 3.2 × 3.2 km procedural topo map (0–500 m
relief, contour lines every 50 m). Twelve people are scattered across hollers,
ridges, and the two towns. Walk the land (WASD, Shift to run), drop repeater
masts (E) where the RF propagation says they'll actually work, and link all
12 people. Ridges block, forests weaken, height wins.

Your simulated MeshCore handheld (📻 button, or B) finds repeaters in radio
range and lets you flood messages across the public channel — repeaters relay
hop-by-hop with real message-ID dedup, and everyone who hears you flashes
green on the map.

## Controls

- **WASD / arrows** walk · **Shift** run (10×) · mouse to look (click to lock)
- **E** drop a repeater · **Q** handheld scan preview · **M** big map (Esc closes, click sets waypoint)
- **B** MeshCore handheld · touch: left-half joystick + drag to look

## Build

`build/` holds the sources (`head.html`, `logic.js`, `game.js`) plus
`three.min.js` and node logic tests. `python3 build/build.py [out.html]`
runs the tests, then inlines everything into a single self-contained
`index.html`. Pushing to `main` rebuilds `index.html` automatically via the
build workflow.

Not affiliated with the MeshCore project — the radio sim is a game, not firmware.
