# McLaren F1 — Browser Driving Experience

An interactive McLaren F1 1993 driving experience: Next.js, TypeScript, React Three Fiber,
Three.js and Rapier physics.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

> `sharp` is pinned to `0.32.6` (the last CommonJS release) because this machine runs
> Node 20.9, which predates import attributes — `sharp` 0.33+ ships ESM using
> `import … with { type: "json" }` and fails to parse. It is only used by the offline
> model preprocessing step, never at runtime. On Node ≥ 20.10 the pin can be dropped.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake, then reverse once stopped |
| `A` `D` / `←` `→` | Steer |
| `Shift` | Boost — a finite reserve of extra push, shown as the violet arc closing the bottom of the rev counter |
| `Space` | Handbrake |
| `C` | Cycle camera (chase → close → cockpit) |
| `R` | Reset onto the nearest road (city) / to the grid (circuit) |
| `F` | Flip the car upright where it stands |
| `M` | Open the city map — click to set a waypoint |
| `H` | Toggle the controls panel |
| `K` | Mute engine audio |

Touch controls appear automatically on coarse-pointer devices.

## Why the first minute used to stutter

Reported as "it lags a lot at first, then after a while it smooths out", on a low-end Windows
laptop, while being perfectly smooth on the machine it was built on. That shape of bug has one
usual cause and it was the cause here: **shader compilation during play**.

Three builds a material's WebGL program the first time something is actually drawn with it. So
every bridge, tunnel lining, station, livery and vehicle type you had not yet met cost a
compile at the moment it first came into view. Hooking `linkProgram` on a production build
measured it exactly:

| | before | after |
| --- | --- | --- |
| programs compiled **during play** | **113 — all of them** | ~50, trickling |
| programs compiled behind the loading curtain | 0 | **259 of 313** |
| curtain lifted at | **1.2 s** | 17 s |

The 1.2 s is the other half of the bug. The curtain used to lift on drei's
`useProgress().active`, which is false *before the first loader starts* — so the player was
dropped into an empty world, and then watched it pop in a piece at a time while the browser
compiled. On an M1 all 113 compiles cost 8 ms together and nobody would ever notice; on
Windows each one is an ANGLE translation to HLSL plus a driver compile, and they land in the
middle of frames.

`Warmup.tsx` fixes it, and each part of it exists because the measurement said so:

- **Wait for the scene to stop growing.** Mounting inside `<Suspense>` is not late enough —
  `TrainLine` rebuilds once the nav raster lands, stations find their own sites. The first
  version compiled at mount, reported "compiled in 0.9 s", and had warmed about a third of a
  world. It now polls the object count and waits for it to hold still.
- **Show the hidden things first**, or the only materials left uncompiled are exactly the ones
  that appear later.
- **Compile, then render from six directions**, because `compileAsync` builds a program per
  material and not its *variants*.
- **Widen the sun's shadow box for one render.** The shadow camera is a 76 m box that travels
  with the car, so a normal shadow render only warms what is beside you; everything else built
  its depth variant on entering that box, which measured as a burst of ~48 programs ten
  seconds into the drive. Widened to 800 m for a single frame, those are built up front.
- **A timeout that lets the player in regardless.** A hitchy game is a bad game; a game that
  never starts is not a game.

The cost is an honest loading screen of about 17 seconds instead of a dishonest one of 1.2 —
which is the trade that was asked for, and the bar now holds back its last tenth and says
`PREPARING` while the compile runs, so the wait reads as work rather than as a hang.

`[warmup] scene compiled in 13.6s (17.2s into the page)` is logged on every run. That is the
number to ask for when someone reports stutter.

## Settings

The pause menu's settings page changes the world you are already in — the admission test for
anything on it is that the running scene can act on it on the next frame, so nothing there
needs a reload (`gameSettings.ts`): traffic density is a cap the AI reads each frame, the
trams and trains mount and unmount, audio flips a gain, and the picture grade is a CSS filter
over the canvas.

**TRAINS** exists to buy frames. It switches off the scripted main-line services and leaves
the railway itself — the track, the bridges, the tunnel and the colliders — because the
stations, the pointwork and the island bridge are mounted separately and stand on that track;
gating the whole railway would leave a station on a viaduct to nowhere. It is the heaviest
single thing in the world that can be turned off: a service is two locomotives and its
coaches, a coach is 95 k triangles after decimation, and there is a service each way.
Measured in the city, in one spot with the same traffic, switching them off took WebGL draw
calls per frame from 2,154 to 1,092 and the share of frames missing a 60 Hz vsync from 24% to
5.5% — about half the frame, for one switch.

## The model needs preprocessing — this is not optional

The supplied `mclaren_f1_1993_by_alex.ka..glb` is a flattened Sketchfab export and cannot
be driven as-is. Raw downloads like it live in **`source-models/`** (untracked — see
`scripts/sourceModels.mjs`, which resolves them, and which also accepts one still sitting in
the repo root). Run once (already done; re-run if you replace the source asset):

```bash
npm run prepare:model
```

This reads the source GLB and writes `public/models/mclaren.glb`. What it fixes:

1. **There are no wheel objects.** Every node is named `Object_N`, and geometry is merged
   *by material*, not by part — all four tyres live in a single mesh with no pivots.
   Rotating that node would spin all four tyres around the car's centreline. The script
   splits each wheel-material mesh into four by triangle-centroid quadrant (the corners are
   cleanly separable, and each quadrant verifies as circular to within 6 mm) and rebuilds
   real pivot nodes.
2. **Rolling and non-rolling parts are separated.** `Wheel_FL/FR/RL/RR` roll *and* steer;
   `Upright_FL/…` steer but never roll. Brake calipers and suspension links sit on the
   upright, and spinning them is an instant tell.
3. **Two baked shadow planes are deleted** (`floor`, a 10 × 10 m quad, and a 2.2 × 5.0 m
   contact-shadow quad) — both sat at ground level and would z-fight with the track.
4. **Scale is corrected.** The export is 17.6 % oversized; ×0.9148 gives a 4.29 m car,
   a 2.72 m wheelbase and 0.3176/0.3504 m tyre radii — matching the real car's staggered
   235/45R17 and 315/45R17 fitment.
5. **Orientation is baked** to Y-up with the nose at −Z (three.js convention), via a proper
   rotation so the model is re-oriented rather than mirrored.
6. **Textures are recompressed** to WebP, capped at 2048 px: 9.85 MB → 0.92 MB, taking the
   GLB from 12.7 MB to 5.1 MB.

Measured geometry is written to `src/config/carGeometry.json` and imported by the vehicle
config, so tuning values stay consistent with the art instead of being hand-copied.

## Architecture

```
src/
  app/page.tsx                     entry: poster -> garage -> drive, chosen from the query
  app/promo/page.tsx               the same poster standalone (server-rendered, zero client JS)
  components/racing/
    PromoPoster.tsx                the advert: one image, four words, one button
    RacingScene.tsx                canvas, physics world, composition
    Car.tsx                        model + wheel/suspension/brake-light visuals
    CarPhysics.tsx                 chassis rigid body + Rapier vehicle controller
    CityMap.tsx                    city chunks, trimesh + box colliders, nav raster load
    Minimap.tsx                    rotating minimap, compass, full map, waypoints
    Traffic.tsx                    instanced NPC vehicles + kinematic collider pool
    Track.tsx                      road, curbs, markings, barriers and their colliders
    trackGeometry.ts               pure geometry builder (also feeds the colliders)
    textures.ts                    procedural canvas textures — no image files ship
    Environment.tsx                sky, procedural IBL, car-following sun, trees, grandstands
    ChaseCamera.tsx                chase/close camera updater
    CockpitCamera.tsx              driver's-eye camera updater
    RacingCamera.tsx               camera rig; blends between modes
    RacingHUD.tsx                  speed, gear, RPM, camera mode, help
    SkidMarks.tsx                  ring-buffered marks, GPU-side fade
    TyreSmoke.tsx                  pooled particles
    TouchControls.tsx              mobile input layer
    LoadingOverlay.tsx
  physics/
    vehiclePhysics.ts              the vehicle model; owns all Rapier sign conventions
    surfaceGrip.ts                 analytic on/off-track grip
    cityNav.ts                     road/height raster: nearest road, ground height
    trafficAI.ts                   scripted NPC driving: road-following, lanes, spawning
  hooks/
    useKeyboardControls.ts         input into a ref, never React state
    useEngineSound.ts              engine note: an AudioWorklet engine model (public/audio/engine-processor.js)
    useTrainSound.ts               the railway: wheel/rail, joints, points, diesel or electric, horn (public/audio/train-processor.js)
    useGarageAudio.ts              garage music + UI click/confirm sound effects
  config/
    vehicleConfig.ts               ALL vehicle tuning lives here
    trackConfig.ts                 circuit definition and curve maths
    cityConfig.ts                  city bounds, spawn choice, box colliders, raster georeferencing
    trafficConfig.ts               NPC traffic tuning
    vehicleCatalogue.json          generated — do not edit by hand
    world.ts                       which world is loaded (city, or ?world=track)
    carGeometry.json               generated — do not edit by hand
    cityData.json                  generated — do not edit by hand
    spawnPoints.json               generated — do not edit by hand (npm run spawns)
    roadGraph.json                 generated — do not edit by hand (npm run roads)
  types/vehicle.ts
```

Per-frame data (telemetry, input, wheel state) lives in refs and is mutated in place.
Nothing that changes every frame goes through React state; only the camera mode and the
help panel do.

## The city

The default world is an open city map (`drive_for_speed_-_map.glb`), roughly 5.5 × 2.75 km
with 91 m of relief. Like the car, it **must** be preprocessed:

```bash
npm run prepare:map     # scripts/prepare-map.mjs
```

The Sketchfab source is 188 MB and unusable as-is — 12,103 primitives across 26,779 nodes
(i.e. 12k draw calls) and 179 MB of *uncompressed* geometry. The script emits
`public/models/city.glb` at **17.5 MB** plus a generated `src/config/cityData.json`:

- **Merged into spatial chunks**, by (material × 400 m cell) rather than by material alone.
  One merged mesh per material would span the whole city and could never be frustum-culled,
  so every tree in the map would be drawn every frame. 12,103 primitives → 344 chunks.
- **Draco compressed**, quantised per *mesh* rather than per scene. Scene-wide quantisation
  spreads 14 bits over 5.5 km — 34 cm buckets — which visibly corrugates the roads and,
  because the road chunks double as the collider, makes the car judder.
