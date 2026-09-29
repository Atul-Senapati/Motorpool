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
- **A position fix sits under the compass** — `X -1006  Z -718`, the world metres the whole
  project is written in, plus `Y` on an aircraft and `ARC` on the main line, where the railway
  is measured along the line rather than across the map. It is the one readout on this HUD
  aimed at whoever is *editing* the world rather than driving through it: answering "what are
  the coordinates of that" used to mean flying a drone there and reading them out of a console
  probe. **Click the tab and the spawn is on the clipboard** as the `?at=x,z,y,heading` query
  `pickCitySpawn` parses, so a place you found once can be reopened exactly rather than
  approximately. See `PositionFix.tsx`.
- **`M` opens the full city map.** It opens *zoomed in*, close enough to plan a turn from —
  the whole 4.9 km city across a 1100 px box made every street two pixels wide and the player
  a speck. Scroll to zoom about the cursor, drag to pan, and the map follows the car until you
  drag it, after which a **RECENTRE** chip brings it back. A compass rose sits in the corner:
  the map never rotates, which is exactly why it is worth saying which way north is.
- **A pinned waypoint is routed along the streets.** Click to pin, and `physics/roadRoute.ts`
  runs A\* over the same road graph the traffic drives — so the line goes round the bay rather
  than across it, and the header reads the real distance (`732 M BY ROAD`) instead of the
  straight-line one. It is re-planned twice a second so the line always starts at the car, and
  it is drawn on the minimap as well, which is what makes the minimap answer "which way at
  this junction" rather than only "roughly over there". One-way streets are respected; if that
  makes a pin unreachable the search runs again ignoring them, because a slightly wrong line
  beats a blank map.
- The tunnels lost their `T1`/`T2` badges. They numbered something nobody experiences as a
  numbered list, and put two labels on the part of the map you most want to read; the broken
  line already says "tunnel".

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

**`?at=x,z` and `?at=x,z,y` drop a vehicle anywhere at all**, spawn table or no spawn table.
The aircraft have read it from the beginning — that is what makes the drone a map you can fly —
and ground vehicles now read the same parameter. They used to ignore it and start in the city
instead, which is a trap: the URL looks like it worked. It is the only way to begin a drive on
the airport island, since the spawn survey only walks the city's nav raster and the island is
not on it. A fourth number is the heading in degrees, and it matters more than it sounds: without it the
car inherits the fallback spawn's yaw, which is aimed down a street in the middle of the city and
has nothing to do with wherever `?at=` just put you. Dropped on the bridge it pointed 13° off the
deck, which is fine for a second and puts you in the sea by the third. A position without a
direction is only half a spawn. `?car=porsche&at=-2108,-399,2,122.6` starts you at the bridge's
city abutment pointing down it, which drives the whole crossing without a steering input.

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

## Halcyon Field: a second island, and an airport on it

In the open water off the **west coast**, level with the city and 168 m from the mainland
shore, there is now a made island with an airfield laid across it — `airportConfig.ts` for the
numbers, `AirportIsland.tsx` for the drawing.

**It started at exactly twice the railway station's island and is now nearly three times it.**
Kestrel is traced at 115,524 m² and grown by `ISLAND_GROWTH`, so the land actually there is
237,055 m². The first cut of this was a stadium — a rectangle with semicircular ends — 1,024 m
long and 520 m wide, 474,452 m² against a target of 474,110, within a tenth of a percent. It
was then asked to be broader and to reach further east, and it is now **667,947 m², 2.8 times
Kestrel**: the radius went 260 to 320, and the landside half is stretched again by 1.35 on top
of that, so the east shore stands 461 m from the centre against 338 m to the west.

**It is a stadium that is no longer symmetric,** and the asymmetry is the point. The runway
sits on the seaward side and everything else — apron, terminal, road, car park — is landside,
so the two halves want different amounts of room; the landside is also the side facing the
city, which is the only side there was water to grow into. The stretch is applied to z after
the roughening and only where z is positive, which keeps the outline star-shaped about the
centre: scaling one half-plane maps rays from the origin to rays from the origin, so the
crown's triangle fan and the sea wall's extrusion are both still valid. `halfWidthAt` went
with it — it described a symmetric island, nothing used it, and a helper that quietly lies
about the shape is worse than no helper.

**Growing east cost a shipping lane its shape.** The west-coast yacht ring was centred
(−2150, 150) with a 240 m radius, and the enlarged island's east shore runs 16 m from its
western arc: a 480 m circle does not fit in what is left of that channel. It could not simply
be pushed out to sea either, because the point of that ring is to put boats where the *train*
passes — the line runs down x = −1888 there. It is now (−2025, 400) at 180 m, which a search
over centre and radius says is the largest ring that still hugs the railway (43 m off the line
at its nearest) with real water round it: 129 m clear of the island, the coast and every other
route. The map's margin needed no attention at all, because it is measured from the outline
rather than fixed — which is the whole reason that was changed.

**It is not one of `TRAIN_ISLANDS`, deliberately.** Those two belong to the railway, and three
separate modules pick one of them *by area* — the station takes the largest, the village the
smallest, the town the largest again. Adding a third island bigger than either would not have
added an island; it would have silently moved the railway station onto it.

**The flat stuff is modelled here and the buildings are not.** Boxes and paint: 840 x 45 m of
runway, a parallel taxiway with three links, two aprons, the landside road and car park, the
markings and the lights. Every static surface merges to one geometry per material, so the
whole airfield is one draw call, the paint two more and the lighting four. The planting is the
city's own tree and its own piece of street furniture, and the ground is the railway islands'
grass, so the new coast reads as the same coast.

The buildings were city chunks to begin with — a 189 m row of high-street frontage was the
terminal, a wide two-storey block was a hangar, and the one small city building taller than it
is broad was the control tower. That was the right answer with no airport assets and stopped
being the right answer when two arrived: a general-aviation airfield kit and a 273 m terminal
concourse. `prepare-airport.mjs` takes seven meshes out of them and `BUILDINGS` puts up eight:
a terminal, a control tower, two hangars, a maintenance shed, freight, a fire station and a
landside office block — 11 k triangles and 355 KB all in.

Three things about that import are worth recording:

- **The kit's runway plate is dropped.** It is 452 m long and ours is 840 m with its own
  markings, lights and edge paint, so importing the plate would mean either a second runway
  lying across the first or throwing away the one that is correct.
- **Nothing is scaled as a file.** The kit is a general-aviation field: its control tower
  measures 44.8 m, which is right, and its larger hangar is 23 m wide, which is a club hangar
  rather than somewhere a 747 fits. Each part is scaled to a *stated real-world size* instead,
  and the parts that already measure up are left alone.
- **The concourse brought its own apron.** Big four-triangle quads at ground level, which is
  exactly where the island's paving already is — two coplanar surfaces 60 mm apart across the
  whole forecourt. Anything low, flat and trivially cheap is dropped on the way in; that is
  five slabs and 101 of 7,678 triangles.

## The ground fleet, and two helipads

**Twenty-two vehicles drive the airfield** on four closed service roads — `SERVICE_ROUTES` owns where
they go, `FLEET` owns what goes where, and `AirportTraffic.tsx` is only the driving. A pushback
tug and a baggage tractor work the stands with the airfield's fire cover and a service truck on
the same circuit; two more run the cargo apron; two buses and the post work the landside road
and take a lap of the car park aisle.

**Polylines, not physics.** These are scenery that moves. Giving them the traffic AI would mean
giving them a nav raster the island does not have, and giving them Rapier bodies would mean ten
more dynamic actors for something nobody can crash into on purpose. A closed polyline walked at
constant speed is what the boats do and it is enough — the heading is the direction of travel,
so a vehicle turns its corners, and the corners are where the eye looks anyway.

Three things this needed getting right:

