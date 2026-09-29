'use client';

import { useEffect, useRef } from 'react';
import { useProgress } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { CubeCamera, WebGLCubeRenderTarget, type DirectionalLight, type Object3D } from 'three';

/**
 * Compiles every shader and uploads every texture *behind the loading curtain*,
 * so the first minute of play is not spent doing it a frame at a time.
 *
 * This exists because of a measurement. Hooking `linkProgram` on a production
 * build showed **114 WebGL programs, every single one of them linked after the
 * loading overlay had gone**, spread from 8 to 14 seconds into gameplay. Three
 * puts a material's program together the first time something is actually
 * drawn with it, so every bridge, tunnel lining, station, livery and vehicle
 * type you had not yet met cost a compile at the moment it came into view.
 *
 * On this machine that is invisible: 8 ms for all 114, because ANGLE on Metal
 * compiles off the hot path. On a low-end Windows laptop the same 114 go
 * through ANGLE to HLSL and then to the D3D driver, tens to hundreds of
 * milliseconds each, and they land *while the player is driving*. That is the
 * reported bug exactly — "it lags a lot at first, then after a while it
 * smooths out". The compiles finish, and the game was never slow, only cold.
 *
 * Three details matter and each cost something to find:
 *
 *  - **Hidden objects must be shown first.** `compile` walks the graph and
 *    skips anything invisible, which would leave precisely the things that
 *    appear later — the ones that hitch — uncompiled. They are flipped back
 *    immediately afterwards.
 *  - **Shadow programs are separate programs.** A material's depth variant is
 *    built when the shadow pass first draws it, so compiling the scene is only
 *    half the job; one forced shadow render covers the other half.
 *  - **It must not be able to hang the game.** `compileAsync` is a promise, and
 *    a promise that never settles would leave the curtain up for ever, so the
 *    caller is told the scene is ready on a timeout regardless. A hitchy game
 *    is a bad game; a game that never starts is not a game.
 *
 * And one that cost a whole measurement round: **it must wait for the scene to
 * stop growing.** Mounting inside `<Suspense>` is not late enough. Plenty here
 * arrives after the boundary resolves — `TrainLine` rebuilds its geometry once
 * the nav raster lands, the stations and the village find their own sites, the
 * sea appears — so a compile at mount warmed a third of a world. Measured: the
 * pass reported "compiled in 0.9s" while programs went on linking until 17.7s,
 * which is to say it had done nothing useful. So the scene is counted every
 * `POLL_MS` and the compile waits for the count to hold still, with drei's
 * loader progress as a second opinion.
 */
/** How often the scene is counted while waiting for it to settle. */
const POLL_MS = 250;
/** How often the watcher looks for streamed-in geometry, once playing. */
const WATCH_MS = 1500;
/**
 * Consecutive polls with an unchanged object count that mean "settled". Four
 * is a second: long enough that a gap between two components mounting does not
 * read as the end of loading, short enough not to be felt.
 */
const STABLE_POLLS = 12;

/**
 * How much the scene has to grow, in objects, before it is worth compiling
 * again after the curtain has gone.
 *
 * The world streams: city chunks arrive as you drive, and the stations and the
 * village place themselves once their site is known. Measured, that kept new
 * programs linking until 35 seconds in — long after any "everything is loaded"
 * moment. So warming is not an event, it is a habit: the watcher below keeps
 * an eye on the count and compiles the newcomers *before* something draws them,
 * which is the difference between a compile that yields and one that lands in
 * the middle of a frame.
 */
const REGROW_OBJECTS = 40;

