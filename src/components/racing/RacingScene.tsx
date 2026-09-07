'use client';

import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Physics, type RapierRigidBody } from '@react-three/rapier';
import { ACESFilmicToneMapping, type Group } from 'three';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { WORLD_ID } from '@/config/world';
import { CAR_PARAM, SELECTED } from '@/config/garage';
import { useKeyboardControls } from '@/hooks/useKeyboardControls';
import { createTelemetry } from '@/physics/vehiclePhysics';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import { CarPhysics } from './CarPhysics';
import { TramRide } from './TramRide';
import { RacingCamera, CAMERA_MODES } from './RacingCamera';
import { RacingEnvironment } from './Environment';
import { RacingHUD } from './RacingHUD';
import type { MenuPage } from './PauseMenu';
import { Track } from './Track';
import { CityMap } from './CityMap';
import { Traffic } from './Traffic';
import { RailLoop } from './RailLoop';
import { LoadingOverlay } from './LoadingOverlay';
import { TouchControls } from './TouchControls';
import { SkidMarks } from './SkidMarks';
import { TyreSmoke } from './TyreSmoke';
import { useEngineSound } from '@/hooks/useEngineSound';
import {
  TRAFFIC_LEVELS, serverSettingsSnapshot, settingsSnapshot, subscribeSettings, updateSettings,
} from './gameSettings';

/**
 * Watches the input ref for the edge-triggered camera key and lifts it into
 * React state. Lives inside the Canvas because that's where the frame loop is;
 * camera changes are rare so a state update here is free.
 */
function CameraCycleWatcher({
  input,
  onCycle,
}: {
  input: ReturnType<typeof useKeyboardControls>;
  onCycle: () => void;
}) {
  useFrame(() => {
    if (input.current?.cameraCycleRequested) {
      input.current.cameraCycleRequested = false;
      onCycle();
    }
  });
  return null;
}

/**
 * Notifies the camera rig when the car has been teleported back to the grid, so
 * it re-seats itself instead of sweeping across the whole circuit to catch up.
 */
function ResetWatcher({ input, onReset }: { input: ReturnType<typeof useKeyboardControls>; onReset: () => void }) {
  const seen = useRef(false);
  useFrame(() => {
    const requested = input.current?.resetRequested ?? false;
    // The physics step consumes the flag, so react to the rising edge only.
    if (requested && !seen.current) onReset();
    seen.current = requested;
  });
  return null;
}

