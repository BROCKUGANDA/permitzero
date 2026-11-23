'use client';

import * as React from 'react';
import { VinylDeck } from './vinyl';
import { haptic } from '@/lib/haptics';
import type { StatusResponse } from '@permitzero/schemas';

/**
 * The console's one orchestrated moment. Everything else on this site is a
 * table or a form; this panel is the thing someone remembers. It states the
 * product's rule in one line and makes the enforcement state physical: the
 * disc only spins while the control plane is actually accepting work.
 */
export function SignalHero({ status }: { status: StatusResponse | null }): React.JSX.Element {
  const [playing, setPlaying] = React.useState(true);
  const halted = status?.enforcement_mode === 'EMERGENCY_STOP';
  const spinning = playing && !halted;

  return (
    <section className="signal-hero" aria-label="Control plane status">
      <div className="signal-hero-copy">
        <p className="signal-eyebrow">
          <span className={halted ? 'signal-led is-alert' : 'signal-led'} />
          {halted ? 'CONTROL PLANE // HALTED' : 'CONTROL PLANE // NOMINAL'}
        </p>
        <h2 className="signal-headline">Authority before action.</h2>
        <p className="signal-sub">
          An agent may ask. Nothing moves until policy, evidence and a human — where required — have all agreed.
        </p>
        <dl className="signal-readout">
          <div>
            <dt>Enforcement</dt>
            <dd>{status?.enforcement_mode ?? 'CONNECTING'}</dd>
          </div>
          <div>
            <dt>Release</dt>
            <dd>{status?.version ?? '—'}</dd>
          </div>
          <div>
            <dt>Queue</dt>
            <dd>{status ? `${status.dependencies.queue.depth} waiting` : '—'}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="signal-cue"
          onClick={() => {
            haptic('select');
            setPlaying((value) => !value);
          }}
          aria-pressed={spinning}
        >
          <span className="signal-cue-glyph" aria-hidden />
          {spinning ? 'Cue held — pause the disc' : 'Cue the disc'}
        </button>
      </div>
      <div className="signal-hero-stage">
        <VinylDeck playing={spinning} />
      </div>
    </section>
  );
}
