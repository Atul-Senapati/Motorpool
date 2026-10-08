'use client';

import { Suspense, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import { Group, Mesh } from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import propsData from '@/config/beachPropsData.json';
import crowdData from '@/config/crowdData.json';
import { beachOutfitFor, dressForBeach } from './beachWear';
import { poseFromQuery, SEAT, seatRider } from './quadRider';

/**
 * A bench for the beach's quad riders: the quad and its seated rider, under
 * orbit controls. `?pose=LeftUpLeg:x:-80,...` overrides joints, `?seat=x,y,z`
 * the seat, `?figure=0` the rider. Not part of the game.
 */
function QuadAndRider({ params }: { params: { pose: ReturnType<typeof poseFromQuery>; seat: number[]; figure: number } }) {
  const { scene: quad } = useGLTF('/models/quadBike.glb', DRACO_PATH);
  const { scene: crowd } = useGLTF('/models/crowd.glb');
  const built = useMemo(() => {
    const g = new Group();
    const body = quad.getObjectByName('quad')?.clone(true);
    if (body) g.add(body);
    const wheel = quad.getObjectByName('quadWheel');
    if (wheel) {
      for (const hub of propsData.quadWheel.hubs) {
        const w = wheel.clone(true);
        w.position.set(hub[0], hub[1], hub[2]);
        g.add(w);
      }
    }
    const info = crowdData.figures[params.figure % crowdData.figures.length];
    const figure = clone(crowd.getObjectByName(info.name)!);
    figure.traverse((o) => {
      if ((o as { isBone?: boolean }).isBone) o.name = o.name.replace(/_\d+$/, '');
      if ((o as Mesh).isMesh) o.frustumCulled = false;
    });
    dressForBeach(figure, beachOutfitFor(params.figure), (m) => m);
    seatRider(figure, params.pose);
    figure.position.set(params.seat[0], params.seat[1], params.seat[2]);
    // The crowd faces +Z, the quad −Z.
    figure.rotation.y = Math.PI;
    g.add(figure);
    return g;
  }, [quad, crowd, params]);
  return <primitive object={built} />;
}

export function QuadLab() {
  const [params] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const seat = (q.get('seat') ?? '').split(',').map(Number);
    return {
      pose: poseFromQuery(window.location.search),
      seat: seat.length === 3 && seat.every(Number.isFinite) ? seat : SEAT,
      figure: Number(q.get('figure') ?? 0),
    };
  });
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#9fb8c9' }}>
      <Canvas camera={{ position: [2.6, 1.6, 1.2], fov: 45 }}>
        <hemisphereLight args={['#dfefff', '#6b5a48', 1.2]} />
        <directionalLight position={[5, 10, 6]} intensity={2} />
        <gridHelper args={[10, 20, '#666', '#777']} />
        <Suspense fallback={null}><QuadAndRider params={params} /></Suspense>
        <OrbitControls target={[0, 0.8, 0]} />
      </Canvas>
    </div>
  );
}
