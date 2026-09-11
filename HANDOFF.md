# Handoff / Context

Continuation notes for picking this project up in a fresh session (different account, no
prior conversation context). Written 2026-08-27.

Read `README.md` first for the user-facing description, controls and architecture. This file
covers what a **new session needs in order to keep working**: state, decisions, traps, and
what is and isn't verified.

---

## 1. What this is

A browser McLaren F1 1993 driving experience. Next.js 16 (App Router, Turbopack) +
TypeScript + React Three Fiber 9 + three 0.185 + `@react-three/rapier` 2 + Tailwind 4.

Built to a detailed spec covering: model loading and wheel identification, real Rapier
vehicle physics (explicitly *not* `position += velocity`), keyboard controls, three cameras,
a procedural track, HUD, effects, reset, responsive/touch, and performance.

**Status: complete and working.** Runs at a steady 60 fps.

```bash
npm run dev      # http://localhost:3000
npm run build    # passes
npx tsc --noEmit # clean
npx eslint src scripts   # clean
```

---

## 2. Environment constraints (will bite you)

| Thing | Value | Consequence |
| --- | --- | --- |
| Node | **20.9.0** only (`/usr/local/bin/node`, no nvm) | Predates import attributes. Anything shipping `import x from "./p.json" with { type: "json" }` throws `SyntaxError: Unexpected token 'with'`. This is why `sharp` is pinned to **0.32.6** (last CJS release) and why `@gltf-transform/functions` was removed — it drags in `ndarray-pixels` → `sharp@^0.35`. npm `overrides` did **not** fix the nested copy on npm 10.1. |
| Directory name | `3dDriving` (capital D) | `create-next-app` refuses it ("name can no longer contain capital letters"). The project was scaffolded in a temp dir and rsynced in. Don't re-scaffold in place. |
| Preview pane | Intermittently reports `document.visibilityState === 'hidden'` | Browsers throttle `requestAnimationFrame` to <1 fps when hidden. R3F's loop is rAF-driven, so the whole sim crawls and Rapier gets huge catch-up deltas. **Any dynamic test taken while hidden is worthless.** Always check `rafFps` first (see §6). |

---

## 3. The model: preprocessing is mandatory

Source asset: `mclaren_f1_1993_by_alex.ka..glb` (13.3 MB, in `source-models/`, untracked).
Output: `public/models/mclaren.glb` (5.1 MB, committed to disk, already generated).

```bash
npm run prepare:model    # scripts/prepare-model.mjs
```

The source is a flattened Sketchfab export and **cannot be driven as-is**:

- Every node is `Object_N`; geometry is merged **by material, not by part**. All four tyres
  are a single mesh with no pivots. There is no FL/FR/RL/RR node in the file at all.
- The script splits each wheel-material mesh into four by triangle-centroid quadrant. This
  is safe because the corners are spatially disjoint and each quadrant verifies as circular
  (Y-radius ≈ Z-radius to <6 mm).
- Two groups, driven differently: **`Wheel_FL/FR/RL/RR`** roll *and* steer
  (`tire`, `tire_side`, `material_48` rim, `brakedisk`, `rimbolt`, `rimlogo`, `F1_nip_logo`);
  **`Upright_FL/…`** steer but never roll (`material_43` caliper, `chrome`, `suport`,
  `black_aluminium`, `McLaren_supportlogo`). Spinning a brake caliper is an instant tell.
- Deletes two baked shadow planes: material `floor` (10×10 m) and material `material`
  (2.2×5.0 m). Both sat at y=0 and would z-fight the track.
- Scale ×**0.9148** (source is 17.6% oversized). Validated three ways: 4.31 m length vs real
  4.29 m, 2.724 m wheelbase vs 2.718 m, and tyre radii 0.3176/0.3504 m which are exactly a
  235/45R17 and 315/45R17 — the real car's staggered fitment.
- Orientation baked to Y-up, nose at −Z, via rotX(−90°)·rotY(180°) — a proper rotation
  (det +1), so the car is re-oriented, never mirrored. **Note:** this flips which x-sign is
  "left", so wheel side is derived from post-transform world position, not local sign.
- Textures → WebP, capped 2048 px: 9.85 MB → 0.92 MB.

The script writes measured geometry to **`src/config/carGeometry.json`** (generated — never
hand-edit) which `vehicleConfig.ts` imports. If you replace the art, re-run the script and
the tuning follows automatically.

---

## 4. Rapier raycast-vehicle traps — read before touching physics

These cost most of the build time. All are documented at their call sites too.

1. **Never read `world.timestep` inside a before-step callback.** It re-enters the borrowed
   `World` and throws *"recursive use of an object detected which would lead to unsafe
   aliasing in rust"*. That aborts the step, so `updateVehicle()` never applies **any** force
   and the car just sinks onto its collider — with no obvious error in the app. Use the
   `PHYSICS_TIMESTEP` constant. `controller.wheelGroundObject()` has the same problem, which
   is why surface grip is analytic (`src/physics/surfaceGrip.ts`) rather than queried.
2. **`mass` goes on the collider, not `RigidBody`**, when `colliders={false}`. Otherwise the
   chassis silently weighs whatever collider density implies — it was **6.6 kg**, not 1140.
3. **Force accumulators persist across timesteps.** `addForce` without `resetForces` compounds
   every frame. The downforce was building into an unbounded force that crushed the
   suspension flat and ground the body along the road.
4. **`suspensionRestLength` does two jobs**: spring free length *and* ray length (the ray
   reaches `restLength + radius`). Deriving the hard-point height from it couples them and
   the car balances on the tip of its own ray — contact flickers, the spring never
   compresses, and ride height becomes independent of stiffness. They are decoupled in
   `vehicleConfig.ts` via `HARD_POINT_ABOVE_AXLE` + `DESIGN_DEFLECTION`.
   Corollary: **droop travel == design deflection**, unavoidably.
5. **Collider friction is ignored** by the raycast vehicle. Traction comes from per-wheel
   `frictionSlip` / `sideFrictionStiffness`, so off-track grip is applied there.
6. **Suspension and engine forces are not in SI units.** `wheelSuspensionForce` reads back in
   units unrelated to the applied impulse, and there is no chassis-mass term. Both were
   calibrated empirically.
7. **Steering sign is inverted** relative to the intuitive convention with a −X axle;
   `STEER_SIGN = -1` in `vehiclePhysics.ts` is the single place it's reconciled.
8. Ordering matters: the suspension bump stop (`maxTravel`) engages at 0.22 m while the
   chassis collider bottom sits at 0.14 m clearance — deliberately, so the springs bottom
   *before* the body can touch the road.

### Calibrated values and how to re-derive them

Dev-only URL overrides exist because mutating these mid-flight destabilises the sim and
produces garbage readings. **One value per page load, clean state each time.**

```
?k=22     suspension stiffness
?ef=6600  engine force per driven wheel
?dc=4.4   suspension compression damping
?dr=8.8   suspension relaxation damping
```

- Suspension: at equilibrium, `stiffness × deflection ≈ 2.13` for this mass. Current
  stiffness is `2.13 / DESIGN_DEFLECTION`. Re-measure if `VEHICLE.mass` changes.
- Engine force: acceleration time scales as 1/force. Data points: 5000 → 6.3 s to 100 km/h,
  9800 → 2.15 s, **6600 → ≈3.1 s** (real car: 3.2 s).

---

## 4a. Tyre marks and the chase camera

**Anything drawn on the ground must sample the ground.** Skid marks were pinned to
`y = 0.014` — fine on the flat circuit they were written for, invisible across a city with
91 m of relief, because every mark was buried or floating. `surfaceHeightAt()` in
`physics/surfaceGrip.ts` is the shared way to ask. A fixed lift is not enough on its own: the
nav raster knows height to 1.5 m pixels, so on a slope the sample can be centimetres out, and
the material carries a `polygonOffset` depth bias the way decals normally do.

**`marksAt()` is deliberately not `gripAt()`.** Grip feeds the vehicle model, so widening it
changes how the car drives and would need re-tuning; deciding where rubber shows does not.
Known limitation: the road mask covers streets, car parks and garage floors, so paved areas it
excludes — a seafront promenade, for instance — take no marks even though you can drive there.

**Rapier's raycast vehicle reports no wheel angular velocity**, so longitudinal slip cannot be
measured as (wheel surface speed − ground speed). `WheelState.longSlip` infers it from demand
instead: throttle against speed for wheelspin, brake against speed for lockup. It is an
approximation and is documented as one at the call site.

**A frame delta must be clamped before it is accumulated.** `SkidMarks` kept a running
`elapsed` that the fade shader compares against each mark's birth. Unclamped, a single
multi-second delta — a tab regaining focus — ages every mark on the map out of existence at
once. `RacingCamera` already guarded against this for the camera; the same trap applied here.

**The chase camera is a damped angle, not an offset.** `ChaseState` holds the rig yaw between
frames, and the lag behind the car's heading is what produces the corner swing. The reverse
sweep commits at the halfway point of its blend rather than interpolating the angle, because
yaw and yaw + π are antipodal and blending between them has no defined direction — the damped
follow then sweeps the short way round, which is both well-defined and what reads naturally.

### Testing either of these in the preview pane

Both are motion features, and the pane renders at ~1 fps, so real-time key injection is
useless. Driving the loop by hand with `three.advance(t)` works, with one trap: **R3F derives
its delta from the timestamps you pass**, so synthetic timestamps push `SkidMarks`' `uTime`
into the hundreds of thousands of seconds and every mark reads as fully faded — which looks
exactly like the marks being broken. The delta clamp above bounds that to 50 ms per call, so
stepping is now safe. Verified numerically rather than by eye: wheelspin 0.57 on the rear
against 0.00 on the front, lockup 1.0, handbrake side slip 0.75, marks laid with mean strength
0.83 and y following the terrain over a 0.15 m range; camera lag 4° straight, 14° cornering,
and a reverse sweep of 0° → 144°.

## 4a-i. The garage picker

`GarageScreen.tsx` is the chrome, `GarageStage.tsx` the 3D studio, `GarageThumbs.tsx` the
offscreen renderer that makes the roster pictures, `garageTheme.ts` the one accent and the
raised-card recipe. Load-bearing facts:

1. **It is a white cyclorama because that is how cars are shot.** Two rules from real studio
   practice, looked up rather than guessed: *light the walls, not the car* — paint reads from
   what it reflects, so a dark room flattens it (two earlier versions proved this) — and *put a
   dark band at the horizon* (photographers hang "blacks"), which is what gives a flank depth on
   white. The reflection map carries that band; remove it and the paint washes out. The floor
   curves into the wall (the cove) so no corner appears in the reflections. Sources in README.
2. **Both `GarageStage` and `GarageThumbs` must be `ssr: false`.** They touch WebGL during
   render; the server pass throws `document is not defined` and Next falls back to client
   rendering *silently*, costing the whole page its server pass.
3. **The thumbnails are renders, not files.** `GarageThumbs` mounts a hidden `frameloop="never"`
   Canvas, renders one vehicle per Suspense resolution with `gl.render` + `toDataURL`, and caches
   in `localStorage` under a **versioned key** — bump `CACHE_VERSION` whenever the shot changes or
   stale pictures serve for ever. It shares drei's loader cache with the stage, so the focused
   vehicle costs no extra download. Cache reads happen in a lazy `useState` initialiser, not an
   effect: the project's lint forbids `setState` inside an effect body.
4. **The root grid needs `grid-cols-[minmax(0,1fr)]`.** Without it the single column sizes to
   the header's non-wrapping intrinsic width, the page becomes wider than the viewport, and the
   spec panel, right arrow and turntable drift off-screen behind `overflow-hidden`. It looked
   like a camera bug; it was CSS.
5. **Nothing may be content-sized.** Every overlay has explicit dimensions — the name gets two
   reserved lines, the blurb a fixed height, numerals a fixed unit cell, the counter a fixed
   width. The previous absolutely-positioned version shifted the whole layout on every switch.
6. **Framing math lives in `garageStudio.ts`** (`frameVehicle` + `cameraPose`), shared by the
   stage and the thumbnail renderer, so a vehicle is not a different-looking object in the two
   places. It fits the vehicle's **actual silhouette at a chosen azimuth**
   (`w·|cos θ| + l·|sin θ|`, exact for a box's orthographic width), not a bounding sphere — a
   sphere fit is fine for a boxy car but wrong for something long and thin, where most of the
   sphere is empty air around the body. The azimuth itself eases from a fixed "3/4 car" angle
   toward broadside as `length / width` climbs past 3 (every car and truck here sits under
   3.3; only the tram, at 9.1, moves). Both corrections are *interpolated* on that ratio, not
   switched on at a threshold, which is why replacing the 43.5 m tram (ratio 15.8) with a 24 m
   one needed no retuning at all — it lands part-way along the same curve. This is the second
   framing fix in this file's history —
   read it before touching either number, or the tram breaks again in a new way.
7. **The tram used to float away from its own turntable ring.** The earlier framing pushed the
   look-at point sideways in world space (`camera.lookAt(-distance * 0.16, …)`) to keep the
   vehicle clear of the spec panel, scaled by the fit distance. That distance is ~10-19 m for a
   car and was ~97 m for the tram under the old sphere fit — so the offset landed the look-at
   point over 11× the tram's own half-width from its centre, and the tram appeared to drift off
   from the ring, which sits at the true origin and never moves. **The fix removed the offset
   entirely**: the camera always looks dead centre, and `GarageScreen`'s spec panel is
   translucent (`backdrop-blur-md`, `rgba(255,255,255,0.72)`) instead of solid, so overlap
   reads as a HUD over the scene rather than as the vehicle hiding behind a wall. If a future
   change reintroduces a world-space offset to dodge some other panel, remember that any offset
   scaled by fit distance will blow up for the tram the same way — offset in screen space
   (`camera.setViewOffset`) or not at all, not in world units.
8. **The first cut of `GarageThumbs` was flatly lit — no environment map, no floor, no
   shadow —** three direct lights and nothing for the vehicle to reflect or sit on. A PBR body
   with nothing to reflect reads as dull plastic regardless of how many lights point at it,
   which is why the roster pictures looked dull even though the stage right above them looked
   fine. It now shares the stage's `studioEnvMap` and gets a cheap radial "ground blob" texture
   standing in for a contact shadow — a real shadow map is not worth its setup cost (the
   `shadows` Canvas prop, shadow-casting lights, a settled render) for a canvas that renders
   exactly one frame and is discarded. `CACHE_VERSION` was bumped to `v4` to flush the old dull
   renders out of `localStorage`; bump it again if the shot changes further.
9. One Canvas for the life of the screen; camera on −Z; articulated vehicles laid out from
   `sections`. See README.
10. **The stage's extra zoom-out margin is tapered by elongation, not applied flat.**
    `frameVehicle` grew an optional `marginMul` (`GarageStage` passes `STAGE_MARGIN = 1.55`; the
    thumbnail renderer passes none, since a small tile wants filling rather than air) — but
    applying it as a flat `distance * marginMul` broke the tram: its fit distance is already
    large from fitting its whole length, and multiplying that by the same factor a compact car
    gets pushed it back far enough to shrink to a sliver in an empty stage. Fixed by tapering the
    margin's effect with the same elongation interpolant `t` already used for azimuth/pitch —
    `effectiveMargin = lerp(marginMul, 1, t)` — so a car near `t = 0` gets the full 1.55× and the
    tram at `t = 1` gets none, restoring its previously-tuned tight framing exactly. **If you add
    another margin-style multiplier here, gate it through `t` the same way rather than applying
    it flatly**, or you will reintroduce this exact regression on the next elongated vehicle.
11. **The picker's prev/next arrows went through two redesigns** as part of the same zoom-out
    pass, and the second undid most of the first. The first attempt (metallic disc, gradient
    face, hover-glow halo, a tick-mark rim borrowed from the turntable decal, a stacked
    double-chevron echoing the DRIVE/RIDE button) was too busy at 64px and read as its own
    separate decoration rather than a control. It was replaced with the plain `RAISED` card
    recipe already used everywhere else on this screen plus one bold chevron — simpler and more
    consistent, not a downgrade. **If the arrows come up again, resist re-adding rings/gradients
    a second time**; the plain-chrome version was a deliberate simplification, not an
    unfinished intermediate step.
    - The since-removed tick marks were computed from `Math.cos`/`Math.sin` and needed rounding
      to 2 decimal places before being rendered as SVG attribute values, because raw trig output
      is not guaranteed bit-identical between Node's SSR and the browser's V8 — an unrounded
      coordinate can differ in its last digit between server and client and React logs a
      hydration mismatch. That specific bug is moot now the tick marks are gone, but the
      **underlying rule still applies to any future SVG geometry computed from trig in a
      server-rendered component** — round it.
    - Also worth keeping: while verifying that fix, the mismatch kept reappearing on fresh
      reloads even after the `round()` code had already landed in source, because the
      **already-running dev server process was serving a stale cached build** —
      `preview_stop`/`preview_start` (a fresh process) cleared it. If a fix that is definitely in
      the source file doesn't show up in the browser, suspect the dev server process before the
      code.

## 4a-ii. The rideable tram

`TramRide.tsx` is the player's tram, and it **replaces `CarPhysics` rather than configuring
it** (`RacingScene` switches on `SELECTED.rail`). That is the important structural point: a
24 m articulated rail vehicle has no business going through a raycast-vehicle model
calibrated on a 4.3 m McLaren, and `railConfig` already parametrises the route by arc length,
so the whole vehicle is one scalar plus a throttle and a brake.

Things worth knowing before touching it:

- **`VEHICLE` still gets built from the tram's garage entry**, because it is a frozen module
  constant read from ~60 places. Everything in that entry describing wheels, suspension or a
  chassis box is therefore inert but must be present and **non-degenerate** — real tram bogie
  figures rather than zeros, so nothing downstream divides by one.
- **Camera offsets scale with `SELECTED.size[2]`**, which for a tram-length vehicle puts the
  chase rig tens of metres back, in the middle of the traffic. `rigSize` exists to override that and frames
  the rig on the driving end. The cockpit offset is *not* scaled for a rail vehicle: the
  scaling assumes the driver sits a fixed fraction back from the nose, which is true of a car
  but put the eye floating several metres in front of a tram.
- **Two kinematic bodies do not collide in Rapier.** Every tram on the loop is kinematic, so
  nothing stops one driving through another; `physics/tramTraffic.ts` is the only thing that
  does. It is deliberately **symmetric** — the service trams brake for the player as well as
  the reverse. The asymmetric version looked fine until you stopped, at which point the tram
  behind rear-ended you within twenty seconds. Verified on the previous, longer tram: a
  service tram closing on a stationary player settles at the minimum gap instead of passing
  through.
- **The player starts half a service interval into the gap left by a stood-down tram.** The
  service sits at multiples of `RAIL_LENGTH / count` and phase 0 is one of them, so starting
  at 0 would put the player inside a tram on the first frame. `RailLoop` renders
  `count - 1` service trams when the driver has taken one out, so the line keeps its interval
  rather than gaining a vehicle.
- `SkidMarks` and `TyreSmoke` are not mounted, and the engine sound is disabled: all three
  read per-wheel slip or an engine that a rail vehicle does not have.
- The tram is excluded from `GARAGE` outside the city, since its route is measured city
  streets. `?world=track&car=tram` falls through to the default car, because `selectVehicle`
  only accepts an id it can find in the roster.

**Still not documented:** `prepare-garage.mjs` and the tram loop's own preparation
(`railConfig.ts`'s route survey, `RailLoop.tsx`, `prepare-tram.mjs`) were added without notes.
The sections above cover the picker and the rideable tram built on top of them, not how the
source models were processed.

## 4a-iv. The main-line railway (new)

**The route is traced from a sketch (current).** `src/config/trainSketch.json` is the user's
drawing over a screenshot of the city map, kept in that screenshot's own pixel coordinates
with the transform that georeferences them, so the trace stays auditable — if a leg looks
wrong, the number to change is the one that was read off the drawing. Fit the transform
against the road mask's own bounding box and cross-check it on landmarks; it came out good to
about ±40 m, and the finished line sits a mean 26 m / worst 142 m from the drawn one.

Three things this changed in `find-train-route.mjs`:

- **`CORRIDOR`** — A\* may only use cells within `CORRIDOR_HALF` (150 m) of the drawn line.
  Enforced as a hard mask, not a price: over open water nothing else charges anything, so a
  priced corridor just gets cut across the bays.
- **Anchors are the drawn vertices**, in order. The chooser (farthest-point sampling, 2-opt
  tour, coastal band, `REACHABLE`/`OPENNESS`/`MAINLAND`) existed to guess at a route and is
  deleted.
- **`SOLID_CLEARANCE` 8 → 14.** The grid is 6 m, so a clearance measured from cell centres can
  come out 4 m short of what it claims — and the fillet arc then cuts the corner off the path
  A\* validated, leaving the finished line closer still. The west leg had 36 m of viaduct 6 m
  from a facade with the finder reporting "0 points inside the clearance", because the check
  and the alignment were not looking at the same line. Two sketch vertices were pushed 45 m
  further out to sea as well; nothing is now nearer than 16 m.
- **`SIMPLIFY_TOLERANCE` 180 → 45.** 180 was tuned to straighten a machine-generated
  staircase; against a hand-drawn line it flattened a 7.07 km loop into a 6.13 km rounded
  rectangle with five corners. Watch this if the shape ever stops matching the drawing.

**Near the city the line is carried over the broadest road, and no land is made.** Two knobs:

- `roadHalf` measures each road cell's carriageway half-width on the *nav raster*, not the 6 m
  search grid — a street is often two grid cells across, which cannot tell an avenue from a
  lane. Broadest here is 33 m. `roadPrice` keeps the flat refusal below `ROAD_BROAD` (20 m) and
  falls away above it, down to `ROAD_FLOOR`. A road cell is always VIADUCT and `ROAD_CLEARANCE`
  holds the deck above the street, so this is a viaduct down the middle of a boulevard — the
  one way through a built-up block that neither demolishes anything nor invents ground.
- **`ROAD_FLOOR` is set at the water price, deliberately, and this is the failure mode to
  watch.** At 3 — cheaper than open ground — the search stopped treating streets as a way
  *through* the city and started treating them as the preferred route everywhere: 13.6 km,
  37 corners, four sharper than 60 m, weaving down the street grid inside its own corridor.
- `MIN_CAUSEWAY` is `Infinity`: no reclamation, every crossing bridged. That is what puts a
  1,944 m viaduct on the west side and takes the over-water total from 2.0 km to 3.7 km. It is
  the direct consequence of "don't add land" and it is the right trade — a causeway across a
  bay reads as a dam. The two islands are the only ground the line may invent.

**Everything that has to hold both tracks is centred on the PAIR, not the running line.** The
route file describes one alignment and every arc length is measured along it; the second track
runs `secondTrackGap` (4.6 m; 12.4 m through the island station) to its left. So the middle of the
railway is 2.3 m left of the running line, and a bore, a cutting, a portal, a gallery or a deck
centred on the running line puts one track hard against the wall and gives the other a metre of
dead room. `trackPair.ts` → `pairCentreAt(s)` is the one function; `TrainLine` (`midOf`) and the
terrain carve in `CityMap` both use it, and carve segments now carry each endpoint's arc so the
shader can be offset without `trainConfig` importing `stationConfig` (a cycle). Bore is 6.0 m
half-width for the pair (2.3 m centres + 2.7 m vehicle + structure gauge + 1.1 m walkway), so
`BORE_COVER`/`TUNNEL_MIN_COVER` went 13 → 14 and `cuttingMaxDepth` with them: the carved arch is
now 3.5 + 6.6 = 10.1 m over the rail and wants the same 3.9 m of ground it had.

**Ruling grade 2 %, 80 smoothing passes.** The line was following the terrain up and down —
25.6 m height span, 67 m of climb round 6.6 km, 26 grade reversals. At 2 % with long vertical
curves it is 13.5 m / 32 m, and the *horizontal* alignment, structures and bores come out
identical, so nothing that is located along the route moves sideways. Trialled on scratch
copies of the generator (`OUT` redirected) before touching the live route — do the same for
any profile change; the stations are all found from this file.

**Double track the whole way round.** `doubleTrackAt` is `true` everywhere and the second track
is the **down line**: `secondTrackGap` is 4.6 m except through the island station, where it fans
out to road 1's 12.4 m (smoothstep over the station's `taper` at each end, mirrored) so platform
A is an island between the two through lines. Consequences that follow from that one decision:

- `IslandStation` builds only `ROADS.slice(2)`, as **loop roads** — `roadOffset` tapers at
  BOTH ends to `ROADS[1] + throatOffset`, `sampleRoad` is symmetric, sleepers count
  `ROADS.length - 2`, and the buffer stops are gone (a loop has nothing to stop). `DOUBLE_TRACK`
  survives in `stationConfig` only as the record of the elevated stretch; nothing reads it.
- **The underground hall is a twin-platform station, 200 m long, written in pair-centred
  coordinates.** With a track each side of the pair centre, a single left-hand platform would
  sit on the down line, so `UndergroundStation` has a platform on EACH side (right = up line,
  left = down line), a tall bay over both tracks between them and a low ceiling over each
  platform. Every lateral number is metres left of `pairCentreAt(arc)` and the samples are
  placed on that centre, so the bore horseshoe needs no shift to hand over to the pair-centred
  lining and the room is symmetric by construction. Each platform and its fittings are
  described once and built twice through `sided(s, …)`; `buildLoft` orients from the profile's
  signed area so the mirrored copy is the right way out. `UNDERGROUND.hallHalf` (8.8 m) replaces
  `wallLeft/wallRight/stepAt`. Fittings on the back walls (posters, fire points, exit portals)
  stand a few cm INTO the room — the room is one loft, so anything behind its wall is invisible
  from inside; a real alcove would vanish. The name frieze is a canvas texture whose U runs up
  the wall and V along the arc: the right wall's reader sees a +90° rotation of the canvas, the
  left wall's reader sees it from the BACK, a reflection — so the left texture is drawn with
  `transform(0,-1,-1,0)`, not a rotation, or it reads upside-down. Hall centre today: arc 3654
  (the longest ≥`minCover` ground-covered run in the longest enclosed stretch), 16.8 m of cover
  at its shallowest.
- **Trains on the second track** (`Locomotive track={1}`) run the loop the other way via
  `locomotivePose(s, direction, lateral)`, one per `TRAIN.count`, half a phase offset from the
  up-line fleet. They are gated on `samples.every(s => s.double)` — now true — and were seen
  coming out of the T1 portal on the left track.
- Every viaduct is now the box-girder double deck (`isWideDeck`), centred on `mid = gap / 2`.

**Darkness underground is the WORLD dimming, not the lining — and it follows DEPTH, not a
switch.** Nothing occludes light in this scene, so a bore lit by the sun, sky and environment map
is a grey pipe in daylight, and no amount of darkening the lining fixes it. `Darkness` in
`Environment.tsx` scales the sun (×0.04), hemisphere (×0.08), ambient (×0.45) and
`scene.environmentIntensity` (×0.1) and swaps the fog for a short black one (18–150 m) — by
`trainDepthAt(railArc)`, the distance along the line to the nearest open point, through a
smoothstep over `DARK_FADE` = 95 m and a 0.3 s damp. The first version keyed it to
`telemetry.enclosed` (a boolean damped over 0.12 s) and the world snapped dark 36 m before every
portal: a light switch. Daylight reaches ~100 m into a real tunnel and fades; so does this, both
ways. `RacingScene` passes `telemetry` and `dark={SELECTED.rail === 'main'}` — only the train
publishes `railArc`, and cars and the tram never go underground.

**Inside a bore, what you see is what the bore lights itself.** The strips are LAMPS (a lens
texture at `BORE_V_SCALE` pitch on a dark housing) and each lamp has an additive glow band on the
wall, the walkway top and the invert edge, aligned to the lens's V, because a lamp that lights
nothing is a sticker. Lining emissive 0.58 (was 1.0). Fittings, all `shifted(midOf)` lofts
filtered by `isBore`: two cable trays a wall, a handrail with instanced posts every 6 m, a painted
walkway edge, a drain between the tracks, a translucent soot band on the crown and grime at the
wall feet; `BoreFixtures` places refuge niches (75 m, alternating), exit signs (50 m) and distance
boards (100 m) by arc, yawed to the line, a few cm INTO the bore — the lining is one back-faced
loft and anything behind it is invisible.

**The bore's section and finish are shared: `boreProfile.ts`.** `LINING_PROFILE` (walkways and
all), `BORE_INVERT`, `LINING_MATERIAL`, `makeLiningTexture` live there, used by the lining in
`TrainLine` and by the hall in `UndergroundStation`, whose end section is the bore's. The hall
resamples its room polygon onto the lining profile's vertex count at matching perimeter
fractions, so each bore vertex has a room vertex to travel to and the walkways flatten into the
floor over the ease. **The lining stops one sample SHORT of the hall** (`isBore` excludes any
segment with an end in the cavern) and the hall carries the bare bore section out to exactly that
sample (`margin`, found by walking the LINING's sample grid — `LINING_PITCH` in `boreProfile.ts`, ~5 m, not the route file's ~6 m — outward with `undergroundStationAt`). Ending the
lining one sample INTO the ease left its last ring free inside a room already wider than it — the
"gap between the station ends and the tunnel wall". The hall's throats (ease + margin) are a
separate loft on the same profile in the station's concrete, a shade darker than the room, with
their own strip lights riding the blended section: unlit, those 18 m were a black void round a
lit box and read as a gap too. The room proper keeps the station's finish over the platforms.

