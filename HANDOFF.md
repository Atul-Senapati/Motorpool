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

Source asset: `mclaren_f1_1993_by_alex.ka..glb` (13.3 MB, in repo root, untracked).
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

## 4a-iii. Replacing the tram model (Melbourne C-class)

The tram was a Gold Coast G:link Flexity 2; it is now a Melbourne C-class (Alstom Citadis
202) in Yarra Trams livery. `prepare-tram.mjs` was rewritten for it and is where all of this
lives. **Read that file before touching the tram asset** — it is heavily commented because
most of what it does is non-obvious, and several of its constants encode a failure.

1. **The interior is found by measurement, not by a list of mesh names.** The script
   rasterizes the model from 26 directions with its own z-buffer and keeps only meshes that
   win pixels. Glass is treated as opaque *on purpose*: that is what makes everything behind
   a window come out invisible, so seats, grab rails, hanging straps, driver's cabs and
   gangway frames — 2.34 M triangles of the source's 2.86 M — fall out without being named.
   The source's node names are useless for this (every mesh is called `Material2` or
   `Material3`), which is why the test exists at all.
2. **Two things the visibility test got wrong first, both now encoded as constants:**
   - `VIEW_ELEVATION` makes the viewpoints a **hemisphere**. With a full sphere it kept 45 k
     triangles of bogie frames and brake discs visible only from beneath the road.
   - **Glazing is exempt from `MIN_VISIBLE_PX`.** An opaque-rasterized test under-counts a
     pane you look *through*; culling glass on those numbers punched the windows out and left
     the inside of the far wall showing through the holes.
3. **The body is cut into three sections at the real bellows**, found by profiling the body's
   waist-height half-width along its length: it dips from 51.1 to 45.5 source units in two
   narrow bands at ±174.5 units from the centre. Unlike the Flexity, this export is authored
   per *material* — every mesh spans the whole vehicle — so sections cannot be made by
   re-parenting nodes, and the triangles have to be bucketed by centroid. `JOINT_OVERLAP`
   makes each section reach past its own cut so neighbours overlap inside the bellows.
4. **It does not decimate. Do not assume you can just turn the error up.** The bodyshell is a
   lattice of thin window and door frames and meshoptimizer will not collapse a border edge,
   so nearly every triangle is locked. Measured: 2 % error bought 12 %; 5 % bought 25 % but
   broke the livery swooshes into dashes and shortened the nose by most of a metre; unlocking
   borders let the shell bridge across its own window openings and sprayed white slivers over
   every pane. All three were rendered before being rejected — `SIMPLIFY_ERROR` sits at 0.5 %
   deliberately. What *does* help is `NEEDLE_ASPECT`, which drops the export's flat ribbons
   (centimetres wide, metres long) radiating from the pantograph; they read as white slashes
   across the roof otherwise. Set it too low (80) and it takes the pantograph's own rods with
   it and leaves a solid white fin.
5. **The result costs 391 k triangles, 6× the tram it replaced**, so `TRAM.count` went from
   five service trams to **three** to keep the line near 1.2 M rather than 2 M. That is the
   single number to change if the frame rate allows more; nothing else depends on it.
6. **Two easy things to forget when swapping a vehicle model:** `GarageThumbs`'
   `CACHE_VERSION` has to be bumped or every returning visitor keeps the old picture in
   `localStorage` (it went to `v5`), and `RAIL.minTramGap` / `tramFollowZone` /
   `TRAM.sectionCollider` are all in metres tuned to the *previous* vehicle's length.
7. **Known rough edge:** the roof around the pantograph still has some untidy geometry from
   the source export that the needle filter does not catch. It reads acceptably at street
   and chase-camera distance, and was left rather than hand-edited.

**Scaling has no single right answer here.** The export is not proportioned to the real
vehicle — length, width and height rulers disagree by about 13 % — so `REAL_WIDTH` was
chosen: width is what `railConfig`'s clearances are reasoned about, since the rails are laid
at 1.44 m gauge down real streets. Needles are excluded from that measurement too, because
the edge-overlay ribbons reach past the bodywork and scaled the real body down by 6 %.

## 4b. The city map — traps found while integrating it

Added after the original build. Source `drive_for_speed_-_map.glb` (188 MB, repo root,
untracked) → `public/models/city.glb` (17.5 MB) + generated `src/config/cityData.json`, via
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

`public/models/cityNav.png` (3265 × 1516 @ 1.5 m/px, 752 KB) is generated by the same script.
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
   to a point *inside a building*. Boxes near local ground now clear the mask with 2.5 m of
   clearance (48,315 px, 20% of the mask). Only near-ground boxes clear, so a raised deck
   does not erase the street beneath it.
3. **The raster must be cropped to where ground actually exists.** A few stray primitives
   stretch the world bbox, which left the city filling under half the image — dead space the
   minimap scrolls through and the full map wastes screen on. Cropping moves the origin, so
   the georeferencing in `cityData.json` has to follow it.
4. **`M` already toggled engine mute** (`useEngineSound.ts`). Binding the map to `M` fired
   both. Mute moved to `K`; the help panel now lists it, which it never did before.

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

`npm run prepare:vehicles` turns the two packs (78.8 MB, repo root, untracked) into
`public/models/vehicles.glb` (2.66 MB) + generated `src/config/vehicleCatalogue.json`.
20 vehicles, 40 cars on the road at once. Read `physics/trafficAI.ts` first, then
`components/racing/Traffic.tsx`.

**Asset traps:**

1. **The two packs are structured differently.** Passenger cars keep wheels as loose
   `Wheel_A..H` nodes that are *siblings* of the bodies; service vehicles have them baked
   into the body mesh. Ten cars therefore have spinning wheels and ten do not.
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

4. **GLTFLoader renames multi-primitive meshes.** A mesh with three primitives becomes
   children named `<name>_1`, `<name>_2`, `<name>_3` — the base name never appears in the
   loaded scene, so a name lookup finds *nothing*. This is the third time this class of bug
   has bitten (see §4b.2 and the city chunks); role travels in `extras` -> `userData`.
5. **NPC bodies MUST be created declaratively (`<RigidBody>`), not imperatively.** Calling
   `world.createRigidBody()` from a `useEffect` throws *"recursive use of an object detected
   which would lead to unsafe aliasing in rust"* — the World is already borrowed at that
   point — and the app then spams the console and eventually loses the WebGL context. This is
   the §4.1 trap in a new place. Letting the library own creation is the only safe way in.
   (The dev-only React warning "final argument passed to useEffect changed size between
   renders" comes from rapier flattening a body's props straight into a dependency list; it
   is a library wart, not a bug in this code.)
6. **All Rapier writes happen in `useBeforePhysicsStep`, never `useFrame`.** Same reason.
   `Traffic.tsx` splits deliberately: simulation and `setNextKinematicTranslation` in the
   before-step callback, instance matrices in `useFrame`.
7. **Traffic is kinematic**, so the player cannot shunt a car aside — hitting one is like
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

`useEngineSound.ts` (engine, driving scene) synthesizes its note live via Web Audio; it plays
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
4. **The click sound is pooled four `<audio>` elements, cycled round-robin**, not one shared
   element restarted per click. A single element cuts its own decay off when clicks arrive
   faster than the clip's length — arrow-key browsing does this trivially. Confirm has no pool
   (the DRIVE/RIDE button is never pressed rapidly enough to need one).
5. **`new Audio(...)` elements are not in the DOM.** `document.querySelectorAll('audio')`
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
