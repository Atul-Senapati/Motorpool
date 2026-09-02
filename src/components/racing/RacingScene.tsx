'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Physics } from '@react-three/rapier';
import { ACESFilmicToneMapping, type Group } from 'three';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { WORLD_ID } from '@/config/world';
import { useKeyboardControls } from '@/hooks/useKeyboardControls';
import { createTelemetry } from '@/physics/vehiclePhysics';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import { CarPhysics } from './CarPhysics';
import { RacingCamera, CAMERA_MODES } from './RacingCamera';
import { RacingEnvironment } from './Environment';
import { RacingHUD } from './RacingHUD';
import { Track } from './Track';
import { CityMap } from './CityMap';
import { Traffic } from './Traffic';
import { LoadingOverlay } from './LoadingOverlay';
import { TouchControls } from './TouchControls';
import { SkidMarks } from './SkidMarks';
import { TyreSmoke } from './TyreSmoke';
import { useEngineSound } from '@/hooks/useEngineSound';

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
  const cameraModeRef = useRef<CameraMode>('chase');

  useEngineSound(telemetry);

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
        // Default PCFShadowMap: PCFSoftShadowMap is deprecated in three r185+.
        shadows
        dpr={[1, 1.75]}
        // `far` sits just past the fog's far plane (780 m), where everything is
        // already 100% fog colour and clipping cannot be seen. The old 1600 m
        // was harmless on a 1.4 km circuit but doubles the frustum depth, and
        // in the city that pulled ~1.9 M of the map's 2.96 M triangles into
        // every frame. The sky is unaffected: its shader pins depth to the far
        // plane rather than being clipped by it.
        camera={{ fov: 62, near: 0.25, far: 820, position: [0, 4, 12] }}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
      >
        <Suspense fallback={null}>
          <RacingEnvironment chassisRef={chassisRef} />
          <Physics timeStep={PHYSICS_TIMESTEP} gravity={[0, -9.81, 0]} paused={paused}>
            {WORLD_ID === 'city' ? <CityMap /> : <Track />}
            {WORLD_ID === 'city' && <Traffic telemetry={telemetry} />}
            <CarPhysics input={input} telemetry={telemetry} chassisRef={chassisRef} />
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
          <SkidMarks chassisRef={chassisRef} telemetry={telemetry} />
          <TyreSmoke chassisRef={chassisRef} telemetry={telemetry} />
        </Suspense>
      </Canvas>

      <RacingHUD telemetry={telemetry} cameraMode={cameraMode} />
      <TouchControls input={input} onCamera={cycleCamera} />
      <LoadingOverlay />
    </div>
  );
}