export function RacingScene() {
  const input = useKeyboardControls();
  const telemetry = useRef<VehicleTelemetry>(createTelemetry());
  const chassisRef = useRef<Group | null>(null);
  /** Shared so Traffic can recognise a hit from the player specifically. */
  const playerBodyRef = useRef<RapierRigidBody | null>(null);
  const cameraModeRef = useRef<CameraMode>('chase');

  /**
   * A rail vehicle rides the tram loop instead of being driven as a car: it
   * replaces the whole physics path rather than configuring it. See `TramRide`.
   */
  const onRails = SELECTED.rail === true;

  // A synthesised V12 on a tram would be absurd, and a tram has no engine note
  // worth faking, so the sound stays off for it.
  const mutedRef = useEngineSound(telemetry, !onRails);

  /**
   * Physics pauses while the tab is hidden. Browsers stop firing animation
   * frames for background tabs, so on return the accumulated delta would be
   * spent on a burst of catch-up steps and fling the car off the circuit.
   */
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const update = () => setPaused(document.visibilityState === 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  /**
   * Back to the picker, from either the G key or the HUD button.
   *
   * Clearing `?car=` is what makes `page.tsx` show the garage again — the
   * selection lives in the URL, not in state, so this is a navigation rather
   * than a state change. Shared by both entry points so the key and the button
   * can never come to mean different things.
   */
  const exitToGarage = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete(CAR_PARAM);
    const query = params.toString();
    window.location.href = window.location.pathname + (query ? `?${query}` : '');
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyG' || event.metaKey || event.ctrlKey || event.altKey) return;
      exitToGarage();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [exitToGarage]);

  /**
   * The pause menu. Open means the world is paused — physics, traffic, trams —
   * and the engine is silent; that is what separates a pause menu from a
   * dialog drawn over a game that is still running. Escape toggles it; H opens
   * it straight onto the controls page.
   */
  const [menu, setMenu] = useState<MenuPage | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Escape') setMenu((open) => (open ? null : 'menu'));
      else if (event.code === 'KeyH') setMenu((open) => (open === 'controls' ? null : 'controls'));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** Player settings. See `gameSettings` for why this is an external store. */
  const settings = useSyncExternalStore(
    subscribeSettings, settingsSnapshot, serverSettingsSnapshot,
  );

  // The sound graph owns its own mute flag so the audio thread can read it
  // without a re-render; the setting drives that flag rather than replacing it.
  useEffect(() => {
    mutedRef.current = !settings.audio || menu !== null;
  }, [mutedRef, settings.audio, menu]);

  const [cameraMode, setCameraMode] = useState<CameraMode>('chase');
  const [modeToken, setModeToken] = useState(0);
  const [resetToken, setResetToken] = useState(0);

  const cycleCamera = useCallback(() => {
    setCameraMode((current) => {
      const next = CAMERA_MODES[(CAMERA_MODES.indexOf(current) + 1) % CAMERA_MODES.length];
      cameraModeRef.current = next;
      return next;
    });
    setModeToken((token) => token + 1);
  }, []);

  // Keep the ref in sync for the frame loop, which must not read React state.
  useEffect(() => {
    cameraModeRef.current = cameraMode;
  }, [cameraMode]);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#0b0d10]">
      <Canvas
        /**
         * The whole grade, in one place: a little brighter, a little more
         * contrast.
         *
         * A CSS filter rather than a post-processing pass. This replaced an
         * `EffectComposer` running bloom, chromatic aberration, a vignette,
         * grain and SMAA — and SMAA was only in there to undo the damage the
         * composer itself caused, because routing the scene through one throws
         * away the canvas's own MSAA. Doing it here is a single compositor blit
         * on a frame that is already on the GPU, it keeps `antialias: true`
         * doing its job, and it costs no render target on a 3 M triangle scene.
         *
         * Brightness proper lives in `toneMappingExposure` below, which lifts
         * the image before the tone curve instead of multiplying it after and
         * clipping the highlights; this is only the last bit of polish on top.
         */
        style={{ filter: `brightness(${settings.brightness}) contrast(${settings.contrast})` }}
        // Default PCFShadowMap: PCFSoftShadowMap is deprecated in three r185+.
        shadows
        dpr={[1, 1.75]}
        // `far` sits just past the fog's far plane (815 m), where everything is
        // already 100% fog colour and clipping cannot be seen. The old 1600 m
        // was harmless on a 1.4 km circuit but doubles the frustum depth, and
        // in the city that pulled ~1.9 M of the map's 2.96 M triangles into
        // every frame. The sky is unaffected either way: it is an
        // equirectangular texture on `scene.background`, which three draws
        // without depth-testing it against anything.
        camera={{ fov: 62, near: 0.25, far: 820, position: [0, 4, 12] }}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          toneMapping: ACESFilmicToneMapping,
          // Lifted from 1.05. ACES holds highlights back hard, and the city
          // reads as an overcast afternoon at the old value even on a clear
          // sky; this is the one knob that brightens the scene itself rather
          // than brightening a filter laid over it.
          toneMappingExposure: 1.22,
        }}
      >
        <Suspense fallback={null}>
          <RacingEnvironment chassisRef={chassisRef} />
          <Physics timeStep={PHYSICS_TIMESTEP} gravity={[0, -9.81, 0]} paused={paused || menu !== null}>
            {WORLD_ID === 'city' ? <CityMap /> : <Track />}
            {WORLD_ID === 'city' && (
              <Traffic
                telemetry={telemetry}
                playerBodyRef={playerBodyRef}
                activeLimit={TRAFFIC_LEVELS[settings.traffic].cars}
              />
            )}
            {WORLD_ID === 'city' && <RailLoop trams={settings.trams} />}
            {onRails ? (
              <TramRide input={input} telemetry={telemetry} chassisRef={chassisRef} />
            ) : (
              <CarPhysics
                input={input}
                telemetry={telemetry}
                chassisRef={chassisRef}
                playerBodyRef={playerBodyRef}
              />
            )}
          </Physics>
          <RacingCamera
            chassisRef={chassisRef}
            telemetry={telemetry}
            modeRef={cameraModeRef}
            modeChangeToken={modeToken}
            resetToken={resetToken}
          />
          <CameraCycleWatcher input={input} onCycle={cycleCamera} />
          <ResetWatcher input={input} onReset={() => setResetToken((token) => token + 1)} />
          {/* Steel on steel leaves no rubber and makes no tyre smoke. Both of
              these read per-wheel slip, which a rail vehicle does not have. */}
          {!onRails && <SkidMarks chassisRef={chassisRef} telemetry={telemetry} />}
          {!onRails && <TyreSmoke chassisRef={chassisRef} telemetry={telemetry} />}

        </Suspense>
      </Canvas>

      <RacingHUD
        telemetry={telemetry}
        cameraMode={cameraMode}
        settings={settings}
        onSettingsChange={updateSettings}
        onExit={exitToGarage}
        menu={menu}
        onMenu={setMenu}
      />
      <TouchControls input={input} onCamera={cycleCamera} />
      <LoadingOverlay />
    </div>
  );
}
