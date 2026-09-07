'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { RigidBody, useBeforePhysicsStep, type RapierRigidBody } from '@react-three/rapier';
import { DoubleSide, Euler, Object3D, Quaternion, Vector3 } from 'three';
import { CITY_NAV_IMAGE, DRACO_PATH } from '@/config/cityConfig';
import {
  RAIL, RAIL_LENGTH, TRAM, railNormalAt, railPointAt, railTangentAt, railWrap,
} from '@/config/railConfig';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { groundHeightAt, loadCityNav } from '@/physics/cityNav';
import { forgetTramArc, gapAhead, reportTramArc } from '@/physics/tramTraffic';
import { SELECTED } from '@/config/garage';
import { buildRibbon, type Sample } from './trackGeometry';

useGLTF.preload(TRAM.model, DRACO_PATH);

/** Metres of arc per texture repeat. No map is bound; this only shapes UVs. */
const V_SCALE = 6;
/** Centreline samples. ~0.7 m apart, which is finer than the 1.5 m raster. */
const SEGMENTS = 3200;

/**
 * Samples the loop at uniform arc length, taking each point's height from the
 * nav raster so the rails sit on the road rather than through it.
 *
 * The route was chosen partly because it is flat — the measured spread is under
 * 20 cm — so this is a small correction, but it is the difference between rail
 * that lies on the tarmac and rail that submarines at one end of the street.
 */
function sampleRail(lift: number): Sample[] {
  const samples: Sample[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const arc = (i / SEGMENTS) * RAIL_LENGTH;
    const [x, z] = railPointAt(arc);
    const [nx, nz] = railNormalAt(arc);
    samples.push({ x, z, nx, nz, arc, isCorner: false, y: (groundHeightAt(x, z) ?? 0) + lift });
  }
  return samples;
}

/** Ground height at an arc length, for placing sleepers and the train. */
const heightAt = (x: number, z: number, lift: number) => (groundHeightAt(x, z) ?? 0) + lift;

/**
 * One tram: a Melbourne C-class (Alstom Citadis 202), articulated.
 *
 * It is placed as three independent bodies rather than one. At 24.1 m long it
 * is well over twice the corner radius — the chord across a rigid body that
 * long is wider than a corner's whole diameter — which is exactly why the real
 * vehicle is three short bodies on articulated joints. Each section is
 * put on the curve at its own arc length, so the tram lines up straight down a
 * street and bends round the corners on its own.
 *
 * Colliders are kinematic, matching `Traffic`: the tram is scripted, so it
 * collides with the player without being shoved off its own rails. Hitting it
 * is like hitting a moving wall.
 */
function Tram({ id, phase }: { id: string; phase: number }) {
  const { scene } = useGLTF(TRAM.model, DRACO_PATH);
  const bodyRefs = useRef<(RapierRigidBody | null)[]>([]);
  const groupRefs = useRef<(Object3D | null)[]>([]);
  // The service trams all run at the same speed, so left alone they never
  // converge and the spacing set by `phase` holds for good. What can close a
  // gap is the *player's* tram sharing the line — so this one also queues,
  // which means it needs a speed of its own rather than a constant.
  const travelled = useRef(phase);
  const speed = useRef(RAIL.trainSpeed);
  const scratch = useMemo(() => ({
    look: new Vector3(), quaternion: new Quaternion(), euler: new Euler(),
  }), []);

  // Cloned so the cached GLTF scene is never re-parented out from under drei —
  // a hot reload would otherwise remount into an already-emptied scene and
  // render nothing. Clones share geometry and materials, so this is cheap.
  const sections = useMemo(() => {
    const copy = scene.clone(true);
    return TRAM.sections
      .map(({ name, offset }) => ({ offset, object: copy.getObjectByName(name) }))
      .filter((s): s is { offset: number; object: Object3D } => Boolean(s.object));
  }, [scene]);

  useEffect(() => {
    for (const { object } of sections) {
      object.traverse((child) => {
        child.castShadow = true;
        child.receiveShadow = true;
      });
    }
    if (sections.length !== TRAM.sections.length) {
      console.warn(`[rail] tram: ${sections.length}/${TRAM.sections.length} sections found`);
    }
  }, [sections]);

  /** Where section `i` sits, as an arc length along the loop. */
  const sectionArc = (offset: number) => railWrap(travelled.current + offset);

  /** Places one section's transform onto `target`. */
  const place = (target: Object3D, offset: number) => {
    const arc = sectionArc(offset);
    const [x, z] = railPointAt(arc);
    const [tx, tz] = railTangentAt(arc);
    const y = heightAt(x, z, 0);
    target.position.set(x, y, z);
    scratch.look.set(x + tx, y, z + tz);
    target.lookAt(scratch.look);
  };

  // Rapier writes happen in the before-step callback, never in useFrame:
  // touching a body from the render loop races the physics step's borrow of
  // the World and throws the "recursive use of an object" abort. Same rule as
  // CarPhysics and Traffic.
  // Published so the player's tram can queue behind this one instead of
  // driving through it — two kinematic bodies do not collide. See tramTraffic.
  useEffect(() => () => forgetTramArc(id), [id]);

  useBeforePhysicsStep(() => {
    // Queue behind whatever is ahead — in practice only ever the player, since
    // the service runs to an even interval.
    const gap = gapAhead(id, travelled.current);
    let target = RAIL.trainSpeed;
    if (gap < RAIL.minTramGap + RAIL.tramFollowZone) {
      const room = (gap - RAIL.minTramGap) / RAIL.tramFollowZone;
      target = Math.max(0, Math.min(1, room)) * RAIL.trainSpeed;
    }
    // Rate-limited so a tram brakes rather than stopping dead on the spot.
    const step = RAIL.tramBrake * PHYSICS_TIMESTEP;
    speed.current += Math.max(-step, Math.min(step, target - speed.current));

    travelled.current = railWrap(travelled.current + speed.current * PHYSICS_TIMESTEP);
    reportTramArc(id, travelled.current);

    TRAM.sections.forEach(({ offset }, i) => {
      const body = bodyRefs.current[i];
      if (!body) return;
      const arc = sectionArc(offset);
      const [x, z] = railPointAt(arc);
      const [tx, tz] = railTangentAt(arc);
      // The models face -Z, so a direction (tx, tz) is heading atan2(-tx, -tz)
      // — the same solve trackConfig.trackSpawn uses.
      scratch.euler.set(0, Math.atan2(-tx, -tz), 0);
      scratch.quaternion.setFromEuler(scratch.euler);
      body.setNextKinematicTranslation({ x, y: heightAt(x, z, TRAM.size[1] / 2), z });
      body.setNextKinematicRotation(scratch.quaternion);
    });
  });

  // Visuals track the same arc length, independent of the physics bodies.
  useFrame(() => {
    sections.forEach(({ offset }, i) => {
      const group = groupRefs.current[i];
      if (group) place(group, offset);
    });
  });

  return (
    <>
      {/* Each section gets a carrier group, and it is the carrier that is
          placed on the rail. The section node itself holds the normalising
          transform prepare-tram.mjs baked in — the turn onto -Z, the scale to
          metres, and its own offset along the tram — so writing position and
          quaternion onto it directly would wipe all three and scatter the
          bodies off the track. */}
      {sections.map(({ object }, i) => (
        <group key={i} ref={(instance) => { groupRefs.current[i] = instance; }}>
          <primitive object={object} />
        </group>
      ))}

      {/* Kinematic collider per section. Declarative, like Traffic's — creating
          bodies imperatively from an effect calls into Rapier while the World
          is already borrowed and aborts the step. */}
      {TRAM.sections.map((_, i) => (
        <RigidBody
          key={i}
          ref={(instance) => { bodyRefs.current[i] = instance; }}
          type="kinematicPosition"
          colliders="cuboid"
          position={[0, -500, 0]}
        >
          {/* Invisible: the visible tram is the sections above, which Rapier
              never sees. This only sizes the collider. */}
          <mesh visible={false}>
            <boxGeometry args={[TRAM.size[0], TRAM.size[1], TRAM.sectionCollider]} />
          </mesh>
        </RigidBody>
      ))}
    </>
  );
}