**Headlamps** (`Headlamps.tsx`, on every locomotive in `TrainRide` and `TrainLine`'s AI
`Locomotive`): two lenses, a marker lamp, an additive glare disc and ONE spotlight per loco, no
shadow, all driven per frame from refs — `dark` (`trainDarknessAt(arc)`, the same curve
`Environment` dims the world with, so the beam fades in exactly as daylight fades out) and
`speed` (sign decides which end leads: white and a beam on the leading end, red and nothing on the
trailing one; reverse and they swap). The lining's diffuse went from near-black to `#57534c` so the
pool actually shows on the concrete — the near-black was there to starve the sun, which the
darkness now does instead. `TrainRide` gained one ref and one child per loco (the other session's
file; a minimal edit).

**The hall is finished in the bore's language.** Vault and throats carry the lining's texture and
`LINING_MATERIAL`; the bay is lit by the bore's lamp strip (lens texture at `BORE_V_SCALE` on
absolute V, so the lamps run on from the tunnel at the same pitch and phase) on each step face,
with the same additive glow pools on the step face, the bay ceiling and the invert; the throat
strips use the lens texture too. Platforms, tiles, panels and tubes are what say "station"; the
structure says "tunnel", and from the bore the hall is the bore, widened. `makeLampTexture` and
`makeGlowTexture` moved to `boreProfile.ts` for this.

**Permanent way, signals, boards and the wire** (`Lineside.tsx`, `trainRegistry.ts`, and the
track in `TrainLine`):
- Sleepers are concrete monoblocs at 0.65 m: one merged, vertex-coloured geometry (tapered body,
  rail-seat pads, four rust clips) instanced for both tracks — `SLEEPER_GEOMETRY`. Rails are a
  flat-bottom section (head/web/foot, `railProfile`). A lidded concrete cable trough runs down the
  running line's right-hand cess wherever the line is open (`TROUGH_PROFILE`).
- **Signals are real.** Four-aspect heads every `BLOCK` (450 m) per track, in the cess, facing
  their trains (running line reads +arc, down line -arc), slid clear of portals and the hall.
  Every train reports itself each physics step to `trainRegistry` (`TrainRide` as `player`, each
  AI `Service` as `ai-<track>-<phase>`), and `Signals` reads block occupancy — the leading end and
  the rake behind it — to set red / single yellow / double yellow / green through per-instance
  colours on four lamp `InstancedMesh`es (`setColorAt`, refreshed at ~7 Hz). Follow an AI
  service and the aspects step back to green as it clears each block.
- Boards: permissible-speed boards where `trainSpeedLimitAt` changes (per direction, km/h
  rounded to 10, canvas text), kilometre posts every 500 m, TUNNEL boards 150 m before a portal.
- OHLE, Indian Railways fashion: an INDEPENDENT mast for each track in its own cess (running
  line right, down line left — a row of masts down both sides), every 54 m, foot on the deck over a
  viaduct. H-section mast (web + two flanges, `Scaled` with offsets), a swivelling cantilever per
  mast — bracket tube sloping from the mast top to the messenger, stay tube, registration tube out
  to the steady arm that sets the stagger — on stem insulators where the tubes leave the mast,
  and a number plate. Tubes are `Tubes`: instanced cylinders between two WORLD points
  (`worldAt(arc, off, rise)`), so they slope; `Scaled` is for axis-aligned boxes. Contact wire at
  4.95 m (pantograph raised 4.76) staggered ±0.22 mast to mast, messenger 6.35 sagging 0.5,
  droppers every 9 m; under ground a rigid conductor rail at 5.05 on drop rods. No portals/booms.
- **One sleeper everywhere**: `sleeper.ts` exports `SLEEPER_GEOMETRY` (concrete monobloc, pads,
  clips, vertex colours; origin at the underside, unit scale) and `TrainLine`, `IslandStation`
  and the other session's `Pointwork` all instance it — the station and crossover roads were
  brown boxes beside grey monoblocs. Any new track must use it too.

**The steel bridge between the islands** (`TrussBridge.tsx`): any open viaduct run whose samples
just beyond BOTH ends fall inside an island outline (point-in-polygon on `TRAIN_ISLANDS`, in
`sampleLine`) is flagged `Rail.truss`; the wide box deck, its `Pillars` and the OHLE masts skip
it. The structure is a **Pratt through-truss with inclined end posts**, built to the photograph:
each ~66 m span (`SPAN`) is 6 equal panels (`PANELS`) with the truss as tall as a panel, a
horizontal top chord over the interior nodes only, end posts sloping from the abutment to the
first top node, a vertical at every interior node, ONE diagonal per interior panel sloping down
towards mid-span (halves mirror), gusset plates at every node, a strut at every top node with an
X in every top panel, a latticed portal in each end post, floor beams at every bottom node with
stringers under each rail, a plate deck, a grated walkway with handrail on the right, bearings on
concrete piers and abutments, and the messenger wire hung from the top struts on drop rods.
**Every member is a straight bar between two exact node points** (`Bars`, with a depth so chords
read as built-up sections); only the deck plate, walkway and handrail are lofts. The crossing is
straight to 0.1° and level, so the planar truss fits it. The first version lofted the chords and
scattered braces without a node grid — it looked drawn, not engineered; that is why.

**The suspension bridge from the small island to the city** (`SuspensionBridge.tsx`): the open
viaduct run with one end inside the SMALLEST island (by outline area) and the other on no island
is flagged `Rail.suspension` (same post-pass as `truss` in `sampleLine`); the wide deck and
`Pillars` skip it. Three portal towers at the quarter points (two 2.4 m legs outside the deck
edges, portal beams over the deck, mid-height and top, saddles), two main cables in the deck-edge
planes (`EDGE` 4.5 m — outside the OHLE masts at 3.3, which stay) as parabolas of `SAG` 0.11 of the
span between saddles and `SIDE_SAG` down to anchor blocks 5 m beyond each end, hangers every 6 m
to the kerb — in PAIRS, with a cable band on the main cable and a clamp on the kerb at each — a
steel box girder with chamfered soffit, kerbs and open two-rail railings on posts (lamp posts every
fourth hanger), a stiffening lattice along each edge under the deck with a cross girder at every
hanger, towers with riveted panel bands, pedestals, X-bracing between the legs in the upper bays,
saddle housings and navigation lights, fendered footing plinths. **Anchorages are one block per
cable, OUTBOARD of the deck** (stepped, splay saddle on top): the first version was one block the
full deck width centred on the line and 2 m above deck — a concrete wall across the track at the
approach. Everything but the deck, kerbs and rails is `Bars`/`Boxes` from `TrussBridge`
(exported). Tower height 46 m; today it is the 1350–1818 m gannet-to-city crossing.

**The town round the island station** (`townConfig.ts`, `IslandTown.tsx`, `cityChunks.ts`): two
through streets with footways and kerbs, a back lane, three cross streets, a station forecourt, a
car park, a level crossing and eleven rows of the city's own buildings, with the city's trees,
street furniture and parked cars scattered between. **Kestrel grew from 1.45 to 1.9 in Z** to
carry it (226 m of island on the platform side, 196 on the bridge side); 1.9 and not more because
every metre of growth is a metre off the road bridge, which is down to 120 m.

- **One frame, plain local numbers.** The whole town is one group at the station's centre turned
  to `STATION_SITE.heading`, in which **local +Z is `along` and local +X is `across`** — verify it
  the way the docstring does rather than guessing, because it is `stationPoint`'s own definition
  and everything else in the file depends on it. +across is the platform side; −across is where
  the road bridge lands and the station's own block already stands.
- **Streets are merged slabs**, four draw calls for the network: carriageway, footway, kerb,
  markings. Junctions are overlapping carriageways (free, and right), but the FOOTWAYS are cut at
  every junction — `gapsFor` — because a pavement running through a road is what would give it
  away.
- **Buildings are city chunks**, one draw call each, picked by height and by triangles per square
  metre (2–5 storeys, dense enough that the triangles are windows not sheds). `cityChunks.ts` has
  the shared collect/place helpers; the geometry is in CITY coordinates so every placement is two
  nested groups, outer for the target and rotation, inner for the chunk's own recentring.
  Colliders are a box round each footprint, not a trimesh of 3–5k triangles of frontage.
- **The level crossing is worked**: `LevelCrossing` reads the same `trainRegistry` the signals do
  and drops the barriers when a train is within 320 m, with the red lamps flashing alternately.
  Two half barriers on opposite road edges, the diagonal pair a real crossing has. The boom lies
  along the road's width, which is the frame's local Z, so **it lifts about local X** — rotating
  about Z swings it sideways into the road, which is what the first version did.
- **Two traps, both hit:** the crossing link was one street and laid its tarmac and footways
  straight through the railway a metre under the rails, and its footway scatter planted a palm
  between the running rails. The link is two streets now with the railway's width missing from the
  middle, the crossing itself being a ramped deck at rail height with flangeways left open at each
  rail; and `RAIL_CORRIDOR` guards every scatter regardless.
- **Parked cars are the game's OWN vehicles, not a city chunk.** The first version parked
  `deco_special_vehicles_texture_-1_-1` twenty times; that chunk is not a car, it is an 8 m cluster
  of lorries, so the town filled with identical trucks. `ParkedCars` now composes them the way
  `Traffic` does — bodies and wheels keyed on `userData.vehicle`/`part`, hubs from
  `vehicleCatalogue.json`, a fixed shuffle over `TOWN_PARKED` so the mix is varied and stable. The
  model's origin is on the GROUND (a hub's y is the wheel radius), so a parked car needs no
  vertical offset; assuming a centre origin buries every car to the axles.