- **Two model conventions, and they disagree.** Everything out of `airport.glb` is prepared
  facing +Z, and a yaw of `atan2(dx, dz)` aims +Z along travel, so those need nothing. The
  city's own `vehicles.glb` faces −Z — `Traffic` drives them with a velocity of
  `(-sin h, -cos h)`. Hence `spin`, and hence the fire engine not reversing round the apron all
  day. The Scania arrives nose at +X (its front door is the foremost of three and its front
  axle is at +4.3 against the rear's −3.7), so `prepare-airport` turns it a quarter on the way
  in rather than leaving a special case in the driving.
- **The apron loop drove through the parked 747s.** Its first version ran a leg at z 33, and
  the stands reach from z −31 to 39. The only way across an apron is behind the tails: z −34
  leaves 3 m to the nearest tail and 12 m to the taxiway edge, which is what an apron service
  road actually is. A clash pass over every route against every building, container and parked
  aircraft is what found it.
- **The fire engine drove round as four wheels and its indicator lenses.** Every one of these
  vehicles is a single glTF mesh with four or five primitives — paint, glass, decals, lights —
  and three.js splits a multi-primitive mesh into one child `Mesh` per primitive, tagging them
  all with the same `{vehicle, part}`. Keeping one mesh per part therefore kept whichever came
  last. `IslandTown` and `Traffic` both collect ARRAYS for exactly this reason and this now
  does too; the lesson is that the precedent was right there and was read too quickly.
- **The bus came out pure white.** The Scania is authored in
  `KHR_materials_pbrSpecularGlossiness`, where the colour is the extension's *diffuse* texture
  and `baseColorTexture` is empty. `prepare-airport` read only the latter, so a bus with a full
  livery arrived as a material that says nothing — which renders white. It now reads the
  extension's diffuse texture and factor when they are there, and the bus carries its 62 KB
  livery. It is the only model of the eleven that uses spec-gloss, which is why nothing else
  was affected.
- **The parked 747s stood on their engines.** The model has no landing gear at all — measured,
  its lowest geometry is two clusters at (±11.6, 9.4) and (±10.5, 10.7), which is exactly where
  a 747-100's inboard and outboard nacelles are, and there is nothing at the nose-gear station
  or under the wing root. Grounded on its lowest point it therefore parks on its nacelles with
  the belly 0.78 m up and no wheels. `GEAR` describes the gear a 747 actually has and
  `buildGear` draws it: a nose leg and four main bogies, two under the wing roots and two under
  the belly, eighteen tyres an aircraft. The aeroplane is lifted 1.7 m onto them, which puts the
  belly at 2.5 m — about where a real one's is. Two merged geometries cover all four aircraft.
- **The route walker is exact.** Each track measures its polyline's length to within 0.1 m,
  closes on itself to 0.00 m, and has no step larger than the sampling step — which is the
  whole of what could go wrong in a leg-walking loop.

**Two elevated helipads** sit on the grass 108 m off the runway edge, outside the strip.
Elevated and grated, which is what a made pad on reclaimed ground is: a steel deck on legs with
an open grille, a safety-orange rim, a painted H and a ring of green edge lights. The grille is
the point of it — a solid deck at 26 m across is a grey square, and what says *structure* is
being able to see the grass through it and the striped shadow it casts. It is about forty-five
bars a pad and they all merge into one geometry, so the pair costs four draw calls. The decks
carry colliders; the legs do not, because nothing can drive between them anyway.

**The detail is all reuse.** Thirteen buildings, four aircraft and fifteen city chunks come out
of eight meshes and the city's own `deco_` parts — nothing new was modelled for any of it:

- **Four 747s**, the same mesh four times. Three nose-in at the terminal and one on the cargo
  apron. They stand on the stands that were *already painted there*: `buildMarks` draws six
  lead-in lines off the taxiway at 78 m intervals, each ending in a stop bar, and an aeroplane
  parked anywhere else is an aeroplane ignoring the markings under its own wheels.
- **A cargo apron** off the east end of the frontage, which is what the island's new east
  ground is for. The freight shed and the maintenance shed are placed a second time on it,
  because an airport's freight side is a row of identical sheds and reuse is what that looks
  like, and the city's `deco_container1_*` chunks make the yard.
- **A landside block** behind the car park: two more `admin` blocks as airline offices and car
  hire, the `fire` mesh again as ground services, and two city blocks — `deco_Building_-4_-1`
  as the airport hotel and `deco_Building_-3_2` as cargo agents.
- **Ground service units** from `deco_special_vehicles_*`, drawn up under the wing at each
  gate and scattered through the car park, because an empty car park reads as a closed airport
  however well it is painted.
- **Paint**, which is the cheapest realism there is and does the most work: an apron taxilane
  for the lead-in lines to start from, two more stands on the cargo apron, hold-short ladders
  where each link meets the runway strip, a dashed centreline down the road, and **bay
  markings across the car park** — an unmarked slab of tarmac the size of the terminal reads
  as nothing at all.

**Four 747s are parked at the stands, and they are the one that flies.** A TWA 747-100 was
imported for this first, and it turned out to have **no landing gear at all**: measured, its
lowest geometry is four clusters at the stations a 747-100's inboard and outboard nacelles sit
at, and there is nothing at the nose-gear station or under the wing root. It is built clean.
Grounded on its lowest point it therefore parked on its ENGINES, belly 0.78 m up, wheels
nowhere.

Drawing gear for it was the wrong answer, and the right one was already in the repo:
`plane.glb`, the VC-25A that flies the two-minute circuit. `prepare-plane.mjs` already splits
that model into body, gear, and the gear doors in BOTH positions — precisely so the flying one
can put its wheels away — and grounds it on its tyres. A parked aeroplane is that model with
the wheels out, which is what it is on a stand anyway: `gear` and `doorsOpen` shown,
`doorsShut` hidden. The TWA model is no longer imported, which takes 9,328 triangles and a
122 KB texture back out of the bundle.

It needs a half turn that the buildings do not. `PARKED.turn` is 0 for "nose at the terminal",
which is island +Z, and a yaw of `turn` points an object's own +Z that way — but this model's
nose is at −Z. `Airliner` adds the same half turn in the air for the same reason.

Each stands 5.9 m off the terminal face with about 10 m between its tail and the taxiway, which
is the whole reason the apron is 86 m deep and not less.

`PARKED` is separate from `BUILDINGS` for one reason: the collider. A building gets a box
round its whole bounding box, and a box round an aeroplane is a 64 x 71 m wall across the
stand that you cannot see and cannot drive under. Aircraft get a box round the FUSELAGE only,
so the wings are what they look like — something to drive under.

**The terminal is 108 m deep and the landside was not.** The old one was a 27 m-deep row of
frontage with the road 70 m behind it; the real concourse stands with its gates on the apron
edge and reaches back to z 170, which is straight through where the road was. So the road
moved to 176, right behind the building, the gate spur moved east past the terminal's end, and
the car park went straight out of the back of it.

Two things about the first placement were wrong in a way only a person looking at it would
catch, and both are worth recording:

- **The terminal faced backwards.** It went up with a `+90` turn, which is the obvious one and
  the wrong one, because the concourse is not symmetric across its depth. Measured in slices,
  its −X third is a 9 m single-storey gate pier and the rest is 20–23 m of terminal, so −X is
  the airside — and `+90` sends local +X to island −Z, which put the frontage out on the
  runway and the jet bridges over the car park. It is `-QUARTER` now, and the pier is on the
  apron where aircraft park against it.
- **The buildings were spread over the island rather than gathered at the field.** Offices at
  z 210, a fire station out on open grass at z 140, a car park 250 m east of the terminal it
  serves. An airport is a compact thing at one end of a big island, and it took two passes to
  get there, because the first one only fixed the depth — a row with 60 m holes in it still
  reads as scenery dotted about rather than as an airport. What settled it was drawing the
  plan rather than flying over it:
  - Airside is now one unbroken row along the north edge of the aprons, z 62 to 114, west to
    east — two hangars, maintenance, the fire station, the terminal, the tower, freight —
    with nothing more than about 30 m between neighbours. The hangar apron shrank from 208 m
    to 160 m to pull the sheds in with them.
  - Landside is squared on the terminal's own axis: the car park is the SAME 210 m footprint,
    x −90 to 120, not a 150 m box pushed off to one side, and the road runs the length of both
    and on west to the hangar gate. Laid out any other way it reads as three separate things
    that happen to be near each other, which is what it was.
- **The buildings stood in a field.** The apron stopped at the terminal's front face, so the
  terminal, the hangars and the tower were all on grass — and a 747 at a gate had its wheels
  in it. An airport's building line stands on hard standing. `frontage` is now one slab from
  the west end of the hangars to the east end of freight (x −390 to 260, z 62 to 120) with
  every building on it, `forecourt` carries the terminal's back half out to the kerb, and the
  aircraft stands are the 108 m of apron in front — a 747's length and enough again to get
  round the back of one parked at a gate. A check reports all eight buildings 100% on tarmac
  and the paving one connected surface of twelve pieces.

  The rectangles tile and never overlap, which matters more here than it sounds: it is all
  laid at one height, so two that share area are two coplanar surfaces fighting for the same
  pixels. Touching along an edge is how the field is joined; sharing area is a z-fight.
- **The terminal floated, on one vertex.** Its pillars stopped a metre short of the ground.
  Every part is grounded by shifting its lowest point to y = 0, and the concourse has exactly
  ONE vertex at the bottom of its bounding box — the next 1,520 are 1.3 m higher. So the whole
  building hung off a stray point, reaching for a floor it never touched. Grounding is on a
  0.3% percentile of the vertex heights now rather than the minimum, which ignores the stray
  and finds the real base; the control tower, which genuinely has 43 vertices on its slab, is
  unmoved by it. The recorded height is measured from the floor too, or the collider would
  have come out a metre too tall and half a metre too low.
- **And it was still too far from the strip.** The chain from runway to terminal is 33 m of
  runway strip, 18 m of taxiway, and the stands — the first two are as tight as an airfield
  gets, so the apron was the only lever. It went from 108 m deep to 86: one 747 length
  nose-in at a gate plus fifteen metres, which is a stand rather than a stand with a taxilane
  behind it. Runway edge to terminal face is 137 m, at the near end of what real airports do,
  and the whole field — buildings, forecourt, road and car park — came 22 m north with it.
  - The tree scatter came in with them — it used to plant the whole 830 m of shore in two rows
    for the sake of it.

Three things were got wrong first and are worth recording, because each was invisible until it
was measured:

- **The plan was disconnected.** Drawn and rendered, it looked fine; drawn as a *plan*, the
  apron stopped six metres short of the taxiway, the hangars faced a shed apron they did not
  touch, the car park sat in a field, and the control tower stood squarely on the service
  road. A flood fill over the paving rectangles now reports one connected surface of eleven
  pieces, and a clash pass reports nothing overlapping and nothing within 12 m of the shore.
  The same pass is what caught the fire station sitting 12 m inside hangar one when the real
  buildings went in — a walk round the island would not have found it.
- **The outline was wound inside out.** `trainConfig` documents this exact trap for the drawn
  islands and it was fallen into anyway: in the XZ plane with Y up, a fan over an outline
  faces +Y only when the shoelace sum is negative, and sweeping the angle the obvious way
  gives a positive one. Every triangle of the crown faced the seabed, so with a front-facing
  material the island was not drawn at all — a car apparently parked on the sea with the
  runway floating above it. `outlineShoelace()` is asserted at load now and the startup line
  says so if it ever flips back.
- **It sat on a shipping lane.** In its first home the east coastal ring took a 170 m bite out
  of it. Every candidate position since has been walked against every ring in the fleet at
  one-degree steps.

The island prints its own line at startup, like the city and the fleet do:
`[airport] 13 buildings and 4 aircraft from 8 meshes (54506 tris), 20 city chunks, 2 helipads, 70 trees`.

**Where it sits took three goes, and the last two taught something.** It went out east on its
own first, 584 m from the city with nothing around it. Then into the northern bay beside the
railway's islands. It is now off the west coast, which is where it was asked for.

- **The map had a fixed margin.** The city map is the nav raster inset into a larger canvas,
  and that inset was a constant 110 px — 165 m, sized for the railway island's 40 m overhang.
  This island reaches 590 m past the raster's west edge, so with a fixed margin it was simply
  not drawn: present in the world, missing from the map, which is the sort of thing you only
  find by opening the map and seeing nothing. The margin is now **measured per side** from
  whatever sticks out (`mapPad`), so only the west grows and the canvas goes from 24 MB to
  28 MB rather than doubling as a symmetric margin would.
- **A northern position would have cost two shipping lanes.** The strait north of Kestrel has
  no spot that clears both the ferry and the cargo ring; siting there needed them moved 650 to
  700 m. The west coast needs nothing moved — the west-coast yacht ring passes 83 m off, which
  is the margin those coastal lanes were themselves drawn to, and it is what stops the island
  coming any further inshore.

**The coast is rough, and there is no beach.** The base is a stadium, but what is drawn is that
stadium with its radius bent about the centre by three sine harmonics, so the shoreline wanders
in and out by up to 13% and no two stretches are alike — a perfect ellipse reads as a game
object. The harmonics are smooth and periodic, which is what keeps the outline star-shaped
about its centre; the crown's triangle fan and the wall's extrusion both need that, and a
random per-point jitter would break it. `halfLength` is 510.8 rather than a round number
because it was solved for after the roughening, back when the finished coast was meant to
measure exactly twice Kestrel; the radius and the landside stretch have moved since and it has
been left where it is, because the length was never what was asked to change. Where the railway's islands shelve into the water on sand, this one stops dead:
it is a reclamation, so it gets the vertical concrete revetment one has — 7 m of wall above the
water, carried on down to the seabed so there is no seam at the waterline.

Two things moved to suit the rough coast: the bend takes 34 m out of the west end, which put
the hangars and their apron in the sea, so both came east.

**The grass is the mainland's.** `#4b6020` is the city's `Auxiliar` material — its verges and
its hills. The railway islands use the town's green, half a step cooler, which against the big
land across the water read as a different kind of ground.

**Getting there is by road now.** It was somewhere you sailed to and looked at; a 318 m
three-lane bridge makes it somewhere you drive to. It crosses at the one place the two coasts
come near each other — the mainland's west shore bulges to x −2140 around z −400, leaving 195 m
of water — and the landing was found by scanning the nav raster for the westernmost *drivable*
pixel on each row rather than by eye.

**It is a steel bridge, and it was a causeway first.** The railway's island is reached by a
reclaimed bank with a road on its crown (`IslandBridge`), and this crossing was built that way
to begin with by reusing the same swept profile. It was the wrong structure. That one is a 130 m
hop to a low island where a bank reads as ground; this is 300 m of open water to an airfield,
where what belongs is something you can see *under*. So it is now a girder deck on twin-column
piers standing on the seabed:

- **The deck** is 14 m wide carrying three 3.5 m lanes with a shoulder each side, on a 0.75 m
  slab, with dashed lane lines.
- **Two plate girders** run under it at ±4.6 m, 1.9 m deep, with cross beams every 12 m. On a
  tied arch these are not just stiffening: they are the **tie**.
- **A tied arch** over the whole channel — two steel ribs, 168 m between the piers, rising 34 m
  to a crown 36 m over the water, with vertical hangers every 9 m, seven bays of cross bracing
  over the crown and a knee brace at each springing.
- **Two piers** stand at the two waterlines, 28 and 196 m — a cap on two columns, down to the
  seabed at −9 m. They are the arch's springings, and there are no others: see below.
- **A 1.05 m parapet wall** each side, in the deck's own concrete, with a steel capping band
  along the top, from 6 m to 200 — everywhere there is a drop.

**Both ends are level runs, and the grade lives only between them.** This took three goes to get
right, and each fault is worth keeping because each one was invisible from the air and obvious
from a car.

*Probe the ground before deciding where a bridge starts.* Reading the nav raster straight down
the crossing's line settles what is actually there, and it is not what the map suggests:
measured along the deck from the anchor, −24 to −16 m is carriageway, −14 to −10 is footpath,
−8 to −2 is carriageway again, 0 to 2 is the seaward footpath, and by 4 the ground has fallen to
−0.26 on its way to the beach. The anchor was already on the footpath — so an `overlap` of 10,
which exists to make a joint overlap rather than butt, put the deck's first ten metres flat
across a live traffic lane. It is 0 now, at both ends, and the bridge starts at the footpath.

*A grade that runs to the anchor buries the far end.* The crossing makes landfall 197 m along,
a hundred short of its end, and the climb used to continue past that to the island crown — which
put the whole last hundred metres UNDER the island's surface, by 0.6 m at the shore and still
0.1 m near the road. The island is solid, so the deck did not emerge from it: it vanished into a
bank of earth at the waterline. From a drone it read as a bridge that stopped at the sea; from a
monster truck it was a wall. So `islandLanding` holds the last 100 m flat at island height and
the climb finishes at the shore — an approach road across the island's grass, which is what the
land part of a crossing is.

*The two ends want opposite signs.* The city end sinks 6 cm (`endSink`) because the street is
drawn there and should win the joint. The island end stands 5 cm proud (`endLift`) because it
crosses open grass, and a deck sunk into grass is one you can neither see nor drive on.

The parapet runs 6 to 200 — clear of the city footpath, and stopping just past landfall. A
parapet is something you have where there is a drop: run to the abutment it is a wall across the
junction, and run over the island approach, which is at grade on grass, it is a wall along a
road with nowhere to fall off.

**What makes it *tied*.** A plain arch pushes outward at its feet, and the ground has to push
back — which is why real arches want rock abutments and why one standing in a tidal channel is
an expensive piece of civil engineering. A tied arch closes the triangle instead: the deck is
strung between the two springings as a bowstring and takes that thrust in tension itself, so the
piers only ever feel weight going straight down. That is the whole reason this one can stand on
two slender twin-column piers in the sea, and it is why the plate girders under the deck are
load path rather than decoration.

Three details follow from actually meaning it rather than drawing an arch shape:

- **Two piers, not four.** The arch carries its own span. A pier under the middle of it would be
  a column holding up something already holding itself up — the classic tell that a bridge was
  modelled from a photograph. `piers` names them now, at 28 and 196 m, which are the two
  waterlines, so the arch clears the channel in ONE span: 168 m of the 297 is arch and every
  metre of open water is under it. A 123 m arch sitting inside a 183 m stretch of water, which
  is what the first version was, is an arch placed on a bridge. This one is the bridge.
- **The rise is measured off the chord.** The springings are at different deck heights — 0.4 m
  city side, 3.4 m island side, because the deck is still climbing where the arch starts. Taking
  the rise off one end would have dropped the rib below the deck at the other.
- **The ribs lean in.** 13.6 m apart at the springings, 9.4 m at the crown. A real pair of ribs
  is braced against each other and bringing their tops together shortens the bracing and
  stiffens the pair sideways. It is also the single detail that most makes a bowstring read as
  one rather than as two parallel arches.
- **A parabola, not a catenary.** A catenary is the funicular shape for load along the *arch*; a
  bowstring's load hangs from the deck, uniformly along the span, and for that the answer is a
  parabola. At this size the two differ by centimetres — but the parabola is also the one you
  can write in a line of code, which is how you know it is the right one.

The ribs, hangers, bracing and knees are all pairs of points on one function, `archAt(side, u)`,
and all of them are drawn by one new helper: `strut(a, b, w, h)`, a box between two points in
space. Everything on this bridge before the arch was either upright or flat, so `part` only ever
turned about Y; an arch facet is tilted in the vertical plane, steeply at the springings and
hardly at all over the crown, and rotating unit +Z onto the member's own direction handles that
and the hangers and the diagonals with one function.

**The hangers lean out, because the ribs lean in.** A hanger on a vertical-rib arch drops
straight down, and copying that here put them in the road: `ribLean` pulls the ribs from 6.78 m
off the centreline at the springings to 4.18 at the crown, and a vertical drop from 4.18 lands
at 4.18, which is inside a carriageway whose edge is 6.3. Every hanger over the middle of the
span was hanging the deck from the middle of the road. The foot is pinned to the parapet line
now and the hanger leans out to reach it — 2.6 m of lateral run over 33 m of drop at the crown,
about 4.5°, which is exactly what an inclined-rib bowstring does and the reason its hangers
splay when you look along it.

**And the feet stand on the parapet, which is a 6 cm decision.** At a rib offset of 6.35 m a
0.22 m hanger reached 6.24, and the carriageway ends at 6.3 — a steel post in the nearside lane,
thin enough to miss in a screenshot and solid enough to find at 60 km/h. At 6.78 the whole
hanger is over 0.42 m of parapet that was never driveable, which is exactly where a real
bowstring's hangers come down.

**The parapet took three attempts, and the middle one was the instructive failure.** It started
as a post-and-rail fence — a post every three metres, a rail across their tops, 1.15 m tall —
which is the correct thing for a real bridge and which, from inside a car, is a picket fence
sliding past at eye height on both sides for three hundred metres, chopping the view into
slices. So it came off, and 42 cm of kerb went in instead. That solved the flicker and created a
worse problem: a bridge seven metres over open water with nothing at its edge does not read as a
bridge at all, and it will not hold a vehicle on the deck — a monster truck went over the side
at 37 km/h without slowing down.

What was wrong was never the height. It was the *repetition*. A solid wall at a proper 1.05 m,
with a steel capping band oversailing it 6 cm each side, is a continuous edge: it is a boundary
you can see and be held by, and nothing in it ticks past the window. You look over it rather
than through it. The oversail is the whole of the detailing — the overhang throws an unbroken
shadow line down the face, and that line is what stops a metre of concrete reading as a blank
slab, which is why this parapet needs no posts to look like one. The wall is in the deck's own
concrete and only the cap is steel; painting the whole thing steel made it read as the fence it
replaced.

What is still shared with the causeway is `buildLoft`. The deck, the girders and the edge beams
are all swept sections along one centreline, which is what that builder is for, and it already
sweeps along an arbitrary direction rather than a fixed axis. Only the piers, cross beams and
lane dashes are boxes, and they all merge into three geometries.

Three heights decide the grade: the street it leaves (read from the nav raster, because that
landing is a coast road and not sea level), the island crown it must meet, and the 6 m of air it
keeps over the water.

**The freeboard is a ceiling on the climb, not a floor under the deck**, and getting that the
wrong way round is what made the first version stand two metres above the street it was supposed
to join. Written as a floor, the profile asked for 6 m of air everywhere there was water — which
began five metres off the abutment — and was then handed to a cone filter that only ever raises.
The filter could not make that climb inside the grade, so it raised the abutment instead, and
the end pin that was meant to hold the deck on the street was overwritten by the very pass meant
to respect it. A clearance demanded where a road cannot have climbed to it yet does not produce
a tall bridge; it produces a bridge that starts in mid-air.

So each sample is bounded by how far the deck could have climbed from either end at no more than
5.5%, capped at the freeboard, and floored by the straight grade between the two ends. Both
abutments stay on their own ground by construction rather than by a pin something else can
undo, and the deck reaches the freeboard if and only if there is room — 2.25 m of climb at 5.5%
needs 41 m and has 150. Three light smoothing passes round the corner where the climb meets the
cap. It comes out 0.09 m at the street, 3.38 m at the crest — 7 m over the water — 3.34 m at the
island, and 5.5% at its steepest, which is only the ramp off the coast road.

**The island's own roads were here first, and the crossing does not get to move them.** The deck
runs the last hundred metres over the island's crown to reach the outer road, which is right — the
island's paving is axis-aligned rectangles in the island's frame and this crossing is a diagonal
in the world's, so a link road between them could be expressed as neither, and carrying the loft
inland gives a joint both sides agree about. What was wrong was everything past that. The outer
road had been stretched 18 m east to reach out and catch the deck, and the deck then ran ten
metres further still, over the road and out the far side as a tongue of tarmac on the grass. A
crossing that arrives late does not get to rearrange the place it arrives at.

So the road is back to the 330 it always ended at, and the island anchor is placed so the deck
stops 0.9 m short of that existing east end — 331 along, against a road running to 330 — and
abuts it rather than lying on it. The deck reaches the island's road network without a metre of
the island's being moved to meet it.

**The city end was walled off, and that is why it could not be driven onto.** The waterfront
here carries a sea wall: `col_Blocks_-6_-3` stands from the pavement to 0.93 m along x −2123 to
−2110, which is exactly where the deck leaves the street. A wall is a `col_` chunk and therefore
solid, so what you met driving west was a kerb you could not climb with the bridge visible
beyond it — the crossing existed and could not be got onto. `IslandBridge` has the identical
problem on its own street and solves it the identical way, and this now does too: the wall is
taken out of the mesh **and** the collider, which is what a highway authority would do rather
than ramp a road over its own parapet.

Two details of that cut are worth keeping. The box is wider than the 14 m deck because the
crossing meets the coast at an angle — a diagonal deck through an axis-aligned box needs the box
as wide as the deck's *shadow* on each axis. And it uses `overlap`, because the wall is tiled in
triangles far coarser than the cut, so a centroid test leaves its coping lying across the new
road; the y band does the discriminating instead, which is why the cut starts above the pavement
the wall stands on rather than at the ground. The two lists — the station's cuts and the
airport's — are concatenated in `CityMap`, so each crossing owns the demolition it needs and
`trim` stays the one place that knows how to cut.

Both ends also sink 6 cm below the ground they meet. Flush would leave the deck's running
surface coplanar with the street's, and two coplanar surfaces meeting under a wheel is a lip you
can catch on; sunk, the street wins at the joint and the bridge comes out from under it.

Only the running surface is solid. The edge beams are 42 cm of kerb and the girders are under
the deck — a car that leaves the carriageway at this height has bigger problems than a
collider.

**Ten cars cross it, and they are not the city's AI.** The city's traffic drives `cityNav.png`,
a raster that knows about road pixels at ground level and nothing about a deck climbing to 3.4 m
over open water. Putting the crossing into it would mean painting a diagonal road onto a grid
and then lying to it about the height, and the cars would still sit at the raster's ground
rather than on the deck.

None of that is needed, because the deck already *is* a track. Every point on it is `pointAt(s)`
and `heightAt(s)` for one number — exactly what a vehicle following a road needs — so a vehicle
here is a distance, a lane and a direction, and there is no polyline to resample, no raster to
consult and no second description of a route that is already described. `deckAt(s, offset)` is
the whole interface. Outbound counts up from the city and inbound counts down from the island,
which is one loop variable for both directions and makes them pass each other properly. They run
from −12 to +14 past the abutments so cars arrive out of the street rather than appearing from
nothing at the joint.

## Three aeroplanes, one runway

The A400M used to be scenery — parked on the cargo apron by the freight sheds, which is what
the east end of the field was built for and which nobody had ever seen used. It flies the field
now, on its own circuit: it lands, runs the runway out PAST the mid-field exit the airliners
take, turns off at the far end, taxis to that same stand, waits 26 seconds, is pushed back, taxis
the whole length of the field and takes off again. The parked one is gone — leaving it there
would have the flying one taxi into itself.

**The separation test had to change, not just its answer.** With two aeroplanes the rule was
"never both on the runway", and 0.25 of a cycle was the roomiest of the thirty offsets that
passed. With three it cannot be satisfied at all: every one of the 1,076 × 1,076 arrangements
leaves at least 5.3 seconds with two aeroplanes inside the runway strip.

That sounds like a problem until you look at what those 5.3 seconds are. Every one of them is
the 747 rotating while the A400M rolls out **five hundred metres away** at the other end of the
runway — which is not a conflict, it is an airport. A 900 m rectangle cannot tell a conflict from
normal operations, so the rectangle was the wrong instrument.

What matters is how close they ever actually get, so that is what is searched now: minimum
**wingtip** clearance — centre-to-centre distance less both half-spans, over every pair, over
every quarter-second of the cycle, ignoring pairs more than 40 m apart in height because one at
200 m and one on the ground are not close however they look in plan.

The result is worth having, and not just tidier: the arrangement the runway-box test liked best
left the 747 and the ATR **56 m** apart centre to centre on the taxiway, which with a 32 m and a
12.5 m half-span is **eleven metres** of wingtip. Searching clearance directly finds **31.9 m** —
three times the margin, from the same three circuits and nothing but a better question.

**Its first path was wrong in three ways, and a plan check found all three.** Walking the ground
part of a circuit and asking, of every sample, "is this on pavement, how fast is it turning, and
what is it near" costs one script and catches what a fly-past never will:

- **It taxied across 30 m of grass.** There are links between the runway and the taxiway at three
  stations — −380, 0 and +380 — and the freighter turns off at about +270, which is between two
  of them. A long-bodied freighter wants its own exit at the end it actually uses rather than a
  detour to a link 110 m further on, so the airfield gained one: `cargoExit`, butting the
  runway's edge and the taxiway's without overlapping either.
- **It spun 116 deg/s at seven knots.** Reversing means the nose stays where it is pointing while
  the aeroplane travels the other way — so an aeroplane pushed backwards to the WEST ends up
  facing east, and then has to turn 162 degrees on the spot to taxi west. A tug does not do that:
  it swings the tail so the aeroplane ends up facing the way it is about to go. The push curves
  east now, and the turn onto the taxiway is a few degrees.
- **Its wing went through a container stack.** The stack at (280, −31) measured 4.9 m from the
  taxi line, which with a 42.4 m span is sixteen metres INSIDE it. It was placed when the A400M
  was parked scenery and nothing moved through the freight yard; the moment the aeroplane started
  taxiing, the yard had to give way.

**And the same check caught the ATR doing the same thing** — 102 deg/s at its own pushback, for
exactly the reason the freighter did, pushed back west and left facing east. Nobody had noticed
because nobody had looked with a number. The worst yaw on the airfield is now 19 deg/s for the
747, 45 for the A400M and 60 for the ATR, all of them at taxi speed, and no aeroplane touches
grass at any point of any cycle.

Changing two circuits changed two lap lengths, which invalidated the schedule, so the clearance
search was run again: 31.0 m between the 747 and the A400M, 31.3 m between the ATR and the
A400M, 39.5 m between the 747 and the ATR.

**Four propellers, split by name.** The A400M is a turboprop and the ATR's spin, so static blades
would have been the one thing that gave it away. The export numbers the blades `BladeCW` and
`BladeCCW` with a suffix, and the numbering runs all the way round one hub before starting the
next — CCW 000–007 is the outer right, CCW 008–015 the inner left, and so on — so four regexes
group them. Clustering on position would also have worked and did not: a blade reaches two metres
either side of its own hub, so grouping on x splits every propeller in half. The hubs come out
at ±12.748 and ±6.912, symmetric to the millimetre, which is how you know the grouping is right.

And `Airliner` stopped choosing its model with `name === '747' ? jet : turboprop`. That is fine
for two aeroplanes and is a bug waiting for a third — the A400M is a turboprop that is not the
ATR, and would have been handed the ATR's mesh and the ATR's two propeller names. It is a table
now.


## Halcyon Pier

An amusement park on the strip of island between the outer road and the cargo apron — 160 m by
144, the first thing on your right as you come off the bridge, and empty until now. Five rides,
a promenade, a fountain, a shop parade and eighty trees. `parkConfig` owns the layout in the
island's own `along` / `across`, `AmusementPark` draws it, and `prepare-park.mjs` gets the rides
down to a size that can ship.

**760,000 triangles in one roller coaster, and 708,000 of them are the track.** That is more
geometry in one ride than in the whole airport, both aeroplanes and every vehicle in the city
put together, and the reason is that a coaster track is a swept tube — the single most
over-tessellated thing a modelling package produces. It comes down to 76,000.

Getting there was measured, not guessed, and two of the measurements are worth keeping:

- **`LockBorder` locks almost everything here.** With borders locked, meshopt could only reach
  298,000; without, 127,000 for the whole ride. The track is thousands of small closed shells —
  every tie and every rail segment its own solid — so nearly every edge *is* a border. Unlocked,
  each shell simplifies inside itself and the pieces cannot pull apart from each other because
  they were never joined.
- **127,000 is the floor, and it is topology rather than tolerance.** Raising the error budget
  from 0.01 to 0.12 changes the result by not one triangle. `simplifySloppy` would go lower and
  would throw the UVs away with it, and the UVs are the track's yellow rails and blue trim.

**The plate is not a plate, and deleting it left the ride in the air.** The coaster carries its
own ground plate, and dropping it is right — the park lays its own paving and two coplanar
surfaces is a z-fight across the whole ride. What was wrong was then grounding the ride on its
own lowest vertex, which put a good part of it eleven metres up.

The plate is 11.24 m thick at final scale. Measured, the support feet come in two families: a
few founded near its underside at 1.06 m, and the bulk of them standing on its top surface at
11.5. So the ride has two datums ten metres apart, and the one that matters is the top of the
plate — that is the ground the thing was drawn standing on. Grounding on the lowest vertex
chose the other one and hung every support of the second kind in the sky.

A floor percentile cannot find this. It was written to find the floor of a building and it does
that well, but the floor here is not part of the part: it is the slab that was just thrown away.
`floorFrom` reads the datum straight off that slab's top before it goes. The supports that stood
on it now stand on the park's paving, the handful that ran down through it are buried, and the
ride's recorded height fell from 45.2 m to 35.2 — which was also its collider.

**The attractions pack is the opposite problem.** Cheap, already in metres, and a laid-out
*scene* rather than a kit, with two of its rides split into a static structure plus a SKINNED
mesh sitting in bind pose somewhere else entirely — the ferris wheel's rim is a flat ring 43 m
across lying in the XZ plane at y 22, forty-four metres behind its own towers. glTF requires
skinned meshes to sit at the scene root with no parent transform, which is why they answer to
their own names (`Object_8`, `Object_111`) rather than to their parents' like everything else in
the file. A quarter turn about X stands the wheel up; centring each on its own middle makes
placing and spinning it a transform and nothing else.

**A clip rule that cut 160 triangles and changed nothing.** Both bumper cars come with a 7.3 m
mast — a contact pole for an electrified ceiling the pavilion does not have. Dropping triangles
*wholly* above a line is the obvious rule and it is useless here, because the mast is four long
quads running the whole way up: every one of its triangles has a foot on the car and a head at
8 m, so not one is wholly above any line you could draw. Dropping any triangle that *reaches*
over the line leaves a 1.5 m car, which is what a bumper car is.

And the measurement has to read the vertices a triangle actually uses. Clipping leaves the
mast's vertices in the buffer — Draco drops anything unreferenced on the way out, so re-indexing
them would be a pass for nothing — and a bounds check that walks the position array straight
through still sees 7.3 m after the mast has stopped being drawn. That is how a 2.5 m car gets a
collider three times its own height.

**The coaster runs, and the ride was in the file all along.** Before finding that, I spent a
long time trying to recover the track's centreline from the mesh — grouping vertices into rings
of the swept tube, splitting the sequence where it jumps, stitching the runs back into a
circuit. It cannot be done, and the measurement that says so is worth keeping: with the jump
threshold set correctly (0.4 m, because the intra-tube step is 0.12 m and the gap between
cross-ties is about 1 m) the longest continuous run in ANY primitive is 25 m, in a circuit
several hundred metres long. The track is not a vertex-ordered sweep; it is thousands of
separate pieces. An earlier threshold of 3 m hid this by chaining across the ties and producing
confident nonsense — a 434 m "run" inside a 16 m box.

The export carries a 45-second animation called "Take 001" driving three cart trains round the
track. That is the ride, drawn by the person who drew the track. `prepare-park.mjs` samples it
at 20 fps into a uniform table of position and rotation — uniform because the keys are LINEAR
and unevenly spaced (979, 909 and 909 of them), and a uniform table is a lookup rather than a
search. The clip animates scale too; it is 1.000 throughout and is ignored.

Two details make it land on the track rather than beside it. The geometry is baked in world
space by the time it is split out, so the cart's own local shape is that geometry with the
t = 0 pose divided back out — and dividing out the pose divides out its SCALE, which is the
FBX chain's, which is why the first attempt produced a 726 m cart. And the sampled positions
take the ride's own framing: the same centring, floor and metre scale as the mesh. The check
that it worked is that all 900 keys of all three trains fall inside the ride's own bounding box,
topping out at 35.0 m against the ride's 35.2 — the train reaches the top of the lift hill and
nothing reaches past the structure.

**A train is four cars, and they trail by metres rather than by keys.** The clip drives ONE
car — the modeller's `Dummy` holds a single body, its seats and two lap bars — and one 1.9 m car
on a 100 m ride is a speck you cannot find from anywhere the whole coaster is in frame. A train
is the same table sampled four times at a fixed offset, so the cars follow each other exactly
rather than approximately.

The offset has to be a DISTANCE. The clip's speed varies the way a coaster's does — it crawls
out of the station and hits the bottom of the drop flat out — so its keys are bunched where it
is slow and strung out where it is fast, and offsetting by a fixed number of keys gives a train
whose cars sit on top of each other at the station and yards apart on the drop. Measured, a
five-key offset was 1.36 m at the station and would have been several times that on the drop.
With a cumulative arc-length table and its inverse, the gap holds at 1.90 m — the length of a
car — to within a millimetre everywhere the train is moving.

It is not exact in the station, and that is worth stating rather than hiding: for the ten
seconds the train is stopped, the head is pinned while the tail sits back on the curved
approach, and the straight-line gap between the first two cars closes to as little as 1.08 m.
146 samples out of 1,350 across the cycle, every one of them at a head height of 4.5 m, which is
the platform. A stopped train's cars overlapping slightly is not the thing anyone is looking at.

**It was sky blue, and now it is neither that nor white.** Two of the three track materials are
untextured and are simply replaced: the rails go red, and the trim tube drops to a dark steel so
the red is the only accent. The supports and the cars are textured, and textures need repainting
at the pixels — glTF multiplies `baseColorFactor` into the texture, so to cancel the supports'
cyan a factor would have to exceed 1 in red, which the format does not allow.

Three measurements decided what those repaints are, because guessing at this twice is slower
than measuring once:

- The supports' texture is **#92dce3** — bright cyan. White was the first answer and the wrong
  one: a hundred slender white members against a bright sky have nothing to read against, and
  the ride loses its structure, which is half of what you see of a coaster from a distance. They
  are gunmetal now, measured at **#5e6066**.
- Getting there needed `brightness` as well as `tint`, because sharp's `tint` PRESERVES
  luminance — it changes hue and leaves lightness alone. A pale cyan texture tinted grey is a
  pale grey texture, which is exactly what the first attempt produced: **#c8d2df**.
- The cars' texture is **#e3e898**, a pale cream-yellow, and that is the "faded".

**The trains are three colours, and they are rotations rather than replacements.** The first fix
for the fade desaturated the cars and duotoned them blue, and that was worse in a way worth
recording: a duotone maps every pixel to one hue, so the livery's stripes, its shading and its
panel lines all collapse into a single flat colour. It read as a blue lozenge. Rotating the hue
keeps all of it — every pixel moves the same number of degrees round the wheel, so the
relationships between the colours survive and only the key changes. Three rotations give three
trains that are recognisably the same design in three colours, which is what a park with three
trains has: **#f44e37** vermilion, **#588bf4** royal blue, **#f73cd3** magenta.

Two things had to be measured rather than predicted. Where a rotation lands, because the mean
hue of a multi-hued texture does not move with the rotation the way a single colour would — −65°
was expected to give red and gave orange, −92° gave pink, and every value was finally swept and
read back off the rendered pixels. And whether pushing saturation this hard flattens the livery,
which is the thing to check: it does not. Per-channel standard deviation goes UP with it, 19.4
at ×1.8 against 24.8 at ×2.2, so the stripes are amplified along with the hue rather than
crushed.

A sweep like that is also easy to get silently wrong. `sharp(img).modulate(...).stats()` reports
the statistics of the INPUT — `stats()` does not see queued operations — so the first sweep
returned the source colour for every single candidate and looked like a hue rotation that did
nothing. The pipeline has to be rendered with `.toBuffer()` first and the buffer measured.

**The pack's rides had crushed blacks, and that is measurable rather than a matter of taste.**
Every ride in the attractions pack is built from two materials — `build_gen_1` and
`build_gen_2`, the pavilion's walls, the drop tower's mast and deck, the carousel's base, the
wheel's A-frame and rim — and both textures had pixels at **0**, a spread of 60 to 74, and means
of #534340 and #916a68. Out in daylight against pale paving that does not read as dark paint; it
reads as a hole cut in the picture, which is exactly what the bumper-car pavilion looked like.

`linear(a, b)` is `out = a*in + b`: the offset lifts the floor off zero and the multiplier keeps
the top from clipping. The darkest pixel goes to 64 and 42, the spread drops to 36 and 55, and a
little saturation goes back on top because lifting blacks toward grey is also lifting them
toward colourless. A structure lit by the sky rather than one cut out of it.

The same measurement caught something that had been hiding in plain sight: the **bumper cars
themselves** were **#0c0e11** and **#120e0b** — near black, on a ride whose entire visual idea is
brightly painted cars bouncing off each other. There is paint in there, at a twentieth of the
brightness it wants. Lifted and saturated they come out teal, purple, orange and pink, which is
what a bumper car is.

The materials also got a finish. Everything defaults to roughness 0.85 and metalness 0.1, which
is right for concrete and wrong for a painted steel ride; the rails, the supports and the cars
are lacquered, and a little metalness with a lot less roughness is the difference between a ride
that catches the sun along its rails and one that looks like chalk.

**The layout was checked before it was built.** A script over `parkConfig` and the model data
that puts a box round every ride at its measured size and its stated turn, then asks whether
each one is inside the site, whether any two overlap, and whether any of the park's paving lands
on the airfield's. The first run failed: the 80 m shop parade did not fit west of the promenade,
and it was standing in the bumper-car pavilion. It is turned a quarter now and stood against the
west boundary, which is the layout's one hard constraint rather than a preference — anywhere it
fits lying flat it lands on either the promenade or a ride.

The rejection sampling for the planting needed the same treatment. 90 trees asked for, 17
placed: the site is 23,000 m², the rides take 12,000 and the paths another 7,000, so what is
left is a fifth of the park in a dozen awkward pieces, and an 11 m spacing on top of that leaves
almost nowhere. A tree may stand 2 m off a kerb and 4 m off a ride now, which is where a park
plants them.

**What is borrowed rather than imported.** The shop parade, the trees, the copses and the
street furniture are city chunks placed a second time — `deco_Building_-4_-1` is the same
low-rise cell the island's village is built from, and `deco_Accesories_-4_-3` is the run of
kiosks and benches that reads as a row of stalls when you scatter it along a promenade. The
hub in the middle used to hold a fountain drawn from nothing — two basins, a pedestal and a
breathing plume — and now holds a statue: the cute cartoon panda with its bamboo, dropped in the
repo and baked to 3.2 m by `prepare-panda.mjs`, standing on a low stone disc (`STATUE`). The
plaza is still laid out from `FOUNTAIN`'s numbers, because every measurement on it was taken off
the fountain. The swap also fixed the plaza's invisible walls: the fountain's collider was a
24 m box round a 12 m basin, and its four corners stood five metres out on the paving. The
plinth's collider is a cylinder the size of the disc and nothing more.

**Everything that moves is a transform.** A ferris wheel is a rotation about Z, a swing carousel
a rotation about Y, a drop tower a position on a line and a bumper car a point on a circle. Not
one needs a rig, an animation clip or a physics body, and between them they are the difference
between a park and a photograph of one. The drop tower's cycle is deliberately not a sine —
climb, hold, fall, rest, with the fall four times quicker than the climb — because the asymmetry
*is* the ride, and up and down on one wave reads as a lift.

**But "a transform" is not the same as "one transform", and the first version got that wrong on
every ride that has parts which move differently from each other.**

- **The wheel's cabins turned with the rim**, because the wheel was one mesh and rotating a mesh
  rotates all of it. A cabin upside down at the top is the thing everybody sees. The source
  already had the split — the rim is two big nodes and each of the sixteen cabins is a pair of
  small ones — so the rule is size, and the pairs are found by clustering what is left on
  position. Each cabin is centred on itself and its offset from the axle is recorded as a radius
  and an angle: 19.65 m, one every 22.5°, measured. The game orbits them and never turns them,
  which is what the pivot at the top of a real cabin does.
- **The wheel hung in front of its own towers**, because it was hung on the middle of the base's
  bounding box. The bearing is not there; it is the apex of the A-frame. Taking the centroid of
  the highest two per cent of the base's vertices puts it at 27.5 m and 1.7 m back in Z, against
  the 23.2 m and 0 that had been written down by hand — four metres low and nearly two out.
- **The swing carousel turned its own foundation.** The base, its steps and its ground plate all
  spun, which is not a thing a fairground ride does. The source splits by material: `build_gen_2`
  is the base and `build_gen_1` is the mast, canopy and swings.
- **The drop tower's gondola rode a bounding box**, whose centre is not the mast — the platform
  at the bottom is wider than the tower and drags the centre off. Same measurement as the wheel's
  axle, and the gondola is on the mast's own centreline now.
- **The bumper cars' facing was two guessed quarter-turns.** For a point at angle `a` on a circle
  the tangent is `(-sin a, cos a)`, and a yaw of `atan2(dx, dz)` aims an object's own +Z along
  it — which works out to exactly `-a`, with no quarter-turn anywhere. What was there was a
  `±π/2` alternating on the car's index, which is what you write when you are adjusting until it
  looks right rather than working out what it should be. `spin` is that correction, named, and
  it is zero.
- **The bumper cars drove under their own floor.** The arena is a raised platform and its deck
  is 2.25 m up, on a structure that reaches the ground; the cars were riding at y = 0, which is
  inside the building. Four of them circled invisibly for a while. The deck is measured now —
  the busiest quarter-metre band in the lower half of the part, because a floor is the one
  horizontal surface with thousands of vertices on it — and the cars ride it.
- **The gondola was inside the deck at the bottom and through the crown at the top.** Both ends
  of a two-number travel, both wrong for the same reason: the numbers were written by hand
  against a tower nobody had measured. The gondola is centred on its own middle and is 4.5 m
  tall, so `low: 3.4` put its floor at 1.15 — a metre inside the platform. And slicing the tower
  by height shows a slim 4.0 x 3.1 m mast from 2 m to 19, then a headframe of 9.0 x 7.6 from 20
  to 25, so `high: 24` drove a gondola whose roof reached 26.25 straight up through the crown.
  It rests on the measured deck and tops out at 16.5, roof at 18.75, just under the headframe.
- **Three rides stood on bare grass.** The drop tower, the swings and the bumper-car pavilion had
  no apron — a 30 m ride rising out of a lawn, with nothing to say anybody was meant to walk up
  to it. Each has one now, sized to its footprint and starting where the neighbouring path stops.

Adding those aprons was also what turned up two coplanar overlaps that had been there unnoticed:
the west cross walk was laid 16 m on top of the parade walk, and the fountain's plaza disc shared
four metres with the wheel's deck. Paving here tiles; it never stacks, and a pairwise check over
`PARK_PAVING` is cheap enough that there is no excuse for finding out from a flickering floor.
The plaza disc is the one exception and it is deliberate: it has to overlap the promenade it sits
on, so it is raised two centimetres and is a kerbed plaza the promenade runs into.

**The moving parts have no colliders.** The rides get a box each from their measured size, the
same as the airfield's buildings; the wheel, the gondola and the cars get nothing. A ferris
wheel with a collider is a 43 m blade sweeping through whatever is parked under it, and the one
thing worse than not being able to drive into a ride is being launched into the sea by one.

**The compass said `undefined -272°`** while this was being flown, and it was not the park.
`(degrees + 360) % 360` normalises a heading that has wrapped once; the drone's yaw accumulates,
so spin it a full turn one way and the result is still negative, `Math.round(deg / 45) % 8` is
negative too, and `CARDINALS[-6]` is `undefined`. Two modulos.

**The map shows the airfield now.** It was the island and one dark bar for the runway, which
was the whole of the airport when the airport was a runway. `paintAirport` draws it from the
very numbers `AirportIsland` builds from — the same outline, the same `PAVING` rectangles, the
same `BUILDINGS` at the same measured sizes — so the airfield on the map is the airfield in the
world by construction and cannot drift from it. Painted in the order the ground is built: land,
then every paved surface, then the runway and taxiway over the top in a darker tone because at
minimap scale an airport *is* two long dark strips beside a pale blob, then the buildings, the
helipads in their safety orange, and the parked aeroplanes in near-white — the one thing on the
island that says what the strips are for.

## The Wall of Death

North of the outer road there is a *maut ka kuan* — a Wall of Death — at island
(330, 304), hard up against the road, with the island line's down main passing 30 m behind
its centre and the parcel hub (see *The island line*) on the ground to its south.
`wallOfDeathConfig.ts` owns the numbers and `WallOfDeath.tsx` draws it inside the island's
group, so `WOD_SITE` is the one thing to edit to move it. It has stood at (245, 358),
(245, 304) and (265, 304) on the way here; what limits how far north it can go is the drum's
foot — 21.6 m from the centre with its plinth — against the track beds, not the canopy's
29.4 m brim, which is 21 m up and clears any train. It is deliberately **not** fenced.

**It is a real drome's anatomy at four times the size, because the player rides it.**
Touring walls are 6–11 m across and 4.6–7.6 m high with the foot of the wall banked so a
rider can get from the floor onto the vertical. This one is 40 m across at the foot: a 23 m
floor, a 9 m bank, and 12 m of timber above it, with a railed gallery round the top, two
straight steel stairs up to it, a canopy brim on twenty columns, a lit sign pylon, a kiosk, and
the city's own traffic cars parked along the forecourt. It went 20, 32, 44, 52 m as the user
asked for bigger, then back to 40 when 52 looked too big; the 52 m step is also where the
geometry changed.

**The wall leans outward at 72°, and that is a concession.** A real wall is vertical, and a
vertical wall was tried: a raycast vehicle holds it only while `v² / R ≥ g / μ`, over 60 km/h on
the rear tyres' grip, held exactly, with nothing under the car but friction — and it could not be
ridden smoothly. At 72° a share of the car's weight presses it into the surface, the speed it
takes to stay up falls by a third, and losing a little speed slides you down the bank instead of
off the wall. The bank is a 9 m arc that sweeps exactly to the wall's angle so there is no
corner anywhere in the profile, and it starts at y = 0 — the crown the wheels actually ride —
rather than at the slab's top, because a bank that began 6 cm up put a lip at its foot that
every car hit at speed. 160 segments and 28 profile steps keep the facets under half a degree.

**The collider is the drawing.** The bank (a `LatheGeometry`), the leaning wall and the outer
skin are merged into one seamless `TrimeshCollider`. The floor is not in it: the slab is flush
with the forecourt and the island's crown under it is the ground, as under every other paving on
the airfield. There is **no door**. A slot through the bank was tried and hit once a lap; a door
that shut behind you was tried and was a mechanism nobody wanted. You get in the way you get into
a Vice City mission: drive into the orange halo on the forecourt, the strip says `ENTER · WALL OF
DEATH`, and Enter puts the car at the drum's centre with the whole floor to build speed on. A cyan
halo at the centre does the reverse. `physics/portals.ts` is the seam: the marker offers, the
chassis moves the car inside its own physics step, the HUD feed reads the offer.

**Minimal, in two colours.** Teal on the plumb foot of the drum, its twenty-four slim ribs, its
trim and the canopy; a soft creamy white on the leaning wall between them, so from the road it
reads as a cream bowl sitting in a teal ring under a teal lid. One ring of warm gold light high
on the wall, a marquee with the name once on the front, a slim totem sign with the name stacked
down it, and a kiosk on a forecourt that meets the outer road's kerb. Many palettes came before
it and this is the pair the user named; low poly is at its best when the design is in the
proportions and the palette is two colours and a line of light.

**The riders are the models dropped in the repo, riding by the physics of the thing.** Two
low-poly bikers — the same motorcycle with a different rider on it, baked by `prepare-bikers.mjs`
into `bikers.glb` facing −Z with each wheel on its own axle node — and two of the city's traffic
cars, assembled from `vehicles.glb` the way `Traffic` reads it. Each machine's up is the negative
of its apparent gravity, `(0, −g, 0) + (v² / r) · u_out`, so it leans up the wall by
`atan(g r / v²)` from the surface normal: a third of a right angle at 65 km/h, the slower car
visibly further up than the bikes, exactly as in the real show. The contact patch is the model's
origin and rides the surface at the radius the leaning wall has at that height; a pitch about the
axles tips the nose up by the slope of the rider's height wave, and the wheels spin at `v / r`.
They carry no colliders. The airfield's tree scatter is excluded from the site (`WOD_BOUNDS`),
because the 286 and 364 planting bands both crossed it.

**It stands against the road so the railway can pass behind it.** The site is `across` 304: the
forecourt's front edge is a metre off the outer road's north kerb and the drum's foot stands at
325.6, so at along 330 the down main, 30 m from the centre, clears the foot by more than eight
metres at ground and passes under nothing but the canopy's brim, twenty metres up.

## The island line: Halcyon Junction and the parcel hub

The airport island's railway (`islandRailConfig.ts`, drawn by `IslandRail.tsx` inside the
island's group) runs from its open end over the water off the north-east corner, round the
Wall of Death's east side, straight down the island along `across` 348 and, through an S on
160 m, over the Skylark road **on its deck** at the island's west tip, to join the Skylark line
end-on over the water. There are no points and no buffer stops at that joint: the two are one
railway, and one climb (1.73 %, `TRUNK_CLIMB`, shared with `countryConfig`) takes it from the
tip up to Skylark's landfall.

### The station

**Halcyon Junction** (`STATION_NAME`) stands on the trunk's straight at along −42: four
platforms, 200 m long, and four tracks — the two mains through the middle with an island
platform each, and a loop outside each main with a side platform beyond it (`STATION`,
`stationLoop`, `stationPlatforms`). The loops ease out of and back into their mains over
100 m leads. All four tracks stand on **one** formation bed (`trunkFormation`), because
separate beds leave grass triangles at every handover and z-fight where they overlap.

- **The building** is the user's own model, `public/models/station.glb`, baked by
  `npm run prepare:station` (`scripts/prepare-station.mjs`) from
  `standar_materials_fbx_nombres_corregidos.glb`: its "store" lettering is dropped, box-projected
  UVs are added, and its materials are re-finished by name. Two copies stand end to end, one
  mirrored, wall to wall along PF1's back, at 1.25×. The finish is a **contrast** palette —
  warm light stone panels on the back and ends, rich cedar slats on the front's piers, slate
  blue-grey and mid-grey concrete as accents, graphite frames — with plain textures (seams
  only). glTF base colours are linear, so every finish is written as sRGB hex and converted.
- **Canopies and footbridge** (`StationCanopies.tsx`, `STATION_CANOPY`, `STATION_FOOTBRIDGE`).
  Thin curved shells over the middle 122 m of all four platforms — an arch on tapered Y columns
  with a glazed rooflight over each island, a sweep from back columns over each side platform —
  grey metal on top, cedar underneath, slate-blue steel and a teal fascia line, light strips
  under the purlins. There are no lamp posts on the platforms. A glazed, roofed footbridge at
  along 14 crosses all four platforms and tracks, with a stair down onto each one. The platform
  floors are paved in 600 mm slabs; the ramps and platform faces are bare concrete.
- **Signs** are generic modern, not London: a slate-blue fascia with a teal train pictogram
  and white lettering over the door on both sides, and only a platform number on each
  platform. Direction signs elsewhere on the railway (the junction gantries) follow a different,
  plainer rule — see *The viaduct junction to Skylark*.

### The forecourt and the car park

`StationForecourt.tsx`, from `STATION_FORECOURT` and `STATION_SHOPS`.

- **The station road is all road kit** (`roadConfig`): a `junctionT` on the parade's second link
  crossroads (along −104), a kit run along the building's front and a `junctionT` at its east
  end whose south arm drops to the station exit on the outer road and whose east arm opens into
  the parcel hub. Hand-built road next to kit junctions was tried and rejected; tiles meet tiles.
- **The car park** runs west to along −300, slid a verge back from the outer road so the hedge
  (the amusement park's own `bushLow` shrubs) stands on grass, not on the footpath. Parade link
  1's outer end is a crossroads whose north arm is the car park's own way in. Three shops from
  the parade kit stand on the asphalt in its northern half, each with a cross aisle and a
  loading bay; a lorry park is at the west end; a bus and coach bay along the kerb and a
  black-cab rank by the station. About a fifth of the bays are filled, and no car is parked dead
  straight.

### The parcel hub

`CourierHub.tsx`, from `COURIER_HUB`: the courier yard on the ground north of the station
building, from the station road's east T to along 290, between the outer road and platform 1.
It is seamless with the station — no fence on its station side — and fenced only along the
road, along the tracks past PF1's end, and across its north end.

- **Two ways in:** the airport entrance at along 120 is a crossroads whose north arm is the
  hub's main gate, and a `junctionT` at along 205 is its north gate.
- **Buildings:** the airport's 60 m cargo shed as the sorting shed, with a raised loading dock,
  roller shutters and a canopy; and two buildings in the station's modern style, built by
  `building()` in `CourierHub` — the **Distribution Centre** at the north end and the **Fleet
  Workshop** at the west end (ribbed silver cladding, slate plinth, teal line, glazed office,
  roller shutters). The city's brick depot and the Skylark island's shed were tried there first
  and taken out as too old.
- **Vehicles:** the city's box truck and artic (`npm run prepare:trucks` cuts them out of
  `city.glb`'s scenery into `trucks.glb`), the Skylark island's artic, lorry cab and site lorry,
  the airport's catering high-loader, post vans, road-service trucks and a few staff cars —
  backed onto the dock, in a lorry park, two van rows and at a fuel and charging canopy.
  Shipping containers are built procedurally, because the city's `deco_container1` is every
  container in the city in one 370 m mesh. At most two lattice towers stand on the site.
- **Platform 1 runs on north** into the hub (`PF1_NORTH`), broadened into a drive-on deck by
  the station and reached by two vehicle ramps down into the yard. Only parcel vans and baggage
  carts stand on it.
- **PF1's own line** (`PF1_SPUR`, `pf1Spur`) carries straight on where the down loop turns back
  to its main, alongside the platform, and then eases onto the down main ahead of the station
  to join it tangentially at along 335 (no curve tighter than 200 m). A container train stands
  on it: a Class 37 at each end of ten flats — 40 ft boxes alternating with pairs of 20 ft boxes
  in mixed colours — spaced by the running freight trains' own `freightFormation`.

To look at it: the whole hub, `?car=drone&at=-2454,-50,50,252.8`; along platform 1 and the
train, `?car=drone&at=-2369,-55,16,252.8`; the Distribution Centre,
`?car=drone&at=-2365,-176,14,252.8`; the station front, `?car=drone&at=-2497,107,16,252.8`.

## Two aeroplanes, one runway

A 747 and an ATR 42 each fly a circuit of the city, land, taxi in, park at a terminal stand, are
pushed back, taxi out and take off again. Two Qantas A330s stand at the other gates and an
Airbus A400M on the cargo apron at the far end — 42.4 x 45.7 m, which is the real aeroplane,
nose at +Z like the A330, and needing no levelling because all three of its gear legs already
reach within 0.3 m of each other. The
startup line names them both:

```
[flight] 747:    9280 m, 38 fixes, 269 s a cycle (248 s moving, 21 s standing), starting 0% round
[flight] ATR 42: 7796 m, 38 fixes, 269 s a cycle (246 s moving, 23 s standing), starting 25% round
```

**The circuit became a thing rather than a module.** `makeCircuit(name, fixes, target?)` is
called twice and each caller gets its own track, attitude tables, holds and `at()`. Everything
above it — the runway frame, the spline, the limits an aeroplane obeys — is shared.

**They share a period on purpose.** The only way to keep two aeroplanes off one runway *forever*
is to give them the same cycle and a fixed offset: unequal periods drift, and drifting periods
eventually coincide, which is to say that one day they would both be on it. The 747's natural
cycle sets the period at 269 s and the ATR's speeds are trimmed by a single factor to match — a
few per cent off the written ones, which nobody can see. A collision, everybody would.

**The offset is 0.25, and it was searched for rather than picked.** Every offset from 0.01 to
0.99 was walked for two full cycles, counting samples with both aeroplanes on the runway and
the closest they come at a similar height. Thirty of the ninety-nine keep them off the runway
together; of those, 0.25 is the roomiest at **65 m** at its worst — twenty metres of wingtip
clearance with a 747's 32 m half-span and an ATR's 12.5 m, passing on the same taxiway. Half a
cycle, the obvious choice, puts them on the runway together for twelve samples out of 2,690.
They park two stands apart, so neither is ever going where the other is.

**Neither aeroplane carries navigation lights.** See below — they read as coloured dots rather
than as lights, and the positions were a 747's handed to a turboprop.

**The ATR's propellers spin, and that took getting the model apart rather than animating it.**
`prepare-airport` splits `leftProp_14` and `rightProp_22` into their own meshes, recentres each
on its own hub and writes the hub to `airportModelData.json`; the component puts the mesh at
the hub and turns it about Z. Nothing else. They tick over on the stand and run in flight,
integrated rather than driven off the clock so that changing the rate does not make the blades
jump.

Two things about the new models were measured and fixed on the way in:

- **The A330 parked nose-up.** Its main bogies are modelled 1.5 m below its nose wheel, so
  grounded on its lowest point it stood tail-down with the nose wheel in the air. `levelGear`
  measures the lowest point near the nose against the lowest near the mains, over the distance
  between them, and pitches the part by the angle that puts all three on the tarmac — 1.9
  degrees here.
- **The slab-dropping rule ate fifty-one parts of the ATR.** "Cheap and flat" was written for
  the terminal's own apron quads, and on an aeroplane 7.7 m tall it matched every door, wiper
  and aerial. It is opt-in now, and only the terminal opts in.

## The 747, and its full cycle

A Boeing 747 flies a circuit of the city, lands, taxis in, parks at a terminal stand, is pushed
back, taxis out and takes off again: a **269-second cycle — 91 seconds of it in the air and 178
on the ground**, of which 21 are spent standing still. `flightConfig.ts` owns the whole thing.
Two more 747s stand at the neighbouring gates and one on the cargo apron; the middle stand is
left empty because that is the one the flying one parks at.

**A minute in the sky is not reachable, and the reason is worth writing down.** Two 180-degree
turns at a 37-degree bank take `pi * sqrt(R / g tan 37)` each — about 32 seconds — *whatever
the speed*, because flying them faster needs a proportionally bigger radius to hold the bank.
That is a minute of turning before a metre of straight is flown. The pattern is now as tight as
it gets at 1,500 m wide on a 750 m radius, and 91 seconds is what falls out. Getting to 60
would take about 70 degrees of bank, which is an airshow, not an airliner.

**Four sudden rotations, all found by measurement rather than by eye.** A sweep of the whole
cycle for degrees-per-second of yaw, bank and pitch turned up:

- **849 deg/s of yaw at the stand, and 776 at the pushback's end.** At a corner the heading
  table holds the *outgoing* tangent and the sample before it the *incoming* one — opposite
  directions — so flipping the pushback's half turn after reading the table meant interpolating
  between two headings 180 degrees apart. The aeroplane spun through half a turn in the five
  metres either side of its own stand. The flip is baked into the table now, which makes both
  samples read 73 degrees and leaves nothing to interpolate.
- **431 deg/s of roll at rotation.** Bank was forced flat on the ground and switched back on at
  the wheels-up point. It fades over 260 m either side now.
- **32 deg/s of pitch levelling off downwind.** Angle of attack was `climbing ? 2.9 : 1.1
  degrees` — a step taken the instant the gradient crossed a threshold, and levelling off
  crosses it. It is a smoothstep over the same range now.

What is left is 20 deg/s of yaw in the back-taxi turn at 6 m/s, 13 deg/s of roll rolling into a
turn, and 10 deg/s of pitch in the flare. Those are all things an aeroplane does.

**The service road moved out from under the aeroplanes.** It ran across the apron three metres
behind the parked tails and — worse — straight through the corridor the flying 747 now taxis
down to reach its stand. The band between the aircraft noses and the terminal is where ground
vehicles actually work, and here it is genuinely empty: a 747 nose-in at z 4 reaches z 39.3,
the terminal starts at 62, the maintenance shed at 58.6. The road threads z 44 to 55 with five
metres either side. Checked: the nearest any route now comes to the taxiing aeroplane is 42 m,
no route passes under a parked one, and the taxi path clips nothing.

## How the ground half works



**The ground half is the interesting half.** It lands, brakes to a taxi speed by mid-field,
takes the middle link off the runway, taxis to the stand and stops square to the terminal;
twenty-four seconds later it is pushed back tail-first, swung through ninety degrees, and
released facing down the taxiway; then it taxis the length of the terminal, turns on the pad at
the threshold, lines up and rolls. Four things this needed that a flying circuit does not:

- **A path can say "slow", it cannot say "stopped".** At 2.4 m/s the aeroplane would glide
  through its own stand in ten seconds and never park. `HOLDS` gives a distance and a duration
  and the component stops advancing the distance until the duration is spent — with a
  `served` index, because without one the aeroplane waits, creeps a metre, and finds itself
  back inside the same window.
- **Two cusps, and both are real.** An aeroplane arrives at a stand nose-first and leaves it
  backwards; it is pushed back and then taxis forward. At each it stops dead and sets off the
  other way, and a Catmull-Rom asked to draw a cusp draws a curl instead. Spans that touch a
  `corner` fix are drawn straight and the spline's neighbours are clamped there.
- **Reverse legs.** A pushback is the aeroplane travelling one way and pointing the other, so
  `reverse` flips the heading over those legs. The flag marks the leg *starting* at a fix,
  which is why it sits on `stand` and not on `push end` — getting that wrong had it taxiing out
  backwards down the whole terminal frontage.
- **The tangent window had to stop being one number.** 40 m either side is right in the air,
  where it keeps the heading off sampling noise. On the ground it is far too wide: the leg onto
  the stand is 28 m long, so a 40 m window reached back past it into the taxiway and parked the
  747 at 64 degrees to the terminal it was supposed to be square against. It is 8 m on the
  ground now, and the taxi turns are crisper for it. Bank is forced to zero on the ground for
  the same family of reason — taxi turns are tighter than any turn in the air, so the curvature
  formula would round the apron with a wingtip on the tarmac.

**Three pieces of new paving, because the aeroplane needed somewhere to do this.** A link is
18 m wide and a 747 leaving the runway at 36 km/h turns in rather more than that, so the middle
link gets an **exit fillet** and the threshold link gets one too; and a runway an aeroplane
back-taxis down needs a **turn pad** at the end, because a 747's minimum turning radius is about
45 m. The pad's west edge is at x −435 and not −460 because the coast comes in fast at that end
— at −460 the south shore is 159 m out and the pad's corner was 6 m into the sea.

Checked rather than eyeballed: the whole 1,825 m ground path is on tarmac at every one of 913
samples, the paving still tiles without overlapping, and it is still one connected surface —
nineteen pieces now.

## The old two-minute circuit



A Boeing 747 flies a continuous circuit of the city and Halcyon Field. **Every two minutes it
lands on the runway and takes off again off the far end** — a touch-and-go, so it arrives at
one threshold and leaves from the other without ever turning round. `flightConfig.ts` owns the
whole flight; `Airliner.tsx` is forty lines that turn it into a transform.

**Nothing in the circuit is a world coordinate.** Every one of the twenty fixes is written as
`along` metres up the runway from its threshold and `across` metres to the side of it, so the
pattern is bolted to the tarmac: move the island or turn it and the circuit goes with it. The
shape is an oval — the runway and its extensions are one straight, a two-kilometre leg over
the middle of the city at 340 m is the other, and two 900 m half-circles join them.

**The attitude is not animated; it falls out of the path.** Heading is the tangent of the
curve, bank is `atan(v²/gR)` from its curvature — the angle a coordinated turn at that speed
and radius actually needs — and pitch is the gradient of the altitude curve plus a couple of
degrees of angle of attack. So the aeroplane leans into its turns by the right amount, rolls
level on the straights, rotates on the runway and flares on the way in, without a keyframe
anywhere. The gear and its doors are the model's own meshes, swapped by visibility: they come
down on the base leg and up ten seconds after lift-off.

Four things had to be measured rather than assumed, and three of them were wrong first time:

- **Which side the city is on.** `across` was written as "right of the landing direction, which
  is the city side". It is not: the runway points north-north-east and everything to its right
  is open water. The whole circuit was being flown over empty sea two kilometres from anything.
  The pattern is left-handed, and `RUN_CITY` now says so.
- **The trim was inverted.** The honest speed profile flies the lap in a little over two
  minutes, and `SPEED_TRIM` scales it to exactly `LAP_SECONDS`. It was *dividing* — a lap that
  ran long was made slower still, and the real lap time was 156 s, not 120.
- **The circuit is over-constrained, and something has to give.** A lap that lands, crosses the
  city and takes two minutes cannot also have airliner turn radii: the turns are most of the
  lap, so bank works out at `atan(4π²R/g·t²)` and a gentle 25° wants a 3 km radius the clock
  cannot afford. It is sized instead so the *speeds* stay honest — 170 to 400 km/h, 46 m/s in
  the roll-out — and the bank is what runs steep, sitting at a steady 31–34° through the turns.
  Written this way the profile needs no trim at all: `SPEED_TRIM` comes out at 0.99.
- **It flew the whole circuit backwards.** A yaw of `heading` points an object's local **+Z**
  along the direction of travel, and `prepare-plane.mjs` turns the model through half a turn
  and leaves the nose at −Z — so the 747 landed tail-first, rolled out backwards and took off
  in reverse, all with the correct flight path. The half turn is added in the transform, not
  the model, and the nav lights were re-sided with it: with the nose at −Z, right is
  forward × up = **+X**, so green goes to +X and red to −X. The model's own `WingLeft` name
  belongs to the frame it arrived in and is no guide.
- **Bank is the second derivative of the path, so plan errors are enormous in the air.** The
  first circuit bowed its downwind leg by 25 m in 2 km — geometrically nothing, and twenty
  degrees of wing-rock on a dead-straight leg. Three things fixed it: *centripetal*
  Catmull-Rom, because the fixes are unevenly spaced and the uniform form bulges out of the
  short spans; a fix every 30° round the turns rather than every 45°, so the spline draws the
  arc instead of passing near it; and a roll-rate limit iterated round the loop, which is both
  what a real aeroplane does and what stops a bump too brief to roll into ever reaching the
  wings.

It prints its own line at startup, like the island and the fleet do:
`[flight] 9543 m circuit, 20 fixes, 120 s a lap (119 s before the trim)`.

**There were six lamps, and they came off.** Red to port, green to starboard, a white strobe on
each wingtip and one on the tail, a red beacon under the belly. The idea was that they make the
thing read as an aeroplane from two kilometres away, where its shape is four pixels. Up close
they did the opposite: an unlit sphere big enough to see from the ground reads as a coloured
dot stuck to the wing, not as a light. And their positions were written for a 747 and then
handed to a 25 m turboprop as well, which put its tail strobe eight metres above the fin and
its wing lamps out past the wingtips. Sizing them per aircraft would have fixed the second
problem; only removing them fixes the first.

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
> the two cannot disagree about where the land is.
>
> **Kestrel is trimmed back on three sides,** and the reason is one mistake with three faces.
> `ISLAND_GROWTH` is symmetric about the centroid: the island needed to be *deeper* for a
> station, got 1.9 in Z, and grew equally in every direction while doing it. But
> `find-train-route.mjs` reads the **traced** outline and decides there and then which stretches
> are ballast and which are viaduct, and the renderer takes that decision straight out of the
> route file and never revisits it. Grow the island afterwards and the land slides out under the
> bridges: **five bays of viaduct standing on grass** at the east end where the steel truss to
> Gannet begins, and five more at the west. A through-truss whose first panel sits in a field is
> the thing you cannot stop looking at. The same growth pushed the south shore out to meet the
> city and left the road crossing a 120 m hop with no room under it for anything to pass.
>
> `ISLAND_TRIM` takes the shores back, per side, anchored on the opposite one so a trim moves one
> coast and leaves the other where it is. Each number is measured against something different:
> **east 14** puts the shore in the six-metre window between the last ballast point (x −695) and
> the first viaduct point (x −689); **west 10** does the same at the other end, between −1318 and
> −1313; **south 106** is set by what the crossing should look like rather than by a structure
> boundary, and takes the road bridge from **120 m to 226 m** — span enough to lift a deck and put
> water under it.
>
> They are tuned against the route file rather than by eye, and they are sharper than they look:
> at south 106 the east window is six metres wide, and 6 leaves a bay on the grass while 18 puts
> ballast over open water, which is the worse failure of the two. Changing the growth, the sketch,
> the route or `ISLAND_SMOOTH_STEP` moves all three windows, so re-measure rather than nudge —
> walk the route's points against the built outline and count the ones whose `structure`
> disagrees with whether they are on land. What survives at the ends is a single 5 m sample of
> viaduct inside the shore at each end, which is not the bug: that is the abutment, and an
> abutment stands on the bank.
>
> It costs the crossing 684 m → 632 m of line on the island. `STATION_SITE` wants 474 m for the
> full layout and shortens its tapers below that, so the station still builds at its full
> 130 m taper with 150 m to spare — but that is the figure to watch if these are trimmed again.
>
> **They are curves now, and they have the airport's sea wall.** The sketch gives Kestrel
> fourteen points and Gannet nine, which is a fourteen-sided and a nine-sided polygon: every
> corner of the coast was a visible crease and the shore swept round it kinked with it.
> `smoothOutline` runs a closed **centripetal Catmull-Rom** through the traced points and
> resamples at 7 m, taking them to 261 and 78. Through the points, not near them — Chaikin and
> the other corner-cutting schemes shrink the shape, which would take land out from under a route
> that was searched against the traced outline. Catmull-Rom interpolates, and because both
> outlines are strictly convex (checked: all fourteen and all nine turns have the same sign) the
> curve between two points can only bow *outward*. The island can gain land from this and cannot
> lose any, which is the only direction that is safe without regenerating the route. It moved the
> station's own arc by two metres.
>
> The shore took two goes. It was a **sand beach**: one quad from the crown edge, 26 m out and
> 12.2 m down to the seabed — the right shape for sand and the wrong one for made ground, and
> what made these read as tropical sandbars with a railway laid over them. It was then a battered
> **revetment** with a section in it: a promenade, a chamfer, a face, a berm at the waterline, a
> toe apron. That fixed the material and kept the mistake. A 26 m skirt of anything round an
> island is a *strip*, and what a strip looks like from the water is a shelf, however it is
> shaded.
>
> `AirportIsland` had had the answer since it was written, and the islands use it now, down to
> the numbers. A plain extrusion — the same outline at the crown and at the seabed, so the face
> is **dead vertical** — with a narrow coping set *inboard* along the top so the edge reads as a
> built lip rather than as the place two surfaces happen to meet. Nothing stands outside the
> outline at all: the island is exactly as big as its outline says and the water comes right up
> to the wall. The face runs to the seabed rather than to the waterline, for the reason that
> island's own note gives — stopped at the water it leaves a ring of z-fighting where two
> surfaces meet at exactly one height, and carried under, the sea plane simply cuts it.
>
> One thing is done differently from the airport. That island sets its coping *radially*,
> `x - (x / len) * COPING`, which it can because its outline is a roughened circle about its own
> origin. These are a 687 x 443 m blob and a 201 x 149 m one, and radially inboard on those makes
> the coping wider at the ends than at the flanks — so it comes off the outline's own inward
> normal instead. `islandInward` is that construction, shared, because three places needed the
> same answer and two of them had their own copy: the coping, the surf band and the map.
>
> Everything that measured the beach stopped measuring it. The **surf band** needed two different
> derivations across the two earlier shores — a fraction of a straight batter, then a section
> solved for its own waterline — and needs none now: the wall is vertical, so the waterline *is*
> the outline, and the foam is a flat ribbon on the sea with its inner edge tucked a metre inside
> the outline where the concrete hides the seam. **`seaNav`** grew each island's outline by
> `shore * 0.6` to keep hulls off water a beach had made too shallow; there is no beach, deep
> water starts at the face, and a boat needs only its own clearance. **`townNav`** boxed its
> raster with `shore + 20` m of slack and now takes 20. **`Minimap`** drew a sand ring and now
> draws one fill, the way `paintAirport` always has. `island.shore` is gone from the type
> altogether — the compiler found the last two callers, which is why it was worth deleting rather
> than leaving at zero. Nothing is deleted — the route file, the generator, the
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
>
> **…and it is currently switched off.** `TOWN_BUILT` in `townConfig` is `false`, which strips
> Kestrel back to the railway: no ring, no streets, no footways, no buildings, no car park,
> forecourt, parked cars, trees, props or lamps, and no transplanted city block on the far side of
> the line. What is left is the station complex and the **level crossing** — deck, markings,
> barriers and wig-wags — because a crossing is railway infrastructure that happens to carry a
> road. Nothing is deleted; set the flag back to `true` and the town returns.
>
> It is one switch and not a commented-out render because the layout is read by *five* places
> that must not disagree: `IslandTown` draws the streets and blocks, `IslandStation` transplants
> the city cell, `townNav` rasterises the same streets into the patch the NPC traffic steers by
> and the player's tyres take grip from, `roadGraph` planarises them into the network the traffic
> routes on, and `Minimap` draws them. Hiding the meshes alone would have left cars steering down
> invisible streets, tyres gripping tarmac on grass, and a map showing a town that is not there.
> The road graph drops the causeway with it, so no NPC is routed onto an island it cannot drive
> on — the bridge itself is still built, it is just not a route any more.

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

## The viaduct junction to Skylark

A double-track junction leaves the main line on its viaduct at `?at=-1545,779` and runs on to
the Skylark line: `JUNCTION`, `JUNCTION_CURVE` and `traceBranch` in `src/config/pointwork.ts`,
drawn by `BranchLine.tsx` inside `Pointwork`.

- **Both roads come off both mains.** The outer road leaves the down line directly; the inner
  road leaves the up line and crosses the down line on a diamond, because the line runs on the
  right. The main viaduct itself is untouched except for its left parapet, which drops to deck
  level over the junction's mouth.
- **The alignment is traced, not offset.** A clothoid starts from the up line's own heading and
  curvature and eases into the branch curve, whose radius is solved by bisection so that the
  straight after it lands exactly on the Skylark line's centreline; 552 m in all, ending
  end-on at Skylark's old pier end (`PIER_END_LINKED` in `countryConfig` drops its buffers and
  end wall, and the old Skylark east bridge is replaced by this branch's own deck).
- **It is drivable through.** The branch, the Skylark line and the airport island's trunk form
  one route, `BRANCH_ROUTE`, 4,047 m long, and the player's train follows it through
  `railPlaceAt` and friends; press **T** before the points to take the diverging road. The only
  buffer stop on it is at the trunk's far end. There is no speed restriction at the junction.
  Two braking fixes made along the way apply everywhere: the overspeed guard now brakes from the
  train's actual speed, and braking curves use `√(L² + 2Bd)`.
- **Signs** (`JunctionSigns.tsx`): gantries at 330 m and 190 m before the toe and one over the
  branch — plain railway-blue boards with a thin white border, a white arrow and one name per
  panel, on galvanised steel. That is the rule for direction signs: no subtitles, distance
  strips, badges or glow.

To look at it: `?car=drone&at=-1566,790,16,35`; the whole line from above,
`?car=helicopter&at=-1770,870,520,0` then **C** three times. To drive it:
`?car=train&road=up&arc=4480`.

## The road viaduct

The crossing to Kestrel is a **masonry arch bridge**: nine openings on eight piers, humped over
a 48 m navigation arch in the middle, with the sea running straight through it.

It has been three things. A box girder on four piers first, and the piers were the problem — a
road that leaves the city on stilts reads as *elevated* the whole way. Then a **causeway**, a
reclaimed bank with the road on its crown, built by the same swept-section builder the railway
uses for its own crossings to these islands; for the 130 m hop that then existed, that was
right. Then the island was trimmed back 106 m (`ISLAND_TRIM`) and the crossing became 226 m, at
which point the bank stopped being a crossing and started being a **dam**. Ground is opaque and
nothing sails through it.

**The arches are not modelled.** The masonry is one extruded elevation: a `Shape` drawn in the
(along, height) plane from the seabed up to the deck soffit, with an arch-shaped `Path` hole
punched through it for every opening, extruded across the bridge's width. Piers, spandrels,
abutments and the arch rings are what is *left* of the block once the holes are taken out — which
is also what they are in a real viaduct. The shape's own +X becomes world −Z and its extrusion
becomes the width, so the group carries a quarter turn about Y.

Each ring is as round as the height allows: a semicircle where there is room for one, squashed
into a segmental arch where there is not, and **omitted entirely** below `minRise`. That is not a
compromise — it is what the ends of a real viaduct look like, the arches shrinking toward the
abutments and then stopping being arches. The main span is segmental for a harder reason: a
semicircular arch over a 48 m channel springs 24 m below its crown, which is 18 m under the
seabed.

**Three things were wrong with the first cut of it**, and the first is the one worth keeping in
mind. The openings were punched as *holes above the springing*, which leaves everything below
springing level solid: what that builds is not eight piers with water between them, it is a
**226 m dam with nine windows near the top of it**, and it showed as a slab of concrete lying
across the whole sea floor. The openings are cut from the **seabed up** now, which makes them
notches in the bottom edge rather than holes in the middle of the wall — and with nothing
enclosed any more the elevation is a single contour with no holes at all. The walk is: along the
base from the city end, dipping up over every opening and back down to the seabed on its far
side, up the island end, back along the soffit, and down to close.

Second, **the landing**, which took three goes and one measurement. The deck ran seven metres
*into* the coast road, on the old causeway's reasoning that a bridge is a street that keeps going;
at 226 m of stone that stopped being a joint detail and became a viaduct whose abutment sat in
the middle of the carriageway. Pulled back ten metres it cleared the road and then stopped dead
*short* of the footway, touching it and overlapping nothing. The measurement settles it: walking
north along the crossing's meridian, the nav raster gives road from z −398 to −416 at y 0.00 (the
coast road), a **six-metre band from −417 to −422 at y 0.15 that is not road** — the footway — and
road again from −423 northward. `CITY_SETBACK` of 6 puts the abutment at −418, four metres into
that band, so the deck lies over the footway and stops a metre short of the kerb; `cityY` is the
footway's own 0.15 rather than the road's zero.

Third, **the stone**, which also took two goes, and the second is a lesson about
`meshStandardMaterial`. It began as a warm tan over a mid-grey coursing texture — mortar two
shades off black, blocks varying ±23, a lit and a shaded edge on every one, five thousand
speckles — and 226 m of that is not a wall, it is a pattern. Worse, the material *multiplies* the
map by the colour, so a map averaging mid-grey halves whatever colour you give it and the wall
came out both muddier and browner than either number read. `makeStone` now draws a **near-white
modulation**, averaging about 0.88, which tints by a few percent and nothing more; the colour
lives in `STONE` alone, a weathered grey granite a step darker than the island's concrete sea
wall so the two do not read as the same material. Coursing you notice when you look for it, which
is what coursing does at fifty metres. `ExtrudeGeometry`'s own UV generator lays the shape's
coordinates down unchanged and the shape is drawn in metres, so the repeat is the tile size
inverted.

**The hump is a raised sine**, `sin²(πt)`, over the straight grade between the landings. Raised
rather than a plain half-sine because `sin²` has zero derivative at both ends: a plain one
arrives at the city street already climbing at 11 %, which is a step you feel at the joint. This
leaves both ends at the grade's own 1.4 % and puts its steepest 8.2 % at the quarter points, out
over the water.

The one number with a real constraint behind it is `arch.crown`. The deck has to clear the
tallest thing that sails under it, and the fleet tops out at the sailing yacht's 8.7 m air
draught (`boatData`); 7.5 m of deck over a sea at −3.6 puts the soffit near 6 m, which is **9.6 m
of clear headroom**. It is also as high as the approaches will take — the steepest gradient of a
raised sine is `π · rise / run`, so every extra metre of clearance costs 1.4 % of gradient.

The deck is swept with `buildLoft` over the same samples and surfaced with the **modular road
kit's own material**, not a painted slab: `useRoadSurface` and the UV swap under `road` are
`AirportBridge`'s, because two bridges wanting a kit road on a curved deck is two bridges, not
two techniques. Stone parapets each side carry colliders of their own — the bank used to catch
anything that left the carriageway, and there is no bank now, only a ten-metre drop.

**`seaNav` had to be told.** It excluded the whole corridor between the two shores, because a
causeway is ground the whole way across and a hull that entered it was aground. It now walks the
bay layout — pier, arch, pier, arch — and turns a boat away only at the masonry. Sailing under
the bridge is the entire reason for having built it.

`[bridge]` prints its own inventory at load, like `[sea]` and `[city]` do: arch count, masonry
vertex count, deck length and crown height. A viaduct that comes out empty — a malformed shape, a
hole wound the wrong way, an extrusion that triangulates to nothing — renders as open water, and
open water where a bridge should be is indistinguishable from a bridge you are not looking at.

## Kestrel's streets

The island has a street grid on it: four avenues by six cross streets, **empty blocks** between
them, a **semicircular ring road** round the west end, and a link down to the road
viaduct. Built from the same **modular road kit** Halcyon Field uses — `modular_roads_pack` carries
kerbs, pavements, lane markings and crossings in its texture, so a road made of it looks like a
road without any of that being modelled.

**The crescent is swept, not tiled, and it had to be.** The kit's curves are **U-turns**, not
corners: one piece takes a road out, round 180° and back, and its two mouths both face the same way
with their centres a fixed distance apart — 46.6 m for `curve1`, 93.2 for `curve2`, 186.2 for
`curve4`. So a kit curve can only ever join two avenues *exactly* that far apart, which is a
constraint on where avenues may go rather than a curve you can draw, and three of them end to end
still read as three U-turns rather than as one road. What the kit does have is a road **surface**,
and a surface sweeps along any centreline at all — which is what both bridge decks already do. The
ring road is therefore a `buildLoft` over a half ellipse, textured with the kit's own material:
the avenue ends run west into it on short radials and it carries them round.

**How deep it goes is solved against the shore, and the shore was not where the notes said.** It
was 60 m for a while, on the belief that the island's west tip was at `along` −260 and that a true
semicircle — which needs the full 116.5 m and reaches −306 — would be 46 m out to sea. Walking the
outline says otherwise: it reaches −308 on the station avenue's line and −341 in the middle. There
was another eighty metres of ground out there the whole time.

So the depth is now measured rather than remembered. `stationShore` walks west from the chord at
every degree of the arc, and the depth is the largest that keeps every point of the sweep 10 m of
grass plus its own half-carriageway inside the water. That comes out at **131 m**, and it is capped
at the half-width — because past a semicircle the ends turn back on themselves and the avenues
would meet the loop from inside it, which is a bulb and not a ring road. What is built is
therefore a **semicircle, 116.5 m in every direction**, reaching −306 with 35 m of grass still in
front of it.

60 m against a half-width of 116.5 was never a ring road anyway. It was a bracket: all the
curvature in two tight corners at the ends with a near-straight between them, which is exactly what
it looked like from the street.

**The avenues do not all run the full length, and that is the point.** The north shore falls away
eastward — 334 m out at `along` −190, 291 at +77, 228 at +255 — so an avenue placed far enough out
to be *behind the dock* is in the sea by the time it reaches the level crossing. Rather than pick
one compromise distance for the whole grid, each avenue runs as far as its own distance allows and
stops on a cross street: the **station avenue** at 56 goes the full six, the **stage avenue** at
149 starts at −12 because everything west of that is the school's campus, the **dock road** at 242
stops at +77 where it has shore left to stop on, and the **quay road** at 289 stops at −101 where
the berth's apron is still further out. `to` is an index into `CROSS`, and the list is non-increasing in it, which is
what lets a cross street work out how far north it runs from a single number.

What that gives is a **ragged north edge and nested loops**: the grid perimeter is one circuit,
the dock road closes a second inside it, and the quay road a third behind the berth. Nine blocks,
and the ground between the stage avenue and the ship — which was the biggest empty space left on
the island — is covered. Two of the nine are not left empty: see **Kestrel Water** and **Kestrel
High** below.

**There was a fifth avenue and it has gone.** The middle avenue ran the length of the island at
across 102.6, 46.6 m out from the station avenue and dead parallel to it, which is not two streets
— it is a dual carriageway with a strip down the middle, and from the deck of either one the other
is the whole view. West of the park it had the school on one side and a block of grass on the
other. Taking it out does three things at once: the campus gets its own ground from the station
avenue right out to the dock road, the west end stops being ruled with parallel lines, and the ring
road gets to be a ring road instead of a bracket round the end of one.

That deletion is also why an avenue is now named rather than numbered wherever anything else
refers to one. `avenue('dock road')` survives an edit to the list; `AVENUE[3]` renumbers silently,
and the park would have moved 47 m into the quay without a single type error.

It is not the old town restored. That one (`TOWN_BUILT`) was streets *and* thirteen blocks of
transplanted city and went wholesale; this is the layout back with the blocks left empty, laid in
the station's own (across, along) frame and fitted to a survey rather than to the shape the
island used to be.

**What the survey said.** Walking outward from the running line at twenty-metre intervals: the
railway takes across −6 to +31 plus ballast over almost the whole length (`STATION_YARD` is
302 m); the cruise berth is `along` −215 to +25 at the north shore; the stage stands at +150; the
viaduct lands at +17 on the *south* shore; and the level crossing at +255 is the one `along` where
the station's four roads have tapered far enough back for a road to get over the line.

**The island was widened for it.** The first cut fitted between the railway at 31 and the stage's
front at 150 — about a hundred metres, which is two avenues and a *single* row of blocks. A
single row is a street, not a grid. `ISLAND_TRIM` now carries a **negative** north figure, which
is the same arithmetic run the other way: 80 m of new land, the stage measuring its own position
off the shore and moving out with it, and room for three avenues.

That is not free, and the cost showed up immediately. Expanding in Z scales the outline about the
south edge, which moves every point north — so the island got *narrower at the route's own
latitude*, and the five route points that had been sitting on land came back as **ballast over
open water**. The end trims were retuned against that (east 14 → 2, west 10 → −9, so the west end
is now pushed out too), and the count is back to a single viaduct sample inside the west shore,
which is the abutment and is meant to be there. The crossing is 628 m and the station still
builds at its full 130 m taper.

**Endless.** Every junction has at least three ways out, and every avenue ends either on a cross
street or on the crescent, so there is nowhere to drive to and be stuck; the nested rectangles
give three circuits and the crescent closes a fourth round the west end. The only thing hanging off the network is the bridge link, and that ends at a bridge. The link cannot run
straight, either: at across −72 it has a few metres of land to spare at `along` 166 and none by
255, so it steps north to −30 and finishes along that.

**The junctions are derived, not written down**, and with a ragged edge that stops being a
convenience and becomes the only sane way to do it. Twenty-eight nodes assigned by hand is
twenty-eight chances to put a corner on backwards, and a corner on backwards is a road that stops
dead with a kerb across it — easy to miss from the air and impossible to miss in a car. Each node
works out its own arms instead: north exists when there is an avenue outside this one that still
spans this cross street, east when this avenue itself reaches the next cross. `junction()` turns
that set of arms into a piece and a turn, off a table of what each of the kit's four orientations
points at. It is what makes the dock road's east end come out as a corner and the stage avenue's
node at the same cross come out as a T.

Two things are honest rather than tidy. The crossing's north approach is a **thirteen-metre stub**
and a kit straight squashed to a fifth of its length carries its lane dashes at a fifth of their
spacing — it is that short because both things it joins are fixed, the ramp by the station's
outermost road and the south avenue by the ballast. And the streets are **not colliders**: a wheel
rides the island crown, exactly as it does on the airfield's roads, with the kit's slab 72 mm over
it.

The grid is drawn on the map as well. It has to be — the island is assembled at runtime and
`prepare-map.mjs` has never heard of it, so anything out here that is not drawn there is simply
not on the map.

## Kestrel Water

The grid leaves fourteen empty blocks, and empty blocks are *waiting* ground: they read as a city
that has not been built yet rather than as a city with space in it. One of them is therefore not a
block but a park, with a pond in it — the only thing on an island of concrete, steel and ballast
that is none of those.

**Where it is, is a compromise, and an honest one.** The island's centroid is at across 118, along
−12, which lands on a cross street in the narrowest column the grid has: the middle and stage
avenues are 46.6 m apart, so a pond there is 28 m of water between two kerbs with nowhere to put a
bank, let alone a tree. The next column out is the largest block in the grid — **93 by 89 m** — and
its centre is 100 m from the centroid on an island 575 m long. That is the middle of the island as
anybody standing on it would use the word.

**The ground is actually opened for it.** The park kit *has* a `pond` part and it is a flat 17 m
disc with 32 triangles: a decal for standing in a fairground. Water reads as water because the
ground goes down to meet it, and a disc laid on a lawn is a puddle of paint from every angle but
straight down. So the pond's own rim is cut out of the island's crown — `buildIslands` triangulates
round it with an ear clipper instead of fanning from the centroid, which a hole makes impossible —
and `KestrelPark` drops a basin through the gap. Both are built from the same outline, so they
cannot disagree about where the water is.

The basin carries **its own collider**, because a hole in the crown with nothing under it is a hole
in the world. Drive in and the car goes down the bank and sits on the bed with the surface at its
roofline, which is what was wanted and is also how it was checked.

**The profile is solved, not stated.** The bank eases from the crown down to a shelf just under the
waterline with a smoothstep, and the bed dishes quadratically from there to two metres. Where that
bank crosses the water is then found by **bisection**, and the water disc is laid at exactly that
radius — so retuning the depth or the shelf moves the water's edge with it instead of leaving a rim
of bank standing out of the pond or a rim of water standing on the grass.

**The shape is a polar blob**, the same construction Skylark Water uses: an ellipse 44 by 38 m with
three harmonics on it, which gives bays and points and no straight edge anywhere. A circle reads as
a reservoir and a rectangle as a dock.

**Planting.** The four trees and two bushes the city map already carries — nothing new ships for
this island — in a belt round the water where a tree by a pond actually is, clumps in the block's
four corners, and a thin scatter over the rest. The reeds are **drawn rather than modelled**: the
kit has nothing that grows in water, and a pond mown to the edge reads as a swimming pool. A clump
is nine tapered quads from a common root with a dark-wet-to-bleached gradient down each blade,
eighteen triangles, strewn by the two hundred in stands rather than as a continuous collar — reed
colonises the shallows it likes and leaves the rest bare, and a collar all the way round is a bath
mat. Each stand straddles the waterline, which is also what hides it.

No colliders on any of it. A tree you can drive through is wrong and sixty rigid bodies in a park
is worse, which is the airfield's convention and Skylark's.

## St. Anjali High School

The whole west end of the grid is a school: building, parking lot, running track and baseball
diamond, `156 m by 113`, on a superblock bounded by four streets, with an arched gateway on the
station avenue and its grounds laid out in front of it. Kestrel Water made one of the empty blocks a
park; this makes the west end the thing the park is opposite — somewhere the island's own people go
every morning, which is the other half of what stops a place reading as infrastructure.

To look at it: the gateway head on, `?car=drone&at=-1117,-734,10,2.5`; the whole frontage,
`?car=drone&at=-1104,-676,42,2.5`; the campus, the grounds and the park together,
`?car=drone&at=-1108,-606,140,2.5`; the campus with the ring road behind it,
`?car=drone&at=-1245,-881,300,92.5`.

**It does not fit in a block, and it should not.** Kestrel's blocks were 140 m by 89 at their
biggest. The choice was to shrink the school to a model village — a 12.5 m building is three real
storeys and any serious scaling makes the doors toy-sized — or to give it a superblock, and a
superblock is what a real school gets: what you do with a school is drive round it, not through it.
So the grid drops **one bay of one cross street**, and the middle avenue that used to halve this
ground is gone altogether. The site is 167 m by 159 between the kerbs.

**The skipped bay is named, not numbered.** `CROSSES` carries a `skip` naming an avenue, and
everything downstream reads it: a junction that would have had a fourth arm across the campus comes
out as a T instead, and the run that would have been laid there is not. One line of table, and the
two ends of the street become T junctions on their own. Nothing is stranded — the bays it keeps are
rungs between parallel avenues, and all four streets round the campus run through.

**Which way it faces is measured.** `prepare-school.mjs` finds the playing fields by the export's
own node names (`Track_1`, `Baseball_2`) and calls the other end the front, the same argument
`prepare-stage.mjs` makes for the open side of a stage. The front then faces the station avenue —
the street the station is on — and the track and the diamond back onto the dock road, where there
is nothing but the quay to overlook them. The campus lies **down** the island, a quarter turn from
the frame it was authored in, because the campus is longer than it is deep and so is the block.

**The scale is solved, not typed.** The fit takes the tighter axis and leaves at least 6 m of
verge: 159 m of block against 156 m of campus costs about five per cent, so the building goes from
12.5 m to 11.8, which nothing can see.

### The frontage: one axis, two yards, and no roads

The campus is 107 m deep in a 167 m block. Centred, that left 30 m of plain lawn on each side —
which is not grounds, it is a school that did not fit its site, twice. So the campus is pushed to
the **back**, the playing fields sit 8 m off the dock road where a strip of grass behind an
outfield belongs, and the whole 52 m of slack is frontage.

Three attempts at that frontage were wrong, and all three the same way. A car park the full 147 m;
then one lane with cars down one side and buses the other; then three yards in a row with a
drop-off in the middle. Each of them ran a tarmac strip out to the avenue for every yard, a walk
right round the site and two spurs across it — and from anywhere above head height those are not
paths, they are **roads through a school**.

What is there now is one axis and two yards:

- the **plaza**, 24 m wide on the building's own centreline, from the gateway at the avenue
  straight to the doors, with a double row of trees down it and the flagpole at its head;
- the **car park** at the west end, its own edge ON the avenue so it needs no drive — you turn off
  the street into it through a gap in the near row — with planted islands breaking the bays;
- the **bus yard** at the east end, the same, with the buses drawn up along the back of the apron
  and a fire appliance at the head of the line;
- behind the car park, the **play area** on a sand oval; behind the bus yard, a full-size
  **basketball court**; and lawn everywhere else, with shrubs along the building's own frontage
  because a façade always has a bed along it.

There is no other paving on the site. Every vehicle out here comes from `vehicleCatalogue`, the
same list `Traffic` drives from; nothing new ships for any of it.

**The avenue got a junction.** The school's entrance met a through road at nothing at all — the one
place on this island where something arrives at the network and the network does not acknowledge
it. `CROSSES` now carries a `mouth` naming an avenue: the node there takes a north arm and comes
out as a `junctionT` **from the road kit**, and no run is laid off it, because the junction tile's
own half-width is exactly the distance from the avenue's centre to the block's kerb. The mouth
lands on the plaza by construction. A painted zebra was tried there first and taken out again: a
crossing across the middle of a junction is a crossing in the wrong place.

**The play frame is the amusement park's own.** `playground` — frame, slide, see-saw — reused
rather than reinvented, which is the rule Kestrel Water is planted by, and a school is a better
argument for that part than a fairground is. It stands on a **sand oval**, because a play frame on
mown grass is a frame somebody left there. The oval is *solved* to contain the frame rather than
typed: the across radius is taken first (the sand has to keep grass round it) and the along radius
is then solved to put the frame's corner exactly on the rim, so the sand follows the frame if the
frame is ever rescaled.

### The gateway

An **arch**, because the first one was two head-height posts with a beam across and that is a
garden gate: from the avenue you could not tell it was there. This one is drawn as a stack of boxes
and voussoirs because that is how one is built — a plinth the pier stands on, a shaft, a cornice it
stops at, a semicircular ring springing from that cornice, an entablature over the crown carrying
the name, and a finial at each end. An 18 m opening, so the building behind it is framed by it,
which is the only job the thing has.

The ring is eighteen voussoirs, each a box turned to stand radially: the box's own +Y is sent to
the radial direction by a rotation about X of `π/2 − θ`, which is how you put a rectangle on a
curve without lofting it. The gateway is a wall in the (along, y) plane of the station's frame,
which is why the voussoirs turn about X and not about Y. Being semicircular it rises half its span,
so the crown is `springing + opening / 2` — one number, not two that have to agree — and the
entablature, the board and the finials all follow from it.

It is cut from **two stones**: a warm one for the mass, taken off the school building's own
colour, and a pale one for the plinths, cornices, keystone, entablature and finials. One flat cream
was a model of a gate; the difference between two stones is the whole of what makes the mouldings
read from across the avenue. A low **boundary wall** in the same two runs each way to the yards —
not a fence, which round a school is a compound, but the thing a gate is a gap *in*, without which
the arch stands on a lawn with grass running past it on both sides.

The board is white on railway blue with a thin border and one name on it, which is the house style
for signs on this map. The flag on the plaza carries the same name on the same blue, with a band of
the gate's stone along the hoist so it still reads as a flag when the cloth is edge on — and it is
a waved grid rather than a quad, because a flat rectangle on a pole reads as a sign somebody bolted
on sideways.

### What is solid, and what is not

**The parking lot is drivable, and that was the point.** The colliders come from
`prepare-colliders.mjs`, the same rasterise-flood-cover pass the airport's buildings get: only
near-vertical surfaces in a car's height band count, so what comes out is the building, the stand
behind the track and the backstop behind the plate — 34 boxes over 43% of the footprint — and the
lot, the drives and the field are open. A campus you can only look at from the road is a texture.

That pass needed one thing telling. The campus is a single slab with a **skirt under its rim that
reaches 1.3 m below the deck**, and measured from the bounding box that skirt rasterises as a
closed wall right round the site: the flood could not get in, 17,600 m² solidified, and the school
came out as one bounding box again. `BAND_FLOOR` now starts the school's band above its deck,
reading the skirt depth out of `schoolData.json` rather than being told it twice. The same trap the
airport's crane rails set, one step round.

Nothing else out here is a collider. The surfaces are 60 mm slabs and a wheel rides the island
crown, exactly as it does on every street round them; the trees, the play frame and the parked
vehicles are scenery, which is the airfield's convention, Skylark's and the town's. The campus deck
sits 72 mm over the crown, the same lift the road kit's slabs take, so it meets the streets at
exactly their height without z-fighting them — and the skirt buries the lift rather than leaving a
step at the kerb.


## The concert stage

East of the cruise berth on Kestrel's north shore there is a 30 m festival stage with a field in
front of it. It is the first thing on this island that is a *destination*: the island has a
station, a freight yard, a cruise berth and a road viaduct, and all four of those are
infrastructure — things that carry people somewhere else. An island you arrive at three ways and
then have no reason to stay on is a junction with scenery.

**Where.** `along` 150, which puts it clear of the berth (that runs −215 to +25) and leaves the
ship along the shore to the west: you come in by sea, walk east, and the concert is at the end
of it. The stage backs onto the sea and faces inland, which is the only way round it can go — a
stage faces its crowd, a crowd needs ground, and the ground is to the south. It also means the
audience faces the station, so a train crossing the island runs across the back of the view.

**The field in front is the island's own grass.** A slab of beaten earth was drawn there first —
90 m by 86 m, laid on the crown — and it read as a brown carpet: a flat untextured rectangle on
grass is a decal, not trodden ground, and grass in front of a stage already says everything the
slab was there to say. What survived it is the number, as `CONCERT.clear`, because that was never
really about the slab: it is how far the stage must stand off the railway, and `CONCERT_SITE`
checks it against the station's outermost road rather than assuming it.

`CONCERT_SITE` measures the shore outward from the running line, the same walk the cruise berth
and the road viaduct's abutment use, and returns null if the field would reach further in than
the station's own formation allows. Nothing on this island may be pinned to a constant any more:
it has been grown, trimmed on three sides and smoothed, and a stage fixed to a number somebody
read off it in one of those states is in the sea in another.

**Preparing it took a second decimator.** The source is 346,534 triangles and `simplify` — the
edge-collapse simplifier every other prepare script here uses — returned **346,534**. It
preserves topology, which is right for a locomotive body and wrong for this: the stage is ten
near-identical 14,144-triangle lattices, each made of hundreds of separate closed tubes, and
there is no edge to collapse between two tubes. Dropping `LockBorder` got it to 339,076. Welding
by position first (worth doing anyway — the export splits vertices three ways at attribute seams,
and `generatePositionRemap` takes two arguments, not the three I first gave it) moved it no
further. The obstacle was never the border, the tolerance or the seams.

`simplifySloppy` ignores topology and hits whatever target it is given. So it is a **fallback**:
every primitive is offered to `simplify` first and only the ones that come back barely changed
are handed to the sloppy pass — 36 of 81 here, which is exactly the lattice geometry that can
afford it, because a truss read at thirty metres is a silhouette. Parts under 1,000 triangles are
left alone entirely; thirty-seven of them come to 3,070 between them, and a decimator given a
fifty-triangle bracket returns a triangle soup. **346,534 → 79,265, 18.5 MB → 0.6 MB.**

Which way it faces is measured rather than stated: the front of a stage is the open side, so the
script counts triangles either side of the deck and calls the lighter half the front. On this
model that is +Z by 274,666 to 71,868, and a half turn is baked in.

## The cruise berth

Kestrel's north shore has a quay on it, and **MS Viking Cinderella** — 191 m over all, 33.8 m
across her bridge wings — lying at it. She never moves and has no route: `SeaTraffic` already has
six hulls going round in rings, and what an island station with its town cleared off it was short
of was something *arrived*. Forty-five metres of white superstructure standing over the platforms
is visible from a train two kilometres out, and it costs one clone and no per-frame work.

**The north side** because it is the side with nothing on it. The platforms run out to +30
(`ROADS`), the relief loop and the road crossing are south, and past the shore there is open
water for hundreds of metres. It is also the side the line runs *along* rather than the side it
arrives from, so she lies parallel to the railway and you pass her whole length from the train.

**The quay face is straight and the coast is not**, and that gap is the whole of the
construction. The north shore falls from 253 m out at `along` −200 to 222 m at +50 — 31 m of bow
over the length of a berth — and a ship cannot lie against a curve. So the face is one straight
line laid *outside* the furthest land on the berth, and the wedge behind it is filled. That is
not a workaround; it is how a quay gets built on a soft shore. `CRUISE_BERTH` walks outward from
the running line at six-metre intervals and measures the coast rather than assuming it — the same
test `BRIDGE` uses to find its own abutment — so the fill follows the island if the outline, the
growth or the trim ever move again. Minimum apron width is 14 m, which is at its minimum in
exactly one place and wider everywhere else.

**The deck shipped invisible, and the bug is worth writing down** because it does not warn. With
X across and Z along, both increasing, indexing the apron strip as `(a, a+1, b+1)` puts the
triangle normal at **−Y**: a front-facing material on a downward-facing slab draws nothing at all,
so the quay was a hole you looked through to the sea, with the bollards and a 191 m ship standing
on open water. It is the same trap `TRAIN_ISLANDS` documents for the island fan, one dimension up
— there the fix is a shoelace test on the outline, here it is winding the strip the other way. If
a flat surface built here ever "does not render", check the winding before anything else.

The apron also stands 5 cm over the crown. Not decoration: it overlaps the grass by `KEY` metres
so it keys into the island instead of butting against it, and the crown is flat here — at the
same height the two are coplanar over a 5 m band the whole 240 m of the berth, which is not an
invisible join but z-fighting the length of the quay. Same trick, same reason, as `SURFACE.road`
laying the town's streets on the same crown. The wall's top ring is lifted with it, or it stands
5 cm short of the deck it holds up and the sea shows through the gap.

The wet edges go down to the seabed rather than to the waterline, for the reason the island's own
wall gives. The apron carries a collider and the face does not: the apron reaches *past* the
outline, so without one it is a slab a car drives through into the sea, while nothing can reach
the face that is not already in the water.

**She comes through the boat fleet like every other hull.** `prepare-boats` merges all seven into
`boats.glb` and tags each mesh with its `boat` id, and `CruiseTerminal` pulls hers out by that
tag. A second model file and a second pipeline for one ship that happens to be tied up would have
been a second pipeline. Her placement needs no fudging either: `prepare-boats` centres a hull on
its own centreline and puts the origin at the **waterline**, dropping the keel `draught` below
it, so she sits at sea level with her side a fender's thickness off the face and nothing else to
set.

The quay is drawn on the map as well as in the world. It has to be: it is a reclamation laid
outside the island's outline, so a map that stopped at the outline would show a 191 m ship
floating in open water 20 m off the coast.

## Freight

The line carries goods as well as people. Two locomotives, two kinds of traffic, and four
trains: a **Class 37 on bogie tanks** working the down road and a **Class 08 on coal hoppers and
box vans** working the up, so whichever road the player is given there is a goods train coming
the other way; and both consists again standing still, the coal in the **relief loop off the up
line** and the oil in the **outermost road off the down line**. One parked rake either side of
the running lines, so the station reads as a place that handles traffic in both directions and
neither hides the other. None of it is drivable, and that is the first decision rather than an
omission.

**Why freight is not a rail set.** `RAIL_SETS` in `trainConfig` is a *player* table — `garage.ts`
builds its RAIL entries straight out of it and `?car=` is resolved against it — so a locomotive
added there becomes a vehicle with a cab camera, a brake handle and a driver's eye height. A
shunter with a 45 mph gearbox is not an express, and nothing in a goods train wants to be sat
in. Freight therefore lives in `FREIGHT_LOCOS` and `FREIGHT_WAGONS` beside that table, and the
garage never sees it.

The deeper difference is shape. A passenger set is one power car and one coach repeated N
times, so `FormationUnit` can tag each unit `'loco' | 'carriage'` and let the renderer resolve
two GLTFs. A goods train is a locomotive and a rake of *whatever is going that way*: the three
wagons here are 10.4, 11.6 and 12.0 m long, 2.44 to 3.78 m tall, and sit on 6.1, 7.9 and 8.5 m
bogie centres. So a `FreightUnit` carries its own model path and its own measurements,
`freightFormation` walks a list rather than a count, and `FreightTrain.tsx` poses each unit from
its own arc length — which is what lets three different wagons couple into one rake and each
sit correctly through a 106 m radius.

**Each engine hauls one commodity.** The rakes were mixed at first, on the reasoning that three
silhouettes read better than one repeated. They do — but what they read as is a pick-up goods
from 1965, not the traffic either locomotive exists to move, and a real working is a *block
train*: one commodity, one wagon type, not shunted en route. So `FREIGHT_OIL` is four bogie
tanks behind the Class 37, because a 1,750 hp type-3 on the only wagon long and tall enough to
sit behind it (12.0 m, 3.78 m) is a train that goes somewhere; and `FREIGHT_COAL` alternates
hoppers and box vans behind the Class 08, because the short mixed slow-moving stuff is exactly
what a shunter is for, and alternating puts the black and the brown along the rake instead of in
two blocks.

**The container flat is built, not downloaded.** `FREIGHT_BOXES` — the intermodal, the third
goods train, on the up road behind the coal — runs on `flat40` and `flat20`, and neither has a
Sketchfab source. `npm run prepare:flat` (`prepare-flat.mjs`) reads the *prepared* tank wagon,
drops its barrel and ladders, and what is left is a 12.0 m bogie flat with a deck at 1.20 m —
which is what a TEA is under the barrel. On the deck goes the city's own shipping container:
the 12-triangle box and 256 × 128 atlas of the `deco_container1_*` chunks every freight yard,
the harbour and the airport's cargo apron are stacked with, so the box on the train is the box
beside the track. The atlas is desaturated on the way through so `baseColorFactor` can paint
each one — one blue 40 ft, or a red and a green 20 ft pair — and the two loads alternate along
the rake so no two adjacent boxes are the same colour. Both GLBs are 0.78 MB and 11 k
triangles, nearly all of it the frame.

**Preparing them.** No new scripts for the three bought wagons: freight is five more entries in
the two tables the passenger stock already uses. `npm run prepare:train37` and `prepare:train08` go through `prepare-train.mjs`
— same world-space measurement, same roof-line test for which end the cab is, same bogie
clustering. `prepare:hopper`, `prepare:boxcar` and `prepare:tank` go through
`prepare-carriage.mjs`.

Three things in those scripts changed, and each was forced by the freight itself:

- **A wagon gets its own width ruler.** `prepare-carriage.mjs` scaled by the *locomotive's*
  measured width, because a coach is built to be flush with the power car it couples to. A
  wagon is flush with nothing, and the three here disagree with each other by 9 cm. An entry
  may now give a `width` of its own, which wins over `loco` when both are present. It also
  matters for the van: at its real 12.80 m length that upload comes out 3.13 m wide — wider
  than anything that has run on this gauge — so it is scaled by width to 11.57 m instead, the
  same trade the APT trailer already made.
- **Textures are transcoded to WebP.** Draco compresses geometry and does nothing to images.
  The tank wagon ships nine 1024 PNGs — 12.3 MB of them — and its GLB came out at **12.6 MB**,
  bigger than the city, for a vehicle that is scenery on the next track. One `sharp` pass at
  quality 84, the same number `prepare-airport` and `prepare-helicopter` settled on, takes the
  images to 1.4 MB. Dimensions are left alone unless they are over 1024; the saving is almost
  all format.
- **A `STOCK` entry may set its own triangle budget**, and the tank does: 12 k against the
  coach default of 45 k. 45 k is sized for a vehicle with an interior, window pillars and roof
  ribs. This one is a barrel on a frame — three primitives, no interior — and it is on screen
  **eight times** between the running oil train and the stabled one, so the default was 360 k of
  tank, more than the whole city. It decimates almost perfectly (45,287 to 12,357), which makes
  it the cheapest 33 k in the project.

**The Class 08's `bogieCentres` is not a bogie.** An 08 is an 0-6-0 on a rigid 11 ft 6 in
frame. The runtime reads that field as "the two points this vehicle stands on", so for a rigid
chassis those are the outer axles, and 3.51 m is what goes in. The clustering will not find it:
the three axles are 1.74 source units apart against a `BOGIE_CLUSTER` of 2.5, so they weld into
one cluster and the script falls back to the declared figure — the right answer arrived at the
long way round, and the log says so rather than hiding it.

### The AI trains could not see each other

This is the bug the goods train exposed, and it is worth writing down because the reasoning that
caused it was sound right up until it wasn't.

Every AI service checked `playerTrain()` for its block and nothing else. The note explaining why
said: the services keep station with one another *for free*, because they all run the same speed
profile, so an evenly spaced set stays evenly spaced and none ever closes on the one in front —
the only train on the line that does not run to a profile is the one with a driver in it. All
true. Then a train appeared that runs a **different** profile. The goods train is pathed at 45 %
of line speed on a road four expresses share, and what those expresses did was overhaul it and
drive **straight through it**, because the train in front was never in the signalling at all.

The rule moved out of the services into `physics/trainSignalling.ts`, and every AI train calls it
with its own report against the same registry the lineside signals and the level crossing
barriers already read. Two changes made that possible: `TrainReport` now carries the reporting
train's `id`, because every train on a road is in that list *including the one asking* and a
train that blocks on its own report never moves again; and it carries `speed`, for the aspect
below.

**Two aspects, not one.** Returning zero the moment anything enters the block gives a following
train a full-service stop, a wait, a full acceleration and another stop — a lurch every twenty
seconds. So the outer two thirds of the block is **caution**: the follower takes the speed of the
train in front and follows it, which on a line with no passing is what actually happens. Only
inside the inner third is it **danger** and a stand. An express that catches the goods train ends
up running behind it at freight speed, which is worth seeing from the lineside rather than a
fault.

**Two defects came with the rewrite, and both showed up as a railway at a standstill.**

The first was the distance function. `ahead` is signed and takes the *shortest way round*, which
is the right answer to "is that train roughly in front of me" and the wrong one for measuring a
train's extent: a vehicle whose nose sits just past the half-loop reads at -3310 m while its own
tail, a hundred metres further on, reads at +3173, because the two ends land on opposite sides of
the antipode. Taking the min and max of that pair produces a span that appears to straddle the
observer, so a train on the far side of a 6.6 km loop read as occupying the block. Every train
was held by one it could not possibly reach, and the whole road stopped on the first physics
step. `blockLimit` measures forward-only distance in `[0, L)` now, which has no seam: a train
behind is not a small negative, it is a number close to the loop length, larger than any block,
and it drops out of the comparison on its own.

The second was arithmetic in the mounting. The up services are phased at `i / 4` of the loop and
the down ones at `(i + 0.5) / 4`, and the first goods train was given `0.375` — which is exactly
where down service 1 already was. Two trains on one arc is the single case honest block working
cannot resolve: each sees the other occupying its own block, both stop, and everything behind
them queues up and stops too. The goods trains sit at an eighth offset now, in the middle of a
gap. `blockLimit` also no longer deadlocks on an overlap it did not cause — a train yields only
to one whose nose is genuinely in front of it, so the follower in a rear-end stops, the leader
runs on, and the two separate.

**And then the profiles were put back together.** Honest block working fixed the collision and
replaced it with a queue: four 300 km/h expresses that used to pass through the goods train now
*followed* it, and with nowhere to pass in section a single train pathed at 45 % of line speed
set the timetable for its whole road. A real railway answers that with a timetable and a loop to
be put inside; this one answered it by deleting the freight speed factor. Goods now runs
`TRAIN.speed` capped by `trainSpeedLimitAt`, exactly as `Service` does, so every AI train on the
line is on one profile again — which is the state in which an evenly spaced set stays evenly
spaced and nothing ever closes on the train in front. That is the property the services were
written to rely on, and it is now true of the goods trains too.

It is not prototypical. A loaded tank train does not do 300 km/h and a Class 08 does not do
anything remotely like it. What it buys is a railway where four trains a road hold their spacing
all session and the only train that can ever be held at a signal is the one with a driver in it —
which is the train `blockLimit` was written for, and the reason it stays.

**And the stabled trains stay invisible to all of it.** A parked rake is never reported, and that
is the whole reason one is safe to leave in a loop. In arc terms a train in a station loop is a
train parked on the running line for ever, so reporting it would hold the block ahead at red and
the level crossing's barriers down, permanently — and now that the AI trains read each other, it
would stop every service on that road dead as well. A loop exists precisely so that what stands
in it does not occupy the line, and the one `if (!yard)` in `FreightTrain` is where that is said.

### Putting a train away

The station has had two loops since the four-road layout was built and nothing had ever stood in
either. `STABLING` in `FreightTrain.tsx` names them: `relief`, the goods loop off the up line on
the town side, which has no platform face — a road with a face is a road a passenger expects a
train to call at; and `goods`, `ROADS[ROADS.length - 1]`, the outermost of the four station
roads, a loop off the down line. The outermost by expression and not by index, because what
matters is that it is the road the station's own formation is sized from (`STATION_YARD`), so
anything standing on it is standing on ballast that already exists.

Neither needs geometry of its own. Both loops **are** lateral offsets off a running line for the
length of the station and nothing at all outside it, which is exactly what `upLoopOffset` and
`roadOffset` return — so a stabled train sits on its running line's arc, displaced, and
`locomotivePose` offsets each bogie before taking the chord as it does for every other vehicle on
the railway. `ahead` converts the train's arc into the station-relative `along` those functions
are written in.

Each rake is centred on the station's midpoint, measured **over buffers** rather than over
`freightLength` — which is the distance from the locomotive's *centre* to the rear buffer, so
half the engine is missing from it. The loops' straights run 107 m either side of the midpoint
(`halfPlatform + approach`), and neither train is 60 m long, so both stand well clear of the
blades at each end: put away, not fouling the turnout.

**What it all costs.** 240 k triangles for the Class 37, 169 k for the Class 08, and 4 k, 4 k and
12 k for hopper, van and tank. The two stabled rakes together are about 475 k on screen for as
long as the player is in the station, and the locomotives are almost all of it — both refuse to
decimate further for the reason `prepare-train.mjs` documents. The two working trains are the
same models again, but they are spread round a 9.2 km loop and only one road's is mounted at all
when the player has the other. Everything is gated on the same `trains` flag as the passenger
services, because that flag is documented as "the rolling stock is where the cost is" and a
parked train is no exception.

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

The freight stock is five further Sketchfab exports: *"British Rail Class 37"* and
*"Train - BR Class 08 Shunter Swallow Livery"* for the locomotives, and *"Coal Hopper Railway
Wagon"*, *"Railway Boxcar Freight Wagon"* and *"Railway Tank"* for the wagons.

The island line's station building is the user's own model,
`standar_materials_fbx_nombres_corregidos.glb`, re-finished by `prepare-station.mjs`. The parcel
hub's lorries are the city map's own scenery, cut out by `prepare-trucks.mjs`.

The sky is *"Kloofendal 48d Partly Cloudy (Pure Sky)"* from
[Poly Haven](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky), licensed **CC0** —
no attribution required, credited here anyway. It is an equirectangular panorama, which is
what a 3D sky has to be: a flat photograph used as a backdrop stays pinned to the screen, so
the clouds would turn with the car instead of staying put in the world. `npm run prepare:sky`
re-downloads it, scales it to 4096x2048, and measures the sun's position and the horizon
colour out of the pixels into `src/config/skyData.json`, so the shadow-casting light and the
fog agree with the photograph rather than with a hand-picked constant.

## Skylark: a countryside island

South-west of Halcyon Field, where the user drew it on the map, there is now a third made
island that is not made land at all: **Skylark**, 840 × 640 m of farmland — `countryConfig.ts`
for the numbers, `countryFields.ts` for the parish, `CountryIsland.tsx` and its three
companions for the drawing. Reach it by the viaduct off the west end of the airport's outer
road, or start there: it is one of the thirteen places a drive can begin.

**It has hills, which none of the others do.** Every other island is a crown at one height with
a wall to the seabed, because every other island is a runway or a station yard. This one is a
ridge of downs across the south rising to 46 m, a wooded hill in the north-east, a lake in the
hollow between and a hamlet on the rise in the middle; `groundAt` is the single height
function — a handful of Gaussian hills over two octaves of value noise, then the *pads* (yards,
the hamlet, junctions, the landing, the lake basin) grade it flat, then the lanes carve it. The
crown is a polar grid of 88 rings by 512 spokes whose outer ring is the outline, so the cliff
extruded from that outline shares its edge exactly; the cliffs are as high as whatever hill runs
into the sea, 6 m on the north shore and 35 m under the lighthouse. The terrain mesh, its
trimesh collider, the nav patch, every tree, cow and cottage read the same function, which is why
nothing floats and nothing is buried.

**The lanes follow the ground rather than the ground following the lanes.** Five of them,
Catmull-Rom splines sampled every three metres, each one's height smoothed along its own
centreline and held under 8.5 %, and the ground within the carriageway brought to that height
with a soft shoulder outside it — a lane on a hillside is in a cutting on one side and on an
embankment on the other, as it would be. They are swept from the road kit's carriageway with
`buildLoft`, exactly as Kestrel's crescent is, because the kit's straights are straight and flat
and a country lane is neither; the two junctions — a T where the bridge road meets the island,
a crossroads in the hamlet — are the kit's own tiles on flattened pads, and every lane starts and
ends square on a junction's mouth. Each lane is its own collider so a wheel rides the lane, and
each tile has a box at the same height so the road is level through them.

**The fields are a Voronoi diagram**, thirty-two cells from seeds thrown at least 88 m apart,
which is what a parish looks like from the air: irregular convex patches meeting at three-way
corners, no two alike. The crop is decided by where the seed fell — sheep grass above 26 m,
wood on Beacon Hill, paddocks round the hamlet, rough grazing along the coast, an arable mix
nearest Home Farm — and painted into one 3072 × 2432 canvas laid over the crown as its colour
map: the rows a field is drilled in along its own long axis, the sprayer's tramlines every
24 m, the darker margin inside every hedge, poppies in the set-aside, the mown stripes on the
green, the cricket square. The hedges are the cell edges, swept as bumpy boxes at the ground,
with dry-stone walls instead up on the downs and a five-bar gate every hundred-odd metres along
the lanes; 4.2 km of hedge and 1.6 km of wall, all of it solid.

**Nothing new was downloaded.** The brief was that anything added should come from the city's
own model, so the six hundred trees are the four the park kit already takes out of it — a wood
of 330, copses in pasture corners, a tree every forty metres along the hedges the way a hedger
leaves one, willows round the lake, an orchard in rows, an avenue up Church Lane, yews in the
churchyard, a lone oak in a few fields for the cattle — and everything built is boxes, prisms
and cylinders: two farms with their barns, silos and a Dutch barn full of bales; twelve cottages
placed along the lanes by distance and side so they face the road; a pub, a church with a
tower, a lychgate and thirty-four leaning gravestones; a windmill on its knoll with sails that
turn; four wind turbines along the crest, yawed to the same wind; a lighthouse on the
south-west headland; a phone box, a post box, a bus shelter, a war memorial, a cricket
pavilion, fingerposts at both junctions with the destinations lettered on them, and the farm's
own tractor out of the garage. And a hundred and fifty animals — Friesians, Herefords and
Angus in the pastures by Home Farm, sheep on the downs, four horses in the paddock, ducks on the
pond, rooks over the wood — each a box with vertex-coloured patches that stands with its head
down, walks somewhere slowly inside its own field and never onto the lane, and stops.

**The viaduct is straight, because it can be.** The airport's outer road ended in a corner at
its west end; the corner is a T now (`roadConfig`), and the T's free arm points 17° west of
south, almost exactly at where the island was drawn. `countryConfig` reads that tile's west
edge as the start of the crossing and the arm's bearing as its bearing, so the road and the
bridge cannot drift apart. 381 m from the tile to the deck's end, 57 of them over the airport's
own crown, 25 onto the island's landing; a `sin²` hump of 6.5 m over the water, so there is no
crease at either shore and 14 m of air under the crest; six hammerhead piers. Plainer than the
tied arch to the airport on purpose — that one is the way into an airport; this is the way out
to a farm, and what you look at from it is the island ahead.

**Everything that knows about islands knows about this one**: `seaNav` keeps boats off its
cliffs, `Environment` gives it a surf line, `cityNav` consults `countryNav` for height and
paving so tyre marks lay and R works, and the map grows its bottom margin for it, fills its
fields in muted crop tones, strokes its lanes and labels it SKYLARK / COUNTRYSIDE.

### The south-west lobe

Asked for once the first half had been seen — "at least half more, south-west" — the island
grew from 0.45 km² to 0.70 by a broad lobe in the coast function (`SHAPE.bumps`), so that
nothing already built moved: the new ground is beyond the old coast, not a stretch of it. What
is on it:

- **A brook** from a spring under the downs' western shoulder, down a coombe it has cut
  (`STREAM`, a V cut off its bed with a channel for the water), into a **harbour** in a cove at
  the lobe's tip: a quay graded flat at 2.2 m with a terrace of cottages, The Anchor, a fish
  shed, a crane, bollards, lobster pots, a slipway, and a stone **pier** out across the mouth
  with a light on its end, four of the game's own boats riding at their moorings and gulls over
  it. The cliff face round the quay is coloured as masonry; the pier is its own geometry and
  collider, the one thing you can drive onto that the crown does not carry.
- **A second road class.** A `mini` is a single-track country road — 4.6 m of plain tarmac or
  4.2 m of gravel, swept with a painted texture because the kit has no piece that narrow — and
  it is what actually joins a farm to a lane: the coast lane from the quay under Castle Hill to
  the lighthouse and up the west coast to Home Farm, with a stone bridge over the brook; the
  coombe lane through a ford; the summit track's switchbacks; Mill Lane, Hill Farm's lane, the
  boathouse lane, the wood ride, the campsite's lane; and a gravel **scramble course**, a closed
  loop with deliberate lumps in its profile. A mini road starts and ends *on* another road
  (`startOn`/`endOn`) at its edge and is pinned to its height there; where a road's pins demand
  a grade steeper than its class allows, it gets that grade rather than a step.
- **Castle Hill**, a hill fort: two banks with a ditch outside each, ringed round the top of a
  new hill, written into the relief itself with a gap at the gate; chalk shows on the bank tops.
  A car park under the entrance, sheep on the ramparts.
- **The strand**: the one stretch of coast that is not a wall — east of the harbour the last
  58 m of land slope down under the waterline, so the sea runs up onto sand. A campsite behind
  it with tents, caravans and a shower block; a vineyard on the slope above with its rows of
  posts and vines; a watermill on the brook whose wheel turns in the channel; a chapel ruin on
  the west coast; a stone circle on the western ridge; a car park and toposcope at the summit;
  the lighthouse moved to the lobe's south-west tip.
- The ring road is now two roads meeting at a third junction, the coombe T, where Quay Lane
  leaves for the harbour, and the fingerposts know.

### The island's own assets

Five downloads arrived after the first two passes, and the rule about the city model being
the only source was lifted with them. `prepare-country.mjs` bakes them (`npm run
prepare:country`), the same way the park and airport kits are baked, with one difference:

- **`public/models/country.glb`** is a static kit — the wind turbine's tower and its rotor as
  separate parts with the rotor pivoted on its vertex centroid so it turns true, the church (a
  chapel model at one and a half times, in the yard the procedural one had), and three houses
  lifted out of the city map (03, 07 and 08 of its residential set) for the newer end of the
  hamlet and the campsite's farmhouse. The grass pack was baked and scattered as nine thousand
  tufts, and taken out again at the user's word; the file stays in the repo root.
- **`public/models/country/*.glb`** are the animated models, one file each, kept as they are
  because baking a skinned mesh to world space throws the skin away: the windmill, pruned to one
  of the two mills in the file and scaled so its tower is 14 m; one of the file's three sheep,
  with the walk cycle; the dairy cow, at two and a half times the size it arrived at. Sizes are
  taken from the models' *posed* bounds — a skinned mesh's raw vertices are bind-space and read
  the windmill's sails at ten times its tower.

What changed on the island: the windmill's sails turn on the file's own clip, the turbines
are the download, the church is the download, three city houses stand on their own pads, five
more grey single-tracks were laid (Back Lane round the west side, Lake Lane down the lake's
west shore and over the downs' end, the cliff lane along the north cliffs from the viewpoint to
the bridge landing, a vineyard lane, and a lane from Hill Farm up to the stone circle; the
campsite lane went from gravel to tarmac), the sheep are the skinned model walking their own cycle
and holding its first frame while they graze, and the three pastures nearest Home Farm carry the
dairy cow in its two idles — it has no walk in its file (idles, two attacks and a death: it is
a game asset), so it stands where it is put and turns its head, and a fourth pasture keeps a
box herd of Herefords for a second breed.

### The Skylark line

A railway round the island, drawn by the user as a yellow line on the map: off the airfield
beside the road viaduct, round the island's west and south sides, and out over the water to
the Petrel shore. Double track, on the ground the whole way round the island — the user's brief
was *no viaduct, only ground*, with cuttings where the hills are in the way and level crossings
where the roads are — and the two water crossings are the two places there is no ground to run
on.

- **The course is set out like a railway.** `RAIL_COURSE` in `countryConfig` is a fillet
  alignment: straights between the waypoints and a circular curve of `RAIL_R` (160 m) tangent
  to both legs at every corner, the radius given up only where two corners stand too close
  (`RAIL_TIGHTEST`, 131 m, reported at load). The line runs 70 m **west** of the road viaduct,
  not east: the first draft landed on the headland's narrow tip and turned 60° in 90 m to get
  round it, a 42 m radius that reads as a wall coming round from a cab; on the headland's broad
  west flank the turn starts at the deck's end and is done at 160 m. The east bridge leaves the
  coast heading north-east, straight for Petrel's shore, because between the lake, the ring
  road and the coast there is no room to turn on land.
- **The formation is the ground.** The profile is the terrain's own height, smoothed, pinned
  level through the station and at the deck heights, and walked from every pin at a ruling
  grade of 2.5 % — a cutting where the hill is above it (15.6 m at the deepest, through the
  downs' west end) and a bank where the hill is below. `groundAt` holds the ground flat across
  the formation (`RAIL_FLAT`, 7.2 m each side) and batters the sides out as steep as the cut is
  deep. The brook goes under it in a culvert: its bed steps down into the pipe and runs on below
  the formation until the valley's own fall takes it lower.
- **One station**, Skylark, on the south side above the vineyard: side platforms outside the
  pair of tracks (4.6 m between track centres is not room for an island platform), kept minimal
  at the user's word: pale platforms, a thin dark roof floating on slim posts over each, a low
  timber slat wall with glass above it to look out through, benches and a few planters, and
  buffer stops at both ends of the line, which is a branch and not a loop.
- **Five level crossings** — the ring road twice, Quay Lane, the coast lane and the vineyard
  lane, all at 53° or squarer. A road's surface is cut exactly at the crossing's panels
  (`RAIL_CUTS`, solved by bisection on the road's samples) and the crossing's own surface takes
  over: concrete panels 35 mm under the rail head so the rails stand out of them as two steel lines, a flangeway slot either side of each rail, a solid box collider under every crossing,
  the road's profile pinned to the rail head across the whole band so it follows the line's
  grade. Each approach has a half-barrier with red lamps on the approaching traffic's
  right-hand verge, walked back until both post and arm are clear of the formation, a stop
  line, a crossbuck on the post, and a warning diamond thirty metres out.
- **No trains of its own any more.** There were two — an HST shuttle and a Class 08 goods,
  each on its own road — until the main line's viaduct junction was carried on to the
  Skylark line's east end (see *The viaduct junction to Skylark*). The line is now part of
  the player's drivable route, and its level crossings follow the player's train
  (`livePlayerRoute`) instead.
- **Two bridges**: a box girder on single piers beside the road viaduct, and one from the east
  coast to a pier a boat's length off Petrel.

`CountryRail.tsx` draws all of it from `RAIL` — the main line's own sleeper, rail section and
steel, lofted along the pair — and the map hatches it in the main line's amber with a bar for
the station. Hedges, trees, gates, poles and the herds all keep off the formation
(`railEdgeAt`).

### The road to Petrel

A second road bridge, beside the railway's east bridge and parallel to it: a T on the ring's
east leg (`JUNCTIONS.petrelT`, which splits the ring into `ringEast` and `ringSouth`), the Petrel
road north-east from its stem to the coast at 5 %, a landing pad cut down to 6 m, and 193 m of
the same concrete beam bridge as the crossing from Halcyon Field — `roadBridge` in
`countryConfig` builds both, `ROAD_BRIDGES` lists them and `CountryBridge` takes one as a prop —
across to Petrel's shore road, whose edge and height (x ≈ 573 in the island's frame, 0.0 m) were
read off the nav raster. The nav, the map and the ground painter know both decks.

### Smoother roads, and the wood ride loops

The user saw the roads cut into the hillier ground in steps. The lanes' carve blend went from
20 m to 36 m and the single-tracks' from 12 to 22, the profile solver smooths six passes instead
of two after its grade walks, and the crown mesh went to 150 rings on 900 coast steps so a bank
is a slope and not a staircase. The wood ride, which dead-ended in Hanger Wood, now loops through
it and rejoins the ring's east leg further west.

### The harbour rebuilt, and textures on every yard building

The quay was a grey disc with a timber barn, a crane, lobster pots and dinghies on it and a
four-lane kit road laid along its front. It is now a rectangular apron of granite flags in
courses, two stone stores with slate roofs along the back, the bollards, two benches, the slipway
and the light, with Quay Lane ending onto the apron at its cove end. The brook widens to a river
mouth over its last hundred metres. And every building the `Yard` builds — farms, stores, the
inn, the chapel, the lighthouse — carries a painted surface now (`surfaceTile`: rubble stone,
render, brick, timber, planks, slate, tile, thatch, concrete), mapped in metres by a world-scale
box UV in `Yard.add`, so a fourteen-metre wall gets fourteen metres of stone and not one stretched
one. The tiles are painted once on the client and hung on the shared materials.

### The single-tracks' surface

Three attempts at painting a lane with random dots were all disliked, and rightly: a painted
surface is flat however busy it is. `laneSurface` in `CountryIsland` now generates the lane as a
HEIGHT FIELD from periodic value noise at four scales — aggregate, patches, cracks, potholes, a
ragged gravel-and-grass edge — and derives the colour, normal and roughness maps from it, so
the lane is lit like a surface. The tile is eight metres along the lane, and `tintLane` gives
every vertex a slow tonal drift from its world position so the tile never reads. One trap cost
a round: the loft's U is metres across the section, not 0..1, and until it was remapped every
lane sampled a single stretched column of its texture — which is why the earlier versions all
looked flat whatever was painted.

### The pond pack, and the vehicles

Seven more downloads, baked by `prepare-country.mjs` into the same kit.

`pond_assets.glb` is a set of water plants modelled ten times life size — a duck 4.2 m long, a
reed eleven metres — so it is taken at a tenth: reeds, sedges, water grass, lotus, broad leaves,
lily pads, two stones, a log, a fish and a duck. `CountryWater.tsx` scatters them round Skylark
Water, the two ponds and the brook, in beds rather than an even fringe, and instances each part
so the thousand-odd of them are a handful of draw calls.

Everything is **in** the water. These are water plants, and a reed standing on dry grass reads
as a weed nobody cut — which is what the first pass looked like. Every plant is now rooted below
the surface and rises through it, the lilies and ducks float on it, the stones and the log sit
half submerged, and the one test each placement makes is that the ground there is under water.
The waterline itself is **found, not assumed**: a lake's nominal radius is the outline its basin
was dug to, and the ground at that radius runs from 5.5 m to 9.8 m against a 5.5 m surface, so
the scatter bisects outward along each bearing for the line the water actually reaches.

The other six are working vehicles — a tractor and trailer, a combine, a flatbed pickup, a box
lorry, an articulated lorry, and the tractor unit out of an oil-field frac rig used as a lorry
cab. Each is scaled off a real one of its kind, turned to face −Z (the convention every vehicle
in the project is placed by) and decimated to a budget.

`PARKED` in `countryConfig` stands two of each around the island, fourteen in all: tractors at
both farms, combines off both yards, a pickup at each of the four car parks, box lorries on the
quay and at the village hall, artics on the Petrel road and at the bridge landing, tractor units
at Hill Farm and the harbour. The stance is **searched, not written down**: each entry names an
anchor and `flatSpot` walks a spiral out from it, trying several headings at each ring, for the
nearest stance where all four corners of that vehicle's own footprint sit within a few
centimetres and nothing is in the way. Hand-picked offsets were what put a lorry across a slope;
a vehicle is 4 m by 16 m at the extreme and the ground under it has to be judged at that size,
not at a point. None of the fourteen now tilts more than 0.35 m.

A third tractor and a third combine are at **work**. `WORK_LOOPS` in `countryFields` gives each
a circuit inside a field's own boundary, brought in by a headland and its corners cut, which is
how a machine works a field — round it, in from the edge — and is also what keeps it off the
hedges that mark the boundary. Every field's Voronoi cell is clipped by a lane or the railway
somewhere, so the headland widens by steps until the whole lap is clear. The two machines drive
their laps pitched to the ground under them, with kinematic colliders written in the before-step
callback, and the baler leaves their circuits alone.

Three traps in the bake, all of them silent:

- `MeshoptSimplifier.generatePositionRemap` takes **two** arguments. A third silently became the
  stride, which produced a garbage remap that scrambled every index — the box lorry came out four
  centimetres tall, with the right triangle count.
- Without that weld the simplifier collapses almost nothing, because a Sketchfab export split per
  triangle corner is all border edges as far as it can tell: 184 k asked down to 13 k came back
  as 115 k.
- `simplifyPrune`'s threshold is relative to the whole mesh, and each primitive here is one
  sub-part of a vehicle, so it read every one as a speck and pruned the lot — all six vehicles
  came back with zero triangles. `simplifySloppy` with a loose error does the same by degrees: at
  1.0 it collapsed the tractor to thirteen triangles.

### Chickens, horses, and the end of the boxes

Two more downloads: `farm_animals.glb` (three skinned chickens on one clip, taken at a fifth —
they are modelled five times life size) and `low_poly_horse.glb` (rigged, but carrying no clip
at all). With those, every animal on the island is a model. The Herefords, the paddock's horses
and the pond's ducks were the last of the boxes-and-spheres herds; they are now the cow model a
shade smaller, the horse model, and the pond pack's own duck placed by `CountryWater`. Only the
rooks and gulls wheeling overhead are still procedural, because no download covers them.

The horse needed a quarter turn in the bake to face −Z like everything else. `rotY` on a LIFE
spec puts that on the wrapper node — and the wrapper is T * R * S, so the
translation has to be the ROTATED shift or the origin slides out from under the model.

Nine hens peck about each farmyard on the chickens' own clip. The horses stand: with no clip in
the file, a model sliding across a paddock with its legs locked looks worse than one standing in
it.

### The paddock, and the farm

The paddock was a two-rail garden fence round a flat green rectangle with hedges running across
it and trees growing inside the rails — the boundary generator had never been told it was there.
`PADDOCK` is in `inBuiltZone` now, which keeps hedges, trees, bushes, bales and poles out of it
in one go. The fence is three rails on 1.45 m morticed posts at 2.2 m centres, following the
ground rather than stepping, with a gateway left in the bay nearest the lane and heavier posts
either side of it. The floor is painted as horses actually graze: cropped close, a worn track
all the way round just inside the rails, rough tussocks through the middle, and poached bare
ground at the gate and the trough.

Home Farm gained the three things that make a farm read as a farm from the air — a silage clamp
(three concrete walls, a black-sheeted heap, old tyres holding it down: the only black rectangle
on an island of green and stone), a stone yard wall with gate piers, and a hen house.

### Corn on the hillsides, and corn being cut

Wheat and barley now go wherever the ground has a real fall to it (`slopeAt` > 0.1), and those
fields set their row angle to the fall line, so the drill's rows climb the incline and the
hillside reads as worked land instead of green.

In the two fields the machines are working, the corn is **there**: 2,300-odd clumps of five
stalks each, drilled along the field's own rows — and cut away for six metres either side of the
loop the machine drives, so there is a worked swathe behind it. That gap is what makes a combine
going round a field read as a combine working rather than one parked on a lawn. Geometry, not
alpha cards: the grass pack was cards and the user had it taken out.

### The hedges come out, and the lanes lose their footways

Two removals at the user's word.

**Every hedge is gone**, geometry and physics both — nine kilometres of field boundary and a
collider under every metre of it. The stone walls stay, because a wall is not a hedge. The hedge
RUNS are still computed, because three other things read them: the hedgerow trees stand along
them, the gates hang in their gaps, and the ground map draws the boundary. So a field edge is now
a line of trees and a change of crop rather than a wall of green a car bounces off, and
`describeFields` reports open boundary rather than claiming hedges nothing draws. The painted
hedge line went with them: it was their shadow, and a shadow under nothing is a green stripe
across a field.

**The lanes' footways are gone.** The road kit's texture runs pavement, edge line, two lanes,
median, two lanes, edge line, pavement, and a lane mapped across its whole width therefore
carried a drawn footway down each side — which a country lane between two fields does not have.
The lanes now sample `ROAD_PAVEMENT .. 1 − ROAD_PAVEMENT`, putting the four lanes across the full
width and leaving the footways off, exactly as both bridges have always done with the same
texture.

### The poultry farm

A chicken farm beside the paddock, at the user's word. `POULTRY` is defined in the PADDOCK's own
frame — 14 m along its length and 40 m off its side — so the two enclosures move together and
read as one holding, eight metres apart at their nearest corners.

The spot was measured rather than chosen. Of the eight places round the paddock, this is the only
one where all nine points of a 36 × 24 m footprint come out level (its four fence corners sit at
8.70 m, to the centimetre, once the pad has graded it) and nothing is within forty metres. The
lane's own side of the paddock was the obvious place and is the wrong one: a run put there
overlaps the carriageway, so a farm track runs up to this one from the lane instead.

What is in it: two deep-litter sheds with pop-holes and ramps down the front, a feed bin on legs
between them, a concrete standing at the shed doors, six free-range arks on skids scattered
across the run, feeders and a water trough. The fence is chicken wire on light stakes — not the
paddock's post and rail, because what reads at a distance is a row of thin uprights with a mesh
you can see the arks through. The floor is painted as ground a flock has been on, which is not
grass for long: scratched right out along the shed fronts where they crowd, bare under every ark
and feeder, thin and yellowed between.

Thirty-four hens live in the run, on the chickens' own clip, kept a metre inside the netting so
a bird never stands in the wire. The farmyard flocks at Home Farm and Hill Farm stay as they were.

### The realism pass

At the user's word the island was made hillier and greener in one pass: the Downs and Beacon
Hill grew, a ridge was added behind the north coast and a swell under the vineyard, and a third
octave went into the noise (the railway's deepest cutting is 16 m for it, still at 2.5 %);
Hanger Wood grew by a third and the copses doubled, to some nine hundred trees; the hedges
became rounded masses with a leafy texture instead of green boxes; the single-tracks got a real
asphalt texture with aggregate, wheel tracks, patches and a worn edge line; the ground map went
to 3.2 px/m with a quarter of a million grass-blade specks over it; and every cottage and the
inn are now the city's houses, ten of them baked into the kit, each scaled down to its
cottage's footprint (never below 0.55).

### Skylark Quarry, rebuilt as a works

The mine went through four quick passes on 2026-09-21 — a benched bowl with a hand-built crusher
and a colliery headgear; downloaded plant standing in for the crusher; a tunnel with a two-foot
tramway coming out of it; a widened yard with a 40 m works, tippers and stone heaps — and then
the user asked for it to be thought out again from nothing and rebuilt "extreme". The site was
looked at as what it is, a hard-rock quarry, and laid out the way stone moves through one.

**The ground first.** A hillside quarry is a level floor with faces round three sides of it,
opening downhill onto its works, and that is now what `mineAt` cuts: a 104 m horseshoe of
three 8 m benches into the hill north of the old site (centre (−380, 118)), opening south onto
one 116 × 140 m terrace at 7.2 m that runs from the site gate on the east to the island
railway's cutting on the west. Floor and terrace are one piece of ground — everything won at
the face comes out along the level to the crusher without a ramp — and the terrace is cut AND
fill, a level rather than a minimum, because the natural ground runs out below it along the
south side and a works stands on made ground there, not on a slope. A bench road climbs the
east face along a graded corridor onto the first bench; the overburden tip is piled at the back
of the terrace beside the pit mouth; a settlement lagoon is dished in the corner by it; and the
adit is driven into the back face, where the user's tunnel wanted to be, with its approach
cutting slotted through the first riser.

**The chain.** Face → excavator → tipper → primary crusher → conveyor → screen house →
conveyors → stockpiles → load-out → weighbridge → gate, and every model stands where that
chain puts it. The face shovel and the excavator are at the north face with a hauler and a
tipper loading; a tipper is up the ramp at the primary — a hopper with grizzly bars on legs
over a jaw crusher, tipped into from a ramp between stepped concrete walls; the crusher's
conveyor climbs out of the pit to the screen house on the terrace (the `mineWorks` model, 40 m
long) and from there conveyors fan out to three stockpile cones, to the rail bin and to the
road silos; lorries load under the silos and cross the weighbridge on the way out of the gate.
The conveyors are built by one function — a lattice gantry on A-frame legs, belt on top, drum
housings at either end — because an inclined gantry with a cone of stone under its head is the
one silhouette that says *quarry* from a mile away. The headgear went: a shaft headframe is a
colliery's, not a quarry's.

**The goods loop.** Stone leaves by train as well as by lorry. A goods loop comes off the
Skylark line's east road at s = 750 and rejoins it at s = 990, with a 100 m straight 10.5 m
out in the middle: the rail load-bay shed stands over its north end and a Class 08 and four HAA
hoppers stand on the rest of it, parallel to the main line and clear of the shed — the user
wanted the train seen, not roofed — with the dock crane beside the track, its jib over them. Ten and a half metres, because the shed is 14.9 m across
and its wall has to stand clear of a train on the main line; the leads are 70 m each, a 1 in 6
yard turnout. The loop's bed is the main line's own ballast — same texture, same section — and
where the lead is still within the line's crown it meets that crown edge to edge, flat, rather
than laying a second bed over the first. Its formation is the line's, so the terrace's west
strip is brought down to the line's grade for it (`mineAt`). It is laid
the way Kestrel's station lays its loops and the way the airfield's yard is laid: as a lateral
*offset* from the running line in the line's own frame, ramped out over an 80 m lead with the
station's `leadCurve` — a switch, a short curve and a straight diagonal at a fixed angle, not a
bell — and where the offset is under `bladeGap` the rails are drawn by `switchBlade`'s
`bladedRailProfile`, so they taper into switch blades lying against the stock rails and the
road shares the line's sleepers, exactly as the crossovers do. Its profile is the running
line's formation sample for sample. An earlier cut had the rake circulating a loop round the
whole works, which the user did not want, and the cut before that a dead-end siding that rode
the line's rising shoulder onto a bank; the offset loop has neither problem, because a road
laid as an offset can only ever be where the line is.

**The rest of a works.** The yard is on a grid now, with asphalt on it: the works road runs
west from the gate at z = −6 to the loop, the haul road north from it at x = −370 into the pit,
a spur east to the workshop, and every building stands square to one of them with nothing
parked on any of them, so the yard can be driven. It is kept sparse at the user's word — one
screen house west of the haul road, the processing house beyond it, three tall silos, a
transformer station; east of it the workshop shed and the fuel point; by the gate the
weighbridge, one office trailer, a parking apron with its bays marked and the pickups and a
lorry nose-in to them; a chain-link perimeter, four floodlight masts, a wheel wash. (A second
screen house, stores, gantry crane, water tower and mast went in and came out again.) The
entrance is a gateway — two brick piers with a steel portal carrying the name board, 16 m
clear, the barriers standing open beside the piers — and it is reached by a real road: the
quarry road, a single-track lane off Back Lane, which leaves that lane down at s ≈ −98 where
it is on the ground (level with the gate it is 14 m up on its bank) and climbs to the terrace
arriving square to the gateway from the east. The user's industrial set (a low-poly kit of separately named buildings, already in
metres) supplied the load-bay shed, the silos, the tanks, the water tower, the office trailers,
the transformer, the stores, the gantry and the mast, each one pick at scale 1; their dock
crane is a 34 m portal crane straddling the goods loop with its jib over the wagons. From the
city map came the workshop shed (`industrial J04`, the one industrial building there that
stands on its own — the rest are 90 m blocks with the streets baked in), the mobile crane, two
small lorries, barriers, skips and crates. The coal-deposit heaps that stood about the working
came out at the user's word, and the dock crane, which first straddled the loop as a portal
crane does, now stands beside it between the track and the processing house with its jib out
over the wagons: the user read the portal as an obstruction, and a crane a train has to pass
under is one. Run-of-mine stone is heaped where it is in a quarry: a surge pile at the
primary, shot rock at the face, fines round the stockpiles, spillage by the rail bin (all since removed). The old
tramway survives as the old working, from the adit out to a timber stone bin on the pit's west
side — and its tubs now stand ON the rails, along them: the first cut had them turned a quarter
across the track (a `+ π/2` that belonged to the sleepers' boxes, not to a model baked facing
−Z) and eight centimetres low. The works road runs west from the gate through the middle of the
yard and the haul road north from it into the pit, and nothing stands on either, so the yard is
open ground a player can drive round.

**The machines work.** Five of them move (`Mover` in `CountryMine`): a tipper on a circuit
down the haul road and back (it drove backwards at first — the KrAZ is baked facing +Z, so a
`face` half-turn goes on its travel yaw), the hauler shuttling between the face and the primary
along the ramp's west side — forward loaded and REVERSING back, the way a truck does at a face it cannot turn at, which is what a
shuttle mode with the model always facing the path's forward direction gives for nothing — the
dozer pushing back and forth on the tip, pitched to its slope, and the excavator slewing at the
face. Kinematic colliders in the physics step, visuals in the frame loop. The user also found
the vehicles over-compressed, which they were: the sloppy pass and the tight budgets came off
the tractor, the shovel, the dozer, the tipper, the excavator and the mine car (the tractor is
118 k triangles now, the dozer 91 k, the tipper 69 k), and the kit is 566 k triangles for it.

**The tunnel's mouth.** A heightfield cannot have a hole in it, so the first portal had the rock
face standing in the archway two metres behind the masonry. `mineAt` now cuts the mouth on past
the face at the bore's own width (`adit.mouth`), and a black wall closes the bore where the rock
takes over again, so from the pit the arch is a hole with dark in it.

**Baking.** Four more downloads went in with this pass (a 40 m factory as the screen house, a
stone heap, a KrAZ tipper, a tracked excavator), and the bake grew two things for them: it
joins primitives by material before decimating — a Sketchfab machine arrives as one primitive
per bolt, 206 for the dozer, and every one is a draw call — and it has a `sloppy` pass for the
things the topology-preserving simplifier will not take down, which is any model built as a
shell per plate. With it the shovel went 46 k → 15.7 k triangles, the dozer 111 k → 49.5 k and
the tipper 81 k → 28 k, and the kit is 390 k triangles with fifty parts in it.
