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
    useEngineSound.ts              engine note: two real recordings, crossfaded and pitched by RPM
    useGarageAudio.ts              garage music + UI click/confirm sound effects
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
- **A navigation raster**, `public/models/cityNav.png` (752 KB), one pixel per 1.5 m:
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

The city already had a tram loop running through it — four of its own streets, with a
scripted service on it (`railConfig.ts`, `RailLoop.tsx`). The tram is also **something you
can take out yourself**: it appears in the vehicle picker alongside the cars, and
`?car=tram` puts you in the cab.

The vehicle is a Melbourne C-class (Alstom Citadis 202) in Yarra Trams livery. It replaced a
Gold Coast G:link Flexity 2 — see **Preparing the tram** below, because getting the new model
usable took considerably more work than dropping a file in.

It is deliberately not treated as a car. At 24.1 m over three articulated sections, with no
wheel pivots and no steering, running it through a physics model calibrated on a 4.3 m
McLaren would be nonsense — and it would not fit down most streets here. So `TramRide`
replaces `CarPhysics` outright rather than configuring it: the route is already parametrised
by arc length, so driving a tram is one scalar pushed along by a throttle and a brake, and
the rails do the steering.

What that gives you is a vehicle that has to be *driven ahead of itself*. The acceleration
and braking figures are the real ones — 1.15 m/s² away from a stop, 1.8 m/s² on the service
brake — so it takes about 17 seconds to reach the 70 km/h line speed and roughly 150 m to
stop again. Reverse is a slow shunt, capped at 4 m/s, because you cannot see behind you.

- **Nothing gives way to you.** The tram is three kinematic bodies, exactly like the service
  trams and the traffic, so cars bounce off it and it does not care.
- **But you do queue.** Two kinematic bodies do not collide in Rapier, so a tram would
  otherwise drive straight through another one — and it is not a corner case, since you can
  out-run the service and a player who simply *stops* gets rear-ended within twenty seconds.
  Every tram on the line therefore asks the same shared registry what is ahead of it and
  brakes for it, player included. Measured on the previous, longer tram: a service tram
  closing on a stationary player settles at the minimum gap instead of passing through it.
- **The camera is framed on the cab**, not on all 24.1 m. Camera offsets scale with vehicle
  length, which is right for cars and would put the rig 34 m back for the tram — down among
  the traffic, watching a distant object rather than driving one. `rigSize` overrides that,
  so the eye sits about 12 m behind the cab and 7 m up, clear above the roof.
- Steering, the handbrake and `F` (flip upright) do nothing on rails, and the engine sound is
  silenced — a tram has no engine to fake. The dial shows tractive load instead of RPM so it
  still says something true.
- The tram is offered **only in the city**, because its route is measured city streets; there
  is no track for it on the circuit.

> The vehicle picker and the tram loop themselves are not yet written up here — they were
> added separately from the notes above.

## Preparing the tram

`prepare-tram.mjs` exists because the C-class model as downloaded is **2.86 million
triangles** — 47× the tram it replaced, against a whole city of 250 k — and two thirds of
that is furniture nobody can see: seats, grab poles and hanging straps modelled as solid
tubes, behind tinted glass. It also arrives as one rigid body, authored per *material*, so
every mesh in it runs the full length of the vehicle.

**Finding the interior is a measurement, not a list of names.** The script rasterizes the
model from 26 directions with its own z-buffer and keeps only the meshes that actually win
pixels. Glass is deliberately treated as opaque, which is what makes everything behind a
window come out correctly invisible, so the seats, grab rails, driver's cabs and gangway
frames all fall out on their own — 2.34 M triangles of them — without anyone having to
identify them by hand. Two refinements came out of getting it wrong first:

- **The viewpoints are a hemisphere, not a sphere.** A tram sits on the ground, so there is
  no camera underneath it; the first version spent 45 k triangles keeping bogie frames and
  brake discs that are only visible from below the road.
- **Glazing is exempt from the threshold**, because the threshold cannot measure it. An
  opaque-rasterized test badly under-counts a pane you are meant to look *through*, and
  culling glass on those numbers punched the windows out of the tram and left the inside of
  the far wall showing through the holes.

**The body is cut at its real articulation joints.** A rigid 24 m vehicle cannot follow this
loop's 10 m corners — the chord across a body that long is wider than a corner's whole
diameter. The joints were measured rather than eyeballed: the body's half-width at waist
height dips from 51.1 to 45.5 source units in two narrow bands, symmetric about the centre
at ±174.5 units, which are the bellows. Triangles are bucketed by centroid into three
sections, each reaching a little past its own cut so neighbours overlap inside the bellows
instead of parting company through a corner.

**It does not decimate, and that is the honest result.** The bodyshell is a lattice of thin
window and door frames, and meshoptimizer will not collapse an edge on a topological border,
so nearly every triangle in it is locked. Raising the error ceiling to 2 % bought 12 %;
5 % bought 25 % but broke the livery swooshes into dashes and blunted the nose by most of a
metre. Unlocking borders instead let the shell bridge straight across its own window
openings, spraying white slivers over every pane. Both were tried and rendered before being
rejected. What does help is a **needle filter** — the export has flat ribbons a couple of
centimetres wide and metres long radiating from the pantograph, which read as white slashes
across the roof from every angle; anything past 150:1 length-to-thickness is dropped.

The result is 391 k triangles and 1.5 MB, from 2.86 M and 72.7 MB. That is still 6× the old
tram, so **the service was thinned from five trams to three** (`TRAM.count`) to keep the
whole line inside about 1.2 M triangles rather than 2 M. That is the one number to change if
your machine can take more.

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