- **Real-world scale recovered — and it was wrong once.** The source is authored in FBX
  centimetres and scaled by 0.01 at the root, leaving a "55 unit" city. The multiplier is
  **×100**, taken from twelve objects whose size is fixed by standard or by law: ISO shipping
  containers (94, 92), a bus shelter (90), a road sign (93), refuse containers and bins
  (100–106), a crowd barrier (105), truck tyre diameter (103), and the legal maximum height
  and width of the two trucks parked in the map (104, 104–105).

  It was ×160, which made the whole city about 1.6 × too large and left the player's car
  looking like a toy beside it. That came from four references that cannot carry the weight,
  recorded here so they are not reached for again: tree height (trees are not a fixed size —
  the ones in this very map imply anything from 49 to 115), a "residential house" 13.4 m tall
  (a four-storey block, not a house), a "wall module" 6.6 m high (a boundary wall is 2–3 m),
  and a truck cab 4.3 m high, above the 4.11 m legal limit it would have to obey. **Scale
  references have to be things built to a specification.**
- **Foliage switched from alphaMode BLEND to MASK**, turning 1.6 M triangles of sorted
  transparency into a shader discard.
- **Collision in two forms.** Streets, car parks and terrain (137 k triangles) become
  trimesh colliders built from the very geometry being drawn, so the wheels raycast exactly
  the surface you see. Buildings become 2,730 per-primitive box colliders — tighter than
  per-building boxes and far cheaper than 836 k triangles of facade. Primitives whose
  footprint exceeds 60 m fall through to the trimesh instead: the worst offender is a single
  5,158 × 4,231 m beach plane whose AABB would otherwise wall off the entire city.
- **Spawn is measured, not hard-coded**, and taken from the *finished* road mask so the car
  starts on a real street. Candidates are ranked by the longest unbroken straight run of road
  through them — a street is a long linear corridor, whereas scoring "how much pavement is
  nearby" rates a car park higher than a road and once picked an elevated parking deck inside
  a block. A height filter keeps the search off flyovers and roof decks.
- **A navigation raster**, `public/models/cityNav.png`, one pixel per 1.5 m: `G`/`B` carry
  ground height as a u16, `A` marks where any drivable ground exists, and **`R` carries two
  levels** — `255` street, `128` other paved ground, `0` not paved. Two, because the map and
  the traffic want different answers and one mask can only be right for one of them.
  Everything paved is *shown*: the yards, forecourts and parking inside the blocks are real
  ground, and a map that left them out drew a city of bare streets with hollow blocks. Only
  the reachable street network is *driven*. `isRoadAt` is the wide test and keeps the meaning
  it always had — the map and the skid-mark surface test use it; `isDrivableAt` is the narrow
  one, used by the traffic AI, the reset snap and the spawn search.

  Getting to the narrow one takes three passes, and each fixes a way NPC traffic used to end
  up somewhere absurd:

  - **The height is the *lowest* paved surface, not the highest drivable one.** The city has
    elevated roads, ramps and a parking tower, and 12,320 cells carry two or more metres of
    paving stacked over one another. Taking the maximum meant an ordinary street cell that
    happens to have a ramp 36 m overhead reported 36 m as its ground — so cars driving that
    street were drawn 36 m up, standing on the rooftops. Measured in the running game at
    (-928, 694): raster 36.65 m, street 0.00 m. One raster can only hold one layer, and the
    street is the layer that matters.
  - **Standing geometry is punched back out** — 10.8 % of all paved cells have something on
    them, because warehouses and shops sit on their own paved lot. A cell is blocked when
    geometry reaches more than 1.5 m above its paving *and* starts below that, so it is rooted
    there. Both halves matter: without the first, kerbs and road markings wall the city off;
    without the second, a bridge, a petrol-station canopy or a tree's crown erases the road
    underneath. This used to be done from the collider boxes, which was the wrong data — a
    primitive only becomes a box if its footprint is under 60 m, so every merged block and
    every tree was missed.
  - **Road a car cannot reach is dropped.** What survives is split into components joined only
    where the height step is one a car could drive, and small islands go: rooftop decks with
    nothing under them, and the scraps of yard the obstacle pass has just cut off from the
    street. Components are kept by size, not by "connected to the biggest" — the western
    districts and the southern island are separate components and all three want traffic.

  Net effect: **296,945 paved pixels drawn** against 301,329 before, so the map is as full as
  it was; **270,165 of them drivable**, with road above 12 m down from 7,235 pixels to 2,450 —
  the remainder being genuine bridges and viaducts. The map paints the two levels in two
  tones, since one tone loses the street grid in a wash of white.

### Map, compass and reset

The raster is what makes the navigation features possible, and it exists because **Rapier
cannot be asked these questions from where they are asked**: any collider query re-enters
the borrowed `World` from inside the physics step and throws (see below). The reset handler
runs in `useBeforePhysicsStep`, so it cannot raycast for the road. Indexing a preloaded
raster is O(1) and safe anywhere.

- **`R` puts you back on the nearest street**, upright and pointing along it, rather than
  teleporting across the map to a fixed grid slot — after a crash you carry on from where
  you were. The road axis is found by probing 18 directions for the longest unbroken run of
  tarmac, and the end closest to your current heading wins so reset never spins you around.
- **A minimap** rotates with the car, with a compass ring whose N really points north and a
  `NE 045°` heading readout.
- **`M` opens the full city map.** Click to drop a waypoint; the minimap shows it (clamped
  to the rim when off-screen) and the distance to it counts down as you drive.

### Where you start

Every drive used to begin on the same street, facing the same way — the one wide central
road the map preprocessor measured. It now begins somewhere different each time, and the
spawn is **surveyed offline rather than chosen at runtime**: `npm run spawns` walks the road
graph (`npm run roads` first — see below) and checks each candidate against the nav
raster and writes a dozen places to `src/config/spawnPoints.json`, which `cityConfig` reads
and `vehicleConfig` picks from once per page load. A spawn that wandered into a wall on some
loads and not others would be the worst of both worlds, which is the same reasoning as the
tram route.

**Candidates come from the road graph, not from the raster.** They used to come from a grid
sweep of `cityNav.png`, accepting any pixel it called street that had street either side and
a clear run ahead — which is not the same question as "is this a road". A multi-storey car
park's roof deck is built from road material, so the raster calls it street; one measured
100 m × 30 m, stood 2.5 m up, touched no street anywhere, and passed every test. A drive
started on top of it, 75 m from the nearest street, with no way down. Sampling
`roadGraph.json` instead makes being on the network the guarantee — that network has already
discarded decks (too wide is a plaza, isolated is too small a component) — and it is the same
network the NPC traffic drives, so the two agree about where the roads are.

It also fixes the heading. The old survey guessed a street's axis by probing 18 directions
and faced whichever end had more room, which on a two-way street is a coin toss: half of all
drives began facing into oncoming traffic. A graph edge has a direction, so the car is placed
in the **driving-side lane** facing the way that lane goes, using the same offset
`roadGraph.laneAt` gives the NPCs (the clamps are read out of `trafficConfig.ts` at survey
time rather than written down twice).

What a candidate still has to prove, against the raster:

- **Flat under the footprint** — within 35 cm over 6 m × 3.2 m. A spawn is a drop from
  0.6 m, and this physics answers a kerb under one wheel by tipping the car over.
- **Thirty metres of clear road ahead** and eight behind, so the first thing you do is drive
  rather than reverse off a kerb.
- **Nine metres clear of the tram and train centrelines.** Five trams run the street loop and
  they are kinematic walls; spawning between the rails is spawning inside one that is on its
  way.
- **Not in a junction, and not on a roundabout**: 14 m of every edge is left alone at each
  end, and one-way ring edges are skipped.
- **At least 300 m from every other spawn**, accepted greedily from a shuffled list, so the
  set covers the map instead of clustering where the street grid is densest.

The script asserts the result rather than assuming it: if any chosen point is further from
the graph than a lane's width it prints the offenders and exits non-zero. The last run kept
12 of 3,665 candidates, every one of them 1.6–4.5 m off a street centreline (i.e. in lane),
at street level, with zero footprint relief.

Re-running gives a different set and prints its seed; `npm run spawns -- 12345` reproduces
one exactly. **http://localhost:3000/?spawn=3** pins a single spawn, which is what to quote
in a bug report about one particular street.

Chunk role travels in glTF `extras`, not in node names: three's GLTFLoader runs every name
through `PropertyBinding.sanitizeNodeName`, which strips `.:/[]`, so structured names are
silently mangled on load.

The procedural circuit is still fully wired and is reachable at
**http://localhost:3000/?world=track** — it remains the reference for physics work, since
it is where the vehicle was calibrated.

## Traffic

The city is populated with NPC traffic built from the two Sketchfab vehicle packs. Like
everything else, they must be preprocessed:

```bash
npm run prepare:vehicles     # scripts/prepare-vehicles.mjs
```

**78.8 MB -> 2.61 MB**, 20 vehicles: 10 civilian cars and 10 service vehicles (ambulance,
city bus, fire truck, school bus, police, taxi, tow truck, garbage truck, post van, service
truck). The script normalises two packs that agree on nothing:

- **Millimetres to metres**, and each vehicle re-centred on its own footprint, sitting on
  y = 0 and facing -Z like the player's car. Every vehicle sat at its own spot in a showroom
  layout at its own arbitrary yaw, so the long axis is recovered by PCA over the body
  vertices.
- **Which way each vehicle faces is read off its lamps.** The long axis comes from PCA,
  which is *undirected* — it cannot tell a bonnet from a boot, so left alone a car drives
  backwards. Road vehicles must by law be lit red at the back and white at the front, so
  the **clear end is the front**: the optics geometry is sampled against its own texture and
  each end's ratio of clear lens to red lens is compared. Cab-forward vans and trucks with no
  clear lens fall back to the glass, since a windscreen is raked forward and a rear window
  rakes back, so the area-weighted glass normal points at the nose.

  Comparing *redness alone* is not enough and shipped two cars backwards: these models carry
  red trim and red side markers at both ends, so it separated a saloon's ends by about 10 %,
  which is noise. The clear-to-red ratio separates them by 2× to 20×.
- **Wheels are reunited with their cars spatially, not by name.** The passenger pack keeps
  wheels as loose `Wheel_A..H` nodes that are siblings of the bodies, and the names cannot be
  trusted: one base name is reused across two different cars, and two distinct nodes share
  the name `Wheel_G001`. Pairing by position — nearest first, capped at four per body, never
  across packs — is the only thing that gives every car exactly four wheels.
