'use client';

import { WORLD_ID } from '@/config/world';
import { SELECTED } from '@/config/garage';
import {
  BRIGHTNESS_RANGE, CONTRAST_RANGE, DEFAULT_SETTINGS, TRAFFIC_LEVELS,
  type GameSettings,
} from './gameSettings';
import { Row, Segmented, Slider } from './hudControls';
import { HUD } from './hudTheme';

const ON_OFF = [
  { label: 'ON', value: true },
  { label: 'OFF', value: false },
];

/**
 * Settings, changed while driving. A page of the pause menu.
 *
 * Only things the running scene can act on immediately are here. Traffic
 * density is a cap the AI reads each frame; the trams mount and unmount, which
 * is cheap because they are seven kinematic bodies apiece; audio flips a gain;
 * the grade is a CSS filter on the canvas. Anything needing the world rebuilt —
 * the vehicle, the map — stays in the garage where a reload is expected.
 */
export function SettingsForm({
  settings, onChange,
}: {
  settings: GameSettings;
  onChange: (next: Partial<GameSettings>) => void;
}) {
  const cars = TRAFFIC_LEVELS[settings.traffic].cars;

  return (
    <div>
      <Section label="WORLD" />

      <Row
        label="TRAFFIC"
        hint={cars === 0 ? 'Empty streets' : `Up to ${cars} cars around you`}
      >
        <Segmented
          options={TRAFFIC_LEVELS.map((level, index) => ({ label: level.label, value: index }))}
          value={settings.traffic}
          onChange={(traffic) => onChange({ traffic })}
        />
      </Row>

      {/* The rail loop is city-only, and a driver already on the rails cannot
          also remove the service that is sharing the line with them. */}
      {WORLD_ID === 'city' && !SELECTED.rail && (
        <Row label="TRAMS" hint="Service trams on the city loop">
          <Segmented
            options={ON_OFF}
            value={settings.trams}
            onChange={(trams) => onChange({ trams })}
          />
        </Row>
      )}

      <Section label="PICTURE" />

      <Row label="BRIGHTNESS">
        <Slider
          value={settings.brightness}
          {...BRIGHTNESS_RANGE}
          onChange={(brightness) => onChange({ brightness })}
          format={(v) => `${Math.round(v * 100)}%`}
        />
      </Row>

      <Row label="CONTRAST">
        <Slider
          value={settings.contrast}
          {...CONTRAST_RANGE}
          onChange={(contrast) => onChange({ contrast })}
          format={(v) => `${Math.round(v * 100)}%`}
        />
      </Row>

      <Section label="SOUND" />

      <Row label="ENGINE" hint={SELECTED.rail ? 'A tram has no engine note' : 'Synthesised, no audio files'}>
        <Segmented
          options={ON_OFF}
          value={settings.audio && !SELECTED.rail}
          onChange={(audio) => onChange({ audio })}
        />
      </Row>

      <div className="mt-4 flex justify-end" style={{ borderTop: `1px solid ${HUD.line}`, paddingTop: 14 }}>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChange(DEFAULT_SETTINGS)}
          className="rounded px-3 py-1.5 transition-colors hover:bg-white/10"
          style={{
            fontSize: 9.5, letterSpacing: '0.2em', fontWeight: 700, color: HUD.muted,
            border: `1px solid ${HUD.line}`,
          }}
        >
          RESET
        </button>
      </div>
    </div>
  );
}

function Section({ label }: { label: string }) {
  return (
    <div
      className="mb-1 mt-3 first:mt-0"
      style={{ fontSize: 8.5, letterSpacing: '0.32em', color: HUD.cyan, fontWeight: 700 }}
    >
      {label}
    </div>
  );
}