/**
 * Street-level tram loop: two rails and their paved bed laid down four of the
 * city's own streets, plus the trams that run them.
 *
 * Gated on the nav raster, which is what supplies the road height under every
 * sample. The raster is a small PNG that `CityMap` is already fetching, so in
 * practice this costs no extra wait; until it lands the loop simply is not in
 * the scene, exactly as the minimap handles it.
 */
export function RailLoop({ trams = true }: { trams?: boolean }) {
  const [navReady, setNavReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadCityNav(CITY_NAV_IMAGE)
      .then(() => { if (!cancelled) setNavReady(true); })
      .catch((error) => console.warn('[rail] nav raster unavailable; loop not laid', error));
    return () => { cancelled = true; };
  }, []);

  const built = useMemo(() => {
    if (!navReady) return null;
    const g = RAIL.gauge / 2;
    const half = RAIL.railWidth / 2;

    return {
      // Rails and bed are sampled separately because each sits at its own
      // height above the road, and the sample carries the height.
      railLeft: buildRibbon(sampleRail(RAIL.railLift), -g - half, -g + half, 0, V_SCALE),
      railRight: buildRibbon(sampleRail(RAIL.railLift), g - half, g + half, 0, V_SCALE),
      bed: buildRibbon(sampleRail(RAIL.bedLift), -g - half, g + half, 0, V_SCALE),
    };
  }, [navReady]);

  useEffect(() => {
    if (!built) return;
    return () => {
      built.railLeft.geometry.dispose();
      built.railRight.geometry.dispose();
      built.bed.geometry.dispose();
    };
  }, [built]);

  if (!built) return null;

  return (
    <group>
      {/* Paved channel between the rails: a shade off the asphalt, which is
          what makes a line of embedded steel read as track rather than as two
          stray scratches. */}
      <mesh geometry={built.bed.geometry} receiveShadow>
        <meshStandardMaterial color="#5d5f63" roughness={0.9} metalness={0.05} side={DoubleSide} />
      </mesh>

      {/* DoubleSide: these ribbons are near-flat and only 14 cm across, and
          which way they wind depends on the loop's travel direction. Rendering
          both faces is cheaper than reasoning about it. */}
      {[built.railLeft, built.railRight].map((rail, i) => (
        <mesh key={i} geometry={rail.geometry} receiveShadow>
          <meshStandardMaterial color="#b9bec6" roughness={0.25} metalness={0.9} side={DoubleSide} />
        </mesh>
      ))}

      {/* One service tram stands down when the driver takes one out, so the
          line still runs to the same interval rather than gaining a vehicle.
          The player starts in the gap this leaves — see TramRide. */}
      {/* The rails stay whatever the setting says — they are part of the street,
          not traffic. Only the service is switchable. */}
      {Array.from(
        { length: trams ? (SELECTED.rail ? TRAM.count - 1 : TRAM.count) : 0 },
        (_, i) => (
          <Tram key={i} id={`service-${i}`} phase={(i / TRAM.count) * RAIL_LENGTH} />
        ),
      )}
    </group>
  );
}