- **The service pack's wheels are carved out of the body mesh.** It keeps no wheel nodes at
  all — an ambulance is four primitives, one per material, with the wheels inside the body
  one — so half the traffic drove with its wheels welded still, which reads as being dragged
  rather than driven. They are not *merged*, though: each wheel is its own closed shell
  sharing no vertex with the bodywork. So the geometry is split into shells by welded position
  and each is asked whether it is round (its extents across the vehicle's Y and Z agree, and
  no vertex reaches further from the hub than a circle of that diameter would), narrow, and
  standing on the floor. The roundness test is the one that does the work — a wing mirror or
  a light housing is boxy, and the corners of a box stand 41 % further out than its sides.
  Shells are then grouped by diameter and the largest agreeing set of at least three wins, so
  a spare on a tailgate or a steering wheel in the cab cannot outvote the road wheels. All 20
  vehicles now have turning wheels; the garbage truck correctly gets six.
- **Transparency is decided from the pixels, not the tag.** Both packs mark materials BLEND
  wholesale, and BLEND is not free: three draws a blended surface with depth-write off, and an
  `InstancedMesh` cannot sort within itself, so the far side of the body draws over the near
  side. The ambulance is 8,620 triangles of bodywork on a BLEND material — the only *body* in
  either pack tagged that way — and it rendered as a translucent, self-overlapping mess while
  every other vehicle looked right. A material now keeps its blending only if its base-colour
  factor says it is transparent or its texture actually has non-opaque texels. Glass and
  decals pass; painted metal does not. Exactly one material was downgraded.
- **64 MB of PNG down to 1.9 MB of WebP at 512 px.** Traffic is never inspected closely.

### How the traffic drives

There is no route graph. Each car reads the same road raster the minimap draws, the way a
line-following robot reads a track: probe a fan of nine candidate headings, keep the one with
the most tarmac ahead, then trim sideways to sit ~3.2 m off the right-hand kerb. Junction
turns, bends and roundabouts all fall out of "where does the tarmac go", and a missing raster
degrades to driving straight rather than crashing. Cars brake for whatever is in their lane
ahead, including the player.

Steering is deliberately lazy. Every input it reads is quantised — the raster is 3 m per
pixel, reach is measured in probe steps, kerbs in half metres — so a controller that steers
straight at the target reproduces that noise as visible wiggle. Instead the yaw rate is
damped and capped by a lateral-acceleration budget, so a car at 12 m/s corners far more
gently than one crawling. Lane trim only applies when *both* kerbs are in reach, i.e. the car
is genuinely in a street: correcting off one kerb alone made cars swerve across junctions and
car parks, where the off side reads as several metres of error.

A cornering budget alone is not enough, though — capping the yaw rate without also capping
the *speed* just means a car understeers off the road. So a car slows until the turn it is
asking for fits the budget, and never travels faster than it could stop in the road it can
actually see. On top of that, staying on the tarmac is a **guarantee, not a preference**: a
step that would leave the road is refused outright, cars keep to the middle of their own half
of the street rather than a fixed distance from the kerb, and a car that somehow strays makes
for the nearest road and is recycled if it cannot get back. Traffic also queues only behind
cars going the same way — braking for oncoming traffic deadlocks both of them.

Measured over 6,000 car-seconds against the real nav raster (`npm run build` has no way to
check this, so it is checked offline — see `HANDOFF.md`): **0.00 % of car-steps off the
tarmac**, worst stray 0.0 m, mean speed 5.1 m/s against an 8–13 m/s cruise.

Every distance in `trafficConfig.ts` is a *world* distance, so it is tied to the city's
`UNIT_SCALE`. When that was corrected from 160 to 100 all of them were scaled by 0.625 to
match — and `laneGain` the other way, being radians per metre.

They are scripted rather than simulated — 20 more raycast vehicle controllers would cost more
than the player's car and buy nothing. Rendering is instanced (84 batches for 40 cars), and
wheels spin off each car's odometer where the pack kept them separate.

**Traffic cars are kinematic**: they collide with the player without being pushed by him, so
hitting one is like hitting a wall rather than shunting it aside.

About 26 % of the time a car is below 1 m/s — slowing for a junction, queuing, or briefly
wedged, with around 56 cars recycled per 150 s for stalling. That got worse when the city
scale was corrected, and unavoidably so: the streets are now 7 m rather than 11 m and there
are 1.6 × as many junctions per metre driven, so the driving problem is simply harder. Halving
the traffic density recovers only 0.2 m/s, and lowering the cruise speed does not help at all,
so this is junction behaviour rather than congestion or over-eager traffic. It is the main
thing left to improve.

### Checking which way the vehicles face

The long axis comes from PCA, which cannot tell a bonnet from a boot, and every scalar test
is ambiguous on *some* vehicle. So the pipeline can draw its own homework:

```bash
ORIENT_SHEET=/tmp/orientation.svg npm run prepare:vehicles
```

That writes a side-on profile of all 20 vehicles — body grey, glass blue, lamps in their
actual texture colour — each with an arrow showing the way the model claims to face. A
correct vehicle has its bonnet or cab on the left and its red lamps and tailgate on the right.
The run also prints each end's clear-to-red ratio, so a marginal call is visible as a ratio
near 1. If one is genuinely wrong, add its name to `FLIP` in the script.

The quickest check in the running game is to park a car broadside: at 90° to the player it
must point to the left of the screen, and a bonnet, a boot or a rear wing is unmistakable
from the side in a way it never is head-on.

## Tyre marks and the chase camera

**Marks are laid for three different things**, and only the first was drawn before:
sliding sideways, spinning the driven wheels up under power, and locking a wheel under
the brakes. The last two need a longitudinal slip figure, which Rapier's raycast vehicle
does not report — it exposes no wheel angular velocity — so it is inferred from what is being
*demanded* of the tyre: full throttle at low speed spins a driven wheel, a hard brake above
walking pace locks any wheel, and both fade out as the condition stops being extreme. Each
mark carries its own intensity, so a light scrub is a faint smear and a locked wheel is black.

**The reason marks were invisible in the city** is that they were pinned to `y = 0.014`, a
flat-world assumption inherited from the circuit. The city has 91 m of relief, so every mark
was either buried under the road or floating above it. They now sample the real surface height
from the nav raster, and take a depth bias like any decal, because on a slope that raster is
only accurate to a few centimetres and no fixed lift can beat it. They are also laid only on
paved surfaces — a deliberately separate test from `gripAt`, since grip feeds the vehicle model
and changing it changes how the car drives, whereas this only decides where rubber shows.

**The chase camera follows the car's heading through a damped angle**, not by being bolted to
the chassis. That lag is the whole character of it: turn in and the rig trails, swings wide,
then gathers up behind you. Measured: about 4° of lag in a straight line and 14° mid-corner.
Two things build on it:

- **Reverse sweeps the camera round.** Hold reverse for about a third of a second and the rig
  eases through 180° to look the way you are actually travelling, instead of leaving you to
  reverse blind into the back of the camera. The dwell and the eased blend are what stop it
  flip-flopping when you rock back and forth off a kerb. Measured: 0° to 144° and climbing over
  roughly a second and a half.
- **Speed backs it off and widens the lens**, and reversing tucks it in so the boot does not
  fill the frame.

## The garage

A white cyclorama, built the way a car studio is built. Two things about how these are
actually photographed decide the whole design — and both came from looking it up rather than
guessing (sources at the end of this section):

- **You light the walls, not the car.** Paint reads from what it reflects, so the room is
  white and bright, and the "lights" are large soft banks either side that the car can see in
  its panels. Two earlier versions put the car in a dark room; it went flat, because there was
  nothing to reflect.
- **Corners must not exist, and a dark line must.** The floor curves up into the wall (the
  cove) so no seam appears in the reflections, and the reflection map carries a dark band just
  above the horizon — the "blacks" photographers hang — which is what gives a flank its depth.
  Without it white-studio paint washes out.

The vehicle stands on a turntable and turns slowly on its own; there is no drag — the picker
is for looking. A directional key from the camera's side casts the shadow, two wide spots pick
out wheels and lamps, a blue kick from behind separates the silhouette from the white wall, and
a dramatic soft-edged ground shadow grounds the car on a floor that still reflects it.

**One colour.** Everything that is not a neutral is the same electric blue — the wordmark
plate, the tabs, the bars, the class shield, the button, the turntable ring, the frame around
the chosen picture. Neutrals are white and deep navy; there is no black.

**Pictures, not names.** The roster shows a rendered image of each vehicle. There are no
vehicle images in this project — it ships models — so `GarageThumbs` makes them: a hidden
offscreen canvas shoots each vehicle once in the same white studio, sharing the stage's loader
cache, and keeps the result in `localStorage`. On a return visit all twelve are on screen before
the first model has downloaded. The cache key is versioned so a changed shot re-renders.

**Nothing moves when you change vehicle.** A fixed grid — 76 px header, stage, 176 px footer
— with every overlay box at explicit dimensions: two lines reserved for the name, a fixed-height
blurb, fixed-width tabular numerals with a fixed unit cell, a counter that holds `01 / 08` and
`01 / 01` in the same space. The spec panel is frosted glass, not a solid card — see below for
why that matters more than it sounds like it should.

Barlow and Barlow Condensed throughout, self-hosted via `next/font`. Chrome is raised, not
flat: lit top edge, shadowed lower edge, cast shadow; tabs and the wordmark plate cut at an
angle; the button a slab with a real edge under it and a sheen that passes across it.

**Framing a 4.3 m car and a 24 m tram with one camera.** `garageStudio.ts` holds the shared
framing math — used by both the stage and the thumbnail renderer, so a vehicle looks like the
same object in the roster as it does on the turntable. Every car and truck in this garage sits
within a 2.1–3.3 length-to-width ratio; the tram is an outlier at 9.1, and the two things that
work fine for a boxy vehicle both broke on it. (It was 15.8 when the tram was a 43.5 m
Flexity. Because both corrections below are *interpolated* on that ratio rather than switched
on at a threshold, swapping in a tram half the length needed no retuning — it simply lands
part-way along the same curve, which is the point of writing it that way.)

- A **fixed 3/4 angle** is the right "car" shot — it shows the face and the flank together —
  but at that angle a train-length vehicle is seen almost end-on: its silhouette collapses to a
  sliver and perspective stretches the near end while the far end recedes to a point. The
  azimuth now eases toward broadside as elongation (length ÷ width) climbs past 3, which is
  why a transit agency's own press photos are broadside rather than 3/4 — it shows the full
  length at a consistent distance from the camera instead of foreshortening it into depth.
- A **bounding-sphere fit** is generous to a boxy car, where most of the sphere sits close to
  the body, and wrong for a long thin one: nearly all of the sphere's volume is empty air
  around a 2.65 m-wide, 24.1 m-long body, so the fit distance ends up governed by the short
  axis and the vehicle renders small in the middle of a lot of unused frame. Distance is now
  fit to the vehicle's actual silhouette at the chosen azimuth — `w·|cos θ| + l·|sin θ|`, the
  exact width of a box's orthographic projection — which is correct for any aspect ratio.

