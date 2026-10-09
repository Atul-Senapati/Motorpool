'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { DoubleSide, type Mesh } from 'three';
import { GARAGE, SELECTED, SWITCHABLE, setSelected, type GarageVehicle } from '@/config/garage';
import { DRACO_PATH, setSwitchSpawn } from '@/config/cityConfig';
import { HELICOPTER_MODEL } from '@/config/helicopterConfig';
import {
  HELI_DECK, HELI_DECK_TOP, HELI_FACING, HELI_GROUND, HELI_RING, HELI_TOWER, heliWorld,
} from '@/config/heliportConfig';
import { offerPortal } from '@/physics/portals';
import type { VehicleTelemetry } from '@/types/vehicle';
import { COLOUR, HEIGHT, RADIUS, makeHalo } from './StationBoarding';

/**
 * Halcyon Heliport's ring: drive in and the HUD offers ENTER · FLY THE
 * HELICOPTER, which puts you in the helicopter, live, on the roof pad. Land back
 * on the roof and stop, and it offers ENTER · LEAVE THE HELICOPTER, which gives you
 * back what you came in, in the ring, facing the road.
 *
 * The same halo and the same hand-over as the train's station rings
 * (`StationBoarding`), and the same rule for who owns the offer: each marker
 * only ever replaces its OWN offer, so the two never clear each other's.
 */

const HELICOPTER: GarageVehicle | undefined = GARAGE.find((v) => v.air === 'helicopter');
/** Landed means this low over the pad, km/h and metres. */
const LANDED_KPH = 6;
const LANDED_HEIGHT = 4;

type Offer = 'board' | 'leave' | null;

export function HeliportBoarding({ telemetry }: { telemetry: RefObject<VehicleTelemetry> }) {
  const halo = useMemo(() => makeHalo(), []);
  useEffect(() => () => halo.dispose(), [halo]);
  const ring = useMemo(() => heliWorld(HELI_RING.along, HELI_RING.across), []);
  // The pad is the tower's roof deck.
  const pad = useMemo(() => heliWorld(HELI_TOWER.along + HELI_DECK.along, HELI_TOWER.across), []);
  const padTop = HELI_GROUND + HELI_DECK_TOP;

  const glow = useRef<Mesh | null>(null);
  const offer = useRef<Offer>(null);
  const boardedFrom = useRef<GarageVehicle | null>(null);
  const phase = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Enter' || !offer.current) return;
      const kind = offer.current;
      offer.current = null;
      offerPortal(null);
      if (kind === 'board' && HELICOPTER) {
        boardedFrom.current = SELECTED;
        // On the roof deck, nose to the road, a little over it so it settles.
        setSwitchSpawn({ position: [pad[0], padTop + 3, pad[1]], heading: HELI_FACING });
        useGLTF.preload(HELICOPTER_MODEL, DRACO_PATH);
        setSelected(HELICOPTER);
      } else if (kind === 'leave') {
        const back = boardedFrom.current
          ?? SWITCHABLE.find((v) => !v.air && !v.rail && !v.sea) ?? SWITCHABLE[0];
        if (!back) return;
        setSwitchSpawn({ position: [ring[0], HELI_GROUND + (back.air ? 3 : 0.6), ring[1]], heading: HELI_FACING });
        setSelected(back);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pad, padTop, ring]);

  useFrame((_, rawDelta) => {
    phase.current += Math.min(rawDelta, 1 / 20);
    const s = 1 + 0.04 * Math.sin(phase.current * 2.2);
    glow.current?.scale.set(s, 1, s);
    const t = telemetry.current;
    if (!t) return;
    let next: Offer = null;
    if (SELECTED.air === 'helicopter') {
      const onPad = Math.hypot(t.x - pad[0], t.z - pad[1]) < HELI_DECK.size / 2
        && t.y - padTop < LANDED_HEIGHT && Math.abs(t.speedKph) < LANDED_KPH;
      if (onPad) next = 'leave';
    } else if (!SELECTED.air && !SELECTED.rail && !SELECTED.sea) {
      if (Math.hypot(t.x - ring[0], t.z - ring[1]) < RADIUS && t.y - HELI_GROUND < 4) next = 'board';
    }
    if (next !== offer.current) {
      offer.current = next;
      offerPortal(next === 'board' ? { label: 'FLY THE HELICOPTER', note: 'Halcyon Heliport' }
        : next === 'leave' ? { label: 'LEAVE THE HELICOPTER', note: 'Halcyon Heliport' } : null);
    }
  });

  if (!HELICOPTER) return null;
  return (
    <group position={[ring[0], HELI_GROUND + 0.08, ring[1]]}>
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
