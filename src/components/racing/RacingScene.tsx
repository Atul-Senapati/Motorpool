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
import { BoatRide } from './BoatRide';
import { SeaTraffic } from './SeaTraffic';
import { RacingCamera, CAMERA_MODES } from './RacingCamera';
import { UiSoundProvider, useUiSound } from '@/hooks/useUiSound';
import { RAIL_CAMERA_MODES } from './RailCamera';
import { RacingEnvironment } from './Environment';
import { Warmup } from './Warmup';
import { RacingHUD } from './RacingHUD';
import type { MenuPage } from './PauseMenu';
import { Track } from './Track';
import { CityMap } from './CityMap';
import { Traffic } from './Traffic';
import { RailLoop } from './RailLoop';
import { METRO_ENABLED, STATION_ENABLED, UNDERGROUND_ENABLED } from '@/config/stationConfig';
import { POINTWORK_ENABLED } from '@/config/pointwork';
import { VILLAGE_ENABLED } from '@/config/villageConfig';
import { TRAIN_LINE_ENABLED } from '@/config/trainConfig';
import { TrainLine } from './TrainLine';
import { IslandStation } from './IslandStation';
import { Pointwork } from './Pointwork';
import { IslandVillage } from './IslandVillage';
import { IslandTown } from './IslandTown';
import { AirportIsland } from './AirportIsland';
import { TOWN_ENABLED } from '@/config/townConfig';
import { AIRPORT_ENABLED } from '@/config/airportConfig';
import { IslandBridge } from './IslandBridge';
import { ElevatedStation } from './ElevatedStation';
import { UndergroundStation } from './UndergroundStation';
import { TrainRide } from './TrainRide';
import { LoadingOverlay } from './LoadingOverlay';
import { TouchControls } from './TouchControls';
import { SkidMarks } from './SkidMarks';
import { TyreSmoke } from './TyreSmoke';
import { useEngineSound } from '@/hooks/useEngineSound';
import { useTrainSound } from '@/hooks/useTrainSound';
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
  const onRails = SELECTED.rail !== undefined;

  // A synthesised V12 on a tram would be absurd, and a tram has no engine note
  // worth faking, so the sound stays off for it.
  const engineMutedRef = useEngineSound(telemetry, !onRails, input, cameraModeRef);
  // A locomotive is not silent either; it just is not an engine note. See
  // `useTrainSound` for what it is instead. Whichever of the two is live is
  // the one the mute switch has to reach.
  const trainMutedRef = useTrainSound(telemetry, onRails, input, cameraModeRef);
  const mutedRef = onRails ? trainMutedRef : engineMutedRef;

  /**
   * Physics pauses while the tab is hidden. Browsers stop firing animation
   * frames for background tabs, so on return the accumulated delta would be
   * spent on a burst of catch-up steps and fling the car off the circuit.
   */
  const [paused, setPaused] = useState(false);
  /**
   * Whether the scene can be drawn without compiling something first. Set by
   * `Warmup`, and the only thing that lifts the loading curtain — see
   * `LoadingOverlay` for why drei's own progress was not enough.
   */
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);
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

  /**
   * The menu's voice. Built here because this is where the setting lives, and
   * handed down through `UiSoundProvider` to the controls that use it.
   */
  const playUi = useUiSound(settings.ui);
  const menuWasOpen = useRef(false);
  // One place for the pause sound, so every way of opening the menu — the key,
  // the HUD's button, RESUME, the browser losing focus — is heard, and none of
  // them has to remember to say so.
  useEffect(() => {
    const open = menu !== null;
    if (open === menuWasOpen.current) return;
    menuWasOpen.current = open;
    playUi(open ? 'open' : 'close');
  }, [menu, playUi]);

  // Switching the interface sound back ON is the one toggle that cannot make
  // its own noise — at the moment it is clicked the bank is still muted, so
  // the confirmation the other rows give you is exactly the one missing from
  // the row that turns them on. This gives it back.
  const uiWasOn = useRef(settings.ui);
  useEffect(() => {
    if (settings.ui && !uiWasOn.current) playUi('toggleUp');
    uiWasOn.current = settings.ui;
  }, [settings.ui, playUi]);

  const [cameraMode, setCameraMode] = useState<CameraMode>('chase');
  const [modeToken, setModeToken] = useState(0);
  const [resetToken, setResetToken] = useState(0);

  const cycleCamera = useCallback(() => {
    setCameraMode((current) => {
      // A rail vehicle cycles its own views: a cab, a nose, a lineside shot and
      // a drone, none of which mean anything on a car.
      const modes = SELECTED.rail ? RAIL_CAMERA_MODES : CAMERA_MODES;
      const next = modes[(modes.indexOf(current) + 1) % modes.length];
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
          {/* Inside the boundary, so it mounts once the models have resolved
              and compiles a scene that is actually complete. */}
          <Warmup onReady={handleReady} />
          <RacingEnvironment chassisRef={chassisRef} telemetry={telemetry} dark={SELECTED.rail === 'main'} />
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
            {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && <TrainLine trains={settings.train} />}
            {/* The crossovers between the two running lines, and a machine at
                every set of points. The station's loop lines are laid by the
                station itself — see `pointwork`. */}
            {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && POINTWORK_ENABLED && <Pointwork />}
            {/* The station stands on the railway's own made island, so it is
                part of the line rather than part of the city: no railway, no
                station. See `stationConfig` — it finds its own site. */}
            {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && STATION_ENABLED && <IslandStation />}
            {/* The road out to it. Solid, and the only way to drive there. */}
            {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && STATION_ENABLED && <IslandBridge />}
            {/* The hamlet on the smaller island, with a halt on the running
                line. Finds its own site — see `villageConfig`. */}
            {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && VILLAGE_ENABLED && <IslandVillage />}
            {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && TOWN_ENABLED && <IslandTown />}
            {/* Halcyon Field, out east. Not gated on the railway: it is its own
                island and has nothing to do with the line — see `airportConfig`. */}
            {WORLD_ID === 'city' && AIRPORT_ENABLED && <AirportIsland />}
            {/* Shipping. Only where there is a sea to put it on, which is the
                same condition the sea itself is drawn under. */}
            {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && <SeaTraffic />}
            {/* The elevated metro station on the street viaduct. Finds its own site. */}
            {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && METRO_ENABLED && <ElevatedStation />}
            {/* The underground station in the long tunnel. Finds its own site by cover. */}
            {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && UNDERGROUND_ENABLED && <UndergroundStation />}
            {TRAIN_LINE_ENABLED && SELECTED.rail === 'main' ? (
              <TrainRide
                input={input}
                telemetry={telemetry}
                chassisRef={chassisRef}
                cameraModeRef={cameraModeRef}
                carriages={settings.carriages}
              />
            ) : SELECTED.rail === 'tram' ? (
              <TramRide input={input} telemetry={telemetry} chassisRef={chassisRef} />
            ) : SELECTED.sea ? (
              // A boat replaces the physics path the same way a rail vehicle
              // does — there is no chassis, no wheel and no road under it.
              <BoatRide
                input={input}
                telemetry={telemetry}
                chassisRef={chassisRef}
                boat={SELECTED.sea}
              />
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
          {/* Nothing with wheels, nothing to leave: a boat would lay rubber
              on the sea. */}
          {!onRails && !SELECTED.sea && <SkidMarks chassisRef={chassisRef} telemetry={telemetry} />}
          {!onRails && !SELECTED.sea && <TyreSmoke chassisRef={chassisRef} telemetry={telemetry} />}

        </Suspense>
      </Canvas>

      <UiSoundProvider value={playUi}>
        <RacingHUD
          telemetry={telemetry}
          cameraMode={cameraMode}
          settings={settings}
          onSettingsChange={updateSettings}
          onExit={exitToGarage}
          menu={menu}
          onMenu={setMenu}
        />
      </UiSoundProvider>
      <TouchControls input={input} onCamera={cycleCamera} />
      <LoadingOverlay ready={ready} />
    </div>
  );
}