Both thresholds are gated so every car and truck here (none reaching even half the elongation
that trips them) renders exactly as it did before; only the tram is affected.

**The stage backs off further than a tight fit.** `frameVehicle` takes an optional `marginMul`,
and the stage (not the thumbnail renderer, which wants its tile filled) passes `STAGE_MARGIN =
1.55` so the hero shot reads as a car on a turntable with room around it rather than something
cropped to the frame edge. That margin is itself tapered out by the same elongation factor `t`
used for azimuth and pitch above — `lerp(marginMul, 1, t)` — because the tram's fit distance is
already large from fitting a 24 m length rather than a ~4 m one, and multiplying an
already-large distance by a compact car's zoom-out pushed it back far enough to shrink to a
sliver in the middle of an empty stage. A car near elongation 3 gets the full 1.55×; the tram,
at `t = 1`, gets none, and keeps the tight framing it was already tuned against.

**The picker arrows use the same raised-chrome recipe as everything else on this screen.** An
earlier version made them a separate motif — a metallic disc with a tick-mark rim borrowed from
the turntable decal, a hover halo, and a stacked double-chevron — which was too busy to read
cleanly at 64px and looked like its own decoration rather than part of the same UI. They are now
the plain `RAISED` card (the same lit-top/shadowed-edge white disc raised cards use elsewhere)
with one bold accent chevron; simpler reads as more consistent, not less designed.

The car used to be pushed left of centre in world space — `camera.lookAt(-distance * 0.16, …)`
— to dodge the spec panel, with the offset scaled by the fit distance. That distance is
roughly 10–19 m for a car and, under a sphere fit, around 97 m for the tram: the offset scaled
with it, landing the look-at point more than 11× the tram's own half-width away from its
centre. On screen the tram appeared to float off from the turntable ring, which sits at the
true world origin and does not move. The camera now always looks dead centre, and the panel
is translucent (`backdrop-blur-md` over `rgba(255,255,255,0.72)`) so any overlap with the
vehicle reads as a HUD sitting over the scene — which is what it is — rather than as a wall
the vehicle is hiding behind.

Things worth knowing if you change it:

- Both `GarageStage` and `GarageThumbs` are `ssr: false` — they touch WebGL during render.
- The Canvas is mounted once with only the model swapped inside; keying the Canvas would
  rebuild a WebGL context on every arrow press.
- The camera sits on the **−Z side** because every vehicle faces −Z.
- An articulated vehicle must be **laid out** — the tram's sections all sit at the origin
  in the file; rendered as-is they stack into one section's worth instead of the whole tram.
- The root grid needs `grid-cols-[minmax(0,1fr)]`. Without it the single column sizes itself to
  the header's non-wrapping width, the page grows wider than the viewport, and the spec panel,
  right arrow and turntable all drift off-screen behind `overflow-hidden`.
- The first cut of the thumbnail renderer lit the scene with three flat lights and nothing for
  the vehicle to reflect or sit on — no environment map, no floor, no shadow. A PBR body with
  nothing to reflect reads as dull plastic no matter how many direct lights point at it; paint
  reads from what it reflects, same as the stage. `GarageThumbs` now shares the stage's own
  `studioEnvMap` and gets a cheap radial "ground blob" standing in for a contact shadow — a
  real shadow map is not worth its cost for a canvas that renders one frame and is discarded.

**Two tools for adding a vehicle.** `npm run inspect -- <file.glb>` measures a source model
and prints what a garage entry has to state but geometry cannot tell you: which axis is the
length, which is the width (by symmetry — a vehicle is symmetric across its width and not
along its length), whether it is Z-up, and the radii of anything round near the ground. And
`WHEEL_DEBUG=1 npm run prepare:garage` prints, per part, exactly which test the wheel hunt
rejected it on. Both exist because guessing was expensive: the monster truck lost its wheels
to a radius ceiling by four centimetres, and the Dodge lost its to being one mesh per
material, and both took a minute to find with these and would have taken much longer without.

