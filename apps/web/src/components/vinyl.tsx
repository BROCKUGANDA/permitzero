'use client';

import * as React from 'react';
import { cn } from '@permitzero/ui';

/**
 * The authority disc. A record is the right motif for this console: it is a
 * physical object whose surface carries information, it only moves when a
 * cue is given, and its label names the authority under which it is playing.
 *
 * It is rendered with CSS 3D transforms rather than a WebGL scene. A record is
 * a flat disc — three.js would buy nothing here and cost a GPU context, a
 * bundle, and a fallback story. What sells the depth is the tilt, the edge
 * underneath, and a fixed light sheen over a spinning surface.
 */
export interface VinylProps {
  size?: number;
  playing?: boolean;
  compact?: boolean;
  label?: string;
  sublabel?: string;
  className?: string;
}

export function Vinyl({
  size = 240,
  playing = true,
  compact = false,
  label = 'PZ',
  sublabel = 'AUTHORITY',
  className,
}: VinylProps): React.JSX.Element {
  return (
    <div
      className={cn('vinyl-scene', compact && 'vinyl-compact', className)}
      style={{ '--vinyl-size': `${size}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      <div className="vinyl-tilt">
        <div className="vinyl-edge" />
        <div className={cn('vinyl-disc', playing && 'is-playing')}>
          <div className="vinyl-grooves" />
          <div className="vinyl-label">
            <span className="vinyl-label-mark">{label}</span>
            {!compact ? <span className="vinyl-label-sub">{sublabel}</span> : null}
          </div>
          <span className="vinyl-spindle" />
        </div>
        <div className="vinyl-sheen" />
      </div>
    </div>
  );
}

/**
 * The signature arrangement: one cued record in front of two filed behind it.
 * The back discs are deliberately still — a room full of spinning records
 * reads as decoration; one record in motion among still ones reads as intent.
 */
export function VinylDeck({ playing }: { playing: boolean }): React.JSX.Element {
  return (
    <div className="vinyl-deck" aria-hidden="true">
      <div className="vinyl-deck-halo" />
      <Vinyl size={268} playing={false} label="PZ" sublabel="FILED" className="vinyl-deck-back" />
      <Vinyl size={268} playing={false} label="PZ" sublabel="FILED" className="vinyl-deck-mid" />
      <Vinyl size={268} playing={playing} className="vinyl-deck-front" />
      <div className={cn('vinyl-tonearm', playing && 'is-cued')} />
    </div>
  );
}

/** The mark used in the header and on the sign-in screen. */
export function VinylMark({ size = 30 }: { size?: number }): React.JSX.Element {
  return <Vinyl size={size} compact playing label="PZ" />;
}
