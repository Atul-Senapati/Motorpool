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
   fatal in an 8.8 km city: past 500 m from the origin you see culled back-faces, i.e. a
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

`public/models/cityNav.png` (2613 × 1214 @ 3 m/px, 500 KB) is generated by the same script.
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
- The 60 m box-vs-trimesh threshold is a judgement call, not a measurement. 2,786 of 2,937
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

   The shipped rule uses the last two together: trust the glass normal when |z| > 0.25 (a
   cab-forward vehicle, where the windscreen dominates and the lights lie), otherwise the
   lights, falling back to glass when the lights are within 10%. `npm run prepare:vehicles`
   prints the decision and both signals per vehicle. If one is still wrong, put its name in
   `FLIP` — do not invent a sixth heuristic.

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

**Steering was rewritten once, after traffic shipped wiggling.** Three compounding causes,
all now fixed and worth not reintroducing: (a) the lane term fired when *either* kerb was
found, so in a junction the off side returned the probe limit, the error read as ~6 m and the
car cranked in a 29° correction *every step*; (b) the yaw target was applied with no damping
even though every input is quantised (3 m raster, 1.5 m probe steps, 0.5 m kerb steps); and
(c) the turn rate was a flat 1.1 rad/s regardless of speed, which at 12 m/s is an 11 m radius
— cars pivoted rather than steered. Yaw is now a damped rate limited by a lateral-acceleration
budget. Measured after: mean |yaw| 0.083 rad/s with about one direction change per car per
5 s, versus constant hunting before.

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