Sources for the studio technique: [Automotive Lighting 9: Studio techniques](http://www.photocornucopia.com/1045.html)
(the cyclorama, "light the walls", and blacks as a false horizon) and
[How to set up automotive studio lighting in Unreal Engine](https://irendering.net/how-to-set-up-automotive-studio-lighting-in-unreal-engine-part-1/)
(area lights both sides, spots for lamps and wheels, a simple scene).

## Riding the tram

The city already had a tram line running through it, with a scripted service on it
(`railConfig.ts`, `RailLoop.tsx`). It is now a **figure-eight**: the route crosses itself
once, at ninety degrees, and the tram runs straight through that crossing twice a lap —
once westbound, once northbound. The tram is also **something you
can take out yourself**: it appears in the vehicle picker alongside the cars, and
`?car=tram` puts you in the cab.

The vehicle is a Gold Coast G:link tram (Bombardier Flexity 2) in its yellow-and-blue
livery. It replaced a Melbourne C-class, which had itself replaced an earlier G:link — see
**Preparing the tram** below, which is now a much shorter piece of work than it was, because
this model arrives in a state the C-class's export never did.

**Six camera views, and now all six are different shots.** The tram is offered the rail
vehicle's mode list, because anything with a `rail` gets `RAIL_CAMERA_MODES` — but
`updateRailCamera` only ever ran for the main-line train, so five of the six fell through to
the *car's* chase rig and were the same picture under five names. Pressing C changed the
label in the corner and nothing else. `TramCamera.ts` gives it its own rig on its own route,
and `TRAM_CAMERA` gives it street-scale numbers, because the main line's are built round a
147 m rake at 300 km/h in open country and put the camera inside the shopfronts here. Two
things needed thinking about rather than scaling:

- **The chase has to get behind the whole tram.** The camera anchor is the leading *cab*, and
  the cab is at the front of a 43.5 m vehicle, so anything under about 40 m back is inside
  the tram. The main line answers that by standing 12 m out to the side; a tram is short
  enough to solve it properly, so this sits 50 m back and only 2.5 m off the centreline —
  which also keeps it out of the street trees, the one thing at camera height on a footway.
- **The ground under a planted or aerial shot is the street's**, read from the nav grid, and
  read at the *centreline* rather than under the camera. Sampling it 7 m out, where the
  camera actually stands, makes the shot hop by whatever a kerb, a verge or a central
  reservation differs by; the tram's own ground is smooth because the route was laid on it.

The overhead and drone shots also had to be steepened. Both started at the main line's
angles, looking along the vehicle from behind — which over a tree-lined street is a shot
through one canopy after another.

It is deliberately not treated as a car. At 43.5 m over seven articulated modules, with no
wheel pivots and no steering, running it through a physics model calibrated on a 4.3 m
McLaren would be nonsense — and it would not fit down most streets here. So `TramRide`
replaces `CarPhysics` outright rather than configuring it: the route is already parametrised
by arc length, so driving a tram is one scalar pushed along by a throttle and a brake, and
the rails do the steering.

What that gives you is a vehicle that has to be *driven ahead of itself*. The acceleration
and braking figures are the real ones — 1.15 m/s² away from a stop, 1.8 m/s² on the service
brake — so it takes about 17 seconds to reach the 70 km/h line speed and roughly 150 m to
stop again. Reverse is a slow shunt, capped at 4 m/s, because you cannot see behind you.

- **Nothing gives way to you.** The tram is seven kinematic bodies, exactly like the service
  trams and the traffic, so cars bounce off it and it does not care.
- **But you do queue.** Two kinematic bodies do not collide in Rapier, so a tram would
  otherwise drive straight through another one — and it is not a corner case, since you can
  out-run the service and a player who simply *stops* gets rear-ended within twenty seconds.
  Every tram on the line therefore asks the same shared registry what is ahead of it and
  brakes for it, player included. Measured: a service tram closing on a stationary player
  settles at the minimum gap instead of passing through it.
- **The camera is framed on the cab**, not on all 43.5 m. Camera offsets scale with vehicle
  length, which is right for cars and would put the rig 60 m back for the tram — down among
  the traffic, watching a distant object rather than driving one. `rigSize` overrides that,
  so the eye sits about 12 m behind the cab and 7 m up, clear above the roof.
- Steering, the handbrake, boost and `F` (flip upright) do nothing on rails, and the engine
  sound is silenced — a tram has no engine to fake. The dial shows tractive load instead of
  RPM so it still says something true, and the boost arc is not drawn at all rather than
  drawn full and inert.
- The tram is offered **only in the city**, because its route is measured city streets; there
  is no track for it on the circuit.

## Finding a tram route

`npm run route:tram` searches the city for a self-crossing loop and writes
`src/config/tramRoute.json`, which `railConfig.ts` reads. It invents nothing: candidates are
checked metre by metre against `cityNav.png` — the same road/height raster the car's reset
and the traffic AI use — and one is accepted only if the entire route, corner arcs included,
is on pavement with a tram's width of clearance either side and flat to within a metre.

The shape is a closed rectilinear polyline over three streets each way, arranged so two of
its legs cross:

```
      x0      x1      x2
 z0    .──────┬───────.      (x1,z0) → (x2,z0) → (x2,z1) → (x0,z1)
       │      │       │              → (x0,z2) → (x1,z2) → back to (x1,z0)
 z1    .──────┼───────'
       │      │
 z2    '──────'
```

The crossing at `(x1, z1)` is deliberately not a vertex — it falls in the middle of two
legs, which is what makes it a crossing rather than a corner.

```bash
npm run route:tram            # a new random route
npm run route:tram -- 12345   # that exact route again
```

The search is random but bounded: it collects two dozen valid routes and picks one, and only
accepts laps between 1.3 and 3.6 km. Without that window the first accepted candidate was a
7.7 km lap — nine minutes a circuit, so you would essentially never meet a tram.

Two things the geometry had to grow up for. Arc length is still closed-form (straights and
circular arcs, nothing else), so the tram is parametrised by distance travelled and runs at
exactly constant speed with no numerical integration — but the segment list is now built from
the polyline rather than hard-coded, and corners are cut with the general `R · tan(θ/2)`
tangent so a future diagonal route does not come out wrong. And `railConfig` asserts at load
that the route passes through its crossing point **exactly twice**; a route that is not the
shape the module thinks it is fails loudly instead of quietly disabling the logic below.

**A crossing is not free.** Two trams can be metres apart on the ground while being half a
lap apart in arc length, which is precisely the case `physics/tramTraffic.ts` could not see
by comparing gaps. Every tram now also asks whether anything is about to occupy the junction
and defers to whoever reaches it first, with the tram id as a tie-break so two arriving
together cannot both yield — or both refuse to. The callers brake on the same number they
always did and need no idea why it shrank.

## The main-line railway

> **The route is drawn, not chosen.** `src/config/trainSketch.json` holds the line traced from
> the user's sketch over the city map — the blue route, the orange tunnel spans and the two
> islands — in that sketch's own pixel coordinates, together with the transform that
> georeferences them. The generator searches a **±150 m corridor** around it rather than
> laying track straight down it: the trace is only good to about ±40 m, and A\* is still what
> keeps the line out of buildings, off the roads and under the hills. Everything the old
> chooser did — farthest-point sampling, a 2-opt tour, a coastal band — was there to guess at a
> route, and is gone.
>
> `TRAIN_LINE_ENABLED` in `src/config/trainConfig.ts` gates the whole thing: line, structures,
> locomotive, minimap trace, the terrain cut, and the sea. The sea belongs to the railway
> because it is one flat plane at -3.6 m spanning 12 km, and the map puts 4,406 cells of
> drivable ground below that line — the underground car park ramps and the low ground at the
> edges — which the water slices straight through. Only a railway bridging the bays is worth
> paying that for.
>
> **Two islands are created** in the northern water, from the shapes in the sketch. The drawn
> route crosses 2.4 km of open sea up there and a single span that long is not a bridge, it is
> a causeway with ideas; the islands break it into four crossings, none over a kilometre, and
> give the line somewhere to come back down to sea level. They are the same numbers in the
> generator (which treats their interior as ground) and in `TrainLine` (which builds them), so
> the two cannot disagree about where the land is. Nothing is deleted — the route file, the generator, the
> geometry and `TrainRide` are all intact — so flipping the flag back to `true` restores the
> railway exactly as described below. The rest of this section documents it as built.
>
> **Two tracks, the whole way round.** The second track is the *down line*: 4.6 m to the left
> of the running line everywhere, with its own service running the other way round the loop.
> Through the island station it fans out to become road 1, so platform A is an island between
> the two through lines and the outer pair are loop roads round platform B, rejoining beside the
> down line at both ends. The underground station is a 200 m twin-platform hall — a platform
> each side, one per track, under low ceilings on green columns, with a tall lit bay over both
> tracks, tiled walls with a name frieze, exit portals, posters, benches and hanging signs.
> Bores, cuttings, portals, decks and the terrain carve are all centred on the *pair*
> (`src/config/trackPair.ts`), not the running line, so neither track hugs a wall.
>
> **It is dark in the tunnels.** The scene's sun, sky and environment light fade with the train's
> depth into a bore — daylight reaches about a hundred metres in and gives out, both ways — and the
> fog goes short and black, so a bore is lit only by what it carries:
> lamps at a fixed pitch down each wall, each throwing a pool of light on the concrete, the
> walkway and the invert; cable trays, handrails, painted walkway edges, refuge niches, exit
> signs and distance boards, soot on the crown and grime at the wall feet.
> Every locomotive carries headlamps whose beam fades in with that same darkness — white and lit
> on the leading end, red on the trailing one — and the underground station is finished in the
> bore's own concrete and lit by the bore's own lamps, so tunnel, throat and hall are one structure.
>
> **The line is equipped.** Concrete monobloc sleepers with clips at 0.65 m, flat-bottom rail,
> cable troughing in the cess; four-aspect colour-light signals every 450 m on each track that
> read real block occupancy — every train, yours and the AI services, reports its position — so a
> signal shows red, yellow, double yellow or green for what is actually ahead; speed boards where
> the limit changes, kilometre posts, tunnel boards; and a full overhead line, Indian Railways
> style — an H-section mast for each track down both sides, each with its own cantilever and
> insulators, a staggered contact wire and sagging messenger with droppers in the open, a rigid
> conductor rail on drop rods through the tunnels and the station.
>
> **The crossing between the two islands is a steel Pratt through-truss bridge** with inclined end
> posts — square panels, one diagonal a panel sloping to mid-span, latticed portals, an X-braced
> top, floor beams and stringers, a walkway with handrail, bearings on concrete piers — the train
> runs through it at bottom-chord level and the wire hangs from the top struts.
>
> **From the small island to the city the line crosses a three-tower suspension bridge** — red
> portal towers at the quarter points, main cables draped saddle to saddle and down to anchor
> blocks on each shore, hangers every six metres to a box-girder deck with parapets.
>
> **The station's throat is pointwork, not a tangle.** Four roads on one continuous ballast
> formation, each converging on the down line at a steady turnout angle — the down line at 1 in 15,
> the loops at 1 in 11 and 1 in 7 — so every loop begins and ends at the main line and none of them
> stops in the grass. The roads follow the railway's own curve rather than a straight projection of
> it, which is what used to leave the western turnouts pointing at nothing.
>
> **The station island carries a town.** Two through streets with kerbs and pavements, a back
> lane, cross streets, a forecourt, a car park and eleven rows of the city's own buildings, with
> its trees and street furniture along them, street lamps, a lineside fence, and a forecourt with
> a bus shelter, a taxi rank and benches. The cars parked in the streets and the
> station car park are the game's own vehicles standing still, a different one in every bay. A
> level crossing joins the two halves of the town — concrete deck panels between the rails, a
> yellow keep-clear box, stop lines, anti-trespass aprons, crossbucks, pedestrian wickets and a
> relay cabinet — and its barriers actually fall, and its red lamps flash, when a train is coming. The island was made half as deep again to hold it all.

The tram is street furniture. The **railway** is the other thing: a 4.9 km loop right round
the city on the main landmass — on ballast across the open ground, over the streets and the
southern bay on viaducts, and through the hills in three tunnels, the longest 312 m.
`npm run route:train` searches for it and writes `src/config/trainRoute.json`;
`src/config/trainConfig.ts` reads that and `TrainLine.tsx` builds it.

```bash
npm run map:obstacles            # rebuild the obstacle raster (only if city.glb changes)
npm run route:train              # a new line
npm run route:train -- 12345     # that exact one again
ROUTE_PREVIEW=out.png npm run route:train   # …and a plan-view PNG of it
npm run prepare:train            # re-process the locomotive
```

Everything about where the line goes and how high it sits is decided offline. Nothing is
searched, sampled or generated at runtime, and the points arrive already smooth.

**The search knows what is actually there.** It used to take its obstacles from
`cityData.boxes` — and those are *collider* boxes, which `prepare-map.mjs` only makes for
primitives under 40 m across, because a single AABB round the beach plane would encase the
city. So every building bigger than forty metres was missing from them, and vegetation was
never in them at all. The line went through both. `npm run map:obstacles` now walks the
finished city mesh and rasterises every non-ground triangle onto the nav raster's own grid:
**red for solid** (buildings of any size, walls, signs, props) and **green for vegetation**.

They get different clearances — 8 m from solid, 6 m from trees — because a railway demolishes
one and fells the other. Six is the floor for either, whatever the reasoning: the tunnel bore
is 5.25 m to the outside of the lining, so anything nearer stands *inside* the tunnel. At 3 m
a tree did, hanging in the bore like a stalactite.

**Three more rules the route obeys**, all from driving earlier versions:

- **Never on a street.** Every road cell becomes a bridge with 5.5 m clearance under it, and
  road is priced at 200× grass so it only touches one where a loop genuinely cannot avoid it.
- **Never on the beach.** Anything below −1.2 m is water: the raster carries the foreshore
  down to −3.6 and the map draws its own shallow water over it, so the first line ran through
  the lagoons.
- **Never doubling back.** Cells used by one leg cost 120 to reuse, and any cell still visited
  twice bounds a spur that is excised. Without both, legs share the one sensible corridor
  through narrow ground and the loop folds onto itself — which showed up as 180° corners and
  clusters of 6 m squares that no radius could fillet.

**Where it goes: a tour along the coast.** The anchors were once a ring of bearings out from
the centroid, which is by construction a small convex loop — under 5 km here however the
bearings were placed. Now every buildable cell in a band along the shore is a candidate; a
well-spread subset is taken by farthest-point sampling biased towards high ground; and they are
ordered by angle then improved by 2-opt, which is the cheap classical way to get a tour that
does not cross itself. Confined to the shore rather than spread over the whole landmass, it
comes out as a loop *around* the map instead of a tangle weaving across the middle of it.

Two things had to be right. Anchors must be on the **mainland** component — the raster reaches
2.7 km east of the city and a stray primitive out there became an anchor, sending the tour into
open ocean. And legs must not share corridors: reuse costs 400 cells over a two-cell corridor,
because the alternative is the spur-removal pass amputating the overlap, and that cost 40% of
one loop in a single cut.

**It goes under what it cannot go round.** Where the coast is built up, the legs dive beneath
it: `BORE_COST` lets A\* drive a tunnel through blocked ground, and there is no height bar on
it any more, so the line will pass under the city as readily as through a hill. The worry was
that nothing is modelled beneath these streets — but a bore there cannot be seen. The lining is
drawn `BackSide`, so from outside it draws nothing, and the terrain above is untouched.

Two things that *are* seen, and both had to be fixed. Half the loop now runs below the
waterline, and the sea is one flat plane at -3.6 m stretching under the whole map: it sliced
horizontally through every bore, filling the lower half with the underside of the water. The
sea now takes the same cut the terrain does. And the shader's segment cap was silently
overrun — the guard added for exactly that caught it at 139 against 128.

**Curves are opened out deliberately.** After filleting, any corner the fillet could not get to
`DROP_BELOW` is a vertex with too little straight either side of it, so it is dropped —
provided the straight replacing it is clear — and the line is filleted again, up to fourteen
times. A chord may cross something solid, because the line goes *under* it; only the length of
a single bored run is limited (`MAX_BORE_RUN`), or the simplifier draws one chord across the
whole city and the loop becomes a single five-kilometre tunnel. Refusing to cross obstacles at
all, which is what it did first, is what left every jog between two buildings in the alignment
as an 11 m corner.

A\* runs between consecutive anchors **with heading in the state**A\* runs between consecutive anchors **with heading in the state**A\* runs between consecutive anchors **with heading in the state**: eight states per cell, one
per direction of arrival, so a turn can be charged for (250 grass-cells per 45°). A plain grid
search turns whenever it is fractionally shorter and its output is a staircase no smoothing
will fix.

Water is priced by **how far offshore it is**, not flat. One flat price cannot do this job:
cheap, and the line strikes out to sea and rings the map on 6.8 km of viaduct; dear, and it
will not cross the bays at all and collapses to a thin oval. Distance from land is the missing
term — crossing a bay stays affordable because the far shore is close, running parallel to the
coast a kilometre out does not.

**Straights and arcs.** The searched cells are straightened with Douglas-Peucker (bounded by
the obstacle mask, not by fidelity to the search) and every corner filleted with a circular arc
at the largest radius its straights allow, up to 400 m, tightened until clear. If no radius
fits, the corner is left sharp rather than left clipping.

```
5.19 km loop, 865 points at 6 m
11 corners; radius min 6 m, median 72 m
12 structures over 2.87 km, longest 510 m — 1.11 km over water, 0 m over streets
10 bores over 1.76 km, longest 324 m
4 enclosed stretches (bores plus the galleries joining them), longest 1110 m
grade: median 1.8%, worst 4.0% (ruling 4%)
0 points inside the clearance
```

**It bores rather than detours.** Blocked ground used to be a wall, so the only way past a
hill or a block of buildings was the corridor between them — which is what made the ashore
alignments wind, and what kept pushing the good ones out to sea on kilometres of viaduct. The
search can now drive a **tunnel** through ground it cannot cross (`BORE_COST`), which is what a
railway does with a hill that size. There is a height bar on it (`BORE_MIN_GROUND`): there has
to be enough ground above the rail to bury a bore in, and this map has nothing beneath its
streets — a tunnel under the flat city would hang in the void below it.

**Long sea viaducts are out.** They take the train past the edge of the built map, where there
is nothing to look at, so water is priced high and `OFFSHORE_COST` higher. Reclaiming the sea
as causeway instead was tried at scale — 3.6 km of it on a 6 km loop — and it looks like
exactly what it is, land invented in open water. The machinery is still there behind
`MIN_CAUSEWAY`, currently `Infinity`, if a crossing ever comes out too long to bridge.

**Bores, cuttings and portals.** A bore needs about 9 m of cover before the hill actually
encloses it (`BORE_COVER`) — the arch stands 8.5 m over the rail. Below that the line runs in
an **open cutting**, excavated by the same shader that cuts the bores but as a battered trench
with no roof. That is what fixed tunnel mouths standing as free-standing arches in flat fields
with a metre-high "hill" behind them: the portal now sits where the ground is genuinely deep
enough to drive into.

A **portal is only drawn where the mouth meets a cut face.** It is a wall built against an
excavation; set straight into a hillside it buries most of itself and leaves its top corner
hanging in mid-air as a slab. Where a bore simply begins under deep cover, the hole in the
rock is the portal. It is also a plain ring now, a little larger than the horseshoe — the
coping and splayed wing walls it used to have were the parts that hung in the air.

Nothing is drawn inside a bore but the track. There were lamp fittings on the arch haunches;
they are gone.

```
7.79 km loop, 1298 points at 6 m
14 corners; radius min 124 m, median 272 m, none tighter than 60 m
10 bores over 2.49 km, longest 720 m · 5 cuttings over 0.46 km
11 structures over 2.74 km — 1.57 km over water, 744 m over streets
1.26 km on reclaimed causeway
0 points inside the clearance
```

**The dials.** `ANCHOR_SPACING` and `COAST_BAND` set how long the loop is and how close to the
shore it stays. `SIMPLIFY_TOLERANCE` and `DROP_BELOW` set how hard the alignment is straightened
— 180 and 110 give fourteen corners at a 272 m median. `MIN_CAUSEWAY` trades reclaimed land
against bridge: at 650 m only the longest crossings are filled. `BORE_COST` is worth knowing
about mostly for what it *cannot* do: raising it from 8 to 400 does not reduce the tunnelling,
because the bores are how the line gets past a built-up coast at all — at 400 it went up, the
alternatives being worse.

**How it is built.****How it is built.****How it is built.****How it is built.** `railGeometry.buildLoft` sweeps a *cross-section* along the centreline,
where `trackGeometry.buildRibbon` only sweeps a flat strip. Everything the line is built from
has a shape — the ballast bank is a trapezium whose toe moves out as the fill deepens, the
deck is a box with a parapet up each side, the rail is a small box section, the tunnel lining
is a horseshoe with its invert. Which way a face points comes from the profile's own winding,
read off its signed area — not from "away from the centroid", which is only right for a convex
section and turns a deck's parapets inside out. Sleepers at 0.7 m and piers are instanced;
ballast is a canvas-drawn stone texture at a tile per metre.

**The tunnels are holes in the hill, not linings drawn inside it.** Every material in the map
is double-sided, so a lining inside solid terrain is sliced through by the hillside wherever
the cover is shallower than the bore — the first fifty metres in from each portal, seen from
inside as a green ceiling across the arch. There is no fixing that with geometry on a mesh
nobody can edit; `CityMap` patches the terrain shell's fragment shader to **discard every
fragment inside the bore** — a horseshoe swept along `tunnelSegments()`, the same
`boreHalf`/`boreWall` the lining is built from, plus a quarter-metre — and bounded to the
segment's own length, because unbounded it carved a channel along every segment's line
through every hill on the map. The lining itself is rendered `BackSide`: a continuous
shuttered-concrete tube from within, nothing at all from outside, with a pair of warm unlit
lamp fittings on the haunches every 14 m so the dark reads as a tunnel and not as a hole in
the renderer. Inside is slab track — no ballast, the sleepers bed onto the invert.

The lining is also very nearly **unlit**, and that matters. Nothing in this scene occludes
light, so the sun reaches inside the hill; with an ordinary lit material the invert, a flat
surface square-on to a 48° sun, came out brighter than anything else in the bore and read as
a sheet of white glass under the sleepers. A near-black diffuse leaves the sun almost nothing
to pick up and an emissive carries the concrete instead, so wall, arch and floor are one even
tone lit by the lamps rather than by a sun that should not be in there. The portal headwall is a `Shape` with the horseshoe as its hole, extruded, so the
opening matches, with a coping along the top and a splayed wing wall each side. The bore is 10 m wide and 8.5 m to the apex — big for one track, so that the
chase camera, which rides 7.7 m up, is inside it and not in the hillside.

**Colliders are on the decks and the causeway crown.** A bridge a car can drive through is
worse than no bridge, and the causeway is land — something that gets onto it should stand on
it rather than drop into the sea. The ballast, by contrast, would be kilometres of kerb across
the open ground.
The terrain's colliders are untouched by the cut, so a car driven into a tunnel mouth hits
the hill it can no longer see.

**The locomotive.** A British Rail Class 91 power car in InterCity Swallow livery, prepared
by `npm run prepare:train` into `public/models/train.glb` and `src/config/trainData.json`.
It arrives already in the project's frame — X across, Y up, nose towards -Z — so the script
measures rather than rotates, and it confirms the cab end from the roof line rather than
trusting a node name: a Class 91 is a wedge at one end and a slab at the other, and a
locomotive that runs the whole loop backwards is not a subtle bug.

It is stood on the curve at **two** points, its bogie centres, rather than at one. That is
not a nicety — the line has 30 m radii and the body is 19.4 m, so a single-point placement
swings both ends about a metre and a half clear of the rails through every corner. The chord
between the two bogies gives the heading, and gives the pitch for free, which matters on a
line allowed 6%. The pose comes out of a `lookAt` basis rather than a pair of `atan2`s,
because Euler angles for yaw-and-pitch mean picking an order and getting it right.

The one disappointment is the triangle count. The source is 661 k and the simplifier will not
take it below 276 k however it is asked: three `Body` primitives worth 95 k give back
35,005 of 35,269 at every target and every error, and welding by position — the obvious
suspect at 65,533 vertices over 13,492 distinct positions — makes it *worse*, and takes the
roof meshes down with it (they decimate cleanly as they are, 72 k to 11 k). So one locomotive
runs the line rather than two; `TRAIN.count` is the knob, and a second one wants the
visibility cull the Melbourne tram had.

**Driving it.** The Class 91 is in the garage under RAIL at 300 km/h alongside the tram, and picking it
swaps `CarPhysics` for `TrainRide` exactly as the tram swaps in `TramRide` — a rail vehicle
has no steering and no suspension worth simulating, and the line is already parametrised by
arc length, so driving one is a single scalar pushed along by a throttle and a brake.

Two things make it a train rather than a long tram:

- **Permanent speed restrictions**, from the line's own curvature. The route is a searched
  path smoothed into a curve, not a surveyed alignment, so it has 30 m corners in it, and a
  locomotive taken through one at 250 km/h does not read as fast, it reads as broken. The
  radius comes from the circle through three points either side and the limit from
  `sqrt(a·r)`; `LATERAL` in `trainConfig` is the knob. With the tightest corner now 83 m
  the restrictions bind far less than they did on the searched-grid line, and the straights
  are clear for the full 300. `?arc=<metres>` starts the locomotive that far round the loop —
  the railway's `?spawn=`.
- **You start on one running line or the other, at random**, the way a drive starts on a
  different street each time. It comes with a *facing*: this is a double-track railway worked
  properly, with the services running up the up line and down the down line, so a train put on
  the down line pointing the way the up line runs would not be on the other track, it would be
  wrong-line running — every service it met would come at it head-on and stop. The down line
  therefore spawns the train turned round, and the driver's forward is that way. One number in
  `TrainRide` (`FACING`) converts the driver's frame into the line's, so the pointwork, the
  overspeed guard and the train registry all keep talking in arc. What that split does cost is
  that **`forwardSpeed` is no longer the line's direction**, and anything that had been using it
  as one is wrong by 180°: the rail cameras were, and put the chase rig in front of the train
  looking away from it. They take `telemetry.railFacing` now and keep the two apart — which end
  of the rake leads is the driver's question, where to plant a shot is the line's.
  `?road=up|down` pins the spawn. The same split caught the chase rig a second time, more
  quietly: its *lateral* offset was unsigned, and `beside` measures left of the **arc**, so the
  rig stood on a fixed side of the line rather than a fixed side of the driver — the driver's
  left running up, his right running down. Nothing moved the train, but the shot mirrored
  between the two spawns, and since the second track is always on the driver's left (this
  railway runs on the **right**, both roads, at every arc) a down-line spawn framed it on the
  wrong side and the ride read as wrong-line running. The side is multiplied by `way` now,
  exactly as the cab's always was.
- **Which way each road is worked lives in one function** (`runsAlongArc` in `railSpawn.ts`).
  The up line runs up the arc and the down line, which is `secondTrackGap` along
  `trainNormalAt` — the **left** of increasing arc — runs back down it, so each driver has the
  other road on his left: the line drives on the right, like the city's streets. It had been
  said twice, once in `TrainRide`'s spawn and once in `Service`, and saying it once is what
  stops the player and the services from ever working a road in opposite senses.

  It was briefly inverted here on the strength of a misread chase view, and the symptom was
  exactly the complaint it was meant to fix: the other track moved to the driver's **right** on
  both roads. A chase rig is offset to one side and is no way to judge this. Take the driver's
  forward `f`, form his left as `(f.z, -f.x)`, dot it with the vector to the other road's
  centreline, and believe the sign.
- **The services keep off the player's road, whichever road that is.** The up line used to
  stand down by name, which was right only while the player could only start on the up line.
  Once the spawn began picking at random, a down-line start put the player on the road carrying
  all four services, all going the same way, with the up line empty — so nothing ever came the
  other way and the only encounter available was overhauling a 150 km/h service from behind
  with no way past. `railSpawn.playerRoad()` is cached and read by both modules, so the ride
  and the line agree on which road is the player's, and the four services always run on the
  other one, toward you.
- **An overspeed system, not an autopilot**, working in both directions. The train will not let itself be faster than the
  line ahead allows, and finds that out by looking forward as far as the brake could bring it
  down from — each restriction relaxed by what the brake can shed on the way to it. It never
  opens the throttle for you. Without it the only way to enforce a limit is to snap the speed
  down at the board, which is not braking. Both directions matters because **reverse runs at
  the same 250 km/h**: the tram holds its reverse to a 4 m/s shunt on the grounds that you
  cannot see where you are going, but a locomotive running long-hood-first at line speed is a
  real thing, and a guard that only looked forward would leave the whole line unrestricted
  backwards. The vehicle is not turned round to do it — the blunt end simply leads.

The acceleration and brake figures are deliberately **not** a real locomotive's. A light
Class 91 does 0.9 m/s² and stops at 1.6, and those were the first numbers here: honest, and
no fun on a 9.2 km loop — 0.9 needs two and a half kilometres to reach the ceiling, so you
never see it, and 1.6 makes the overspeed lookahead a kilometre and a half, so the train
brakes for corners it cannot see and never gets going. 3.0 and 3.5 keep it unmistakably a
train — twenty seconds and 900 m to line speed, 700 m to stop — while making the whole loop
drivable. Both are in `TrainRide`.

The chase rig is anchored at the **body centre**, unlike the tram's, which is anchored at its
leading cab. The tram has to be: at 43.5 m a rig framed on the whole vehicle sits 34 m back
among the traffic. One 19.4 m locomotive is the opposite problem — anchored at the cab, the
chase offset lands on the roof with fifteen metres of locomotive stretching towards the
camera. The map arrow and the compass still read from the cab, which is where the driver is.

**The camera reins itself in underground.** The open-air chase rig sits fifteen metres back,
up to 8.4 m high at speed, and swings up to half a radian wide through a corner — which
throws the eye seven metres sideways. The bore is 5 m to each wall and 8.5 m to the apex, so
all three had to come in or the camera spends every tunnel inside the lining and, at a portal,
inside the hillside (which is only cut where the bore is). `TrainRide` reports a 0..1
`enclosed` on the telemetry — true if the vehicle *or* either end of the camera's reach is
inside, damped over about ten metres of travel — and `ChaseCamera` blends distance, height,
swing and yaw follow toward a tight rig by it. Inside, the eye ends up 11 m back and 5.4 m up
on the centreline, with three metres of clearance to the arch at 300 km/h.

It is deliberately *not* a separate camera mode. Cutting to a different rig at every portal
would be far more intrusive than the tuck, and would take away the frame the driver chose;
this is the same camera, briefly better behaved. Cars never set `enclosed`, so nothing about
them changes.

Both railways are drawn on the minimap and the M-key map: the tram loop in teal, the main
line in amber.

**The sea is new, and it is not decoration.** `prepare-map.mjs` rasterises only drivable
surfaces, so everything off the coast comes back as void. That was invisible while the game
stayed on the roads and stops being invisible the moment a railway bridges a bay. The surface
sits at -3.6 m, just under the beaches; one plane, in `Environment.tsx`, city only.
`TRAIN.seaLevel` and the finder's `SEA_LEVEL` have to agree.

> The vehicle picker and the tram loop themselves are not yet written up here — they were
> added separately from the notes above.

## Preparing the tram

`prepare-tram.mjs` turns `gold_coast_glink_light_rail_tram__flexity_2.glb` (7.8 MB,
`source-models/`, untracked) into `public/models/tram.glb` (3.9 MB) plus a measured
`src/config/tramData.json`, via `npm run prepare:tram`.

It is a quarter of the length it used to be, and the reason is the asset rather than a change
of mind. The C-class export it was written for was 2.86 M triangles of SketchUp geometry
authored per *material*, so it had to be visibility-culled from 26 viewpoints, cut into
sections triangle by triangle at a measured bellows position, and simplified to a budget it
fought all the way. This export needs none of that: **60 594 triangles**, a quarter of the
whole city, authored **one node per module** the way the real vehicle is built, and
proportioned correctly — scaled by its real 43.5 m length the width lands at 2.63 m against
a real 2.65, so unlike the C-class there is no judgement call about which ruler to trust.
Nothing is culled and nothing is decimated. What is left to do is four things.

**The seven modules are found by measurement, not by name — because the names lie.** There
are five distinct `glink_seg*` names for seven modules, they repeat between the two ends, and
the doors named `seg2_*` include the ones in the centre module. What is reliable is size and
position: a mesh that spans nearly the full body width and metres of its length is a
module-scale mesh, and the module centres are the clusters those fall into. The script
asserts it found seven and prints them with their pitch, so a different tram fails loudly
instead of quietly coming out as one rigid body.

**Every other node is assigned to a module by where it sits**, cutting at the midpoints
between module centres — which puts each door, wheel, bogie and window strip in the module it
belongs to. A rigid 43.5 m body cannot follow this loop's 10 m corners; seven bodies of about
6 m can, and each is placed on the rail at its own arc length. No geometry is cut, so a mesh
that overhangs its own module (the mirrored shell halves reach about 0.4 m past a joint)
simply overlaps its neighbour — which is what you want at an articulation joint anyway, since
sections placed at fixed arc-length offsets move *closer* together on a curve, never further
apart.

**The glazing is sorted out from the bodywork by measured texture alpha, per triangle.** This
is the one real trap in the model. The export puts the whole tram — bodywork, doors, wheels,
bogies and glass — on a single `BLEND` material, because 8 % of its texture atlas is the
tinted glass. three.js honours transparency per *material*, so all 53 k triangles on it were
drawn as transparent geometry with no depth write: the bodyshell stopped occluding anything
and you looked through the roof at the seats. Culling the interior would not have fixed it —
the roof would still have been see-through. Splitting by mesh does not work either, and was
tried: it moved only 42 of 105 primitives, because a module's shell is one mesh whose UVs
cover its window openings as well as its panels. So each triangle is sampled at its three
vertex UVs and its centroid, and the 50 790 that never touch a translucent texel are
re-indexed onto an opaque clone of the material that does write depth. The 2 528 that do keep
the blend material, which is what it is for. Only index buffers are rebuilt; both halves of a
split primitive share the original's vertices.

One bug this swap exposed was not in the asset at all. Both tram renderers oriented each
section with `Object3D.lookAt`, which aims an object's **+Z** at its target — while every
model in this project faces **-Z**, which is what the colliders and the camera anchor already
used. The visuals were therefore 180 degrees out from the physics, drawing every section
end-for-end in place: harmless-looking on the near-symmetric C-class, but on a tram with a
cab at *each* end it turned both noses inwards and left the open gangway faces pointing out
of the ends. `RailLoop` and `TramRide` now set the same heading the colliders do.

**Then each module's parts are re-parented onto one section node with a baked normalising
transform**: the quarter turn that puts the body's forward axis onto the project's -Z, the
scale to metres, and the shift that puts the section's own centre at its origin. Because
nothing is rebuilt, the livery's UVs and its ten textures survive untouched. Which end leads
is not a decision to make — a Flexity 2 has a cab at both ends and is symmetric about its
centre.

Two easy things to forget when swapping any vehicle model, both of which bit here:
`GarageThumbs`' `CACHE_VERSION` has to be bumped or every returning visitor keeps the old
picture out of `localStorage` (it is now `v6`), and `RAIL.minTramGap`, `RAIL.tramFollowZone`,
`TRAM.sectionCollider` and `tramTraffic`'s `FOULING` are all metres tuned to the *previous*
vehicle's length. The script prints the figures its own measurements suggest for all of them,
which is where the current values came from. The service also went back from three trams to
**five** (`TRAM.count`): at 61 k triangles the whole line costs 303 k, against 1.2 M for
three of the C-class. That is still the one number to change if your machine can take more.

## Riding the boats

Two hulls are drivable, a 16.6 m flybridge yacht and an 8.6 m cabin cruiser (`boatConfig.ts`,
`BoatRide.tsx`). A boat is not a car on water: it is a kinematic body under four forces —
buoyancy, thrust, drag and the helm — and everything that makes it feel like a boat is in how
`HYDRO` balances them. The physics samples the wave field under the bow, the stern and each
beam every step, so the hull heaves, pitches and rolls on the swell it is actually in.

**The sea you float in is real geometry now.** The water had been a flat plane whose normal
waved (`animateWater` in `Environment.tsx`): right from a bridge, wrong from a boat, where you
sit 1.5 m over a mirror while the hull bobs on a swell the picture does not show.
`SeaSurface` draws a 180 m patch of displaced water around the camera, moved by
`seaWaveGLSL().displace` — generated from the same `SEA_WAVES` table `seaHeightAt` sums — so
the surface you see is the surface the hull is floating on. It uses the sea's own material,
fades its displacement to nothing over the outer quarter so it meets the flat plane at the
plane's level, and follows the camera in whole 2 m quads so the vertices never crawl through
the wave field. The flat plane keeps the distance, where the fog has it anyway.

**The wake lies on the waves.** `BoatWake` used to lay its foam on the flat plane, and said so,
because foam at `seaHeightAt` was half a metre off the drawn surface. That is inverted now:
the quads are re-laid every frame at `seaHeightAt`, tilted to `seaSlopeAt`, and spray dies
where it meets the wave rather than at still-water level.

**Two planing terms** (`HYDRO.planeLift`, `HYDRO.planeFollow`). A fast hull climbs out of
the hole it displaces and runs on top of the water; the spray and the flattened wake already
said so while the hull sat at its dead-water draught. The level the buoyancy spring settles to
now rises with the square of speed — so the bob keeps the boat's own period at every speed —
and the share of the wave slope the hull takes up falls on the same curve, because a boat on
the plane skips the swell rather than riding it.

**A hull floats a little above its own waterline** (`HYDRO.freeboard`). `prepare-boats.mjs`
puts each model's waterline at its y = 0 and the hull floated with that exactly on the water,
which was right for a flat sea and wrong for one with crests in it: the boat rides at the MEAN
of its four samples while the water round the outline goes higher than that mean, so the sea
climbed the topsides and came aboard over a low cockpit sole. How much higher was measured,
not guessed — sampling the wave field around a hull against its own four-point mean over
90,000 positions, headings and moments:

| hull | median rise | p99 | worst |
| --- | --- | --- | --- |
| 8.6 m cruiser | 0.10 m | 0.22 m | 0.25 m |
| 16.6 m yacht | 0.20 m | 0.38 m | 0.42 m |

It grows with length because a longer hull spans more of a 42 m swell, so the lift is per
metre of hull — 0.023 puts both on their own p99 — and it saturates at `SEA_REACH`, since a
203 m ferry spans so many wavelengths that its mean is flat calm and the crest beside it is
the whole wave and no more. The scripted fleet takes the same lift, so a yacht you are chasing
floats like the one you are steering.

**Aground means aground.** `afloatAt` knows the islands, the causeway and every paved surface,
and nothing else: the nav raster has no entry for sand, so on the city's own beaches it
answered "unknown", which read as water, and a cruiser at 130 km/h ended forty metres up the
beach with only its flybridge showing. `BoatRide` now also drops a short ray from six metres
up, at the hull's centre and at its bow, against fixed bodies only; anything it finds above
the waterline is shore. The bow test is what stops the boat at the sand rather than halfway
up it.

## Sound

**Engine note: synthesized live from RPM, not played back from a recording.** An earlier
version crossfaded two real recordings (an idling car, a car at speed) and pitch-shifted each
with `playbackRate` to cover the gap between them. That is audibly wrong two ways over:
`playbackRate` speeds up or slows down the *whole* recording, transients included, so a sample
nudged 1.6x sounds sped-up rather than higher-revving, not a continuously higher note; and the
two source recordings were different real cars, so the "engine" changed character at the
crossfade point instead of sweeping smoothly. Worse, every vehicle in the garage played the
exact same pair — the 4-tonne **electric** Hummer got the same V12/muscle-car note as
everything else.

`useEngineSound` now builds a small Web Audio oscillator graph and re-tunes it every frame
straight from telemetry: `firing frequency = (rpm / 60) * engine order`, where engine order is
firing pulses per crank revolution (cylinders/2 for a four-stroke). The fundamental therefore
tracks RPM exactly and continuously — no sample boundary to cross, nothing stretched. A
fundamental (sawtooth) plus two harmonics (a square an octave up, a sine an octave down) run
through a lowpass filter that opens with load, plus a little filtered broadband noise for
mechanical grit, gives each car in `VOICES` a distinct, tunable voice — a screaming V12 for the
McLaren, a muffled '63 coupe V8 for the Riviera, a low gritty diesel six for the Peterbilt —
instead of one borrowed recording for the whole garage. The Hummer gets a different voice
entirely: a clean motor whine pitched from **road speed**, not the fake per-gear RPM sweep
every combustion car uses, because a single-speed reduction drive has no gearshift to dip for.

**Garage music and UI sound effects.** `useGarageAudio` plays a looping ambient track behind
the vehicle picker and short click/confirm sounds on the tabs, arrows, roster tiles and the
DRIVE/RIDE button — one mute switch for all of it, next to the vehicle counter, remembered in
`localStorage` the same way the last-driven vehicle is. Two things worth knowing:

- **Autoplay is blocked before a user gesture**, so the music starts lazily on the first
  pointerdown/keydown on the page — the same pattern `useEngineSound` already used for the
  engine note. Testing this with a script-dispatched `element.click()` will not exercise it:
  a synthetic click is not a trusted gesture and the browser silently refuses to start
  playback, which looks identical to a real bug until you switch to a real input event.
- **The click sound is pooled four ways.** A single shared `<audio>` restarted on every click
  cuts itself off mid-decay when the driver browses faster than the clip's own length (arrow-
  key repeats do this easily); a small pool gives each rapid click its own voice.