- **A crossing road must reach the streets it joins.** The link tee'd into nothing: both through
  streets stopped at along ±250 and the crossing is at −265, so its two stubs ended 15 m short in
  the grass and the whole thing read as misplaced. Both through streets now run to −282, which is
  as far as the land allows (the island still reaches 119 m on the shore side there against the
  street's 114). Check a junction's two ends against the span of what it meets, not just its own.
- **Detail that carries a town**: street lamps on both through streets (merged posts and arms, a
  separate emissive geometry for the heads), a lineside fence, and forecourt furniture — bus
  shelter, taxi rank, benches, bins.
- **Look for the fence that is already there before adding one.** `IslandStation` has had a
  `SeaFence` all along, 3.7 m outboard of road 3 (across 34.5). A second fence at 33 put two
  boundary fences 1.5 m apart, both within 2 m of a running rail — closer than a fence is ever
  built, and from any low angle it reads as a fence standing IN the track. There is no room on
  that side: four roads and two platforms fill it to 30.8 and the forecourt starts at 34. So the
  town's fence is `FENCE.runs` — two segments on the OPEN south side, 14 m off the line, west and
  east of the transplanted block, which is its own boundary for the 286 m it occupies. Platforms
  need no fence behind them and a terrace backing onto the railway needs none in front.
- **The level crossing is at the EAST end, and that is the whole point.** `stationPoint` projects
  `along` down the tangent at the station's midpoint — a straight line — and the railway is only
  straight from about −100 eastward. West of that it curves away: 14.8 m of drift at −200 and
  **32.6 m at −265**, where the crossing first was. A deck laid in frame coordinates there crossed
  open grass with the railway passing 33 m to one side, which is exactly what "the crossing is
  misplaced / not on the main line" looked like. At +255 the drift is zero, so the frame IS the
  alignment and the deck sits on the rails by construction. **Measure the drift before placing
  anything in this frame that has to touch the railway** — and if it must sit where the frame
  lies, build it on the arc instead, which is what `buildFence` does.
- **The crossing, as built**: concrete deck panels at rail level with the flangeway left open at
  each rail, asphalt approach ramps humping up over the ballast (panel grey on a ramp reads as a
  slab bridge), a yellow keep-clear box whose diagonals are CLIPPED to the box — drawn as a fixed
  fraction of its diagonal they ran out onto the grass — stop lines and rumble strips out on the
  level street beyond each ramp, ribbed anti-trespass aprons outside the outer rails, crossbucks
  on the standards (a Z-long bar rotated about X puts the cross in the plane facing the traffic;
  about Y or Z it lies flat or edge-on), bells, pedestrian wickets at the footway edges and a
  relay cabinet beside it.
- **No moving traffic on the island.** `Traffic` drives the nav raster, which is the city only, so
  the island's cars are parked. A car can drive there — the island crown is a collider and the road
  bridge lands on it — but the AI cannot.

**A discrete object cannot read a quantised field the way a loft can.** The down line's sleepers
came from `samples[round(arc / STEP)].gap` — the 5 m `Rail` grid — while its rails are LOFTED from
the same samples, and a loft interpolates between them. On the plain double track the gap is
constant so the two agreed; through the station's fan, where it opens from 4.6 m to 12.4 m over
130 m, the sleepers got a staircase — one value for eight sleepers, then a 30 cm jump sideways —
and stepped out from under the rails ramping smoothly above them. That was the zig-zag.

`downLineAt(arc)` is the continuous answer — `trainPointAt` offset by `secondTrackGap(arc)` — and
the sleepers are also **squared to the down line's own heading** now, from a central difference of
that, rather than to the running line's tangent: on the fan the two differ by up to 1 in 15, so a
sleeper yawed to the running line sat about four degrees skew to the rails resting on it. The rule
to carry forward: anything placed *per object* (sleepers, fittings, scatter) needs the smooth
function, not the sample grid; only lofts can live on the grid, because they interpolate.

**A body posed on one curve cannot be translated onto another.** The train drifted through the
turnouts — nose pointing along the main line while the vehicle slid crabwise down the loop — and
the cause was one line in `locomotivePose`. It took *both* bogie points off the running line,
derived the yaw from that chord, and only then shifted the finished body sideways by
`normal * lateral`. Rigid translation preserves heading, so on any road that diverges the body
kept the main line's heading no matter where it had been moved to.

The fix is to apply the offset **before** the yaw is measured, per bogie:

```ts
const bogie = (arc) => {                       // where the wheels actually are
  const [x, y, z] = trainPointAt(arc);
  const off = offsetAt(arc);                   // lateral is now a function of arc
  if (!off) return [x, y, z];
  const [nx, nz] = trainNormalAt(arc);
  return [x + nx * off, y, z + nz * off];
};
// centre = midpoint of the two bogies; yaw = atan2 of the chord BETWEEN THEM
```

Offsetting each bogie at its own arc gives the position *and* the heading of the road under the
wheels for free — the chord between two points on the loop is the loop's own direction. That is
also why `lateral` had to become `number | ((arc: number) => number)`: a scalar cannot answer
"how far out is the road at the front bogie", which is a different number from the rear one
anywhere the gap is opening. All six call sites (`TrainRide` ×3, `RailCamera` ×2, `TrainLine` ×1)
now pass `(a) => lateralAt(livePoints, a)`.

Measured crab removed, against the real geometry: **down line 6.66°, inner loop 8.73°, outer loop
14.68°**. The outer loop was the worst because it has the largest offset gradient, which is also
why it looked like drifting rather than a slight skew.

Same family of bug as the sleeper staircase above, and the same rule: **the offset is part of the
curve, not a post-transform.** Anything that needs a heading must take it from the curve it is
actually riding.

**Verified by riding it** (see §6): from the down line, `T` set to DIVERGE, the HUD walked
`DOWN LINE` → `CROSSOVER` → `LOOP 2`, and at 52–84 km/h through the switch and along the platform
the loco and every coach sit square on the loop — wheels on the rails, bodies parallel, heading
advancing a degree at a time. Note the loops connect to the **down** line, so from the up line a
crossover has to be taken first; the HUD's `POINTS <n> M` counts to the next switch, not the loop.

**A set of points is taken by the leading wheels, and which end those are depends on
direction.** `stepPoints` was fed the arc `TrainRide` integrates — the leading locomotive's
centre — no matter which way the train was going. Running forward that is nearly right; the
nose is half a locomotive further on. Propelling it is wrong by the whole length of the
train, and it broke reverse diversion three separate ways at once. Marched over the real
geometry with a 30 m rake, the same code path both ways:

| move | old (locomotive's arc) | fixed (`leadEnd`) |
|---|---|---|
| reverse into loop 2, east throat | switch worked 30 m late, coach jumps **1.59 m** | on the blades, **0.03 m** |
| reverse into loop 1, east throat | **wrong platform** — ends on loop 2 | loop 1, **0.018 m** |
| reverse, up line onto the west crossover | **stalls half way** — takes 356 only | 356 *and* 300, onto the down line, **0.025 m** |
| all three forward equivalents | 0.030 / 0.018 / 0.025 | identical |

The 0.02–0.03 m residue is the turnout ramp's own gradient over a 0.2 m step, so the fixed
column is continuous to the resolution of the test. The forward column is unchanged, which
is the point: this is not a new behaviour, it is the same behaviour finally applied to the
end that arrives first.

Why each failure follows from the one cause is worth keeping:

- **The snap.** `roadAt` gives *every* arc already past a turnout the new road the instant
  the move is recorded. Recording it when the locomotive crosses means the coaches, which
  propelling are 30 m ahead of it, have long since passed — so they all change road in one
  frame, which is a sideways teleport rather than a movement.
- **The wrong platform.** Loop 1's turnout is at 980 and loop 2's at 1000. Propelling from
  the east, the leading end reaches 980 first; the locomotive reaches 1000 first. Working
  the points from the locomotive therefore picks whichever turnout suits *the wrong end of
  the train*.
- **The stall.** A crossover's far end is `compulsory` — the road simply stops. Worked from
  the locomotive the exit was still 30 m ahead when the test ran out, so the train sat on a
  connecting track that does not exist beyond it.

`leadEnd(rake, way)` is the whole fix, and `Rake` is `{ arc, front, back }` because
`formationLength` measures from the leading locomotive's *centre* to the last vehicle's
tail — so the reach forward is the other half of that locomotive (9.7 m) and the reach back
is `formationLength` itself (30 m for a locomotive and one coach). The telemetry and the
speed guard read from the same end now: a countdown to the blades that was a train length
too long is what makes the key feel broken, because it ran out *after* the points had been
taken.

**Points cannot be moved in front of a train that is on them, but a stationary train is not
approaching.** `leverLocked` refuses `T` inside `POINTS.foul` (12 m, about the switch
rails) and shows `LOCKED` in the indicator rather than silently ignoring the press — a
lever that does nothing and says nothing is indistinguishable from a broken key, which was
half the original complaint. The `moving` argument is the other half of the real rule and
is not decoration: without it a driver who had stopped short of the points *intending to
reverse* would be locked out by the points ahead of the end they were about to leave, which
is exactly the shunt this change exists to permit. Verified: free at 30 m and 15 m from the
blades, locked at 5.1 / 2.1 / 0.1 m, free again once past and looking at the next turnout,
and never locked at a standstill.

**The route to a platform from the start point is a reverse shunt, and now works.** The
train starts at arc 402 on the up line, which is *inside* the station's throat — the west
crossover (300–356) is already behind it and the loops come off the down line only, so
there is no forward move that reaches a platform short of a full lap. The real move is the
one a signaller would give: `T` for DIVERGE, propel back over the west crossover (356 → 300)
which lands the train on the down line, then draw forward, still armed, into loop 2 at 396
or loop 1 at 416. Every one of those four turnouts is a facing point for the direction it is
taken in, which is why it needed the leading end to be right.

**The indicator had to say which *way*, because the view cannot.** `RailPoints` told the
driver a route was called but never where it went, and that gap is not a cosmetic one: two
roads that will be hundreds of metres apart are, at the blades, the *same offset* — that is
the whole basis of `Road.offset` — so the picture through the windscreen at the moment the
decision matters shows one railway, not two. The hand of the turn is therefore not
observable from the cab and has to be computed.

`PointsAhead.hand` is that, from `handOf`: the two roads' offsets a probe's length past the
blades (at them the spread is zero by construction), signed against the direction of travel.
`Road.offset` is metres *left of the running line* measured along increasing arc, so the sign
is a fact about the railway and not about the train — a train running the other way has the
line's left on its right, and getting that backwards would put the arrow on the wrong side
for every reverse move, which is the half of the pointwork hardest to check by eye. Verified
against an independent world-space cross product (`d_z*b_x - d_x*b_z > 0` for a side vector
`b` left of heading `d`) at every turnout near the station in both directions: **16 of 16
agree**, and the normal is left of increasing arc at every arc tested (cross = +1). The
result is legible as railway rather than as arithmetic — from the down line the platform
loops diverge **left** while the crossover back to the up line diverges **right**, and both
flip when propelling.

The panel is now three faint reference rows and one filled strip. The split is the design:
the rows are read at leisure (which road, how far, what the lever is set to) while the strip
answers the only question the driver has at the blades and has to survive being read in the
corner of the eye at speed. It is the one place in this HUD with a fill behind it, which is
what "read this one" is spelled as when everything else is unpanelled type; the fill is the
state's own colour at low alpha so it cannot disagree with its border about what state it is
in.

Four states rather than two, because two of them are not the lever's to decide:

| strip | when | colour |
|---|---|---|
| `▲ STRAIGHT ON → <this road>` | no route called, or nothing ahead | cyan |
| `◀ / ▶ DIVERGE LEFT/RIGHT → <road> · <limit>` | route called | amber |
| `◀ / ▶ ROUTE SET → …` | `leverLocked` — blades under the leading wheels | red |
| forced | the road ends there, so it is taken either way | warm |

Showing a compulsory turnout or a locked lever in the same amber as a called route would be
a lie about who is in charge. The limit turns red when the train is more than 2 km/h over it,
and a note line says why the lever is not behaving as expected — `POINTS UNDER THE TRAIN`,
`ROAD ENDS — POINTS TAKEN EITHER WAY`, `BRAKE FOR THE DIVERGING ROUTE`, `NO POINTS AHEAD` —
because every one of those is otherwise something the driver has to infer from the key
seeming not to work.

Confirmed on screen: `▲ STRAIGHT ON → DOWN LINE` and `◀ DIVERGE LEFT → LOOP 2 · 65 KM/H`
toggling cleanly on repeated presses at a stand, `▶ DIVERGE RIGHT → CROSSOVER · 108 KM/H`
with the limit red and `BRAKE FOR THE DIVERGING ROUTE` showing while over it. The locked
strip was verified at the logic level (`leverLocked` free at 30 m and 15 m, locked at 5.1 /
2.1 / 0.1 m, never locked at a standstill) rather than caught live — the 12 m window passes
in a fraction of a second and the pane only advances a frame per screenshot.

One trap for whoever tests this next: **do not read this panel by splitting `innerText` on
newlines and indexing.** Adding the strip and the note shifted every index, and two
confusing "the lever reverted on its own" readings during this work were that, not the game.
Find the elements (`span` whose text matches the lever words, with `POINTS` in its parent).

### The emergency brake, more services, and a loop on the right

**An emergency brake is not a harder press of `S`.** What makes it a control rather than a
stronger pedal is that it cannot be feathered and cannot be released until the train has
stopped, so both are modelled: `emergency` latches on the key and clears only at a stand with
the key up, and while it is applied no power can be asked for and no gentler rate chosen.
`EMERGENCY_BRAKE` is 9.0 m/s² against the service 4.2 — roughly the real ratio, and in this
game's numbers **386 m to stop from 300 km/h instead of 830 m**. It settles to zero the same
way coasting does, because at 9 m/s² it would otherwise overshoot into reverse and oscillate,
which is the one thing an emergency brake must never look like.

It hangs on `Space`, which is the car's handbrake and was dead on rail vehicles. But it is
**edge-triggered**, and that is not a detail: `handbrake` is a held value, so it is only seen
if it is still down when the physics step next runs, and a quick jab between two frames is
simply lost. That is acceptable for a handbrake and unacceptable for the control whose whole
purpose is being hit in a hurry — it is also exactly how the first version failed its first
test. `emergencyRequested` is set on keydown and consumed by the step, and the held value is
still read too, so both a tap and a hold work. `CarPhysics` and `TramRide` swallow the flag.

**More services: the old count was measuring the wrong thing.** `TRAIN.count` was 1, on the
grounds that the Class 91 is 276 k triangles. The cost that matters is not how many services
exist but how many are **on screen at once**, and three.js frustum-culls per mesh — a service
on the far side of a 9.2 km loop is a matrix update and nothing else. Spaced evenly, the
nearest is always about `TRAIN_LENGTH / count` away, so co-visibility barely moves as the
count rises; what rises is how often you meet one. Four puts a service every 2.3 km on each
road: three up (one stands down for the player) and four down. They keep station rather than
signal each other, all running the same speed profile, so an evenly spaced set stays evenly
spaced. The player is the exception and is **not** protected from them — worth knowing before
anyone reports running through one.

**A loop off the up line, on the right.** Everything in this station is built out to the left
because that is the side with 131 m of land; the right has 97 m and carried nothing, with the
running line's own ballast toe only 3.2 m out and the town beginning at -14. `UP_LOOP` puts a
road in that gap, and three decisions are worth keeping:

- **`-PAIR_GAP`, not a new number.** This is the same relationship the middle pair already
  have — two roads sharing one formation with no platform between them — so it reuses the
  spacing that note settled on. Its ballast toe lands at -9.2 m, **4.8 m clear** of the town
  fence and inside `RAIL_CORRIDOR`, so nothing in the town moves for it.
- **A relief loop, not a platform road.** A face would have to be numbered, and numbering one
  on the far side of the up line renumbers every sign in the station: the up line already has
  a face on platform A, and a track cannot be platform 1 twice. A relief loop needs no face —
  it is where a slow service stands to be overtaken, which is what a station with four
  platform roads and two through lines is short of.
- **It closes on zero, not on the running gap.** Every other road here ramps to
  `TRAIN.elevated.trackGap` because it is joining the down line. This one joins the up line,
  which *is* the origin of the coordinate, and that single difference is the whole of what
  makes it an up-line loop.

Its lead is `loopLead.relief`, 150 rather than the inner loops' 175, and that is a layout
decision rather than a clearance one: at 175 its turnouts landed on 416 and 980, exactly
where loop 1's are on the down line — four sets of blades on one transverse line. Nothing
broke, but a throat reads as a sequence of decisions and a real one staggers its points. The
west throat is now **396 / 416 / 441** and the east **955 / 980 / 1000**.

Two consequences elsewhere. The station's formation was symmetric about the running line
because nothing lay to its right; `Yard` now carries `inner` from `stationInner` and
`FORMATION_PROFILE` samples both edges. And `IslandStation` now lists what it lays in one
place, `BUILT_ROADS` — an offset function and a drawn extent per road — because the rails,
the sleepers and the instance ceiling all want the same answer to "which roads are there";
`sampleRoad` takes that function rather than a road offset, which is what let a road whose
offsets are negative join the same machinery.

**Verified.** The relief loop exists as road #4 with turnouts at 441/955 on the up line; its
offset holds -6 through the platforms and ramps monotonically to 0 by 257 m, never crossing
the up line; `pointsAhead` offers it from the up line in **both** directions with the hand
right and flipping (RIGHT running forward, LEFT propelling); the formation reaches
-9.23 m against a -14 fence; the throat staggers as above; a clean load logs zero console
errors. The emergency brake was confirmed in the running game — applied at 30 km/h with the
throttle still held, it overrode power, stopped the train, released itself at the stand and
let it pull away again, with the red `EMERGENCY BRAKE / HELD UNTIL STOPPED` telltale showing
throughout. **Not** screenshot-verified: the relief loop's rails in the world, and the count
of services on screen. The pane renders roughly a frame per screenshot, so covering the
550 m from the reset point to the station costs thousands of frames; both changes ride on
code paths (`BUILT_ROADS`, the `Service` array) that already render their existing members.

### Missing sleepers, and a crossing that paved over the loops

Two faults, both of the same shape: something that had to know **how many roads
there are** had been told, once, that there were two.

**The sleepers were on a shared budget that had always been too small.** The
instance ceiling was `(halfPlatform + approach + site.taper) * 2` per road,
multiplied by the number of roads. But a road's real extent is `roadDrawn`,
built on `roadTaper`, which takes the *longer* of `site.taper` and what the
ballast allows and then aims at `STATION.loopLead` — 175 m, 225 m, 150 m —
rather than at `site.taper`, which is 130 m. Every road therefore overran its
allowance, and because the walk filled them in list order with one shared
counter, the shortfall always landed on whichever road came **last**. Measured:

| road | arc length | sleepers needed |
| --- | --- | --- |
| platform loop 1 | 529.5 m | 815 |
| platform loop 2 | 573.7 m | 883 |
| relief loop | 473.4 m | 729 |
| **total** | | **2427** |

against a ceiling of `730 * 3 + 4` = **2194**. Short by 233, so the relief loop
— added last — lost 233 sleepers, its outer 151 m. And before the relief loop
existed the ceiling was `730 * 2 + 4` = 1464 against 1698 needed, so platform
loop 2 was losing *its* far end in exactly the same way, which is the down-line
half of the report and had been true for as long as the loops have.

Fixed by computing the placements in full and taking the instance count from
`placements.length`. An exact count cannot starve, and cannot silently mis-size
when the next road is added.

The same walk had a second fault worth keeping separate, because it shows up as
"missing at some points" rather than "missing at the end". It found each
sleeper's segment by proportion — `at / length` scaled to the sample count —
which assumes the samples are evenly spaced in **arc**. They are evenly spaced
in **`along`**, and a road on a taper covers more arc per step than one on the
straight, so through the throat the wrong segment was picked and `t` came out
outside `[0, 1]`: sleepers interpolated past the end of their own segment,
bunching in places and leaving gaps in others. It now advances a cursor and
finds the segment, and clamps `t`.

**The level crossing hardcoded two tracks.** `buildCrossing` built its deck
from a literal five-panel list — apron, four-foot, six-foot, four-foot, apron —
around centres `0` and `TRAIN.elevated.trackGap`. Its last panel therefore ran
as one unbroken slab from 5.43 out to the deck's north edge at 14, with its top
face at exactly `railTop`. Measured at the crossing's own `along` of 255 the
tracks are:

```
[-0.01, 4.60, 6.20, 10.15]     up line (relief loop merged into it), down line,
                                platform loop 1, platform loop 2
```

so both loops sat inside that slab, coplanar with their own rail heads, and the
crossing buried them. It now builds the panel list from `stationTracks(along)` —
nine panels with a flangeway cut at each of the eight rails.

`stationTracks` is the general answer, and worth reaching for rather than
counting roads again: the up line, the down line at `secondTrackGap`, each
platform loop where its lead reaches, and the relief loop where its lead
reaches, sorted across the formation. Two roads closer than a gauge apart are
**one** track — past the blades a loop *is* the line it joined, which is the
whole basis of `roadOffset` — so a merged road is filtered out instead of being
given a second flangeway a few centimetres from the first. It reports five
tracks at along 200, four at 255, three at 270 and two at 290, which is the
throat closing up exactly as `roadOffset` draws it.

One consequence to know about: at along 255 platform loop 1 is only 1.6 m from
the down line, so the six-foot between them computes to a *negative* width
(5.43 to 5.37). A slab of negative width is a slab wound inside out, so panels
narrower than 20 mm are dropped and the two flangeways merge into one slot —
which is what that separation actually looks like. The crossing is sited inside
the station throat, so it will always have converging roads under it.

**Verified by measurement**, not by eye: the counts and extents above, the track
list at six positions through the throat, nine panels with one degenerate one
dropped, the northmost rail at 10.87 inside a deck edge at 14, and a clean load
with zero console errors. **Not** seen in the world — the browser pane would not
advance the train (trip stayed at 0 m under held throttle) and the crossing is
950 m from the spawn, so no screenshot of either fix. Both are geometry whose
inputs and outputs were measured directly, but that is an argument and not a
photograph; worth a look next time the game is run for real.

### The level crossing: longer, smoother, and solid

**There was no collider.** The deck and its ramps were meshes and nothing else,
so a car drove *through* the metre-high hump at crown level and out the other
side. The town's own note explains how it got missed and is worth keeping in
mind for anything else added here: *"the streets are 6 cm slabs on an island
crown that is already a collider, so a car drives on them anyway"* — true of a
6 cm slab, and false the moment something rises a metre above the crown.

`crossingSolid` is the fix: the whole crossing as one closed prism, its
cross-section a convex hexagon — ground, up the near kerb, up the slope, across
the deck, down the far slope, down the far kerb — extruded the width of the
road. 12 vertices, 20 triangles, under a `type="fixed"` `TrimeshCollider` with
road friction. A prism rather than a stack of cuboids because the ramp has to be
*smooth*: a staircase of boxes gives the wheels forty small steps and the car
shakes its way over.

**The ramps were a staircase, and now they drive.** Nine steps over what is now
16 m is an 11 cm riser — that is a flight of stairs, and it is what the collider
would have been had it been built from the visual. There are forty slices now,
under 3 cm each, and both the slices and the solid come from one shared
`crossingHeight(across, deck)` so what is drawn and what is driven cannot drift
apart. The measured profile: flat at 0.06 to the ramp foot, linear to 1.187 at
the deck edge, flat across, and down again — **1 in 14.2**, a road gradient.

One real bug fell out of sharing that function. The visual ramp climbed to
`top - 0.14`, the deck panels' *underside*, so there was a 14 cm step at the
deck edge — invisible enough to survive review, and exactly the sort of thing a
car rides over as a thud once there is a collider. The road surface is
continuous across a crossing; both now go to `top`.

**Longer, and derived rather than written down.** `CROSSING_DECK_S/N` were -9
and 14, chosen when the crossing spanned two tracks. It spans four (see
`stationTracks`), and a hardcoded edge cannot know that. They now reach a 6 m
apron clear of the outermost rail on each side, with the old literals kept as a
**floor** so the crossing can only ever grow:

| | before | after |
| --- | --- | --- |
| deck | -9 … 14 (23 m) | -9 … 16.87 (**25.9 m**) |
| ramps | 14 m | **16 m** |
| overall | 51 m | **57.9 m** |
| clear of the outer rail | 3.1 m | **6.0 m** |

**What this does not fix, and cannot.** The crossing sits at along 255, which is
inside the station throat, so the roads under it are *converging*: platform
loop 1 is 1.6 m from the down line there, closer than a track's own gauge. No
deck length makes those two read as separate railways, because at that point
they very nearly are not. Covering them is now correct — a flangeway each, an
apron beyond — but if the four roads are wanted *visually distinct* the crossing
has to move to where they are apart, and every along in the zero-drift window
has the same problem somewhere: five well-spread tracks at 200, four at 255,
three at 270, two at 290. Moving it means re-siting `crossing-link-s/n` and
re-checking the town's clearances, which is a job rather than a constant.

**Verified by measurement:** the table above, the barrier standards landing at
-27 and 34.87, the solid's 12 vertices and 20 triangles spanning y 0 to 1.187
(exactly `railTop`, so its top face is the panels' top face), the height profile
monotone up then down, and a clean load. **Not** driven over: the player's car
spawns in the city, the island is a bridge and several kilometres away, and
there is no moving traffic on the island to watch. The collider is verified as
present, correctly shaped and at the right height; whether a car *feels* right
crossing it is the one thing that wants a human at the wheel.

### The crossing follows the track

**The panels were straight and the railway was not.** Every deck panel was an
axis-aligned box spanning the whole road, with its flangeways cut at the track
offsets taken at **one** `along` — the crossing's midpoint. The tracks do not
hold still over the width of a road. The crossing is 22 m wide (along 244 to
266), and measured across it:

| | along 244 | along 255 | along 266 |
| --- | --- | --- | --- |
| tracks | 4 | 4 | **3** |
| up line | -0.25 | -0.01 | 0 |
| down line | 4.60 | 4.60 | 4.60 |
| platform loop 1 | 7.16 | 6.20 | *merged* |
| platform loop 2 | **11.79** | 10.15 | **8.51** |

Loop 2 moves **3.3 m** across the road. Its flangeway was cut once, at 10.15, so
at each end of the deck the slot was **1.6 m from its own rails** — the panel
ran over the rail on one side and left bare ballast on the other. That is the
whole of "not following the track".

Three things had to change.

- **A band between two diverging rails is a trapezoid**, so `deckPanel` builds
  one: a box whose two ends carry their own across extents, vertices lerped
  between them. The offsets vary linearly over a strip this short, so one
  trapezoid is exact rather than an approximation.
- **The number of tracks changes across the road.** Loop 1 is a road of its own
  at the near edge and has merged into the down line by the far one, so the set
  of flangeways is not the same at both ends and there is no pairing to do. The
  deck is cut into `DECK_STRIPS` of a metre; the one strip that straddles a
  merge is laid straight from its own midpoint, and the rest taper.
- **The UVs were the other half of "not seamless."** Every panel stretched the
  whole texture over its own width, so a 3 m band and a 0.3 m one showed the
  same two joints at wildly different scales and no joint lined up with its
  neighbour's. `deckPanel` maps UVs from position instead, so separate panels
  tile as one continuous surface (`DECK_TILE`).

Verified: at along 244 the built panel edges are
`-1.08 -0.86 | 0.36 0.58 | 3.77 3.99 | 5.21 5.43 | 6.33 6.56 | 7.77 7.99 | 10.96 11.18 | 12.40 12.62`
— eight flangeways, each straddling a rail at `centre ± gauge/2` for all four
tracks — and at along 266 six flangeways for the three tracks that are left,
loop 2's now at 7.68–7.90 and 9.11–9.33 against rails at 7.79 and 9.23. The
frame drift over the crossing is 3 cm, so the flat frame is exact here and no
`stationRailPoint` sweep is needed; that would change if the crossing ever moved
west of along -100.

**The barriers were standing in the wrong place, and it looked like a second
crossing.** `barrierAcross` was `[RAMP_S - 2, RAMP_N + 2]`, which put the two
standards 18 m clear of the deck and 27 m from the nearest rail — booms out in
the town with an empty ramp between them and the railway. They are now
`[DECK_S - 2.5, DECK_N + 2.5]`: at the edge of the surface they protect, which
is where a driver stops and where the boom actually blocks the road.

The stop line followed them in, and that needed one more thing: on the ramp
`MARK_TOP` is a metre underground, so it takes its height from `crossingHeight`
like the rest of the hump, and is the real 0.4 m wide — narrow enough that the
1-in-14 fall across it stays inside the paint. The rumble strips stay out on the
level approach, because that is what they are.

### Portals over the station, and the footbridge put back straight

**The loops had no wire at all.** `Lineside` wires the two roads the running
line carries — `[0, 1]`, offsets `0` and `s.gap` — and knows nothing about the
station's own roads, so a train could be routed into a platform or the relief
loop and run under bare sky. The masts it *does* build are single-track: one
column in the cess beside each road, which through a four-road throat means a
forest of them, several planted between rails that are converging on each other.

`StationCatenary` answers both the way a real wired station does — **portals**.
Two masts outside the whole formation, a lattice beam between them, and a
registration dropping to each track's contact wire. Measured, the beam spans
**-9.3 to 34.1 across five tracks** through the platforms and narrows to two at
the throat ends, on twelve portals at the plain line's own 54 m pitch. Contact
and messenger wire with droppers now run over all three station roads (both
platform loops and the relief loop): steel 12,144 vertices, wire 16,896,
droppers 4,224.

Three things had to be true for it to join up rather than sit beside the
existing line.

- **One set of dimensions.** The heights were module-private constants in
  `Lineside`; they are now `CATENARY` in `trainConfig` and both files read it. A
  contact wire that meets the line's at a different height is a wire that steps
  in mid-air where the loop joins.
- **The line's masts stand down inside the yard.** `LinesideSample` gained
  `yard` and the mast loop skips it, so the portals replace the single-track
  masts instead of growing through them. The **wires** still run through —
  standing the wire down at the station would be worse than the forest.
- **Portals keep clear of the footbridge.** The bays are in phase with the plain
  line, and that put a portal at along **-77** with the footbridge at **-78**:
  the lattice beam inside the bridge's 3.2 m span, its top chord at rail head
  +7.90 against the parapet at +7.89. Found by listing the portal positions
  against `FIT.bridgeAlong` rather than by looking. Real overhead line does not
  build a portal where a bridge crosses; the bay is lengthened and the structure
  stands clear, which is what it does now.

**The footbridge was my own regression, from adding the relief loop.** The legs
were a list of bare numbers and the stairs indexed `legs[1]` and `legs[3]`.
Inserting a leg for the relief loop shifted every index under it, so:

- the two flights landed over the **cess** at platform height instead of on the
  platforms — floating above the ballast;
- `onPlatform = i === 1 || i === 3` then marked the two cess legs as standing on
  a platform, so those hung in the air while the real platform legs started at
  ground level and speared up through the paving.

Each leg now carries what it stands on and whether a flight comes down it, and
the flights are derived by `legs.filter((l) => l.stair)`. Positional coupling
between two lists is the bug; naming makes it impossible rather than merely
fixed.

Two alignment faults came out with it, one of them pre-existing. The town-side
flight sat at `legs[0] - 1.6`, which is **outboard of the deck's own end** — its
head hung off the bridge. And the deck only reached 1.4 m past the outermost
ballast toe, which is not enough to hang a 2.8 m stair from and still land clear
of the relief loop's ballast. The deck now reaches `toe - 4.2` and the flight
comes down at `townSide + 2.4`, inboard of the end and clear of the formation.

One trap for next time: after this change the console showed
`CATENARY is not defined` on a clean load while the geometry that uses
`CATENARY` had demonstrably built (12,144 vertices of it). That was a **stale
Turbopack chunk**, not a cycle — `trainConfig` imports nothing but JSON, so it
cannot be an initialisation-order fault. `rm -rf .next` and a server restart
cleared it. The existing note about stale chunks is worth trusting: check
whether the dependent geometry exists before believing the error.

### Swapping the Class 91 for a Grand Central HST

New sources in `source-models/`: `train_-_grand_central_class_43.glb` and
`mark_3_carriage_std_open_grand_central_livery.glb`. They are a **matched set** —
a Class 43 power car at each end of a rake of Mark 3s in the same livery is an
HST — which is why they go in together rather than one at a time. The formation
`formationFor` builds was already top-and-tail, so this is the first time the
models and the formation agree: the Class 91 ran with a driving trailer at the
far end, and top-and-tail was an approximation of it.

**The Class 43 export faces the wrong way, and the script now turns it.** Step 2
of `prepare-train.mjs` reads which end the cab is off the roof line — a power
car is a raked wedge at the cab and a flat slab at the other end — and it used
to *throw* if that end was not at -Z, on the grounds that a bad export should be
fixed at source. This one measures 2.79 at +Z against 4.22 at -Z, so the nose is
at +Z, and turning a 27 MB export by hand to satisfy a script is the wrong way
round. `HALF_TURN` bakes it into the one node the script already writes.

The trap in that is the translation, and it is worth writing down: a glTF node
applies T, then R, then S, so with a rotation in, `T` is read in the **rotated**
frame. Leaving it alone turns the model about the origin and swings it a body
length off the rails. A half turn about Y maps `(x, y, z)` to `(-x, y, -z)`, so
the fix is a sign flip on X and Z with Y left alone — which is also why the
measured size needs no adjustment. Verified in the game: the `NOSE` camera looks
forward down the line and the body sits square on the rails.

**A wrong scale shows up in the dimension it was not fitted to.** `REAL_LENGTH`
was still the Class 91's 19.4 m, and against this export that gave a body
**15.6% wider** than a real power car and 4.37 m tall. At the Class 43's own
17.79 m the same measurement comes out 5.9% over on width and **4.01 m** tall
against a real 3.90. Two independent dimensions agreeing is the check; one of
them being close is not. Bogie centres measured 10.09 m against a real 10.34.

**The Mark 3 needed the opposite of a rescue.** The carriage script scales by the
*locomotive's width* rather than the coach's length, and the note explaining why
was about the APT upload being 26% too fat for its length (ratio 0.154 against a
real coach's 0.122). The Mark 3 is 0.124 — it is simply correct — so the two
rulers now agree and the width ruler is kept for the flush coupling rather than
to paper over anything. It comes out 23.36 m against a real 23.00. One figure is
still a fallback rather than a measurement: the wheels arrive as a single
cluster, so bogie centres are the real 16.00 m. For a Mark 3 that IS 16.00 m, so
the answer is right either way — but it is the line to check if the coach
changes again.

**What the swap changed downstream.**

| | before | after |
| --- | --- | --- |
| power car | Class 91, 19.4 m, 276 k tris | Class 43, 17.79 m, **192 k** |
| coach | APT trailer, 18.7 m | Mark 3, **23.36 m**, 135 k |
| default rake | 157 m | **158 m** at five coaches |

The coach growing 25% is the substantive change, and it broke the platform fit:
six Mark 3s make a 182 m rake against a 170 m platform, six metres hanging off
each end. `DEFAULT_CARRIAGES` is five now, which comes to 158 m and fits — and
is how Grand Central actually formed these sets, two power cars and five Mark
3s. The slider still runs higher for anyone who wants the overhang.

Everything else adapts on its own, which is the payoff for measuring rather than
writing numbers down: the formation offsets, the `Rake` reach the pointwork
works from, the camera rig, the bogie posing. What did **not** adapt and had to
be edited by hand is every place the vehicle is *named or described* — the
garage label, year, mass, wheelbase, wheel radius and top-speed note, the
collider height (a Class 43 has no pantograph to stand proud of the roof, so
`bodyHeight` is the real 3.9 m), the cab-eye note, the bore-clearance note and
the catenary's height comment. Those are the cost of a livery swap, and they are
worth grepping for: `Class 91`, `APT`, `pantograph`.

### Keeping both trains

The HST went in as a *replacement*, which was wrong — the Class 91 was a
working vehicle and a railway can own two classes. Both are now selectable, and
the shape of that is worth recording because it is not "load both".

**Two sets built, one loaded.** `RAIL_SETS` in `trainConfig` holds the pair, and
`LOCOMOTIVE`/`CARRIAGE` resolve to whichever the `?car=` names — so `TrainRide`,
`formationFor`, the AI services and the rail cameras read the same two constants
they always did and know nothing about the choice. Verified by what the browser
actually fetches: `?car=train` pulls `train.glb` + `carriage.glb` and
`?car=train91` pulls `train91.glb` + `carriage91.glb`, with the other pair never
requested. That matters — the unused set is 370 k triangles and 2 MB of GLB.

The selection is read from the URL in `trainConfig` rather than passed down from
`garage`, because `garage` imports `trainConfig` and the dependency only goes
one way. The price is that the ids in `RAIL_SETS` have to match the garage's
rail vehicle ids with nothing enforcing it, so `garage` builds its two entries
**from that same table**: a mismatch shows up as a missing vehicle rather than
as the wrong train.

**The prepare scripts take the stock as an argument.** Each has a `STOCK` table
carrying source, destination, data file and the real dimensions, chosen by
`npm run prepare:train -- <id>` (`prepare:train91` and `prepare:carriage91` are
the shorthands). The real dimensions live *beside the source* rather than as
module constants, because editing a ruler to build a different vehicle is
exactly how a Class 43 got scaled to a Class 91's length earlier in this work.
The carriage table also names *its own* locomotive's data file, since it scales
by that locomotive's width — pairing a Mark 3 with a Class 91's width would be
the same class of mistake.

**One bug the split exposed.** Both scripts wrote `model: '/models/train.glb'`
as a literal, so the Class 91's data file pointed at the HST's model — a swap
that type-checks, renders, and is simply the wrong train. The path is derived
from `DST` now.

**And one garage duplication avoided.** `TRAIN_VEHICLE` was sixty lines written
longhand; a second copy would have left ten numbers to keep in step across two
blocks, which ends with a Class 91 quoting a Class 43's mass. `railVehicle(id)`
takes the measurements from the set and the character — year, mass, wheelbase,
wheel radius, blurb — from `RAIL_CHARACTER`, and everything else is shared
because it describes the *line* rather than the vehicle. The pivots and radii
are derived from the wheelbase and wheel size rather than written out, so the
two cannot disagree about where a bogie is.

| | Class 43 (`car=train`) | Class 91 (`car=train91`) |
| --- | --- | --- |
| set | 2 power cars + Mark 3s | Class 91 + APT trailers |
| power car | 17.79 m, 192 k tris | 19.40 m, 276 k tris |
| coach | 23.36 m, 135 k | 18.66 m, 96 k |
| mass, wheelbase | 70,250 kg, 2.6 m | 81,500 kg, 3.35 m |
| `bodyHeight` | 3.9 (aerials measured) | 3.8 (pantograph measured) |

The AI services follow the player's choice, because `SERVICE_FORMATION` is built
from the same `LOCOMOTIVE`/`CARRIAGE`. One railway, one fleet — and it avoids
loading both sets to put a different class on the down line. Running the *other*
class as the AI service would be a nice touch and is the obvious next move if
the triangle budget ever allows it.

**Third time for the stale-chunk trap**, and it is now worth treating as the
default hypothesis: `RAIL_SETS_ALL is not defined` appeared with a **500 from
the server pass** while the page rendered the right train from the right files.
`trainConfig` imports nothing but JSON, and nothing `garage` depends on imports
`garage`, so a temporal dead zone is impossible — `rm -rf .next` and a restart
cleared it, exactly as it did for `CATENARY`. Check whether the dependent thing
demonstrably works before believing the ReferenceError.

### Both classes on the line, and two thumbnails that differ

**The services now alternate classes.** `Service` took its models, formation and
length from the module-level `LOCOMOTIVE`/`CARRIAGE`, which resolve to whatever
the player picked — so the line was a procession of the player's own choice.
It takes a `stock` prop now, `SERVICE_STOCK(i)` walks `RAIL_SET_IDS`, and both
sets are preloaded. Verified from the registry, whose ids carry the stock:

```
ai-train91-1-828   ai-train-1-2483   ai-train91-1-4139   ai-train-1-5794
```

Two of each, alternating down the loop, plus the player — and the up line still
carries no service at all, which is the earlier rule about not putting a
same-direction train on the driver's own road.

The cost is real and was the reason the first design loaded one set: both are
now resident, which is 370 k triangles and 2 MB of GLB a single-class line did
not pay for. What it buys is a railway with two classes on it.

**A bug this turned up, and it was mine.** `formation()` read `trainData` and
`carriageData` *directly* — the HST's files — while the models came from the
selected set. So driving the Class 91 got Class 91 bodies at HST spacing: a
19.4 m power car placed as though it were 17.79, and 18.66 m coaches on
23.365 m centres, which is **4.7 m of daylight between every pair of coaches**.
It type-checked and it rendered. The offsets and the models have to come from
one place, so `formation(count, tailEngine, setId)` takes the set and the cache
key includes it; `formationFor`, `formationLength` and `serviceFormationFor` all
default to the selected set and accept an override, which is what lets one
`Service` be a Class 91 while its neighbour is a Class 43.

That also forced the stock table to move **above** the formation builder:
`FORMATION` is built at module-init time, so a table declared below it would be
in its temporal dead zone. Worth remembering — this file initialises a lot at
module scope.

**The garage showed the same locomotive twice**, and the mechanism to fix it was
already there. Thumbnails are rendered from each vehicle's own model and cached
in `localStorage` under `motorpool.thumb.<version>.<id>`. The key is the vehicle
**id**, not the file — so when `train.glb` stopped being a Class 91 and became a
Class 43, the `train` entry went on serving a picture of a locomotive that is no
longer in it, while the brand-new `train91` entry rendered the Class 91 fresh.
Two names, one photograph. `CACHE_VERSION` exists for exactly this (v5 and v6
were both tram model swaps); v7 throws the lot away. Verified: fourteen
thumbnails re-rendered and the two rail entries now hash differently.

The general lesson is the one the constant's own note makes, now with a second
instance: **an id surviving a model swap is a cache that lies.** Anything keyed
by vehicle id and holding a picture, a measurement or a size has to be
invalidated when the file behind the id changes.

### Performance: measuring it, and the first big win

**How to measure this at all**, because two of my attempts were worthless and it
is worth writing down why. Frame timing in the browser pane is meaningless — the
pane throttles rAF, and a p50 of 17 ms sat next to a p95 of **6,025 ms**. And
comparing whole-frame counters across reloads is meaningless too: the AI
services are moving, so each reload measures a different world. My first A/B
"showed" that bigger chunks cost more draw calls, which is nonsense.

What works is a **deterministic single-frame shot**: park the camera at a fixed
pose, `gl.info.autoReset = false`, `reset()`, `gl.render()` by hand, read the
counters that render produced. Three consecutive reads then agree exactly. And
to isolate one thing's cost, toggle its `visible` **within a single page load**
and diff — same camera, same AI positions, clean delta.

**Where the frames were going**, at the spawn:

| | |
| --- | --- |
| draw calls | ~1,500 |
| triangles drawn per frame | ~5.9 M |
| triangles in the scene | 12.3 M |
| meshes | 6,700 |
| meshes with `castShadow` | 5,011, totalling 9.8 M triangles |
| shadow pass | 413 calls, 1.05 M triangles |

**The single biggest item was the sleepers, and the reason is worth knowing: an
`InstancedMesh` is culled as ONE object.** Three culls it against its bounding
sphere, and the sphere of a field following a 9.2 km loop encloses the whole
world — so all 23,747 sleepers were submitted every frame regardless of where
the camera looked. At 96 triangles each that is **2.28 M triangles, roughly half
of everything the camera pass drew**, to show a few hundred metres of track.

`InstancedField` cuts a field into chunks of `FIELD_CHUNK` (128) instances, each
with its own bounding sphere. Measured by the visibility diff at the spawn: **163
chunks exist, 25 are drawn, 584 k triangles instead of 2,279,712 — a 74% cut for
+24 draw calls.** That is the trade in a sentence: draw calls are cheap in the
hundreds, vertices are not cheap in the millions. Nothing else changes; the
sleepers all still exist and the shared `SLEEPER_MATERIAL` means the renderer
still sees one program however many chunks survive.

Chunk size was swept. 512 culled too coarsely (~1.1 M left); 128 leaves 584 k;
finer would trade more calls for less. It is one constant with the reasoning on
it.

**No other instanced field is worth the same treatment**, which is worth
recording so nobody looks twice: the sleepers were 2.28 M of the 2.9 M total
across all 339 instanced fields. The next largest is 151 k of vegetation at a
315 m radius, then 90 k of lineside fittings. All small.

**What is left, in the order it is worth doing.** The remaining ~3.9 M
triangles per frame are not instanced, so chunking does not apply:

1. **The rail stock, ~2.5 M.** Five trains of six vehicles, and the per-vehicle
   detail is extravagant: the wheels alone are **35 k triangles per vehicle**
   across three primitives, and a coach carries `Seats` at 11,928 and
   `Button_Silver` at 28,380. `TRIANGLE_BUDGET` asks for 70 k and the simplifier
   stops at 192 k because some primitives refuse to decimate — that note is in
   `prepare-train.mjs` and is the thread to pull. Dropping coach interiors
   outright, or an LOD for anything past ~150 m, is the biggest remaining win.
2. **The shadow pass, 413 calls and 1.05 M triangles.** 5,011 meshes cast, and
   the rail vehicles dominate — a coach's *interior* casting into the shadow map
   is pure waste, since it is inside a box. Restricting `castShadow` on the
   vehicle traverse to the body shell would take most of it.
3. **Device pixel ratio, capped at 1.75.** It changes no geometry — it is fill
   cost — so it does not show in these counters at all, but 1.75 is 3.06x the
   pixels of 1.0. Dropping the cap to 1.5 is 27% fewer pixels for very little
   visible difference, and it belongs in `SettingsPanel` as a choice rather than
   as my decision.

### The shadow pass: one box per vehicle instead of a hundred meshes

Measured first, within a single page load so the moving services could not
confound it — toggle `castShadow` on the rail meshes, shoot, toggle back:

| | draw calls | triangles |
| --- | --- | --- |
| whole shadow pass | 504 | 1,382,909 |
| of which the rail stock | **353 (70%)** | 584,530 (42%) |

353 calls is **19% of every draw call in the frame**, spent on shadows nobody
can resolve. The cause is that a vehicle is not one mesh: the trains are 3,080
meshes between them, about a hundred per vehicle split by material, and each is
its own submission to the shadow map — the seats, the door furniture, the
`Button_Silver` at 28 k triangles. The interior ones cannot contribute a visible
shadow at all, being inside a box.

So the vehicles stop casting and **one box per vehicle casts for them**
(`ShadowProxy`). A train is very nearly a box, and at shadow-map resolution the
difference between its silhouette and its bounding box is not findable.

| | before | after |
| --- | --- | --- |
| shadow pass calls | 504 | **155 (-69%)** |
| shadow pass triangles | 1,382,909 | **798,427 (-42%)** |

Better than the 353 predicted, because the light follows the player: only a
handful of the 36 proxies are inside its frustum at any time, so the proxies
give back about four calls of the 353 saved.

**Two dead ends worth recording, because both look right and neither works.**
The obvious way to have a caster the camera cannot see is to put it on its own
layer and enable that layer on the light. Three's shadow pass tests
`object.layers.test( camera.layers )` against the **scene camera**, not the
light (`three.module.js`, `renderObject`) — so a proxy the camera cannot see
casts nothing. `material.visible = false` fails for the same reason: the shadow
pass checks that too, a few lines further down. What does work is
`colorWrite: false`, which draws the proxy in the colour pass — one call, no
pixels, no depth — and lets it cast normally. One no-op call per vehicle against
a hundred real ones.

**Verified geometrically** rather than by hunting for a shadow on screen: across
all 36 proxies, every one casting, a coach's proxy is 18.77 m against the
model's 18.76 and its vertical range is [4.20, 7.68] against the model's
identical [4.20, 7.68]. The locomotive's proxy stops at 8.00 where the model
reaches 8.95 — the difference is the raised pantograph, which is what
`bodyHeight` exists to exclude and what a shadow box must not include or the
train reads as carrying a container. Width comes out ~0.1 m over because the
world AABB of a yawed box is bigger than the model's; invisible in a shadow.

**Where the frame stands now**, against the ~1,500 calls / 5.9 M triangles this
started at: the two changes together (sleeper chunking and this) take a spawn
frame to about **1,200 calls and 3.7 M triangles**. The remaining big item is
unchanged and still the biggest: the rail stock's own 192 k and 135 k per
vehicle in the colour pass, where `TRIANGLE_BUDGET` asks for 70 k and the
simplifier stops early. That is the next thing to pull, and the note on it in
`prepare-train.mjs` is the thread.

### The line ahead: a transient strip in the top centre

The top centre was the only large free region on the HUD — top-left is the
identity banner, top-right a 40 px pause hexagon, bottom-left the map,
bottom-right the instruments. `RailAhead` fills it, for the main-line train
first, because that is the category where more information changes how you play
rather than merely looking good: knowing a 65 km/h restriction is 400 m out is a
decision, where a G-meter is an ornament.

**Transient rather than persistent, and that was the right call.** A readout
that is always on screen becomes wallpaper, and the driver stops seeing it
exactly when it starts to matter. Here the strip's *presence* is the first piece
of information, which is the same rule the rest of this HUD already follows:
nothing painted that is not a value.

**One message, never a stack.** Three warnings stacked is a panel again, and at
250 km/h a driver reads one line or none. The order is a driver's:

1. a train on the road ahead — nothing else matters if there is;
2. a restriction, once the brake is what gets you to it;
3. the station, on the approach.

The restriction test is the interesting one and it is deliberately not "is there
a lower limit somewhere ahead". `urgency` is `need / distance` — the distance
the brake needs against the distance left — so a 65 km/h corner two kilometres
off is not news, and the same corner at 400 m is. Amber over 0.45, red over
0.85.

**A bug caught by doing the arithmetic rather than by looking.** The figures
come out of the overspeed guard's own lookahead so the strip cannot disagree
with the thing actually braking the train — but the guard's reach *is* the
braking distance, so a restriction entered its view at the precise moment it had
to be acted on. The strip would have flicked straight to red with no amber
phase at all. The scan is twice the guard's reach now, with a 400 m floor for
when the train is slow enough that braking distance is nearly nothing.

**Two layout attempts, and what the second one taught.** The strip and the
identity banner were both positioned absolutely at `top-6`, and on a narrow
window they merged into a single bar — the strip is centred on the screen, and
the screen's centre is inside the space a long vehicle name can occupy. A flex
row fixed the overlap and broke the brief: centring in the *leftover* space put
the strip under the pause hexagon and off to the right, which is not the top
centre anyone means.

What works is caps, on the understanding that **text has to clear text, not
boxes**. The banner ends inside its own 80 px of right padding and the strip's
leading gradient is transparent for the first fifth of its width, so the two
washes may overlap while the words never do. 34% was the first cap and it
truncated "CLASS 43" — which is the measurement a cap should be judged by. 46%
on rail, and the original 60% everywhere else, because the constraint exists
because of the strip and should not be paid where the strip cannot appear.

**Verified** at the spawn, where the station is 700 m off: `KESTREL ISLAND ·
700 M · STATION` in cyan, centred, clear of the banner and the pause button,
fading in and out. The train-ahead and restriction branches share that render
path, fade and colour switch; their *triggers* are arithmetic and were checked
by hand rather than driven to, because the pane will not carry the train far
enough to meet a restriction.

**Still on the table**, from the same discussion: a G-meter and a self-arming
0–100 timer for PERFORMANCE, a pitch-and-roll attitude readout for UTILITY, and
a waypoint tape for STREET. The frame this establishes — one centred strip, one
message, level as colour — is what makes those cheap.

### Driving hints, and the strip becoming shared

`RailAhead` was one component that both decided what to say and drew it. Adding
car prompts to the same slot meant either a second strip that would drift from
the first, or splitting it. It is split: `HudStrip` is presentation — the shape,
the fade, the accent edge, the keycap, and the rule that nothing is rewritten
that has not changed — and a **feeder** is a function of the telemetry and the
frame's delta that returns one message or nothing. A category is added by
writing a function.

`railAheadFeed` is the line ahead as before. `driveHintsFeed` is the new one,
and it answers "press SHIFT to boost" and "boost is full" plus what fell out of
having the mechanism:

| | |
| --- | --- |
| on its roof or side | `[F] RIGHT THE CAR · ON ITS ROOF` |
| all four wheels off the ground | `AIRBORNE 1.4 S` |
| reserve fills, first time ever | `[SHIFT] BOOST READY · HOLD TO OVERTAKE` |
| reserve fills, thereafter | `[SHIFT] BOOST · FULL` |
| reserve emptied | `BOOST SPENT · RECHARGING` |

**Three rules keep it from nagging, and they are the design rather than
decoration.**

1. **Teach once, ever.** The long form is worth saying to somebody who has never
   boosted and to nobody else, so it is remembered in `localStorage` and never
   shown again once obeyed. A hint that repeats is not a hint.
2. **State notices are edges, not conditions.** A full reserve is news at the
   moment it fills and wallpaper for the five minutes after, so notices fire on
   an edge and hold 2.6 s.
3. **Situations outrank both.** On its roof, the car has something more pressing
   to say than its reserve.

**The bug rule 2 was not enough for, caught by watching it live.** BOOST SPENT
sat on screen for as long as SHIFT was held — 150 samples where 39 were
intended. `boosting` *flickers* when the reserve hovers at the engage floor: it
cuts out, a little charge returns, it engages, it cuts out. A plain rising edge
on "stopped boosting with an empty reserve" therefore re-fired every few frames
and kept re-arming the hold. Both notices are **latched** now — they may fire
again only once the thing they report has actually gone away and come back
(charge back over 0.5 for spent, under 0.9 for full). Verified: 39 samples then
silence, with the key still held.

**One new telemetry field.** `upright` is the world-Y component of the chassis's
own up axis — 1 level, 0 on its side, -1 on its roof — computed from a
quaternion that was already to hand, so it costs a rotate and a read. It is what
lets the strip offer `F` only when the car is somewhere it cannot drive out of,
and it is the field a UTILITY attitude readout would want next.

**A regression I introduced and had to take back out.** The shared label got
`whitespace-nowrap`, which held it to one line and made the strip wider than its
own 38% cap — so "KESTREL ISLAND" overflowed into the pause hexagon. Wrapping is
what keeps the box inside the width it was given. A two-line strip is fine; a
strip that runs under a button is not.

**Verified in the game**, both feeders: `KESTREL ISLAND · 700 M · STATION` on the
train, and on the McLaren `BOOST READY` firing on the first frame — found by
reading the strip's DOM rather than by screenshot, because a 2.6 s notice on a
20-second load is not something a screenshot will catch — then `BOOST SPENT ·
RECHARGING` caught live in amber, correctly placed and correctly timed.

**Still on the table:** a G-meter and a self-arming 0–100 timer for PERFORMANCE,
pitch-and-roll for UTILITY, a waypoint tape for STREET. All three are now a
feeder function each.

**The station throat, reworked.** Three separate faults made it read as scattered, and they are
worth keeping apart because each has its own lesson.

1. **The roads were laid in the FLAT frame while the running line follows the true alignment.**
   `stationPoint` projects `along` down the tangent at the station's midpoint; the line is straight
   from about −100 eastward but curves west of it — 15 m of drift at −200 and **24 m at −237**,
   which is exactly where the inner loop's turnout sits. So the loop closed on where the frame
   *said* the down line was and stopped 24 m from the real one: a rail ending in the grass, which
   is what "loop line has a dead end" was. `stationRailPoint(along, across)` measures every offset
   along the railway's own normal at its own arc, and the roads, the formation and the sea fence
   all use it now. Platforms stay on `stationPoint` — they are inside the straight stretch and a
   platform is straight anyway.
2. **A smoothstep is the wrong curve for a turnout lead.** Its gradient peaks at 1.5x its average,
   so the outer road's 26 m of shift over 188 m came out at **1 in 4.3** in the middle. A real
   turnout is a switch, a short curve and then a straight lead at a fixed angle — flat-topped, not
   a bell. `leadCurve` is that: eased over `LEAD_EASE` at each end, constant between. Same length,
   peak `shift/((1−ease)L)` instead of `1.5 shift/L`, and what the eye gets is a straight diagonal
   leg. Now: down line **1 in 15** (was 1 in 11), inner loop **1 in 11.4** (was 1 in 5.5), outer
   loop **1 in 6.7** (was 1 in 4.3).
   - Each road's offset is **absolute** — its own ramp from its platform offset to the running gap
     — not a separation from the road inside it. A ladder was tried twice and is worse both ways:
     short, the outer road loses 23 m in 91; long, its gradient is its own *plus* its parent's
     *plus* the down line's, all peaking in the same 80 m, which is 1 in 4.6. Ordering is still
     safe by construction — a common start plus a longer lead the further out a road begins means
     the outer road has always completed a smaller fraction of a larger shift, so
     `R3 >= R2 >= down` everywhere. Verified: 0 violations over the whole throat.
   - Leads are clamped to the **measured ballast**, not the crossing: `site.ballast` walks out
     while `structure === BALLAST`. The crossing is 684 m but its outer 30 m each end is the
     viaduct approach, and a 225 m lead put the outer turnout 26 m out over a bridge.
3. **Every road carried its own ballast trapezium.** Where the roads are far apart that leaves a
   wedge of GRASS between two running lines, which no railway has; where they converge the beds
   overlap, and since the station is level every crown is at the same height, so the overlaps are
   coplanar and z-fight. `IslandStation` now lays ONE formation (`FORMATION_PROFILE`, reaching from
   the running line's toe out past `stationOuter`), and `TrainLine` leaves it alone — `Rail.yard`
   from `stationYardAt`, excluded from `isBank`. The formation ends where the outermost turnout
   does, by which point `stationOuter` has closed to the running gap, so it hands over to
   `TrainLine`'s own ballast with no step. **This was the single biggest visual change.**

**The rail chase rig tucks underground** (`RAIL_CAMERA.chase.bore*`, blended on
`telemetry.enclosed` in `RailCamera`): its open-air 12 m side / 10 m up is in the rock inside a
6 m bore, seeing through back-faced walls — the other way "the station floated in a void".

**Verifying stations from the browser pane.** The ride URL is `/?car=train&arc=N`. The pane is
hidden, so a real click never focuses the canvas and `computer key` does nothing — dispatch
`new KeyboardEvent('keydown', {code: 'KeyC'})` on `window` instead; one press per JS call, a
second apart, or only one registers. Mode order is chase → cab → nose → cinematic → drone. After
a switch, PUMP FRAMES before trusting one: in a background pane a frame renders only when you
screenshot, and `RacingCamera` clamps `delta` to 1/20 s, so a mode change advances 50 ms per
screenshot — take ~20 `screenshot scale:0.1` first, or the cab shot is the rig still sliding in
from the 12 m chase position and looks like a camera planted over the down line or in the rock.
Key presses are consumed per frame too: presses without a frame between them collapse into one. The cab view is the honest one (0.55 m off the line); the rail chase rig (`RailCamera`,
12 m side / 10 m up, no bore tuck) is in the rock inside any enclosed section, seeing through
back-face-only rooms — that is the rig, not the geometry. `UNDERGROUND_SITE` is the middle of
the longest *ground-covered, ≥ minCover* run inside the longest enclosed stretch, not the
stretch's midpoint: 3654 today, not 3866 — recompute from `trainRoute.json` before going there.

**A cutting wall stands 5.5–7 m out from the rail, so it has to be built to the ground *there*,
not under the track.** Built to the centreline height, on any hillside with cross-slope the
uphill wall stopped short of the carved face and left a band of raw terrain above it, while the
downhill wall stood proud with its coping in the air — grey slabs at odd heights with wedges of
grass between, on a cutting whose alignment data was perfectly clean (straight, monotonic,
continuous). `Rail.groundL/groundR` sample the nav raster at each wall's own position;
`TrainLine` rebuilds once when the raster lands if it wasn't in yet. Diagnose this class by
comparing the route data against the picture: if the data is clean and the picture isn't, the
renderer is reading the wrong place.

**`cuttingMaxDepth` has a ceiling as well as a floor.** It has to be ≥ `TUNNEL_MIN_COVER` so a
cutting can reach daylight — but every cutting carve overlaps 2.5 m into the bore it leads to, and
the hill over the rail at a portal is only 13.5–15.2 m. At 24 (raised for a drawn cut that was
later removed) the carve took the hilltop off above every headwall and left a notch of raw
terrain edges round the mouth — "sharp meshes at the tunnel entries". The deepest real cutting
is 12.8 m; 13 reaches daylight for all of them and stops at the portal crown. Check with: no
mouth should have `hill over rail < cuttingMaxDepth` unless you want the top carved off.

**Carve on where the rail is, not on what the structure is called.** `cuttingSegments` used to
chain on `structure === CUTTING`, which misses anything else the ground happens to close over.
The classifier makes a point VIADUCT whenever it crosses a road or water without asking what
the ground *beside* it does, and one deck came out 3.5 m inside a bank — built correctly, with
a hillside in front of it, seen from the cab as grass growing over the rails. It chains on a
`BURIED` predicate now (`ground > rail + CUTTING_COVER`, anything but a bore), so a buried
viaduct or embankment is trenched like a cutting. Check with: no point outside a tunnel should
have `ground - rail > 0.3` and not appear in `cuttingSegments()`.

**Carve on where the rail is, not on what the structure is called.** `cuttingSegments` used to
chain on `structure === CUTTING`, which misses anything else the ground happens to close over.
The classifier makes a point VIADUCT whenever it crosses a road or water without asking what
the ground *beside* it does, and one deck came out 3.5 m inside a bank — built correctly, with
a hillside in front of it, seen from the cab as grass growing over the rails. It chains on a
`BURIED` predicate now (`ground > rail + CUTTING_COVER`, anything but a bore), so a buried
viaduct or embankment is trenched like a cutting. Check with: no point outside a tunnel should
have `ground - rail > 0.3` and not appear in `cuttingSegments()`.

**`CUTTING_OVERCUT` must be negative.** The cut face and the lofted wall are chorded
differently, so their tops cannot meet exactly and one has to be offset. Offset the concrete
*upward* (it was +0.7) and wherever the trench runs out shallow the wall and its coping stand
proud of the ground: grey slabs sticking out of flat grass all round a portal, which is exactly
what it looked like. Sunk below the ground line, the terrain laps over them and the seam is
hidden the same way — the worst case becomes a little wall buried rather than a little field
missing. Anything else lofted against the terrain wants the same sign.

**`CAMERA_REACH` is a rendering constraint, not a comfort setting.** The shader carves a hole
for the bore and nothing else, so the hillside a portal is cut into is solid everywhere except
that horseshoe. At 16 m the chase rig swung back and up the moment the locomotive cleared the
mouth — out of the carved arch and into the hill — and the frame filled with the terrain's back
faces: two green wedges either side of the cab converging over the roof, reading as grass
hanging above the track. 36 m covers the rig at full extension plus its swing. Any change to the
chase rig's distance or height has to be checked against this.

**One number decides where a cutting stops and a tunnel starts, and it has to be the same
number in two files.** `TRAIN.cuttingMaxDepth` (13) is how deep the shader will carve a
cutting; `TUNNEL_MIN_COVER` in `find-train-route.mjs` is the cover at which a point becomes a
bore. Split them and both halves fail, and I shipped both failures in one session:

- cut cap 9.9 / tunnel bar 10.6 left a 0.7 m band where a cutting could not reach the surface —
  an unlined slot buried in the hill, invisible from outside;
- and bores with as little as **1.1 m over the carved arch** (which stands 9.1 m over the rail),
  which on undulating ground between 6 m route points broke out as a horseshoe hole in the
  middle of a grass slope, with the portal headwall hanging in the slope beside it.

At 13 for both: a trench below that reaches daylight, a bore above it keeps 3.9 m of ground over
the excavation. Verify with two counts that should both be zero — bores where
`cover - 9.1 < 2`, and cuttings where `depth > cuttingMaxDepth`.

**Joining two bores must not make a bore where one cannot exist.** The joiner converts the gap
to TUNNEL, and converting unconditionally is what produced those 1.1 m bores. It now only
converts over water — where the tube carries itself and there is no terrain to break out of —
or under `TUNNEL_MIN_COVER`. A shallow gap stays a cutting and just gets the shell over it.

**`BORE_COVER` is what the grading aims for; `TUNNEL_MIN_COVER` is what makes it a tunnel.**
Conflating them put an open cutting under thirty metres of hill: with 11.6 m of cover the point
missed the 13 m bar, came out CUTTING, and the shader carved it as a trench — bounded at
`uCuttingTop`, so it never reached daylight and left an unlined slot buried inside the hill
with the underside of the hill for a roof. Invisible from outside, which is why it survived.
The question is not "is there a lot of ground above" but "would an open trench here reach the
surface", so the bar is the carved arch (9.1 m) plus a margin. Fixing it turned
`tunnel 192 / cutting 48 / tunnel 78` on the southern peninsula into one 318 m bore.

**Joining two bores has to change the structure, not just the `enclosed` flag.** The joiner
used to mark the gap enclosed and leave VIADUCT underneath, so the deck and its piers were
still built and what you saw between two bores was a bridge with a lid on it. The gap becomes
TUNNEL outright now: `isDeck` stops matching, deck and piers go, and the lining runs unbroken
from one bore into the other. Over water that is a tube spanning the gap on its own, which is
what a covered way across a narrow inlet is — and it only ever happens over gaps up to
`TUNNEL_JOIN` (140 m), so the span stays short enough to read as one. On the southern peninsula
this turned `tunnel 42 / viaduct 66 / tunnel 318` into a single 426 m bore.

**A bore that opens onto a viaduct needs a portal too.** The rule was "only where the mouth
meets a cut face", which is right for a mouth set straight into a hillside — a headwall there
buries itself and leaves its top corner hanging out of the slope. A viaduct mouth is the
opposite case and was wrongly lumped in with it: there is nothing to bury the headwall in, so
the tunnel simply stopped and opened onto a bridge with no face at all.

**Geometry of the excavations — four numbers that all have to agree**, and every one of them
shipped wrong at least once:

| number | value | why |
| --- | --- | --- |
| lining apex | 8.5 m over rail | `boreWall + boreHalf` |
| carved apex | 9.1 m | the shader cuts 0.6 m proud of the lining |
| `BORE_COVER` | 13 m | must clear the *carved* apex, not the lining |
| `uCuttingTop` | `cuttingHalf * 1.8` | bounds the cutting carve above the rail |

At `BORE_COVER` 9 the hole taken out of the terrain came out 10 cm below the surface — and on
any undulation, above it: a horseshoe opening hovering in a flat grass field, looking down into
the tunnel, with no portal anywhere near because it was the middle of the bore. The rule is
that cover is measured against what the *shader* removes, not against what the lining occupies.

The cutting carve had no upper bound at all, so it removed everything above the rail between
its battered walls, for ever upward. Segments are chords, and a chord between two shallow
points can pass through a 40 m hill: at 40 m the battered half-width was 31 m, so it took a
62 m-wide V out of the hillside. `uCuttingTop` bounds it, and `cuttingHalf`/`cuttingBatter`
went 7/0.6 → 5.5/0.14 — a retained cutting stands nearly vertical, and the shader carves to
exactly the wall's shape, so narrowing the wall narrows the damage. 27 m of hillside removed
became 13 m.

**The trench geometry has to be wider than the trench**, or there are holes under the ballast
on the approach to every portal. The shader overruns each carve segment by 2.5 m so consecutive
chords meet on a curve, and the chords run between *simplified chain ends*, not route points —
so the ground is gone for a few metres either side of a cutting while the floor and walls, keyed
on `structure === CUTTING`, stopped dead at the boundary. `Rail.trench` grows the trench four
samples (20 m) into its neighbours, but only where `fill < 0`: on an embankment nothing was
carved and a floor slab laid there would hang in the air beside the ballast.

**A cutting needs a floor as well as walls.** The shader carves the terrain out of the trench —
floor included, since a trench with a bottom left in it is not a trench — and for one round
nothing put anything back: the ballast shoulder covered the middle and either side of it you
looked straight through the ground. `cuttingFloor` lays a slab between the wall feet, at the
same level, so the three pieces meet on one line.

**Ballast goes in cuttings too.** `isBank` required BALLAST at both ends, so a cutting got no
ballast and the sleepers sat on the bare trench floor. A cutting is still a railway on ballast;
only bridge decks and enclosed stretches are slab.

**The bore reads as a tunnel, not a pipe.** Three things together, and none of them works
alone: segment rings in the lining texture (a dark recess with a lit lip below it, plus
staggered bolt pockets — the one feature that says "bored tunnel", and the only thing in there
that passes at a readable rate), a 256x512 texture so the pixels go on the V axis where the
rings are rather than on the featureless wrap, and enough emissive to see any of it. At
`emissive #5a5648` / 0.62 against a near-black diffuse the rings were invisible and the bore was
the same flat dark end to end; `#9d9686` / 1.0 is what makes the detail read. Nothing inside a
bore is lit by the sun, so the emissive channel carries the whole interior.

**The bore has a lighting strip** down each wall (`lightStrip`, unlit `meshBasicMaterial` with
`toneMapped` off). It is not decoration: a tunnel lit only by the headlight is a black tube
with a moving pool in it and no way to judge speed, because everything in view is the same
distance away. A continuous strip gives the eye a receding line. Set `LIGHT_STRIP_PROUD` off
the lining — flush, the two coplanar surfaces z-fight down the whole length of every tunnel.

**The cuttings are lined.** An open cutting is carved out of the terrain by the shader, and
what that leaves is a raw hole — the map's hillside sliced through, showing unlit back faces
down a trench up to 10 m deep and 25 m wide. `cuttingWall`/`cuttingCoping` loft concrete onto
the same battered face the shader cuts (`cuttingHalf` at the foot, opening by `cuttingBatter`
per metre), carried `CUTTING_OVERCUT` past the top because the cut face and the lofted face
are chorded differently and meeting them exactly shows daylight along the seam on every curve.
The bore lining also gained a walkway either side: cheap, and it is what gives the tunnel a
sense of scale — the eye needs a horizontal line at a known height, and a bare horseshoe gives
it none.

`R_MAX`/`DROP_BELOW` trade smoothness against fidelity, and it is a real trade: 620/210 gives
13 corners, min radius 222 m, 6.63 km; 850/280 gives 9 corners and min 379 m but shaves the
loop to 5.78 km, which means it has left the corridor and stopped being the drawn route.

**Seven bugs worth remembering, six of which shipped invisibly:**

1. **A bore's ceiling beat a bridge's clearance and put 58 points of deck under the sea.** The
   `ceiling` cone carries a bore's cover requirement outward at the ruling grade, so a few
   hundred metres of open water past a portal are still told to stay deep, while the water
   asks for six metres of air. `min(max(rail, clearance), ceiling)` gave the ceiling the last
   word. Fix: `ceiling = max(ceiling, clearance)` first — cover is a preference, air over a
   shipping lane is not. Where it bites the line comes up early and the structure pass, which
   reads the finished profile against the ground, reclassifies it as a cutting on its own.
   Check with: no point where `ground === null` may have `y < SEA_LEVEL + BRIDGE_CLEARANCE`.
2. **The islands were built with their normals pointing at the seabed and were simply not
   there.** Which way a traced outline winds is an accident; a fan over it faces +Y only when
   the shoelace sum is negative. `TRAIN_ISLANDS` normalises the winding. Same lesson as
   `buildLoft`'s signed-area test, one dimension down — and the same failure mode: no warning,
   no error, just missing geometry.
3. **The line ran buried inside the islands.** The profile blend is weighted towards `lower`
   (`CUT_FILL_BALANCE` 0.1), so it dipped up to 2.2 m below the crown and 60 of 133 island
   points came out as *cutting*. An island is not the terrain mesh, so nothing carved the
   trench: the train ran inside the grass, on slab track, with no ballast. Fix: the clearance
   floor now includes `p.ground` on a created island. There was never anything to gain by
   cutting into one — it was built to be exactly as high as the railway needed. Check with:
   every point inside an island outline should be `ballast`, `rail - ground` in [0, 0.5].
4. **The generator and the renderer disagreed about where an island ended.** The finder shelved
   the ground down across a 26 m beach *outside* the outline and called anything above
   `SHORE_LEVEL` land; the renderer drew that band as a skirt falling to the seabed. So the
   line ran onto ground that visually was not there. Both now use the crown and nothing else —
   `islandHeight` is the outline test, and the beach is dressing.
5. **`bored` did not mean "there is a hill over me", and the classifier believed it anyway.**
   It means the cell was inside a building's clearance and the simplifier drew a chord through
   it expecting the grading to dive under. The grading does not always get to — over water and
   over roads the clearance floor outranks the bore ceiling — so 135 of 260 "tunnel" points
   had under nine metres of cover and the shallowest was 5.5 m *above* the ground: a concrete
   tube in open air with the terrain shader carving a hole in the hillside around it. That is
   the "tunnel over buildings" and half the "huge cutouts". Cover decides the structure now,
   and `p.bored` no longer forces TUNNEL. Check with: every TUNNEL point should have
   `ground - rail >= BORE_COVER`.
6. **640 m of railway ran through the west district's buildings**, hidden until (5) stopped
   labelling it tunnel. Three things had to change, and two of the three were wrong turns
   worth recording:
   - `BORE_MIN_GROUND` 0 → 10 m. A chord may only cross something solid where the ground is
     high enough to bury a bore. Flat districts sit at 0-2 m; the hills the line genuinely
     bores are 10-43 m.
   - **Refusing the crossing was not enough on its own.** With the corridor still pinned over
     the district the only paths left were the gaps between blocks: 13.7 km, 38 corners, 52 m
     minimum radius. Widening the corridor is worse still — it lets the search cut the bay.
   - **The drawing had to move.** A hand trace is good to a few tens of metres and that was
     enough to put the north-west corner inside the district rather than along its shore. Each
     drawn vertex that lands on built-up ground is now walked outward to the nearest spot with
     `SHORE_MARGIN` (30 m) of clear ground — 12 of 53 moved, furthest 114 m. Result: 0 points
     inside a building, nothing nearer than 99 m.
7. **Slivers of hillside stood inside the bores.** The terrain-cut shader bounds each segment
   to its own length plus an overlap, and 0.6 m was too little: on a curve two chords meet at
   an angle and the wedge between them went uncut, visible from the cab as flakes of grass
   hanging in the tunnel. 2.5 m of overlap and 0.6 m (was 0.25) of radial margin close it.
   Over-cutting is free — the extra is behind the lining.

**Switched off as of an earlier session; back on now.** The user asked for the line to come off the map —
"drop train route from map we will get back on this later" — so `TRAIN_LINE_ENABLED` in
`src/config/trainConfig.ts` is `false`. It is one flag, gated in five places, and nothing
else was touched:

| File | What the flag does |
| --- | --- |
| `RacingScene.tsx` | `<TrainLine />` is not mounted, and `SELECTED.rail === 'main'` can never route input to `TrainRide` |
| `garage.ts` | `TRAIN_VEHICLE` is off the shelf, so `?car=train` falls through to the default rather than stranding the driver on a line that is not there |
| `Minimap.tsx` | no amber trace |
| `CityMap.tsx` | `cutTunnels` returns immediately — the terrain and the sea are not patched at all, so the bore-testing loop does not run per fragment either |
| `Environment.tsx` | the sea plane is not drawn |

The sea is part of the railway, not part of the city, and missing that cost a round trip: the
user came back with "there are lots of cuts in map that happened due to track". `Sea()` is one
flat plane at -3.6 m spanning 12 km, added so a bridge over a bay would not read as a bridge
over an abyss, and it slices through everything the map puts below that line — 4,406 cells of
drivable ground, 2,281 of them paved, down to -11.9 m, which is the ramps into the underground
car parks and the low ground at the map's edge. It was the only railway change to the world
that the flag did not already cover; everything else is either gated or inert (`enclosed` in
`ChaseCamera` is only ever set by `TrainRide`, so it stays 0 and every blend it feeds is the
identity).

**The map mesh itself was never touched by any of the railway work** — worth knowing before
anyone re-imports the source. `city.glb` was clean in git throughout, and re-running
`prepare:map` off the untouched `drive_for_speed_-_map.glb` reproduces the same 344 chunks and
2,956,492 triangles.

Use a flag rather than deleting: the route is the expensive part. `find-train-route.mjs` is a
graded, filleted, obstacle-aware search whose constants were tuned over many passes, and none
of it should have to be recovered from git. Verified with the flag off: garage lists 12
vehicles ending at the tram, no console errors, and the hillside at (-1017, 1302) — which had
a portal in it and a bore under it — is unbroken green.

The rest of this section describes the line as built, for when it comes back.

A 9.2 km loop right round the outside of the map, quite separate from the tram. Files:
`scripts/find-train-route.mjs` (`npm run route:train`), `src/config/trainRoute.json`
(generated), `src/config/trainConfig.ts`, `src/components/racing/railGeometry.ts`,
`src/components/racing/TrainLine.tsx`, plus a sea plane in `Environment.tsx`. README has the
full write-up; what is worth carrying forward here is what went wrong.

1. **Water cannot be priced per cell.** At a flat high price the line walks round every bay:
   the first working route had one 24 m bridge in 11 km. At a low price it nibbles across
   puddles. A large fixed cost to *enter* water plus a small per-metre cost is what actually
   models a bridge, and it has to be added outside the diagonal-length weighting or a
   diagonal shoreline pays 1.41 abutments.
2. **A hard grade cap makes the search fail outright.** The raster has genuine steps in it —
   sea walls, cliff faces, the lip of a cutting — and forbidding them seals off whole coasts:
   at 6% there was no loop at all, at 16% still none. Charge for climb instead and fix the
   profile afterwards.
3. **Charging for climb is not the same as charging for height.** With relief priced but
   height free, the line happily ran a contour round a hill at 40 m, because getting up there
   cost it nothing *on that leg*. `HEIGHT_COST` above `PLAIN_TOP` is what keeps a coastal main
   line on the coastal plain.
4. **The bridge clearance must be a hard floor, not a term in the blend.** Folded into the
   upper envelope it gets averaged away against the lower one and the deck comes out with its
   soffit a metre under the water — literally a row of piers with a causeway on top. Take the
   maximum instead; the grade guarantee survives it, because the greater of two functions with
   a bounded slope has one too.
5. **"Outward is away from the centroid" is wrong for a concave section.** A deck is a U
   between its parapets, so that test turns both parapet inner faces inside out. Use the
   profile's winding, from its signed area.
6. **The map has no water.** `prepare-map.mjs` rasterises only drivable surfaces, so the bays
   are void — which nothing noticed until a railway bridged one. The sea plane at -3.6 m is
   part of this change; `TRAIN.seaLevel` and the finder's `SEA_LEVEL` must agree.

**Verified in the pane:** the deck (rails, sleepers, parapets) from a car standing on it, a
viaduct and pier from underneath, piers standing in the water, and an unchanged city drive —
no console errors. **Not verified:** anything dynamic. §2's `visibilityState === 'hidden'`
bites hard here — the game reads it and pauses physics outright, so the car will not move in
the pane at all. Spawn points were temporarily repointed at the structures to get the camera
there and then restored from a backup; `?spawn=<n>` is the hook to reuse.

**The locomotive** (`scripts/prepare-train.mjs`, `npm run prepare:train`) is a Class 91 power
car, source `train_-_british_rail_class_91_power_car.glb` (32 MB, `source-models/`). Three
things worth carrying forward:

7. **It will not decimate.** 661 k in, 276 k out, and that is the floor: three `Body`
   primitives totalling 95 k give back 99.3% at every target and every target error. Welding
   by position is the obvious fix — 65,533 vertices over 13,492 distinct positions — and it
   makes things *worse*, both exact and tolerant, and drags the roof meshes (which decimate
   fine untouched, 72 k -> 11 k) down with them. Tried and rejected; don't spend the hour
   again. `TRAIN.count` is 1 because of this. A visibility cull like the Melbourne tram's,
   aimed at those three roof-band meshes, is the way to a second one.
8. **`MeshoptSimplifier.generatePositionRemap(positions, stride)` takes two arguments**, not
   three. Passing the vertex count as the stride silently returns a remap a third of the
   right length, and the simplifier then deletes entire meshes.
9. **The locomotive appeared to be invisible for six rounds of debugging, and was not.** The
   bounding box was right, the materials opaque, the meshes visible, the world position
   correct — and every screenshot showed empty track. It was doing 90 km/h and had left
   before the shutter opened. Whenever something scripted "is not rendering", park it first:
   set `TRAIN.speed` to 0 and pin its `phase`, then look.

**Riding it** (`TrainRide.tsx`, plus `TRAIN_VEHICLE` in `garage.ts`). Three notes:

10. **`GarageVehicle.rail` is now `'tram' | 'main'`, not a boolean.** It has to name the line:
    both services stand a vehicle down when the player takes one out, and taking the
    locomotive out must not remove a tram. Everywhere that only asks *whether* a vehicle is on
    rails still reads it as truthy and needed no change.
11. **The chase rig is anchored at the body centre, not the cab** — the opposite of `TramRide`.
    Anchored at the cab, the offset (measured back from the anchor) lands on the roof with
    fifteen metres of locomotive between it and the camera. Telemetry still reports the cab,
    so the map arrow and compass are unaffected.
12. **The speed restrictions are not decoration.** Without them a 250 km/h locomotive through
    a 30 m radius is 130 m/s² sideways and the body visibly snaps round the corner. The
    lookahead in `TrainRide.limitAhead` is derived from `BRAKE`, so raising the brake shortens
    it and lowering the brake lengthens it — change one and check the other, or the train
    starts braking for corners a kilometre and a half away and never accelerates. It also
    takes a direction: reverse runs at the full 250 too, and a forward-only guard would leave
    the line unrestricted backwards.

**Verified in the pane:** 0-249 km/h under throttle, restrictions holding curves at 150 while
the sea viaduct allowed 235, braking back down, 250 km/h reached in reverse with the guard
still binding at 240 through curves, and the garage entry rendering with the right figures. Physics does run in the pane in this
configuration (§2's visibility trap did not bite this session), but the override plus an
interval-held key was still needed to drive.

**Still to do:** the long train the user mentioned is not built — this is the power car alone,
so nothing couples to it. The 80 m where the line crosses streets is still a low bank a car
drives through rather than a level crossing.

## 4a-v. Railway rewire: geometry, roads, foreshore, tunnels (new)

The second pass on the line (`find-train-route.mjs` rewritten; `trainConfig`, `TrainLine`,
`CityMap` changed). README has the design; what to carry forward:

13. **A grid A\* cannot be smoothed into track.** Whatever the kernel, a staircase of 6 m
    steps comes out as thirty-metre corners with no say in where. Heading has to be *in the
    search state* (8 states per cell) with turns charged, and the result filleted with real
    arcs. Then the radius is a chosen number, not an emergent one.
14. **Douglas-Peucker tolerance is bounded by buildings, not fidelity.** At 7 m the search's
    one-cell jogs round building margins survived as 2 m corners; at 45 m with a
    clear-of-buildings check on every chord they are gone. At 15 m *without* the check it
    straightened the line across streets the search had avoided.
15. **`SHORE_LEVEL` sits between +0.0 and -1.5, and nowhere else.** Streets are exactly
    0.0-0.2 m (70% of land cells); at +0.3 the classifier drowned the city and no route
    existed. Dry sand runs to about -1; at -0.5 the whole beach was "water" and the western
    half of the loop went onto a viaduct along it. -1.2 works.
16. **Road at 200× grass, not 30.** Lower and the search runs along the city's street edge
    rather than round the hinterland, because that is fewer turns.
17. **The western districts are out (`WEST_LIMIT`).** Street grid to the sand; every line
    through them violates "not on road" or "not on sea". One-number switch.
18. **Envelope grading is a sawtooth** at the ruling grade — cones are. Smooth the blend
    (convex combination keeps the grade), then re-impose the clearance floor (max keeps it).
19. **Tunnels need the terrain cut, not just a lining.** All map materials are double-sided;
    the hillside slices through any lining where cover < bore height. `CityMap` patches the
    `Blocks` material's fragment shader via `onBeforeCompile` to discard fragments inside a
    horseshoe swept along `tunnelSegments()`. `customProgramCacheKey` must be set or three
    reuses the unpatched program. Terrain *colliders* are not cut.
20. **The terrain cut must be bounded along the track.** The first shader tested only the
    lateral and vertical offset from each segment and clamped `t`, so every one of the ~45
    segments cut an *endless* horseshoe channel along its own line — through every hill on
    the map, reported as "hills distorted, lots of cutouts". `along` is now required to lie
    within the segment (±0.6 m overlap so consecutive segments meet on a curve). If a hill
    ever looks carved again, this is the first thing to check.
21. **Joining two bores is not "call the gap tunnel".** The 168 m between this route's first
    two is a bay at 24 m up — no hill, so the terrain cut has nothing to remove and a lining
    there hangs over the sea. The gap is flagged `enclosed` with its `structure` left as
    viaduct, so it keeps its deck and piers, and the renderer adds a gallery: parapet-less
    deck (the ordinary parapets stand up through the lining floor — 3.1 m out and higher than
    the invert, well inside a 5 m bore), lining through, outer shell round it. Portals go at
    the ends of the enclosed run, not each bore.
22. **The chase rig does not fit in a tunnel and has to be told.** Fifteen metres back, 8.4 m
    up at speed, and a half-radian corner swing that throws the eye seven metres sideways —
    against a bore 5 m to the wall and 8.5 m to the apex. `VehicleTelemetry.enclosed` (0..1,
    only ever set by `TrainRide`) blends distance/height/swing/yaw-follow toward `ENCLOSED` in
    `ChaseCamera`. The swing term is the one that actually matters; height is second. Test
    both ends of the camera's reach, not just the vehicle, or the rig is still wide when the
    eye crosses the portal — and the hillside is *not* cut outside the bore, so the eye ends
    up inside solid terrain.
23. **Nothing occludes light, so anything "indoors" must light itself.** The tunnel invert is
    flat and square-on to a 48° sun, so with a normal `meshStandardMaterial` it was the
    brightest surface in the bore — reported as "white transparent under the track". Adding
    ballast over it hid the symptom but the bore is slab track, so the fix is the material:
    near-black `color` (nothing for the sun to pick up) plus `emissive` + `emissiveMap`
    carrying the concrete. Any future interior needs the same treatment.
24. **`cityData.boxes` is not "the buildings".** It is the collider box list, capped at a 40 m
    footprint by `prepare-map.mjs`, and vegetation is not in it at all. Routing against it put
    the line through large buildings and through trees. `scripts/make-obstacle-map.mjs` walks
    the mesh instead and writes `public/models/cityObstacles.png` — red solid, green
    vegetation, on the nav raster's grid. Re-run it if `city.glb` ever changes.
25. **Clearance has a hard floor: the widest structure the line is built from.** Trees at 3 m
    stood inside the 5.25 m tunnel bore. Nothing may be nearer than ~6 m.
26. **Over water, obstacles need a height test against sea level, not against nav ground.**
    There is no nav ground at sea, and the map's beach shell (a 5 km plane on the `Building`
    material) reaches far out over it — measured against sea level at 1.5 m it marked the
    whole bay solid. Only what a bridge deck would hit (8 m) counts out there.
27. **`classify` must test obstacles *before* water.** After, anything standing in the sea —
    port cranes, jetties — was invisible and the viaduct ran through them.
28. **Excluded ground must be BLOCKED, not water.** `WEST_LIMIT` marked the western districts
    as water; the search treated that as bridgeable and ran 1.5 km of viaduct down the
    boundary through their buildings.
29. **The tunnel-cut shader has a fixed segment cap and overrunning it is silent.** Ten bores
    at a fixed 12 m pitch came to 147 segments against a 96 cap, so the later tunnels were not
    cut and the hillside showed through the floor of the bore. `tunnelSegments()` now splits
    adaptively by chord deviation (33 segments for the same bores) and `CityMap` shouts if the
    cap is ever exceeded.
30. **The good alignment is offshore, so the line reclaims land for it.** Ashore this map
    gives a 72 m median curve radius; over water, 290 m. `CAUSEWAY_FREEBOARD` and friends in
    the route finder turn long water crossings into embankment with bridged channels, and
    `TrainLine` builds the landform (grass crown, sand flanks, crown collider). Reclaimed
    points take `ground = rail`, so the causeway rises with the alignment — at a fixed
    freeboard the grading called two thirds of it viaduct.
31. **Blocked ground has to be borable or every alignment winds.** `BORE_COST` lets A\* drive
    a tunnel through what it cannot cross, gated by `BORE_MIN_GROUND` — there must be ground
    above the rail to bury the bore in, and there is nothing under this map's streets.
    `gradeProfile` gains a slope-limited *ceiling* to hold those sections buried; the minimum
    of two slope-limited surfaces is slope-limited, exactly as the clearance maximum is.
32. **A bore needs ~9 m of cover, not 2.5.** The arch is 8.5 m over the rail, so with less the
    hill clips the top off it — and every mouth came out as a free-standing arch in a flat
    field. Below `BORE_COVER` the line is an open `CUTTING`, cut as a battered trench by the
    same shader (segments past `uBoreCount` in `CityMap`).
33. **A portal only belongs at a cut face.** Set into a hillside a headwall buries itself and
    leaves its top corner in mid-air; the coping and wing walls it used to have were worse.
    Drawn only where the mouth adjoins a `CUTTING`, and a plain ring otherwise.
34. **Length fights everything.** Ashore, clear of buildings/trees, and off long viaducts caps
    the loop near 5 km. `RING` 18 buys 7.2 km at thirteen sub-60 m corners; `RING` 16 buys size
    by going back out to sea. Reclaiming the sea as causeway reads as invented land and was
    reverted (`MIN_CAUSEWAY = Infinity` keeps the code, off).
35. **A ring of bearings caps the loop at the perimeter of the ground.** Under 5 km here,
    whatever the bearings. Replaced by farthest-point sampling over every buildable cell,
    ordered by angle then 2-opt — 7.5 km. Anchors must be on the **mainland** flood-fill: a
    stray primitive 2.7 km east of the city became one and the tour set off into open ocean.
36. **Legs sharing a corridor is what makes despur dangerous.** At `REVISIT_COST` 120 the
    overlap cost 40% of the loop in one cut. Now 400 over a two-cell corridor, and despur only
    excises sub-loops under `DESPUR_MAX`; a large self-crossing is left.
37. **Open the corners after filleting, don't just measure them.** Dropping a vertex the fillet
    could not open to `DROP_BELOW`, and re-filleting, took the median radius from 78 m to
    138 m. The chord that replaces it gets the same clearance test the simplifier uses.
38. **Anchors in a coastal band give a loop; anchors everywhere give a tangle.** `COAST_BAND`.
39. **Boring under the city is free to look at, but not free of consequences.** The lining is
    `BackSide` so it is invisible from outside — but the bore sits below the sea plane, which
    stretches under the whole map at -3.6 m and sliced through every tunnel. `cutTunnels` is
    exported from `CityMap` and applied to the sea as well now.
40. **The simplifier must be allowed to cross obstacles.** Once boring is on, refusing chords
    through buildings means the search can tunnel but the alignment cannot be straightened —
    median curve radius came out at 11 m. Allowed, capped by `MAX_BORE_RUN`, it is 272 m.
41. **`BORE_COST` does not control how much tunnel there is.** 8 to 400 changes it barely, and
    at 400 it rises: the bores are how the line gets past the built-up coast, so pricing them
    up only buys worse detours.
42. **Stale console buffers lie.** 400 "BoxGeometry NaN" errors persisted across reloads of one
    tab; they were from a single HMR moment when the old Portal read a config field that had
    just been renamed. A fresh tab showed none. Check a fresh tab before chasing.

**Verified in the pane (tour route):** long sweeping track at grade through the hinterland;
the two legs running alongside with a viaduct crossing over, reading as a junction; portals and
bores as below. **Verified earlier (causeway route, since reverted):** causeway sweeping across the bay with a bridged
channel ahead and the hills beyond; the same running past the container port; both bores clean
inside. **Verified earlier (previous route):** approach viaduct into a portal set cleanly in the
hillside; three separate bores checked from inside — lining, lamps, no terrain intrusion, no
vegetation in the bore; the 1,110 m joined stretch continuous with no open viaduct between its
bores. **Not verified:** a full lap at speed.

**Verified earlier:** train on the ballasted line beside (not on) a street; viaduct
sweeping over the southern bay with the road passing under it; both portals of the long
tunnel — headwall, coping, wing walls — set into intact hillsides with no channels carved
beyond them; inside the bore — shuttered-concrete lining, paired lamp fittings on the
haunches, no terrain intrusion, daylight at the far end; the 612 m joined stretch continuous
from inside across bore/gallery/bore, and the gallery seen from the valley as a covered tube
running hillside to hillside; a full run in at 115-206 km/h with the rig tucked and clear of
the lining throughout, and 300 km/h reached on the coastal straight after it. **300 km/h is now verified** — reached on the beach straight east of the tunnels.

## 4a-iii. Replacing the tram model (back to a G:link Flexity 2)

The tram has now been swapped twice: G:link Flexity 2 -> Melbourne C-class -> G:link Flexity
2 again, this time from `gold_coast_glink_light_rail_tram__flexity_2.glb` (7.8 MB, in
`source-models/`, untracked). `prepare-tram.mjs` was rewritten again and is where all of this lives; the
C-class machinery it used to carry — a 26-viewpoint visibility cull, a triangle-by-triangle
cut at a measured bellows, a weighted simplification budget — is **gone**, because this
export needs none of it. Note that none of it was ever committed — the C-class swap lived
entirely in the working tree — so if you go back to a model in that state, the visibility
cull and the geometric cutting have to be written again from scratch.

What actually matters about the swap:

1. **This export is in good shape and the script is short because of it.** 60 594 triangles,
   authored one node per module the way the real vehicle is built (seven modules, four
   bogies), correctly proportioned, ten 1024² textures. Nothing is culled, nothing is
   decimated, no geometry is rebuilt. The interior is kept — you can see it through the
   glass, which is the point.
2. **Sections are made by re-parenting nodes, not by cutting geometry**, which is what the
   C-class export made impossible. The seven modules are located by *measurement* (a
   module-scale mesh spans nearly the full width and metres of the length; the centres are
   the clusters those fall into) because the node names lie: five `glink_seg*` names for
   seven modules, repeated between the ends, and the doors named `seg2_*` include the centre
   module's. The script asserts it found seven and prints them, so a different tram fails
   loudly rather than silently coming out rigid.
3. **The one real trap: the whole tram is on one `BLEND` material.** 8 % of the texture
   atlas is tinted glass, so the export marks the material transparent — and three.js
   applies that per material, meaning 53 k triangles of bodywork were drawn with no depth
   write. The symptom is that you look through the roof at the seats, and it is not fixed by
   culling the interior (the roof stays see-through) nor by splitting per mesh (tried: it
   moved 42 of 105 primitives, because a shell mesh's UVs cover its own window openings). It
   is fixed per *triangle*: sample the alpha channel at the three vertex UVs and the
   centroid, re-index everything that never touches a translucent texel onto an opaque clone
   of the material, leave the rest blended. 50 790 opaque against 2 528 blended.
4. **The export ships a "Please Read" billboard** — a two-triangle textured plane 12 m off to
   one side carrying the author's credit and licence. It is dropped before anything is
   measured, or it takes the bounding box with it; its primitives have to be disposed by hand
   or its half-megabyte texture rides along into the file (same gltf-transform trap as 4b.4
   below). The model is **CC BY 4.0** by JoErain, so the credit moved into the README rather
   than being dropped with the plane.
5. **Numbers tuned to the previous vehicle's length, all of which had to move.**
   `RAIL.minTramGap` 30 -> 50, `TRAM.sectionCollider` 9.3 -> 7.1, `tramTraffic`'s `FOULING`
   18 -> 28, and `TRAM.count` 3 -> **5** (the whole service is now 303 k triangles, against
   1.2 M for three C-classes). `prepare-tram.mjs` prints a suggestion for each of the first
   three every time it runs, which is where these came from. `GarageThumbs`'
   `CACHE_VERSION` went to `v6` — miss that and returning visitors keep a cached picture of
   the old tram for ever.
6. **Garage-entry facts that are stated, not measured:** the label, the year (2014, when the
   line opened), the ~60 t tare mass and the 70 km/h line speed. `size` and `sections` come
   from `tramData.json`, and `rigSize` is deliberately *not* the vehicle's length — see
   `garage.ts`.
7. **`Object3D.lookAt` faces a model the wrong way, and it had been doing so all along.**
   Both tram renderers placed each section's carrier group with
   `group.lookAt(point ahead)`. On anything that is not a camera or a light, `lookAt` aims
   the object's **+Z** at the target — and every model here faces **-Z**, which is what the
   kinematic colliders and the camera anchor use (`Math.atan2(-tx, -tz)`, with a comment
   saying so). So the visuals were 180 degrees out from the physics: each section was drawn
   end-for-end in place, which on a vehicle with a cab at *each* end puts both noses inwards
   and leaves the open gangway faces sticking out at the ends of the tram. It survived the
   C-class because its three sections were nearly symmetric and it read as "blunt"; this
   tram's cab modules made it obvious. Fixed in `RailLoop` and `TramRide` by setting the same
   heading the colliders use. **If a vehicle ever looks reversed, check for `lookAt` before
   suspecting the asset** — the model was right in this case, and was rendered offscreen from
   both quarters to prove it before any code was touched.
8. **Known rough edge:** the interior is kept in full (about half the triangles) rather than
   culled, on the grounds that 61 k is cheap and the glass is see-through. If the line ever
   needs to be cheaper, that is the first place to look, not `TRAM.count`.

**Verified in the browser, not by inspection:** the tram renders solid from the chase camera
and on the garage stage with all seven modules laid end to end and no gaps at the joints, and
no `[rail] tram: n/7 sections found` warning appears for any of the five service trams. What
was *not* re-checked interactively is the queueing behaviour behind a stopped player, which
is unchanged code but now has a 43.5 m vehicle and a 50 m minimum gap under it.

## 4a-iv. Where the player spawns

The city had one spawn, from `cityData.json`. It now has twelve, surveyed by
`scripts/find-spawns.mjs` (`npm run spawns`, which samples lanes of `roadGraph.json` — a
raster sweep once put a spawn on a car-park roof deck) into `src/config/spawnPoints.json`, and
`vehicleConfig.spawn` picks one per page load via `cityConfig.pickCitySpawn()`.

1. **The choice has to be made once, at module scope, and nowhere else.** `VEHICLE.spawn` is
   read at mount by `CarPhysics` (the RigidBody's `position`/`rotation`), by
   `vehiclePhysics`' initial state, and by the reset handler as its fallback. Picking per
   render or per frame would have the three disagree. Picking a car in the garage reloads the
   page, which is what makes the next drive somewhere else.
2. **Server-side it returns the first spawn, not a random one.** A random pick during SSR
   differs from the client's and nothing good comes of that; no HTML depends on the spawn, so
   a stable placeholder is free.
3. **Nothing is decided at runtime, deliberately.** The raster loads asynchronously and after
   the car is already mounted, so a runtime `nearestRoad` pick would mean spawning at a fixed
   point and then teleporting — and a spawn that lands in a wall on some loads and not others
   is unreproducible. Everything is verified offline instead, the way the tram route is.
4. **`?spawn=<n>`** pins one, for reproducing a report about a particular street. Out-of-range
   and non-integer values fall through to the random pick rather than throwing.
5. **The trap in the survey itself:** the direction probe originally measured only as far as
   the 30 m it required, so both ends of every street saturated at 30, the "face the roomier
   end" comparison was always a tie, and every car spawned facing whichever end the probe
   happened to test first. `PROBE` is now 90 m. If spawns ever start facing walls, look there
   before looking at the raster.
6. **Re-run it after `npm run prepare:map`,** or after moving the tram or train routes — the
   points are metres in world space and are only as valid as the raster and the routes they
   were measured against.

## 4b. The city map — traps found while integrating it

Added after the original build. Source `drive_for_speed_-_map.glb` (188 MB,
`source-models/`, untracked) → `public/models/city.glb` (17.5 MB) + generated `src/config/cityData.json`, via
`npm run prepare:map`. The city is now the **default** world; `?world=track` restores the
circuit. See README "The city" for the pipeline. Five things cost real time:

1. **Tailwind 4 auto-source-detection will hang `next dev` outright.** `@import "tailwindcss"`
   with no `source()` walks the entire project and feeds every text-ish file to the class
   extractor. Adding `public/draco/draco_decoder.js` (512 KB of minified Emscripten) and a
   148 KB generated JSON was enough to pin a CPU core and grow unboundedly — the server sits
   at `Compiling / ...` forever, with the *next-server* process idle at 0% and a
   `pool_entry-[turbopack-node]_transforms_postcss` worker at 99%. Symptom looks like a hung
   dev server, not a CSS problem. Fixed in `globals.css` with
   `@import "tailwindcss" source(none);` + an explicit `@source "../**/*.{ts,tsx}"`.
   **If `next dev` ever hangs again, check that postcss worker's CPU first.**
2. **Node names cannot carry structured data through GLTFLoader.** three runs every name
   through `PropertyBinding.sanitizeNodeName`, which *strips* `.:/[]`. A `col::Street::-2_1`
   node arrives as `colStreet-2_1`, so a `startsWith('col::')` test matches nothing, no
   colliders are built, and the car falls through the city with no error anywhere. Chunk
   role now travels in glTF `extras` → `Object3D.userData`.
3. **drei's `<Sky>` is a BackSide box at the world origin, `distance` (default 1000) wide.**
   It only renders while the camera is *inside* it. That is invisible on a 266 m circuit and
   fatal in a 5.5 km city: past 500 m from the origin you see culled back-faces, i.e. a
   black sky. Now `distance={45000}`. Enlarging it is free — three's Sky shader pins
   `gl_Position.z = gl_Position.w`, so it is never clipped by `camera.far`.
4. **gltf-transform: disposing a Mesh does not dispose its Primitives.** The orphaned
   Primitives keep referencing the source accessors, so an orphan sweep that only walks
   `root.listAccessors()` keeps all 52,210 of them alive and the writer serialises 179 MB of
   dead geometry *next to* the new chunks. Draco compresses fine and the file still grows
   (188 MB → 190 MB). Original primitives must be disposed explicitly.
5. **`camera.far` was 1600 while the fog saturates at 780.** Harmless on the circuit; in the
   city it doubled the frustum depth and pulled ~1.9 M of the map's 2.96 M triangles into
   every frame. Now 820.

### 4c. Navigation raster, minimap and reset-onto-road

`public/models/cityNav.png` (3265 × 1516 @ 1.5 m/px, 739 KB) is generated by the same script.
R = paved, G/B = ground height as u16 over [minY, maxY], A = any drivable ground. One asset
serves the minimap, the full map, and `R`. Read `src/physics/cityNav.ts` first.

**Why a raster at all:** trap §4.1 again. Every collider query re-enters the borrowed World
from inside the physics step; the reset handler lives in `useBeforePhysicsStep`, so it
*cannot* raycast to find the road or its height. Array indexing is O(1) and safe anywhere.

Four more things that cost time here:

1. **`ImageBitmap.close()` zeroes `width`/`height`.** Reading them after closing gave 0, and
   every downstream `createImageData` threw `IndexSizeError: The source width is zero`.
   Worse, the failure was invisible: the catch was a silent `() => {}`, so the minimap just
   never appeared with nothing in the console. **Don't swallow errors in a load path.**
2. **The road mask must have building footprints punched out of it.** It is built from paved
   geometry, which knows nothing about what was built on top — warehouses and shops sit on
   their own paved lots, so those pixels read as street and `R` would "rescue" a stuck car
   to a point *inside a building*. This was originally done from `boxes`, and that is the
   wrong data — see §4c-i, which replaced it.
3. **The raster must be cropped to where ground actually exists.** A few stray primitives
   stretch the world bbox, which left the city filling under half the image — dead space the
   minimap scrolls through and the full map wastes screen on. Cropping moves the origin, so
   the georeferencing in `cityData.json` has to follow it.
4. **`M` already toggled engine mute** (`useEngineSound.ts`). Binding the map to `M` fired
   both. Mute moved to `K`; the help panel now lists it, which it never did before.

### 4c-i. Why NPC traffic was flying over the city (new)

Reported as "traffic is cluttered in random places, sometimes above buildings, above pillars".
All of it traced back to this raster, and the diagnosis is worth keeping because none of it is
visible by looking at the game — the cars are small, they are far away, and the ones in the
wrong place look like the ones in the right place until you measure.

**How to measure it.** Add one line to `Traffic.tsx`'s existing `useEffect`:

```ts
(window as unknown as { __npcs?: unknown }).__npcs = npcs;
```

then in the preview pane, after overriding `document.visibilityState` (§6):

```js
const a = (window.__npcs||[]).filter(x => x.active);
JSON.stringify({active: a.length, stuck: a.filter(x => x.stuck > 0.5).length,
                rows: a.map(x => [x.x|0, +x.y.toFixed(2), x.z|0])})
```

Before the fix, one sample of 40 cars had them at y = 5.06, 20.01 and **36.00**, with six
wedged. After, every car in two separate samples of 24 sat at 0.00–0.16 m with none wedged.
That probe is the acceptance test; put it back if you touch any of this.

**Three separate causes, all in `prepare-map.mjs`:**

1. **The height was the maximum over all drivable surfaces.** That is right for terrain and
   wrong for a city with layers. 12,320 cells carry ≥2 m of paving stacked over itself, and a
   street cell under a ramp reported the ramp. At (-928, 694) the raster said 36.65 m and the
   street is at 0.00 m — the car was on the street and drawn on the skyline. Fixed by tracking
   `navPavedLow` (min over paved) alongside `navHeight` (max over drivable) and preferring the
   paved one. The trade is that traffic can no longer use an elevated deck as a road surface
   where a street runs under it; one raster holds one layer, and the street is the one worth
   holding.

2. **The obstacle cut came from `boxes`.** Those are collider boxes, capped at
   `BOX_MAX_FOOTPRINT`, so every merged block fell through to the trimesh and no tree was ever
   boxed. 10.8 % of paved cells have something standing on them and most of it was invisible
   to that pass. Now every non-drivable triangle is rasterised into a height *span* per cell,
   and a cell is cut when the span reaches above 1.5 m and starts below it. The second half of
   that test is what stops a bridge deck, a petrol-station canopy or a tree crown erasing the
   road beneath it, and the first half is what stops kerbs and road markings — which are
   non-drivable primitives covering much of the carriageway — from walling the city off.

3. **Nothing checked that road was reachable.** Rooftop car parks are paved, marked out, and
   read as street. A connected-component pass over 8-neighbours, joined only where the height
   step is under 1 m, drops components below 400 cells. Keep them **by size**, not by
   "connected to the largest": the two western districts and the southern island are separate
   components and all three want traffic.

**The map still draws all of it.** Narrowing the mask to the street network was right for
traffic and wrong for the map — the blocks went hollow and the city read as a bare grid, which
the user came back on. So `R` carries two levels rather than one: `255` street, `128` other
paved ground, `0` not paved. `isRoadPixel` (> 127) is unchanged in meaning and still what the
map and `surfaceGrip.pavedAt` use; `isDrivablePixel` (> 191) is the new narrow test, used by
`trafficAI`, by `nearestRoad`/`roadHeadingAt` (the reset snap should not drop you on a roof
deck) and by `find-spawns.mjs`. Every existing `> 127` test in the offline scripts therefore
kept working and kept its old, wider meaning — that is why the level is 128 and not something
that would have to be threaded through `find-tram-route.mjs` and `find-train-route.mjs`.

Drawn 296,945 px against 301,329 before, so the map is as full as it was; 270,165 drivable.
The map paints the two in two tones — one tone puts the grid in a wash of white.

**Things that look like fixes and are not:**

- *Filtering by material.* The block interiors are the same `Street` material as the roads —
  370,364 of 396,620 paved cells are `Street`. There is nothing to filter on.
- *Filtering by width, to keep streets and drop plazas.* Measured: a 7 m morphological opening
  removes 60 % of the mask and a 13 m one still removes 28 %, because the avenues here are as
  wide as the lots. It would gut the main roads to tidy the car parks. So paved forecourts and
  yards that genuinely connect to the street are still road, and traffic will occasionally
  cross one. That is deliberate.
- *Using the terrain shell as the "real" ground.* 219,551 of 374,501 paved cells have no
  `Blocks` geometry under them at all — downtown, the streets *are* the ground.

Re-run `npm run prepare:map` (about 7 s), then `npm run roads`, then `npm run spawns` — in
that order, since the road graph is built from the raster and the spawn set is walked off the
road graph. `npm run spawns` exits non-zero if any spawn lands off the network. The spawn set is
picked from the finished mask. `prepare:map` also rewrites `city.glb`; the mesh is unchanged
(same 344 chunks, same 2,956,492 triangles) but Draco does not encode byte-identically, so
expect an 18 MB binary churn in the diff that means nothing.

### 4d. Spawn selection, and `F` to flip

**The spawn is chosen from the finished road mask, and the scoring metric matters.** Two
wrong answers were shipped and rejected before the current one:

1. *From the raw Street/Parking triangles* (original): those still include the paved lots
   inside building blocks, so the car started in a walled yard between two warehouses.
2. *From "how much pavement surrounds this point"*: openness scores a car park or a
   courtyard **higher** than a street, and it picked an elevated parking deck in the middle
   of a block, 16 m up.

What actually identifies a street is that it is a **long linear corridor**, so candidates are
ranked by the longest unbroken straight run of road through them (12 axes, capped at 240 m),
with a pull toward the road-network centroid. Plus a hard filter: a candidate is rejected if
it sits more than 2 m above the minimum road height nearby, which is what keeps the search
off flyovers and roof decks. The result is a ground-level avenue near the city centre,
facing down the street.

**A bug worth remembering:** the crop in step 3b reassigns `navW`/`navH`/`navOriginX/Z`, and
originally left `navRoad`/`navHas`/`navHeight` at the *original* stride. Anything indexing
`pz * navW + px` afterwards then reads the wrong pixels entirely — the spawn landed on a tile
that was neither road nor even ground. The working arrays are now cropped alongside the
image so every array and every piece of metadata describes one grid. If you add another
consumer of the raster inside the script, it must come after the crop.

**`F` flips the car upright** where it stands (`Vehicle.flipUpright`), keeping position and
heading and lifting 0.6 m so the body can rotate clear. It is deliberately distinct from `R`:
rolling onto your roof against a kerb should cost you your momentum, not your place in the
city. Uprightness is structural rather than computed — `reset()` builds a yaw-only quaternion
— so it cannot produce a tilted car. Heading is read from the chassis before `reset()` runs,
because `reset()` reuses both scratch objects. Degenerate case: a car balanced exactly
nose-up leaves the forward vector with no horizontal component and the heading collapses to
north, which is harmless.

Conventions worth knowing: heading is `forward = (-sin h, -cos h)`, matching `trackSpawn()`.
The minimap rotates the map by `+heading` to put forward at screen up; the north-up full map
rotates the *player marker* by `-heading`. The full-map canvas must NOT use `object-contain`
— it letterboxes the bitmap inside the element while the click-to-waypoint mapping reads the
element rect, silently offsetting every waypoint. An explicit `aspectRatio` is used instead.

**Verified:** `nearestRoad` returns 0 m and stays put when already on tarmac; from inside
building blocks it moves 6–21 m and always lands on road, with grid-aligned headings.
Click-to-waypoint maps to within ~20 m, which at that element size is ~1.2 CSS pixels.
Pressing `R` wedged against a building keeps the car local (same block, same heading) rather
than teleporting to spawn. The spawn is a ground-level avenue in the city grid, facing down
the street. `F` was verified on a genuine roll-over — the car ended up on its side against a
kerb after a handbrake crash and came back upright on all four wheels, settled, in place.

**Not done / known soft spots in the city:**
- `gripAt()` still returns 1 everywhere in the city, **even though the raster that would fix
  it now exists**. `isRoadAt(x, z)` in `physics/cityNav.ts` is exactly the lookup needed —
  wiring it into `surfaceGrip.ts` would give real off-tarmac grip loss and make `SkidMarks`
  suppress on grass, as it does on the circuit. Left undone deliberately: it changes vehicle
  handling, which is calibrated on the circuit, and it wants a driving test that the hidden
  preview pane (§2) cannot give. Note the mask now excludes building footprints, so it is a
  road test, not a "solid ground" test.
- Vegetation and street furniture (`Accesories`) have **no** collision — you drive through
  trees and lamp posts. Loose AABBs there would be worse than nothing.
- Frame cost could not be measured honestly: the preview pane reports `visibilityState:
  'hidden'` (see §2), so rAF runs at ~3 fps. Driving the renderer manually gave ~15 ms/frame
  at 283 draw calls / 1.5 M triangles, but hiding the vegetation (−0.7 M triangles) and
  disabling the shadow pass both changed *nothing* measurable, and repeat runs of the
  identical config varied 14.7 → 17.2 ms. **That number is noise-dominated — do not treat
  it as a frame budget.** Real fps needs a genuinely visible window.
- The 40 m box-vs-trimesh threshold is a judgement call, not a measurement. 2,730 of 2,937
  candidate primitives box tightly; the rest go to trimesh.

**Verified in the city:** spawns on a street and rests stably (y 0.21–0.30 m over 60 s of
driving, never falls through); accelerates to 88 km/h; stops dead against a building and
stays pinned under full throttle, with a box collider 2.18 m from the stopping point.
`?world=track` still renders and drives unchanged. `npm run build`, `tsc --noEmit` and
`eslint src scripts` are all clean.

## 4e. NPC traffic

`npm run prepare:vehicles` turns the two packs (78.8 MB, `source-models/`, untracked) into
`public/models/vehicles.glb` (2.61 MB) + generated `src/config/vehicleCatalogue.json`.
20 vehicles, 40 slots; the density setting caps how many are live (MEDIUM, the
default, is 24). Read `physics/roadGraph.ts`, then `physics/trafficAI.ts`, then
`components/racing/Traffic.tsx`.

**The cars follow a road graph, not the raster.** The first AI probed the nav raster
directly and weaved; everything below about probes, fans, kerb panic and deadbands is
history. Now:

- `npm run roads` skeletonises the street mask out of `cityNav.png` into
  `src/config/roadGraph.json` (centrelines, widths, junctions; roundabouts kept as
  one-way rings). Re-run it whenever `prepare:map` re-bakes the raster.
- `roadGraph.ts` loads that, adds the island's streets and the causeway from
  `townConfig`/`stationConfig` at runtime (`planarise`), and serves lanes: an edge, a
  direction, and an offset to the driving side (`TRAFFIC.driveOnRight`, one switch).
- `trafficAI.ts` drives each car as a distance along a lane: headway to the car in
  front on the same or the next lane, give way at junctions (anyone in the box, then
  traffic from the priority side arriving within `arrivalWindow`; `patience` breaks
  mutual waits; committed once past the stop line), curve and turn speeds from the
  cornering budget, the level crossing as a gated edge, spawning onto lanes only.
- The player is projected onto the nearest lane each step so traffic queues behind them.
- Verify offline before the browser: the scratch probe in this repo's history ran 24 cars
  for 120 s and read spacing, off-road samples, stopped share and yaw spikes.

**Asset traps:**

1. **The two packs are structured differently.** Passenger cars keep wheels as loose
   `Wheel_A..H` nodes that are *siblings* of the bodies; service vehicles have them baked
   into the body mesh. Ten cars therefore had spinning wheels and ten did not, which the user
   noticed and reported. `extractWheels` now carves them out of the body — see trap 5.
2. **Wheel names lie, three different ways.** Two distinct nodes share the name
   `Wheel_G001`, so keying by name silently merges them. One base name is reused across two
   different cars (eight nodes stripping to `Wheel_A`, two sets of four with slightly
   different radii), so grouping by base name hands one car eight wheels and a 12 m bounding
   box. And both packs load into one list with overlapping showroom layouts, so a passenger
   car's wheel can land nearest a fire truck. Only spatial pairing works: nearest-first,
   capped at four per body, never across packs. Check the printed table — any car not showing
   `4 wheels` or with a width over ~2.8 m means this regressed.
3. **Orientation is PCA, which is undirected — this shipped wrong once.** PCA finds the long
   axis but not which end is the nose, so vehicles came out facing randomly and traffic drove
   backwards. Four candidate rules were measured before one worked; the failures are worth
   knowing so they are not retried:

   | signal | result |
   | --- | --- |
   | authored node rotation | the packs are not internally consistent — no use |
   | glass **centroid** | dominated by side windows; called the school bus wrong |
   | front vs rear overhang from the hubs | differs by 3–16 cm, i.e. noise |
   | **tail-light redness** | decisive for cars; misled by red bodywork on fire engines |
   | **area-weighted glass normal** | ±0.06 on cars (noise), but 0.27–0.60 on cab-forward vans, trucks and buses |

   **The shipped rule is the clear-to-red lamp ratio.** Road vehicles are lit red at the back
   and white at the front by law, so the clear end is the front. Per end, sum the lens area
   classified red (saturated, red-dominant) and the area classified clear (bright, nearly
   unsaturated), then compare the ratios. Cab-forward vehicles with no clear lens fall back to
   the glass normal.

   Two refinements were each worth a shipped bug:

   - **Area-weight the samples.** Summing per triangle lets a finely tessellated scrap of red
     trim outvote a whole lamp lens; fixing that alone changed four of the twenty decisions.
   - **Use both colours, not just red.** Redness alone separated a saloon's ends by ~10 %,
     indistinguishable from noise, because these models carry red trim and red side markers at
     both ends — it shipped the Coupe and the Sport facing backwards. The clear-to-red *ratio*
     separates them by 2× to 20×, and switching to it changed exactly those two decisions and
     left the other eighteen untouched, which is the check that it is measuring the real thing.

   Only the outer thirds of the body count, so roof beacons and side repeaters are ignored.

   **How to check it by eye, quickly.** Park a car broadside — 90° to the player — and its
   nose must point to the left of the screen. From the side a bonnet, a boot or a rear wing is
   unmistakable; head-on and three-quarter views are not, and I twice talked myself into the
   wrong answer from them. Two useful sanity anchors: the taxi and the police sedan share one
   body mesh, so they can never disagree, and the player's McLaren is validated, so parking a
   car alongside it at the same heading compares against a known-good reference in one frame.
   `ORIENT_SHEET=/tmp/o.svg npm run prepare:vehicles` draws all twenty in profile. If
   one is genuinely wrong, put its name in `FLIP` — do not invent a sixth heuristic.

**Runtime traps:**

4. **Half the pack's wheels are inside the body mesh, but not merged into it.** Each wheel is
   its own closed shell sharing no vertex with the bodywork, so `extractWheels` splits the
   geometry into shells by welded position (1 mm) and classifies each. The discriminating test
   is **roundness**: no vertex may stand further from the hub than a circle of the shell's own
   diameter would reach. A box's corners stand 41 % further out than its sides, so mirrors,
   light housings and fuel tanks fail it outright; extent ratios and ride height alone do not
   separate them. Shells are then grouped by radius and the largest agreeing set of ≥3 wins,
   which is what stops a spare wheel or a steering wheel from being picked.

   Verify with the emitted table (every vehicle should show wheels; `!` marks none or an odd
   number — six is a truck's twinned rear axle and is correct) and by checking the carved
   wheel mesh is centred on its hub, or it will orbit rather than spin:

   ```
   wheel centre offset y=0.000 z=0.000   r(mesh)=0.392  r(cat)=0.3915  hub y=0.39
   ```

   Hub height should equal the radius — that is the wheel sitting on the ground.

5. **Both packs tag materials BLEND wholesale, and one of them was a whole vehicle body.**
   three draws a blended surface with depth-write off and an `InstancedMesh` cannot sort
   within itself, so the far side of the body draws over the near side. The ambulance is 8,620
   triangles of bodywork on a BLEND material — the only *body* in either pack tagged that way,
   which is exactly why it alone looked broken while 19 vehicles looked fine. `cloneMaterial`
   now downgrades to OPAQUE unless the base-colour factor or the texture's alpha channel says
   otherwise. Watch the `opaque` line at the end of the run: it should name `ambulance` and
   nothing else. If it starts naming glass, the alpha test has broken.

6. **GLTFLoader renames multi-primitive meshes.** A mesh with three primitives becomes
   children named `<name>_1`, `<name>_2`, `<name>_3` — the base name never appears in the
   loaded scene, so a name lookup finds *nothing*. This is the third time this class of bug
   has bitten (see §4b.2 and the city chunks); role travels in `extras` -> `userData`.
7. **NPC bodies MUST be created declaratively (`<RigidBody>`), not imperatively.** Calling
   `world.createRigidBody()` from a `useEffect` throws *"recursive use of an object detected
   which would lead to unsafe aliasing in rust"* — the World is already borrowed at that
   point — and the app then spams the console and eventually loses the WebGL context. This is
   the §4.1 trap in a new place. Letting the library own creation is the only safe way in.
   (The dev-only React warning "final argument passed to useEffect changed size between
   renders" comes from rapier flattening a body's props straight into a dependency list; it
   is a library wart, not a bug in this code.)
8. **All Rapier writes happen in `useBeforePhysicsStep`, never `useFrame`.** Same reason.
   `Traffic.tsx` splits deliberately: simulation and `setNextKinematicTranslation` in the
   before-step callback, instance matrices in `useFrame`.
9. **Traffic is kinematic**, so the player cannot shunt a car aside — hitting one is like
   hitting a wall. Making them shovable needs dynamic bodies *and* a driver model to recover
   afterwards, which is a much bigger change.

**Steering was rewritten twice.** The second rewrite fixed a regression the first one caused,
which is worth reading before touching `trafficConfig.ts`:

> Curing the wiggle meant capping the yaw rate by a lateral-acceleration budget and raising
> `turnPenalty` to 24. Together those made cars **unable to corner**. At cruise the yaw cap
> implies a 14–38 m turning radius where a city junction needs 6–10 m, and at a penalty of 24
> any turn past 35° scored worse than driving straight on — the fan did not even reach past
> 35° to begin with. So cars drove straight across every junction and off the tarmac. Off the
> raster all nine probes read zero, every heading scores `-|offset| × turnPenalty`, and
> straight-on wins by default: **a car that left the road drove in a straight line for ever**,
> through buildings and off the map, and stopped getting a ground height so it appeared to
> fly. That is what "NPCs everywhere, jumping off buildings" was.
>
> The lesson: `turnPenalty` is *route choice*, and must never be used to buy smoothness —
> smoothness is `steerSmoothing` and the cornering budget. And a yaw cap is only survivable
> if the car also **slows down to earn the turn**; capping yaw alone just means understeering
> off the road.
>
> Five changes, each measured (see the harness below):
> 1. `turnPenalty` 24 → 10 and the fan widened to ±60°, so a junction turn can win.
> 2. Speed capped so the requested yaw fits `lateralAccel`, and by the braking distance into
>    the road actually visible.
> 3. Staying on tarmac made a guarantee: a step that would leave the road is refused, and a
>    car that strays heads for `nearestRoad` and is recycled if it cannot recover.
> 4. Lane aim is a quarter of the measured corridor width, not a fixed 3.2 m. A fixed offset
>    put both directions of travel within 1.6 m of each other on an 8 m street — inside the
>    obstacle cone — so oncoming cars saw each other, both braked to a halt and **deadlocked**.
>    Streets that narrow are over half the city.
> 5. Traffic queues only behind cars going the same way. Braking for oncoming traffic is the
>    same deadlock by another route.
>
> Also tried and **reverted, because it measured worse**: letting a boxed-in car scan the full
> circle for an escape. Gated on reach it fired on ordinary junction approaches and swung the
> heading wildly (stalls 59 → 92); gated on being stopped it oscillated between the
> full-circle pick and the fan (6.9 → 28 direction changes per car-minute).

**The first rewrite, after traffic shipped wiggling.** Three compounding causes,
all now fixed and worth not reintroducing: (a) the lane term fired when *either* kerb was
found, so in a junction the off side returned the probe limit, the error read as ~6 m and the
car cranked in a 29° correction *every step*; (b) the yaw target was applied with no damping
even though every input is quantised (3 m raster, 1.5 m probe steps, 0.5 m kerb steps); and
(c) the turn rate was a flat 1.1 rad/s regardless of speed, which at 12 m/s is an 11 m radius
— cars pivoted rather than steered. Yaw is now a damped rate limited by a lateral-acceleration
budget. Measured after: mean |yaw| 0.083 rad/s with about one direction change per car per
5 s, versus constant hunting before.

### The city's scale was wrong, and how it was fixed

`UNIT_SCALE` in `prepare-map.mjs` was **160** and should have been **100** — the whole city
was 1.6 × too large, which is why the player's car looked like a toy in it. The four original
references were all things with no fixed size (a tree, a "house", a "wall") or measured too
generously (a truck cab above its own legal height limit). Twelve specification-built
references — ISO containers, a bus shelter, a road sign, bins, a barrier, truck tyre diameter,
and the legal maximum dimensions of the map's two trucks — all land between 90 and 106.

The measurement needs no renderer and no vertex data: glTF `POSITION` accessors carry
`min`/`max`, so an object's world bounds come from the JSON chunk alone. That is worth
remembering — the source GLB is 188 MB but only its first few MB need reading.

Changing it moves everything expressed in world metres:

| where | what |
| --- | --- |
| `prepare-map.mjs` | `CELL` 400 → 250, `BOX_MAX_FOOTPRINT` 60 → 40, `BUILDING_CLEARANCE` 2.5 → 1.5 |
| `prepare-map.mjs` | `NAV_RESOLUTION` 3 → 1.5, and `RUN_CAP`/`BLOCK` re-derived in pixels to keep the metres they stand for |
| `trafficConfig.ts` | every distance × 0.625; `laneGain` ÷ 0.625, being radians per metre |
| `Environment.tsx` | fog 220/780 → 140/490 |

Speeds, accelerations, angles and times are real properties of a car and do **not** move. The
player's own car is unaffected: it is measured against the real McLaren, and the physics is
calibrated to it, so making the car bigger to fit an oversized city would have been the wrong
correction and would have broken the tuning.

Two traps found while retuning traffic afterwards:

1. **A threshold compared against a stepped probe can become dead code.** `kerbDistance` walks
   outward in `kerbStep` increments, so the smallest value it can *ever* report is the first
   step. After the rescale `kerbPanic` was 0.5 and the step was 0.5, so `right < kerbPanic`
   was unsatisfiable: no car ever noticed a kerb, they all drove into them, and the stall rate
   tripled. `kerbPanic` must stay above `kerbStep`, and it is commented as such.
2. **An emergency threshold must not overlap normal operation.** With the lane aim at ~1.75 m
   from the kerb and the panic at 1.2 m, the panic fired on 23–33 % of samples — during
   ordinary driving, not emergencies — which made steering twitchy and tripped the
   corner-speed limit constantly.

Things tried and rejected on measurement, so they are not retried: aiming a third of the
street width from the kerb instead of a quarter (no speed gain, twice the steering direction
changes); a 1 m/px nav raster (58 MB resident, too much); and lowering the NPC cruise speed to
6–10 or 5–9 m/s, which lowered the average without reducing the crawling at all — proof that
the crawling is junction geometry, not cars being driven too fast.

### Measuring traffic without a browser

The preview pane never gives the R3F canvas a layout size when it is hidden, so the scene does
not mount and **nothing dynamic can be measured there** — the canvas stays 300×150 and
`window` never sees the scene. Traffic is therefore checked headlessly, which is a better test
anyway: thousands of car-seconds, and it counts what the eye cannot.

The harness transpiles the real `trafficAI.ts` / `cityNav.ts` with the Babel that ships inside
`next` (there is no `esbuild` or `tsx` here, and Node is 20.9), decodes `cityNav.png` with
`sharp`, and injects it as the raster. It lives in the scratchpad, not the repo; rebuild it by
transpiling those two modules to CJS, appending a setter for the module-private `raster`, and
stepping `updateTraffic` at 1/60 with a player that follows the road.

Two traps that made earlier numbers wrong, both worth avoiding:

- **The PRNG in `trafficAI` is module-level and cannot be reset.** Running tuning variants in
  sequence in one process gives each a different spawn stream, so the comparison is
  meaningless. Run **one variant per process**.
- **A freed slot is refilled inside the same `updateTraffic` call**, so a naive before/after
  comparison never sees a range despawn and reads it as zero.
- The player must actually **drive**. A stationary player means nothing reaches the despawn
  radius, traffic piles up in the spawn ring and jams on itself.

Current numbers, 6,000 car-seconds at the corrected city scale: 0.00 % of car-steps off the
tarmac (worst stray 0.0 m), mean speed 5.06 m/s against an 8–13 m/s cruise, mean |yaw|
0.341 rad/s, 13.2 steering direction changes per car-minute, 56 cars recycled for stalling per
150 s. The stalls and the 26 % below 1 m/s are the honest remaining weakness. Note the
instrumented target speed is 7.1–7.7 m/s, i.e. the speed *limits* are not what holds cars
back — refused steps are, at 12–16 % of samples.

**Verified:** 40 cars spawn and hold steady; 35–38 of 40 sit on tarmac at any moment and
**zero off-road cars are ever stalled** — the handful off-mask are clipping a kerb mid-turn
and rejoining, not stuck. Average 28 km/h, peak 45 km/h. All 20 types render (84 instanced
batches) and face the right way — checked by parking vehicles at the player's own heading,
where a correctly oriented one shows its rear: blue sedan, cyan hatchback, fire truck
("ENGINE 33" on the back), school bus and city bus all pass. The school bus was demonstrably
reversed before the lights/glass rule and is correct after.

**Not verified:** frame cost with traffic on. The preview pane renders at ~0.5 fps (§2), so
the usual caveat applies — check real fps in a normal window before assuming 40 cars are
free.

## 4f. Sound

`useEngineSound.ts` (engine, driving scene) drives an AudioWorklet engine model —
`public/audio/engine-processor.js`: cylinders firing off a crank into two resonant exhaust
pipes, plus intake, valvetrain, blower/turbo, overrun pops, tyre and wind noise, a cockpit
muffle — with one `VOICES` entry per vehicle. Read the worklet's header first. It plays
no files. `useGarageAudio.ts` (music + UI SFX, garage screen) plays real files from
`public/audio/`, sourced from Pixabay (Content License — free for commercial and
non-commercial use, no attribution required) with the user's explicit per-file approval before
download, per this project's own download-permission policy. Files: `menu-music.mp3`,
`ui-click.mp3`, `ui-confirm.mp3`.

1. **The engine went through three approaches: pure oscillator synthesis, then two real
   recordings crossfaded, and now back to synthesis — done properly this time.** The
   recording-based version (`engine-idle.mp3`/`engine-high.mp3`, equal-power crossfaded,
   playback rate clamped to `[0.78, 1.65]`) was reported as sounding wrong, and it was: two
   *different* real cars swapping character at the crossfade point, `playbackRate` stretching
   each recording's own transients instead of genuinely raising its pitch, and — worst of all —
   every vehicle in the garage played the same pair, including the 4-tonne **electric** Hummer.
   `useEngineSound` now builds a small oscillator graph per drive and re-tunes it every frame
   straight from telemetry, with **no sample boundary anywhere**:
   - **Combustion cars**: `firing frequency = (rpm / 60) * order`, where `order` (firing pulses
     per crank revolution, cylinders/2 for a four-stroke) is one field of a per-vehicle
     `VOICES[id]` entry — a fundamental sawtooth plus a square 2nd harmonic and a sine
     sub-harmonic, through a lowpass filter that opens with load, plus filtered noise for grit.
     **Give every new car in the garage an entry in `VOICES`** (or it silently falls back to
     `DEFAULT_VOICE`, a generic order-4 note) — this is where a V12 gets to sound different
     from a diesel six.
   - **The Hummer (`hummer`) gets a completely different voice**, not just different tuning: a
     clean triangle-wave motor whine pitched from **`telemetry.speedKph`**, not the fake
     per-gear RPM sweep every combustion car's audio rides on. A single-speed reduction drive
     has no gearshift to dip for, so tying its pitch to the same sawtooth-shaped fake RPM signal
     the HUD uses would have reintroduced exactly the kind of wrongness this rewrite was fixing.
     **If another EV joins the garage, give it the electric voice too** (`type: 'electric'` in
     its `VOICES` entry) rather than leaving it on the combustion path by omission.
   - All parameter changes ride `AudioParam.setTargetAtTime`, not instant assignment, so a gear
     shift's RPM drop glides rather than clicks.
   - Verified by dispatching a synthetic `pointerdown` to trigger the lazy build (the pane's own
     `requestAnimationFrame` was not running at the time — see §6's frame-rate-check gotcha —
     so the normal physics-driven tick loop never called `voice.update()` on its own), then
     calling the voice's own `update()` directly across the RPM/speed range for each vehicle
     type (gas, diesel, electric) and confirming the `AudioContext` reached `running` (not stuck
     `suspended`) with no exceptions. The frequency/filter/envelope formulas were additionally
     hand-computed and cross-checked against the code for the McLaren's V12 profile.
2. **A script-dispatched `element.click()` does not satisfy the browser's autoplay gesture
   requirement — a real `computer`/CDP click does.** This cost a false "the music doesn't
   work" reading during verification: `tab.click()` via `javascript_tool` fired the React
   `onClick` (so `playClick()` ran and was audible in the network log) but never fired
   `pointerdown`, and even if it had, a synthetic click is not a *trusted* event, so
   `audio.play()` inside the gesture handler is silently refused. Driving the same click
   through the Browser tool's `computer` action (real CDP input) started the music
   immediately. If a future change to either audio hook "doesn't work" in an automated check,
   suspect the test's input method before the code.
3. **`useGarageAudio`'s mute preference needed the same hydration trick `GarageScreen` already
   uses for the remembered vehicle** — `useSyncExternalStore(subscribeNever, readMuted, () =>
   false)` for the read, with a separate local `chosen: boolean | null` layered on top for the
   toggle. The first version read `localStorage` inside a `useEffect` and called `setState`,
   which is exactly the cascading-render shape this project's lint (`react-hooks/set-state-in-
   effect`) forbids — and would have been a second, independent way to hit the same class of
   hydration mismatch `lastVehicleId` was already written to avoid.
6. **The click sound is pooled four `<audio>` elements, cycled round-robin**, not one shared
   element restarted per click. A single element cuts its own decay off when clicks arrive
   faster than the clip's length — arrow-key browsing does this trivially. Confirm has no pool
   (the DRIVE/RIDE button is never pressed rapidly enough to need one).
7. **`new Audio(...)` elements are not in the DOM.** `document.querySelectorAll('audio')`
   finds none of them, which looks like "nothing was created" during a quick check. They still
   play and are still real `HTMLAudioElement`s; verify via a temporary `window.__probe`
   assignment (removed before shipping — see the pattern used throughout this file) or via
   `read_network_requests` filtered to `/audio/`, not via DOM queries.

## 5. Track

`src/config/trackConfig.ts`. Centreline is a closed radial curve `r(θ)` from four harmonics,
`R = 210`, amplitudes summing to 0.52. Because `r` stays strictly positive the curve is
star-shaped about the origin and **cannot self-intersect** — a guarantee hand-placed control
points don't give. Tuned to a **1.44 km lap, tightest corner 18 m (~50 km/h hairpin),
fastest 266 m sweeper**.

**`trackNormal` must point outward** — `(tz, −tx)` for this counter-clockwise curve. The
inward convention silently inverts every ribbon's winding, which makes the road single-sided
facing **down** (i.e. completely invisible) and puts the grandstands in the infield. This was
a real bug; don't "simplify" it.

The road ribbon doubles as its own trimesh collider, so the wheels raycast exactly the
surface you see. Spawn is derived from the curve (`trackSpawn()`), not hard-coded — the world
origin is in the infield.

---

## 6. How to test dynamically (important)

There is **no debug bridge left in the code** — it was all removed during cleanup
(`SceneDebug.tsx` deleted, `window.__vehicle`/`__input`/`__raceDebug` and
`Vehicle.debugSet/debugRead` all gone). Drive through the real keyboard path instead:

```js
const key = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));
key('keydown', 'KeyR');   // reset
key('keydown', 'KeyW');   // throttle — release with keyup
```

Read speed from the DOM: `document.querySelector('.tabular-nums').textContent`.

**Always check frame rate before trusting anything dynamic:**

```js
let n = 0, stop = false;
const tick = () => { if (!stop) { n++; requestAnimationFrame(tick); } };
requestAnimationFrame(tick);
// ...after ~2s: n/2 should be ~60. If it's <5, the pane is hidden — results are void.
```

Note the `computer key` browser action did **not** deliver `code: 'KeyC'` reliably; dispatch
synthetic `KeyboardEvent`s instead. Also: `javascript_tool` times out at 30 s, so long runs
must be detached (assign to `window.__something` and poll).

**The frame-rate check above can itself hang instead of returning a low number.** When the
Browser pane is hidden (not the same as backgrounded-but-visible — `tabs_context` says so
explicitly), `requestAnimationFrame` was observed to never fire even once: an `await`-wrapped
version of the snippet above timed out the whole `javascript_tool` call at 45 s rather than
resolving with a small `n`. Don't `await` it directly — poll a detached counter instead, same
as any other long-running check. **`computer`'s coordinate-based click can also fail outright
in this state** (`"could not be attributed to a frame"`), even right after a screenshot that
appears to show the scene — the screenshot can be a forced repaint that doesn't reflect a live,
interactive frame. `tabs_select`ing the tab does not reliably fix either symptom. When a click
is needed only to satisfy this project's own gesture-gated code (not to test real pointer
hit-testing), dispatching a synthetic `PointerEvent('pointerdown')` on `window` sidesteps both
problems — it still reaches a plain `addEventListener` listener even though it isn't a
*trusted* event, which is all `useEngineSound`/`useGarageAudio`'s own lazy-build gate needs (see
§4f gotcha 2 for where trust *does* matter — actually starting audio playback).

If you need a lap-scale test again, the approach that worked was an autopilot: a P-controller
on heading error to a look-ahead point on the analytic centreline, with corner speed targets
from `curvatureRadius`. **Gotcha:** three.js `getWorldDirection()` returns the **+Z** axis,
which for this car is the *rear*. Negate it. That bug cost a debugging cycle and was in the
harness, not the app.

---

## 7. Verification status — be honest about this

**Verified:**
- Autopilot run: **0.77 laps, up to 155 km/h, suspension never bottomed (0% of samples)**,
  3.3% off-track, one auto-recovered incident.
- 0–100 km/h ≈ 3.1 s; gears and RPM sweep correctly; reverse; braking.
- All three cameras (screenshots of chase, close, cockpit); reset; brake lights.
- Skid marks: 43 quads laid on the racing surface, correctly suppressed on grass
  (instrumented), **and** confirmed visually as dark trails behind the rear wheels.
- Tyre smoke visible as soft puffs.
- **60 fps** measured at idle, accelerating, handbrake-sliding (smoke + marks active), and in
  cockpit. Heap 51 MB.
- Production build, typecheck, lint all clean.

**Not verified / known soft spots:**
- No full lap captured on video/screenshot at racing speed — the preview pane kept going
  hidden (see §2), throttling rAF. Physics now pauses while the tab is hidden, which is the
  correct fix but also blocks that kind of testing in the same environment.
- Front/rear weight distribution is mildly front-biased (collider centre at z = −0.19, from
  the body bbox). The real mid-engined F1 is ~42/58 rear. Attitude error is ~1.75° nose-down
  — visually negligible, but if you want authentic balance, bias the centre of mass rearward
  rather than moving the collider (which would leave the nose unprotected).
- Chassis collider bottom sits 0.10 m above the visual floor, so the body can visually clip a
  tall kerb without a collision. Curbs are 2.5 cm, so it doesn't show in practice.
- Not tested on a real mobile device; `TouchControls` mounts on `(pointer: coarse)` only.
- No lap timing / no opponents / no post-processing (all out of scope per the spec).

---

## 8. Deliberate decisions you might otherwise "fix"

- **`react-hooks/immutability` is disabled for `src/components/racing/**`, `src/hooks/**`,
  `src/physics/**`** (`eslint.config.mjs`, rationale inline). The rule forbids mutating
  anything a hook returned, which is exactly the zero-allocation `useFrame` pattern the spec
  demanded. It stays on for all UI. 25 errors otherwise.
- **No webfont.** `next/font/google` was removed from `layout.tsx` in favour of a system
  stack, to avoid a build-time network fetch.
- **`page.tsx` is `'use client'` with `dynamic(..., { ssr: false })`.** The scene builds
  canvas-backed textures during render and touches WebGL on mount; it cannot server-render.
- **Textures are procedural** (`textures.ts`, canvas-generated) and the **environment map is
  procedural** too — `drei`'s `Environment preset=` fetches an HDRI from a CDN, which is an
  external runtime dependency for something generatable in a few ms.
- **`shadows` uses the default PCFShadowMap.** `PCFSoftShadowMap` is deprecated in three
  r185+ and logs a warning.
- **The sun light follows the car** and snaps to a 2 m grid — a single shadow map can't cover
  1.4 km, and continuous movement makes shadow edges shimmer.
- **Physics pauses on `visibilitychange`.** Without it, returning to a backgrounded tab spends
  the accumulated delta on catch-up steps and flings the car off the circuit.
- **A cabin fill `pointLight`** is parented to the car. The roof self-shadows the interior
  almost black, which is physically right but made the cockpit camera unusable.

---

## 9. Git state

Repo has **one commit** (`a9079bd Initial commit from Create Next App`). Everything built in
this session is **uncommitted**: modified `README.md`, `eslint.config.mjs`, `package.json`,
`src/app/*`; untracked `scripts/`, `src/components/`, `src/config/`, `src/hooks/`,
`src/physics/`, `src/types/`, `public/models/`, `.claude/`, and the source `.glb`.

Nothing has been committed or pushed — the user never asked. Ask before committing.

Note `AGENTS.md`/`CLAUDE.md` contain a block that `next dev` rewrites; committing it with
your work keeps the tree clean.

---

## 10. Suggested next steps (none started)

- Lap timing + best-lap display in the HUD.
- Rear-biased centre of mass for authentic mid-engine balance (§7).
- Draco/meshopt compression on the GLB to get below 5.1 MB.
- Gamepad support (the spec mentioned it; only keyboard + touch exist).
- A real HDRI if the CDN dependency is acceptable, for better paint reflections.

## Quality presets and the train switch — and an R3F trap worth knowing

Added so a machine that cannot hold 60 has something to give up. `gameSettings` gained
`train` (a boolean) and `quality` (an index into `QUALITY_LEVELS`), the panel gained a row
for each, and `RacingScene` binds the level to the canvas.

1. **`<Canvas>` props beat effects, and this cost a debugging round.** The first version set
   the pixel ratio imperatively — `useThree(s => s.setDpr)` in an effect keyed on the level —
   on the reasoning that a prop only configures the renderer at creation. That is wrong: R3F
   **re-applies `dpr`, `shadows` and `camera` from the props on every re-render of the
   component that owns the canvas**. The measured symptom was exact and would have been very
   hard to guess at from the code: switching to LOW dropped the effective pixel ratio from
   1.75 to 1.0, and a render later it was silently back at 1.75. Anything a quality preset
   controls that has a canvas prop must live on that prop; the `Quality` component now holds
   only the two follow-ups a prop cannot express — `shadowMap.needsUpdate`, without which the
   already-rendered maps keep being sampled and the last frame's shadows stay painted on the
   ground after the pass is off, and `updateProjectionMatrix()` after a new far plane.
2. **Shadow resolution is not a prop either, for a different reason.** `shadow-mapSize` only
   decides how big the map is when three allocates it, on first use; writing a new size to a
   light that already has one does nothing. `SunLight` therefore sets the size and then
   disposes and drops `light.shadow.map` so the next frame allocates at the new size, and
   turns shadows off through the light's own `castShadow` — with no caster, three skips the
   pass.
3. **Fog is driven from a frame loop, so the preset has to go through it.** `Darkness` writes
   `fog.near`/`fog.far` every frame to fade the tunnels in and out, which means it overwrites
   anything set on the fog object. The open-air values now arrive as `openNear`/`openFar`
   props instead of the module constant, which is also what makes a preset change take effect
   one frame later with no special casing.
4. **The train switch gates the services only.** `TrainLine` renders the whole railway —
   bore fittings, bridges, piers, sleepers, portals, lineside and four trimesh colliders —
   plus two `<Service>` blocks. `trains` gates the two blocks and nothing else, on purpose:
   the stations, the pointwork and the island bridge are mounted separately and stand on that
   track.
5. **No `SETTINGS_VERSION` bump.** New fields are absent from stored blobs and fall back to
   their defaults in `loadSettings`, which is all they need; bumping the version would have
   reset every existing install's traffic level, which is the one thing that migration is
   for.
6. **Measured, not asserted** (same spot, same traffic, draw calls per frame and the share of
   frames missing a 60 Hz vsync): HIGH with trains 2,154 calls and 24% late; HIGH without
   trains 1,092 and 5.5%; LOW with trains 350 and 5%. Both machines here cap at 60, so the
   median frame time says nothing — the late-frame share is the signal. Re-measure that way
   rather than watching an FPS counter.

Not done, in rough order of what would pay next: no FPS or frame-time readout anywhere, so a
player has no way to see what a preset bought them; the quality levels do not touch texture
resolution, the environment map or the city's own chunk geometry, because none of those can
change without rebuilding the world; and there is no automatic first-run guess from
`hardwareConcurrency` or `devicePixelRatio`, which would be the obvious next step if people
do not find the panel.

## HUD redesign v3 — panels, no shadows

Third pass on the driving HUD, after two that the user judged "the same UI".
The brief was better contrast, a different layout, and **no text shadows**.

**Language** (`src/components/racing/hudTheme.ts`)
- `INK = {}` and `INK_FILTER = 'none'` — every text-shadow / drop-shadow in the
  HUD and menus is gone. Both tokens are kept as no-ops so the many `...INK`
  spreads still compile; don't add new uses.
- `PANEL` — `rgba(0,0,0,0.44)` with a 1 px light top edge, no blur — sits
  under every cluster; `PANEL_CUT` is a 12 px chamfer off the bottom-right
  corner. One shape everywhere. `PLATE`/`PLATE_CUT` are aliases to these.
  (An opaque 0.86 + blur version was tried and reverted on request: "less
  opacity".)
- Secondary type is solid (`muted #b9c9da`, `faint #7f93a9`), not translucent
  white, because it now always sits on the panel.
- `LABEL` — Barlow Condensed bold at 13–16 px, 0.12em tracking — replaces the
  9–10 px tracked system caps on every label (identity bar, route indicator,
  strip, odometer captions). This, plus the panel gradient being darkest on the
  left where text starts, is what made the type legible without shadows.
- `PANEL_CUT` is a parallelogram (both ends sheared 12 px) rather than a
  single chamfer — the "leaning forward" racing-game panel.
- `ACCENT` is the fixed cyan for every vehicle (per-category tint was tried and
  reverted on request).

**Layout** (`RacingHUD.tsx`)
- Top row is ONE flex row: identity bar (shrinks) · strip (centred in the
  remainder, max 520 px) · pause control (never shrinks). No more absolute
  width caps keeping three things apart.
- Identity bar: solid cyan category tag + name at 26 px + `1993 RWD` (hidden
  below `lg`) + camera with glyph (hidden below `md`). Name never truncates.
- Pause: icon-only hexagon, cyan outline, glow on hover (a labelled
  version was tried and rejected as "not gaming style").
- `RailPoints` is a panel under the identity bar, `whitespace-nowrap`.
- `HudStrip` is a panel (in flow, not absolute).
- **Minimap stays round** (a square version was tried and reverted on request):
  196 px disc, cyan ring with glow, heading + waypoint tab under it on a panel.
- Dial unchanged in shape; its disc is `rgba(0,0,0,0.44)`; odometer strip uses
  the panel.
- McLaren CC BY-NC credit lives in the pause menu subtitle, not the HUD.

**Game feel** (added on "make it even better")
- `@keyframes hud-in` (globals.css): each cluster slides in from 10 px above,
  staggered — top row 0 ms, route indicator 120 ms, map 200 ms, dial 280 ms.
- Ignition sweep (`RacingTacho`, `SWEEP_MS = 1400`): the needle runs to the
  redline and back on a sine on the first frames, then hands over to the
  engine (`max(live, sin)` so a moving car is never under-read).
- Speed digits 52 px, gear 22 px.
- Livery hatch: a 14 px diagonal-stripe sliver off the end of the category tag
  on the identity bar — the one decoration on the bar.
- Turnout schematic (`RailPoints`): a 64×26 SVG beside the action text —
  through road plus a branch that curves up for a left-hand turnout, down for
  right, converges for a JOIN; the route the train will take is in the mode
  ink, the other dim; branch hidden when no points are ahead.

**Detailing pass** (on "add more detailing")
- Identity bar shows category **glyph** · hatch · name · camera only —
  year/drive removed on request, and the category word replaced by a **Lucide icon** on
  the accent slab (`CATEGORY_ICON` in `RacingHUD.tsx`: Gauge / CarFront / Truck
  / TrainFront / Ship, 26 px, stroke 2.4). `lucide-react` was added to
  package.json for this. Two rounds of hand-drawn SVG glyphs were rejected
  before it — use the library for any further HUD iconography. A 2 px accent "speed line" trails out under
  the bar.
- Pause is a panel-cut button (accent leading edge, glyph, hatch tail) — the
  hexagon was rejected.
- (Corner-bracket `Frame` was added and then removed on request.)
- `HATCH` token: the diagonal-stripe sliver closes the identity tag, the pause
  button, the odometer plate and the heading tab.
- Strip has an icon **badge** in place of the bare edge bar: a 44 px slab in
  the level colour with a hatched tail, and a *contextual* Lucide icon —
  `StripMessage.icon` ∈ info/warn/station/train/limit/boost/air/flip (MapPin
  for the station, TrainFront for train-ahead, Gauge for a restriction, Flame
  for boost, Wind for airborne, RotateCcw for right-the-car); defaults to the
  level's mark. All icons are mounted and the current one shown by `display`,
  since the strip is written through refs, not re-rendered. Feeders in
  `hudFeeds.ts` set the icon.
- Minimap ring has a fixed lubber notch at the top.
- Below `lg` the identity bar drops the camera label and the strip drops its
  qualifier. The name is `truncate` with a 120 px floor and neither the bar's
  inner row nor the identity column has `min-w-0` (a `min-w-0` there let the
  clip-path swallow the name); the strip wrapper has `min-w-[260px]`. Measured
  at 800 px: name 138 px unclipped, strip whole, pause clear.

**Controls page** (`HelpPanel.tsx`) rebuilt: it was one long list that ran
off a laptop screen. Now a grid — 3 columns at `lg` (WASD + arrow clusters own
column 1, the four groups fill a 2×2), 2 at `md`, 1 below — and every key is a
`Key` keycap (dark body, lit face 3 px short of the bottom so the edge reads
as a key side; `wide` for SPACE/SHIFT/ESC/BACKSPACE). Bindings are
`{ keys: string[][], label }` — alternatives joined by "or", chords side by
side. The `Cluster` draws W/A/S/D and ↑/←/↓/→ as laid out on the keyboard with
the job under each column. `SubPage` takes `wide` (980 px) for this page.

Verified on `?car=mclaren` and `?car=train` in the pane with no console
errors; `tsc` + eslint clean. Pause/Settings pages keep the earlier restyle
(dark scrim, game-menu rows, cut-corner controls).

Browser-pane gotcha reconfirmed: reloading the same tab several times leaves a
black canvas (no console error) — open a fresh tab, and allow ~20 s for the
city map to load before judging a black scene.
