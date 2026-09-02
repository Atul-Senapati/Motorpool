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
| `Space` | Handbrake |
| `C` | Cycle camera (chase → close → cockpit) |
| `R` | Reset onto the nearest road (city) / to the grid (circuit) |
| `F` | Flip the car upright where it stands |
| `M` | Open the city map — click to set a waypoint |
| `H` | Toggle the controls panel |
| `K` | Mute engine audio |

Touch controls appear automatically on coarse-pointer devices.

## The model needs preprocessing — this is not optional

The supplied `mclaren_f1_1993_by_alex.ka..glb` is a flattened Sketchfab export and cannot
be driven as-is. Run once (already done; re-run if you replace the source asset):

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
  app/page.tsx                     client-only entry (the scene touches WebGL on mount)
  components/racing/
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
    useEngineSound.ts              synthesised engine note (no audio assets)
  config/
    vehicleConfig.ts               ALL vehicle tuning lives here
    trackConfig.ts                 circuit definition and curve maths
    cityConfig.ts                  city bounds, spawn, box colliders, raster georeferencing
    trafficConfig.ts               NPC traffic tuning
    vehicleCatalogue.json          generated — do not edit by hand
    world.ts                       which world is loaded (city, or ?world=track)
    carGeometry.json               generated — do not edit by hand
    cityData.json                  generated — do not edit by hand
  types/vehicle.ts
```

Per-frame data (telemetry, input, wheel state) lives in refs and is mutated in place.
Nothing that changes every frame goes through React state; only the camera mode and the
help panel do.

## The city

The default world is an open city map (`drive_for_speed_-_map.glb`), roughly 8.8 × 4.4 km
with 146 m of relief. Like the car, it **must** be preprocessed:

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
  spreads 14 bits over 8.8 km — 54 cm buckets — which visibly corrugates the roads and,
  because the road chunks double as the collider, makes the car judder.
- **Real-world scale recovered.** The source is authored in FBX centimetres and scaled by
  0.01 at the root, leaving a "55 unit" city. Tree height, house footprint, wall height and
  truck height independently agree on ×160.
- **Foliage switched from alphaMode BLEND to MASK**, turning 1.6 M triangles of sorted
  transparency into a shader discard.
- **Collision in two forms.** Streets, car parks and terrain (137 k triangles) become
  trimesh colliders built from the very geometry being drawn, so the wheels raycast exactly
  the surface you see. Buildings become 2,786 per-primitive box colliders — tighter than
  per-building boxes and far cheaper than 836 k triangles of facade. Primitives whose
  footprint exceeds 60 m fall through to the trimesh instead: the worst offender is a single
  5,158 × 4,231 m beach plane whose AABB would otherwise wall off the entire city.
- **Spawn is measured, not hard-coded**, and taken from the *finished* road mask so the car
  starts on a real street. Candidates are ranked by the longest unbroken straight run of road
  through them — a street is a long linear corridor, whereas scoring "how much pavement is
  nearby" rates a car park higher than a road and once picked an elevated parking deck inside
  a block. A height filter keeps the search off flyovers and roof decks.
- **A navigation raster**, `public/models/cityNav.png` (500 KB), one pixel per 3 m:
  `R` marks paved surface, `G`/`B` carry ground height as a u16, `A` marks where any
  drivable ground exists. Building footprints are punched back out of the road mask, since
  warehouses and shops often sit on their own paved lot and would otherwise read as street.

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

**78.8 MB -> 2.66 MB**, 20 vehicles: 10 civilian cars and 10 service vehicles (ambulance,
city bus, fire truck, school bus, police, taxi, tow truck, garbage truck, post van, service
truck). The script normalises two packs that agree on nothing:

- **Millimetres to metres**, and each vehicle re-centred on its own footprint, sitting on
  y = 0 and facing -Z like the player's car. Every vehicle sat at its own spot in a showroom
  layout at its own arbitrary yaw, so the long axis is recovered by PCA over the body
  vertices.
- **Which way each vehicle faces is worked out from its lights and its glass.**
  The long axis comes from PCA, which is *undirected* — it cannot tell a bonnet from a boot,
  so left alone roughly half the pack drives backwards. Two physical signals settle it:
  tail lights are red and head lights are not, so the red end is the back (sampled from the
  optics geometry against its own texture); and a windscreen is raked forward while a rear
  window rakes back, so the area-weighted glass normal points at the nose. The lights decide
  cars; the glass decides cab-forward vans, trucks and buses, where the lights mislead
  (a fire engine is red all over, an ambulance carries red markings at both ends).
- **Wheels are reunited with their cars spatially, not by name.** The passenger pack keeps
  wheels as loose `Wheel_A..H` nodes that are siblings of the bodies, and the names cannot be
  trusted: one base name is reused across two different cars, and two distinct nodes share
  the name `Wheel_G001`. Pairing by position — nearest first, capped at four per body, never
  across packs — is the only thing that gives every car exactly four wheels.
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

They are scripted rather than simulated — 20 more raycast vehicle controllers would cost more
than the player's car and buy nothing. Rendering is instanced (84 batches for 40 cars), and
wheels spin off each car's odometer where the pack kept them separate.

**Traffic cars are kinematic**: they collide with the player without being pushed by him, so
hitting one is like hitting a wall rather than shunting it aside.

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