All five clips are Pixabay Content License (free for commercial and non-commercial use, no
attribution required): `muscle car engine idling` by flutie8211, `Ferrari 458 İtalia Sound
Effect (Going Fast)` by AstonMartinVantageV12, `Smooth Menu Background` by Roman_Sol, `UI
Button Click #5` by Audley_Fergine, and `Game UI Confirm Selection Sound #2` by
Vadim_Makes_Sound.

## The interface has a voice

Menus make sounds: a hover as the cursor crosses a row, a click when something is chosen, a
two-note figure when a setting is toggled, a low pair when the world stops and the same pair
inverted when it starts again. `useUiSound.ts` is the whole bank, and it is **synthesised**
for the same reason the engine and the train are, not out of habit:

- A UI sound has to be short — 45 ms for a hover — and it has to be able to fire again before
  the last one has finished. An `<audio>` element cannot, which is why `useGarageAudio` keeps
  a pool of four just for its click. Web Audio gives every blip its own oscillator, so running
  the cursor down a list is a run of separate ticks rather than one stuttering clip.
- It adds no files. The bank is about a kilobyte of arithmetic against the 6 MB of menu music
  already in `public/audio`.

It is kept deliberately dull, because these play over a game and none of them was asked for.
Nothing has a fundamental above 900 Hz and the master runs through a 2.2 kHz lowpass — the
ear's sore spot is 2–5 kHz, which is exactly where a bright UI tick sits. Every blip fades in
over 6 ms rather than starting square, since a step in the waveform is a click in the literal
sense and that is what makes cheap interface audio sting. Hover is a fifth of the click's
level: it fires on movement rather than on intent, so it is a texture, not an event.

