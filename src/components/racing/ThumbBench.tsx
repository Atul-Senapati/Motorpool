'use client';

import { useState } from 'react';
import { GARAGE } from '@/config/garage';
import { ThumbStudio } from './garageThumbStudio';

/**
 * Walks the whole garage, one vehicle at a time, through the same studio the
 * rail's live shots use (`ThumbStudio`), and posts each picture to the dev
 * route that writes it into the repo (`/api/thumbs`). Low quality on
 * purpose: a rail card is 184 × 112 and the point is that it is instant.
 *
 * One at a time, never in parallel — each shot holds a model in memory, and
 * the bench is meant to run on whatever machine is to hand.
 */
const QUALITY = 0.62;

export function ThumbBench() {
  const [index, setIndex] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const vehicle = GARAGE[index];
  const done = index >= GARAGE.length;

  const save = async (url: string) => {
    const id = vehicle.id;
    let line = `${id}: `;
    try {
      const response = await fetch('/api/thumbs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, data: url }),
      });
      const result = await response.json();
      line += response.ok ? `${(result.bytes / 1024).toFixed(1)} KB` : `failed — ${result.error ?? response.status}`;
    } catch (error) {
      line += `failed — ${String(error)}`;
    }
    setLog((l) => [...l, line]);
    setIndex((i) => i + 1);
  };

  return (
    <div style={{ padding: 24, fontFamily: 'ui-monospace, monospace', fontSize: 13, color: '#0b1220', background: '#f4f6fa', minHeight: '100dvh' }}>
      <h1 style={{ fontSize: 16, fontWeight: 700 }}>Garage thumbnails → public/garage/thumbs</h1>
      <p data-status={done ? 'done' : 'working'}>
        {done ? `Done: ${GARAGE.length} vehicles.` : `Shooting ${index + 1} / ${GARAGE.length}: ${vehicle.label}`}
      </p>
      <pre>{log.join('\n')}</pre>
      {!done && <ThumbStudio key={vehicle.id} vehicle={vehicle} quality={QUALITY} onDone={save} />}
    </div>
  );
}
