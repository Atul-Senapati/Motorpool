'use client';

import { Suspense, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import { Quaternion, Vector3, type Group } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import bikeData from '@/config/motorbikeData.json';
import { bikeParts, MOTORBIKE_MODEL } from './Motorbike';
import { pose } from './motoRider';

/**
 * A bench for the Firehawk and its rider, under orbit controls. Not part of
 * the game. `?lean=40` (degrees, + to the bike's left), `?bars=10` (degrees),
 * `?pace=0..1`, `?brake=0..1`, `?cam=x,y,z` for a fixed camera; the stunts
 * by `?pitch=30` (degrees, + a wheelie), `?stand=1`, `?hands=1` (no hands).
 */
interface LabPose { lean: number; bars: number; pace: number; brake: number; pitch: number; stand: number; hands: number }
function Bike({ p }: { p: LabPose }) {
  const { scene } = useGLTF(MOTORBIKE_MODEL, DRACO_PATH);
  const parts = useMemo(() => bikeParts(scene), [scene]);
  const group = useRef<Group>(null);
  const axis = useMemo(() => new Vector3(...(bikeData.steerAxis as [number, number, number])).normalize(), []);
  useFrame(() => {
    if (!group.current) return;
    group.current.rotation.z = p.lean;
    group.current.rotation.x = p.pitch;
    parts.steer.quaternion.copy(new Quaternion().setFromAxisAngle(axis, p.bars));
    if (parts.rig) pose(parts.rig, parts.root, { lean: p.lean, bars: p.bars, pace: p.pace, braking: p.brake, pitch: p.pitch, stand: p.stand, noHands: p.hands });
  });
  return <group ref={group}><primitive object={scene} /></group>;
}

export function MotoLab() {
  const [p] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const deg = (k: string) => (Number(q.get(k) ?? 0) * Math.PI) / 180;
    const cam = (q.get('cam') ?? '3,1.4,0').split(',').map(Number);
    return { lean: deg('lean'), bars: deg('bars'), pace: Number(q.get('pace') ?? 0.5), brake: Number(q.get('brake') ?? 0), cam,
      pitch: deg('pitch'), stand: Number(q.get('stand') ?? 0), hands: Number(q.get('hands') ?? 0) };
  });
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#9fb8c9' }}>
      <Canvas shadows camera={{ position: p.cam as [number, number, number], fov: 40 }}>
        <hemisphereLight args={['#dfefff', '#6b5a48', 1.4]} />
        <directionalLight position={[5, 10, 6]} intensity={2.2} castShadow />
        <gridHelper args={[10, 20, '#666', '#777']} />
        <Suspense fallback={null}><Bike p={p} /></Suspense>
        <OrbitControls target={[0, 0.7, 0]} />
      </Canvas>
    </div>
  );
}