Three things were worth more thought than the sounds themselves:

- **Where it is heard from.** The controls that want to make a noise are the small shared ones
  — a row, a segmented button, a slider — three levels below the component that knows whether
  sound is on. They take it from a context (`UiSoundProvider`) rather than a prop threaded
  through `SettingsForm` to `Row` to `Segmented`, which is the kind of plumbing that gets
  dropped the next time one of them is touched. The default is a no-op, so a control outside a
  provider is silent rather than broken.
- **Which way a toggle chimes.** The first rule was positional — right is up — which is right
  for TRAFFIC, whose options run OFF, LOW, MEDIUM, FULL, and backwards for every ON/OFF row,
  because `ON_OFF` puts ON first and so turning something *off* moved right and chimed upward.
  A boolean knows its own direction; everything else still reads it off the row.
- **The switch that silences the rest.** Turning interface sound back on cannot announce
  itself from the button that does it, because the bank is still muted at the moment of the
  click — so the one row whose effect you most want confirmed was the one row that gave no
  confirmation. `RacingScene` watches the setting instead and chimes on the way in. The
  garage's mute button has the same shape and the same answer.

The pause sound is wired the same way: one watch on whether the menu is open, so the key, the
HUD's button and RESUME are all heard without any of them having to remember to say so.
INTERFACE, under SOUND in the settings, turns the lot off; it is separate from ENGINE because
a player who silences the engine to hear their own music has not asked for a silent menu.

