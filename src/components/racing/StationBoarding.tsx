'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CanvasTexture, DoubleSide, SRGBColorSpace, type Mesh } from 'three';
import { GARAGE, SELECTED, SWITCHABLE, setSelected, type GarageVehicle } from '@/config/garage';
import { DRACO_PATH, setSwitchSpawn } from '@/config/cityConfig';
import { CARRIAGE, LOCOMOTIVE } from '@/config/trainConfig';
import {
  TRAIN_STATIONS, requestTrainStart, stationAlongside, type TrainStation,
} from '@/config/trainStations';
import { offerPortal } from '@/physics/portals';
import type { VehicleTelemetry } from '@/types/vehicle';

/**
 * Boarding the train, at Kestrel, Halcyon Junction and Skylark.
 *
 * A glowing circle on each station's forecourt, the same kind as the Wall of
 * Death's entry halo: drive (or fly the drone low) into it and the HUD strip
 * offers ENTER · RIDE THE TRAIN. Enter puts you in the locomotive — switched
 * live, no reload (`setSelected`) — standing at that station's platform
 * (`trainStations`, `TrainRide`). The ride never starts anywhere else.
 *
 * The way back is the same in reverse: stop the train at any of these
 * stations and the strip offers ENTER · LEAVE THE TRAIN, which puts you back
 * in the vehicle you boarded from, in that station's circle.
 */

const RADIUS = 4.5;
const HEIGHT = 3.6;
const COLOUR = '#37b3ff';
/** Stopped means under this, km/h. */
const STOPPED_KPH = 2;

/** The locomotive Enter puts you in. */
const TRAIN: GarageVehicle | undefined = GARAGE.find((v) => v.id === 'train') ?? GARAGE.find((v) => v.rail === 'main');

function makeHalo(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.3)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 128);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

type Offer = { kind: 'board' | 'leave'; station: TrainStation } | null;

export function StationBoarding({ telemetry }: { telemetry: RefObject<VehicleTelemetry> }) {
  const halo = useMemo(() => makeHalo(), []);
  useEffect(() => () => halo.dispose(), [halo]);

  const glows = useRef<Array<Mesh | null>>([]);
  const offer = useRef<Offer>(null);
  /** What you boarded from, to give back when you get off. */
  const boardedFrom = useRef<GarageVehicle | null>(null);
  const phase = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const o = offer.current;
      if (e.code !== 'Enter' || !o) return;
      offer.current = null;
      offerPortal(null);
      if (o.kind === 'board' && TRAIN) {
        boardedFrom.current = SELECTED;
        requestTrainStart(o.station.id);
        // Loading started here, not mid-render in `TrainRide`.
        useGLTF.preload(LOCOMOTIVE.model, DRACO_PATH);
        useGLTF.preload(CARRIAGE.model, DRACO_PATH);
        setSelected(TRAIN);
      } else if (o.kind === 'leave') {
        const back = boardedFrom.current ?? SWITCHABLE.find((v) => !v.air) ?? SWITCHABLE[0];
        if (!back) return;
        const { circle, platform, ground } = o.station;
        // In the circle, facing away from the platform, out of the station.
        setSwitchSpawn({
          position: [circle[0], ground + (back.air ? 3 : 0.6), circle[1]],
          heading: Math.atan2(-(circle[0] - platform[0]), -(circle[1] - platform[1])),
        });
        setSelected(back);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    phase.current += delta;
    const s = 1 + 0.04 * Math.sin(phase.current * 2.2);
    for (const g of glows.current) g?.scale.set(s, 1, s);
    const t = telemetry.current;
    if (!t) return;
    let next: Offer = null;
    if (SELECTED.rail === 'main') {
      // On the train: stopped, alongside a station's platform.
      const station = Math.abs(t.speedKph) < STOPPED_KPH ? stationAlongside(t.x, t.z) : null;
      if (station) next = { kind: 'leave', station };
    } else if (!SELECTED.rail && !SELECTED.sea) {
      const station = TRAIN_STATIONS.find((st) => Math.hypot(t.x - st.circle[0], t.z - st.circle[1]) < RADIUS
        && t.y - st.ground < 4);
      if (station) next = { kind: 'board', station };
    }
    if (next?.kind !== offer.current?.kind || next?.station.id !== offer.current?.station.id) {
      offer.current = next;
      offerPortal(next?.kind === 'board' ? { label: 'RIDE THE TRAIN', note: next.station.name }
        : next?.kind === 'leave' ? { label: 'LEAVE THE TRAIN', note: next.station.name } : null);
    }
  });

  if (!TRAIN) return null;
  return (
    <>
      {TRAIN_STATIONS.map((st, i) => (
        <group key={st.id} position={[st.circle[0], st.ground + 0.05, st.circle[1]]}>
          <mesh ref={(m) => { glows.current[i] = m; }} position={[0, HEIGHT / 2, 0]}>
            <cylinderGeometry args={[RADIUS, RADIUS, HEIGHT, 48, 1, true]} />
            <meshBasicMaterial
              color={COLOUR}
              map={halo}
              transparent
              opacity={0.55}
              side={DoubleSide}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
            <ringGeometry args={[RADIUS - 0.35, RADIUS, 64]} />
            <meshBasicMaterial color={COLOUR} transparent opacity={0.9} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </>
  );
}
