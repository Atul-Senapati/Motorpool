'use client';

import { WORLD_ID } from '@/config/world';
import { SELECTED } from '@/config/garage';
import { TRAIN_LINE_ENABLED } from '@/config/trainConfig';
import {
  BRIGHTNESS_RANGE, CARRIAGE_RANGE, CONTRAST_RANGE, DEFAULT_SETTINGS, QUALITY_LEVELS,
  TRAFFIC_LEVELS, type GameSettings,
} from './gameSettings';
import { Row, Segmented, Slider } from './hudControls';
import { ACCENT, HUD, accentAlpha } from './hudTheme';

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

      {/* The scripted main-line services. Hidden from the driver of one, the
          same way TRAMS is: you cannot delete the service you are part of.
          This is the heaviest thing in the world that can be switched off — a
          coach is 95 k triangles and there are several per service — so it is
          the first thing to try on a machine that is struggling. */}
      {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && SELECTED.rail !== 'main' && (
        <Row label="TRAINS" hint="Services on the main line. The railway stays">
          <Segmented
            options={ON_OFF}
            value={settings.train}
            onChange={(train) => onChange({ train })}
          />
        </Row>
      )}

      {/* Only on the train: it is the only vehicle the setting means anything
          to, and the panel is opened from inside whatever you are driving. */}
      {SELECTED.rail === 'main' && (
        <Row
          label="CARRIAGES"
          hint={settings.carriages === 0
            ? 'Two locomotives, back to back'
            : `${settings.carriages} coach${settings.carriages === 1 ? '' : 'es'} between the engines`}
        >
          <Slider
            value={settings.carriages}
            {...CARRIAGE_RANGE}
            onChange={(carriages) => onChange({ carriages: Math.round(carriages) })}
            format={(v) => String(Math.round(v))}
          />
        </Row>
      )}

      <Section label="PICTURE" />

      <Row label="QUALITY" hint={qualityHint(settings.quality)}>
        <Segmented
          options={QUALITY_LEVELS.map((level, index) => ({ label: level.label, value: index }))}
          value={settings.quality}
          onChange={(quality) => onChange({ quality })}
        />
      </Row>

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

      <div className="mt-5 flex justify-end" style={{ borderTop: `1px solid ${HUD.line}`, paddingTop: 16 }}>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChange(DEFAULT_SETTINGS)}
          className="px-4 py-2 transition-colors hover:bg-white/10"
          style={{
            fontSize: 10.5, letterSpacing: '0.22em', fontWeight: 700, color: ACCENT,
            border: `1px solid ${accentAlpha(0.45)}`,
            clipPath: 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)',
          }}
        >
          RESET TO DEFAULTS
        </button>
      </div>
    </div>
  );
}

/**
 * What a quality preset actually does, in the panel, in the player's terms.
 *
 * Written out rather than left as a word, because the three levels trade
 * different things: LOW is the only one that takes visible world away (the
 * haze comes in to 430 m), while the step from HIGH to MEDIUM is resolution
 * and shadow detail, which costs sharpness rather than distance.
 */
function qualityHint(index: number): string {
  const level = QUALITY_LEVELS[index];
  const shadows = level.shadowMap === 0 ? 'no shadows' : `${level.shadowMap}px shadows`;
  return `${Math.round(level.dpr * 100)}% resolution, ${shadows}, sees ${level.fogFar} m`;
}

/** A section heading: the accent, a short rule under it, room above. */
function Section({ label }: { label: string }) {
  return (
    <div className="mb-1 mt-5 pl-5 first:mt-0">
      <div style={{ fontSize: 9.5, letterSpacing: '0.34em', color: ACCENT, fontWeight: 700 }}>
        {label}
      </div>
      <div className="mt-1.5 h-px w-10" style={{ background: accentAlpha(0.6) }} />
    </div>
  );
}