## The circuit

The centreline is a closed radial curve `r(θ)` built from four harmonics. Because `r` stays
strictly positive the curve is star-shaped about the origin and therefore *cannot*
self-intersect — a guarantee hand-placed control points don't give you. Tuned to a 1.44 km
lap whose tightest corner is an 18 m hairpin (~50 km/h) and whose fastest is a 266 m
sweeper, so there are real braking zones. The road ribbon doubles as its own trimesh
collider, so the wheels raycast against exactly the surface you can see.

## Notes on Rapier's raycast vehicle

Several of its behaviours do not match what its docs imply, and each cost real debugging
time. They're documented at the call sites; briefly:

- **`world.timestep` must not be read inside a before-step callback.** It re-enters the
  borrowed `World` and throws *"recursive use of an object detected which would lead to
  unsafe aliasing in rust"*, which aborts the step — so the vehicle controller silently
  never applies any force and the car just sinks onto its collider. `wheelGroundObject()`
  has the same problem, which is why surface grip is computed analytically instead.
- **`mass` belongs on the collider, not the `RigidBody`**, when you pass `colliders={false}`.
  Otherwise the chassis silently weighs whatever its collider density implies (6.6 kg here).
- **Force accumulators persist across timesteps.** Downforce applied with `addForce` and no
  `resetForces` compounds every frame into an unbounded force that crushes the suspension.
- **`suspensionRestLength` sets both the spring free length and the ray length.** Deriving
  the hard-point height from it couples the two, and the car ends up balanced on the tip of
  its own suspension ray — contact flickers and ride height stops depending on stiffness.
  The two are decoupled in `vehicleConfig.ts`.
- **Collider friction is ignored** by the raycast vehicle; traction comes from the per-wheel
  `frictionSlip`, so off-track grip is applied there.
- Suspension and engine forces are **not** in plain SI units, so the stiffness and engine
  values were calibrated empirically. Pass `?k=`, `?ef=`, `?dc=`, `?dr=` in development to
  re-calibrate with a clean simulation state per page load.

## Continuing this work

`HANDOFF.md` holds session-handoff context: environment constraints, the Rapier gotchas in
full, how to re-calibrate the tuned values, how to drive the car from the console for
testing, what is and isn't verified, and which decisions are deliberate.

## Credits

The city map is *"Drive for Speed — Map"* (`drive_for_speed_-_map.glb`), a Sketchfab export.

Traffic uses *"Generic Passenger Car Pack"* and *"Generic Civil Service Vehicles Pack"*, also
Sketchfab exports.

The car model is *"McLaren F1 1993 By Alex.Ka."* by [Alex.Ka.](https://sketchfab.com/Alex.Ka.),
licensed **CC BY-NC 4.0**. Attribution is shown in the HUD. Non-commercial use only.

The tram is *"Gold Coast G:link Light Rail Tram (Flexity 2)"*, created by **JoErain**
([www.joerain.com.au](http://www.joerain.com.au)) and licensed
**[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — free to use with credit,
which is what this paragraph is for. The export carries those terms on a textured billboard
parked beside the vehicle, which `prepare-tram.mjs` drops from the model (it is 12 m off to
one side and would otherwise take the bounding box with it); the credit is kept here
instead.

The advert at `/promo` uses a single supplied **generated** image as its backdrop
(`public/promo/city-traffic.webp`) — not a photograph, and not a render of the game. Note that the
vehicles in it are not the vehicles in the garage and its lead car carries a visible
manufacturer badge, which is worth resolving before that page is used publicly. The unused
`public/promo/mclaren-hero.png` is a real render of `mclaren.glb`, regenerable with
`npm run promo:art`, kept for the alternative treatment.

The sky is *"Kloofendal 48d Partly Cloudy (Pure Sky)"* from
[Poly Haven](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky), licensed **CC0** —
no attribution required, credited here anyway. It is an equirectangular panorama, which is
what a 3D sky has to be: a flat photograph used as a backdrop stays pinned to the screen, so
the clouds would turn with the car instead of staying put in the world. `npm run prepare:sky`
re-downloads it, scales it to 4096x2048, and measures the sun's position and the horizon
colour out of the pixels into `src/config/skyData.json`, so the shadow-casting light and the
fog agree with the photograph rather than with a hand-picked constant.