export function Warmup({ onReady, timeoutMs = 40000 }: {
  /** Called once the scene is genuinely ready to draw — or once it has run out of patience. */
  onReady: () => void;
  timeoutMs?: number;
}) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  // Drei's loader progress. Not sufficient on its own — it is false before the
  // first loader starts and true again the moment the last byte lands, both of
  // which are why the curtain used to lift at 1.2 seconds — but as one of two
  // conditions it usefully rules out "still downloading".
  const { active } = useProgress();
  const activeRef = useRef(active);
  // Written in an effect, not during render: the React Compiler lint rejects a
  // ref write in the render body, and it is right to — the same rule the
  // settings store and the garage's remembered vehicle are built around.
  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    let done = false;
    let cancelled = false;
    const started = performance.now();
    /**
     * Logged like `CityMap`'s and `Traffic`'s own one-liners, and for the same
     * reason: this is the number to look at when someone reports stutter. A
     * `timeout` reason means the compile never finished and the player was let
     * in anyway — expect hitching, and go looking for why.
     */
    const finish = (reason: 'compiled' | 'timeout') => {
      if (done) return;
      done = true;
      console.info(`[warmup] scene ${reason} in ${((performance.now() - started) / 1000).toFixed(1)}s`
        + ` (${(performance.now() / 1000).toFixed(1)}s into the page)`);
      onReady();
    };

    // The backstop. Whatever happens below, the player gets into the game.
    const timer = window.setTimeout(() => finish('timeout'), timeoutMs);

    const countObjects = () => {
      let n = 0;
      scene.traverse(() => { n += 1; });
      return n;
    };

    const run = async () => {
      // Wait for the world to stop arriving. `activeRef` rather than `active`
      // because this runs once and must see the current value, not the one
      // captured when it started.
      let last = -1;
      let stable = 0;
      while (!cancelled && !done && (stable < STABLE_POLLS || activeRef.current)) {
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
        const n = countObjects();
        stable = n === last ? stable + 1 : 0;
        last = n;
      }
      if (done) return;

      const hidden: Object3D[] = [];
      scene.traverse((object) => {
        if (!object.visible) {
          hidden.push(object);
          object.visible = true;
        }
      });

      try {
        // `compileAsync` yields between programs, so the curtain keeps
        // animating instead of the tab going white for several seconds.
        await gl.compileAsync(scene, camera);
      } catch {
        // An older three, or a driver that refused: the synchronous path still
        // warms everything, it just blocks while it does.
        try { gl.compile(scene, camera); } catch { /* nothing more to try */ }
      } finally {
        for (const object of hidden) object.visible = false;
      }

      /**
       * The shadow pass's own programs, and the first texture uploads.
       *
       * The sun's shadow camera is a 76 m box that travels with the car, so a
       * shadow render at its normal size only builds depth variants for what
       * happens to be beside you right now — and everything else builds its
       * own the moment it enters that box, which is a hitch ten seconds into
       * the drive when a tram comes round. Widening it for this one render
       * puts a few hundred metres of city through the depth path instead. The
       * program does not depend on the box's size, only on the material, so
       * the variants are built once here and the box goes straight back.
       */
      try {
        const sun = scene.getObjectByProperty('isDirectionalLight', true) as DirectionalLight | undefined;
        const shadowCamera = sun?.shadow?.camera;
        const saved = shadowCamera && {
          left: shadowCamera.left, right: shadowCamera.right,
          top: shadowCamera.top, bottom: shadowCamera.bottom, far: shadowCamera.far,
        };
        if (shadowCamera) {
          shadowCamera.left = -400; shadowCamera.right = 400;
          shadowCamera.top = 400; shadowCamera.bottom = -400; shadowCamera.far = 1400;
          shadowCamera.updateProjectionMatrix();
        }
        gl.shadowMap.needsUpdate = true;
        gl.render(scene, camera);
        if (shadowCamera && saved) {
          Object.assign(shadowCamera, saved);
          shadowCamera.updateProjectionMatrix();
          gl.shadowMap.needsUpdate = true;
        }
      } catch { /* the render loop will do it a frame later */ }

      /**
       * Then the same thing from six directions at once.
       *
       * `compileAsync` builds a program per material; it does not build the
       * *variants*. A material gets a different program when it is first drawn
       * into the shadow map, and the sun's shadow camera is a 76 m box that
       * travels with the car — so objects compile their depth variant as they
       * enter it, which measured as 48 programs still linking around thirty
       * seconds in, well into play. A cube render covers the ground the
       * forward camera cannot: 64 px a face costs nothing in fill, and every
       * face is a real render, so the variants get built here instead of under
       * a wheel three streets later.
       */
      try {
        const target = new WebGLCubeRenderTarget(64);
        const probe = new CubeCamera(0.3, 900, target);
        probe.position.copy(camera.position);
        scene.add(probe);
        probe.update(gl, scene);
        scene.remove(probe);
        target.dispose();
      } catch { /* best effort — the forward pass already did the bulk */ }

      window.clearTimeout(timer);
      finish('compiled');

      // From here the curtain is gone and the player is driving, so every
      // further pass is silent and asynchronous.
      let known = countObjects();
      while (!cancelled) {
        await new Promise((resolve) => window.setTimeout(resolve, WATCH_MS));
        if (cancelled) break;
        const n = countObjects();
        if (n <= known + REGROW_OBJECTS) { known = Math.max(known, n); continue; }
        const grew = n - known;
        known = n;
        try {
          await gl.compileAsync(scene, camera);
          console.info(`[warmup] compiled ${grew} streamed objects (${n} in the scene)`);
        } catch { /* the draw will compile it, as it always did */ }
      }
    };

    void run();

    return () => {
      window.clearTimeout(timer);
      done = true;
      cancelled = true;
    };
    // Once, on mount — which, inside `<Suspense>`, is after the models resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
