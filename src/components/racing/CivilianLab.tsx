'use client';

import { Suspense, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AnimationMixer, type Group } from 'three';
import crowdData from '@/config/crowdData.json';
import {
  advancePhase, bindRig, CIVILIANS, poseRig, type CivilianRig, type Gait,
} from './civilianRig';

const MODEL = '/models/civilians.glb';
const CROWD = '/models/crowd.glb';

type Mode = 'idle' | 'walk' | 'run' | 'circle';
const SPEED = { idle: 0, walk: 1.4, run: 4.2, circle: 1.4 };

function Figure({ index, mode, x }: { index: number; mode: Mode; x: number }) {
  const { scene } = useGLTF(MODEL);
  const info = CIVILIANS[index];
  const figure = useMemo(() => {
    const source = scene.getObjectByName(info.name)!;
    const copy = clone(source);
    copy.position.set(0, 0, 0);
    copy.traverse((o) => { o.frustumCulled = false; o.castShadow = true; });
    return copy;
  }, [scene, info.name]);
  const rig = useMemo<CivilianRig>(() => bindRig(figure, info.hipHeight), [figure, info.hipHeight]);
  const gait = useRef<Gait>({ phase: index * 0.7, move: 0, run: 0, time: index });
  const group = useRef<Group>(null);
  const angle = useRef(index / CIVILIANS.length * Math.PI * 2);

  useFrame((_, dt) => {
    const g = gait.current;
    const speed = SPEED[mode];
    g.time += dt;
    g.move += ((mode === 'idle' ? 0 : 1) - g.move) * Math.min(1, dt * 4);
    g.run += ((mode === 'run' ? 1 : 0) - g.run) * Math.min(1, dt * 3);
    g.phase = advancePhase(rig, g.phase, speed * g.move, dt, g.run);
    poseRig(rig, g);
    const gr = group.current!;
    if (mode === 'circle') {
      const R = 7;
      angle.current += speed * dt / R;
      const a = angle.current;
      gr.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      // Tangent of the circle, walking anticlockwise seen from above.
      gr.rotation.y = Math.atan2(-Math.sin(a), Math.cos(a));
    } else {
      gr.position.set(x, 0, 0);
      gr.rotation.y = 0;
    }
  });

  return <group ref={group}><primitive object={figure} /></group>;
}

/**
 * `?mode=run&view=side&only=7&set=crowd` — the starting mode, a camera (front,
 * side or close: a side-on close-up of one figure), one figure on its own, and
 * which pack: the auto-rigged civilians (default) or the animated crowd.
 */
function readParams() {
  const q = new URLSearchParams(window.location.search);
  const only = q.get('only');
  return {
    mode: (q.get('mode') ?? 'walk') as Mode,
    view: q.get('view') ?? 'front',
    only: only === null ? null : Number(only),
    crowd: q.get('set') === 'crowd',
  };
}
const CAMERAS: Record<string, { position: [number, number, number]; target: [number, number, number] }> = {
  front: { position: [0, 2.2, 9], target: [0, 1, 0] },
  side: { position: [11, 1.6, 2], target: [0, 0.9, 0] },
  close: { position: [3.2, 1.1, 0.6], target: [0, 0.9, 0] },
};

/**
 * One of the animated crowd (`prepare-crowd.mjs`), playing the shared walk
 * clip. Every figure after the first has suffixed bone names (`Hips_3`), so the
 * clone's bones are renamed back to the plain names the clip targets.
 */
function CrowdFigure({ index, mode, x }: { index: number; mode: Mode; x: number }) {
  const { scene, animations } = useGLTF(CROWD);
  const info = crowdData.figures[index];
  const { figure, mixer } = useMemo(() => {
    const copy = clone(scene.getObjectByName(info.name)!);
    copy.traverse((o) => {
      o.frustumCulled = false;
      o.castShadow = true;
      if ((o as { isBone?: boolean }).isBone) o.name = o.name.replace(/_\d+$/, '');
    });
    const m = new AnimationMixer(copy);
    const action = m.clipAction(animations.find((a) => a.name === crowdData.clip)!);
    action.time = (index * 0.37) % crowdData.duration;
    action.play();
    return { figure: copy, mixer: m };
  }, [scene, animations, info.name, index]);
  const group = useRef<Group>(null);
  const angle = useRef(index / crowdData.figures.length * Math.PI * 2);

  useFrame((_, dt) => {
    const moving = mode !== 'idle';
    mixer.timeScale = moving ? (mode === 'run' ? 2 : 1) : 0;
    mixer.update(dt);
    const gr = group.current!;
    if (mode === 'circle') {
      const R = 7;
      const speed = 1.3;
      angle.current += speed * dt / R;
      const a = angle.current;
      gr.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      gr.rotation.y = Math.atan2(-Math.sin(a), Math.cos(a));
    } else {
      gr.position.set(x, 0, 0);
      gr.rotation.y = 0;
    }
  });

  return <group ref={group}><primitive object={figure} /></group>;
}

export function CivilianLab() {
  const [params] = useState(readParams);
  const [mode, setMode] = useState<Mode>(params.mode);
  const cam = CAMERAS[params.view] ?? CAMERAS.front;
  const count = params.crowd ? crowdData.figures.length : CIVILIANS.length;
  const shown = params.only === null ? Array.from({ length: count }, (_, i) => i) : [params.only];
  const Body = params.crowd ? CrowdFigure : Figure;
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#9fb8c9' }}>
      <Canvas shadows camera={{ position: cam.position, fov: 45 }}>
        <hemisphereLight args={['#dfefff', '#6b5a48', 1.2]} />
        <directionalLight position={[5, 10, 6]} intensity={2} castShadow shadow-mapSize={[2048, 2048]} />
        <mesh rotation-x={-Math.PI / 2} receiveShadow>
          <planeGeometry args={[60, 60]} />
          <meshStandardMaterial color="#8a8f86" />
        </mesh>
        <gridHelper args={[60, 60, '#666', '#777']} position-y={0.002} />
        {/*
          The boundary has to be inside the Canvas. Without it a figure still
          loading suspends the Canvas itself, R3F unmounts it — calling
          forceContextLoss() on the way out — and the remount gets the dead
          context back: a white page.
        */}
        <Suspense fallback={null}>
          {shown.map((i, k) => (
            <Body key={i} index={i} mode={mode} x={(k - (shown.length - 1) / 2) * (params.crowd ? 0.9 : 1.1)} />
          ))}
        </Suspense>
        <OrbitControls target={cam.target} />
      </Canvas>
      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 8 }}>
        {(['idle', 'walk', 'run', 'circle'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            data-mode={m}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: mode === m ? '#1d4ed8' : '#fff', color: mode === m ? '#fff' : '#111',
              font: '600 14px system-ui',
            }}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}
