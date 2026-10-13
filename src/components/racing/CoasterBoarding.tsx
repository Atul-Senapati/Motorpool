'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { DoubleSide, type Mesh } from 'three';
import { SELECTED } from '@/config/garage';
import { HELI_GROUND, heliWorld } from '@/config/heliportConfig';
import { COASTER_RING } from '@/config/parkConfig';
import { COASTER_VIEW_NAMES, boardCoaster, coasterRide, cycleCoasterView } from '@/physics/coasterRide';
import { offerPortal } from '@/physics/portals';
import type { VehicleTelemetry } from '@/types/vehicle';
import { COLOUR, HEIGHT, RADIUS, makeHalo } from './StationBoarding';

/**
 * Halcyon Pier's roller coaster: the blue halo at the end of the cross walk,
 * at the foot of the coaster's station. Drive in and the HUD offers ENTER ·
 * RIDE THE ROLLER COASTER, which sits the camera in the front car of the first
 * train, at the platform, two seconds before it pulls out. It goes round for
 * as long as you like; C cycles the views (front seat, back seat, chase,
 * trackside, aerial) and Enter again gets you off, back in your own vehicle,
 * which never left the halo.
 *
 * The same halo, offer and Enter key as the train's station rings
 * (`StationBoarding`) and the heliport's (`HeliportBoarding`).
 */

/** Keys that would drive the parked car, or switch it, while you are on the ride. */
const HELD_OFF = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE', 'KeyZ', 'KeyX', 'KeyR', 'KeyF', 'Tab',
]);

type Offer = 'board' | 'leave' | null;

/** While riding the strip also names the view, and that C changes it. */
const leaveOffer = () => ({
  label: 'LEAVE THE ROLLER COASTER',
  note: `${COASTER_VIEW_NAMES[coasterRide.view]} · C: VIEW`,
});

export function CoasterBoarding({ telemetry }: { telemetry: RefObject<VehicleTelemetry> }) {
  const halo = useMemo(() => makeHalo(), []);
  useEffect(() => () => halo.dispose(), [halo]);
  const ring = useMemo(() => heliWorld(COASTER_RING.along, COASTER_RING.across), []);

  const glow = useRef<Mesh | null>(null);
  const offer = useRef<Offer>(null);
  const phase = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While riding, the car's own keys go nowhere — capture phase, ahead of
      // the controls and the vehicle wheel. Key-ups pass, so nothing sticks.
      // C cycles the ride's own views instead of the car's.
      if (coasterRide.riding && e.code === 'KeyC') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) {
          cycleCoasterView();
          offerPortal(leaveOffer());
        }
        return;
      }
      if (coasterRide.riding && HELD_OFF.has(e.code)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.code !== 'Enter' || e.repeat || !offer.current) return;
      const kind = offer.current;
      offer.current = null;
      offerPortal(null);
      if (kind === 'board') {
        boardCoaster();
      } else {
        coasterRide.riding = false;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      coasterRide.riding = false;
    };
  }, []);

  useFrame((_, rawDelta) => {
    phase.current += Math.min(rawDelta, 1 / 20);
    const s = 1 + 0.04 * Math.sin(phase.current * 2.2);
    glow.current?.scale.set(s, 1, s);
    const t = telemetry.current;
    if (!t) return;
    let next: Offer = null;
    if (coasterRide.riding) next = 'leave';
    else if (!SELECTED.air && !SELECTED.rail && !SELECTED.sea
      && Math.hypot(t.x - ring[0], t.z - ring[1]) < RADIUS && t.y - HELI_GROUND < 4) next = 'board';
    if (next !== offer.current) {
      offer.current = next;
      offerPortal(next === 'board' ? { label: 'RIDE THE ROLLER COASTER', note: 'Halcyon Pier' }
        : next === 'leave' ? leaveOffer() : null);
    }
  });

  return (
    <group position={[ring[0], HELI_GROUND + 0.06 + 0.08, ring[1]]}>
      <mesh ref={glow} position={[0, HEIGHT / 2, 0]}>
        <cylinderGeometry args={[RADIUS, RADIUS, HEIGHT, 48, 1, true]} />
        <meshBasicMaterial
          color={COLOUR} map={halo} transparent opacity={0.55} side={DoubleSide} depthWrite={false} toneMapped={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[RADIUS - 0.35, RADIUS, 64]} />
        <meshBasicMaterial color={COLOUR} transparent opacity={0.9} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
