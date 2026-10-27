'use client';

import { CheckCircle2, ChevronRight, MinusCircle, ShieldAlert } from 'lucide-react';
import { reasonLabel, reasonTone } from '@/lib/reason-codes';
import { cn } from '@permitzero/ui';

const TONE_STYLE: Record<string, { icon: typeof CheckCircle2; className: string }> = {
  allow: { icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400' },
  review: { icon: ShieldAlert, className: 'text-amber-600 dark:text-amber-400' },
  deny: { icon: MinusCircle, className: 'text-destructive' },
  unknown: { icon: ChevronRight, className: 'text-muted-foreground' },
};

export function ReasonList({ codes }: { codes: string[] }): React.JSX.Element {
  if (codes.length === 0) {
    return <p className="text-sm text-muted-foreground">No reasons recorded.</p>;
  }
  return (
    <ul className="flex flex-col gap-2.5">
      {codes.map((code) => {
        const tone = reasonTone(code);
        const { icon: Icon, className } = TONE_STYLE[tone] ?? TONE_STYLE['unknown']!;
        return (
          <li key={code} className="flex items-start gap-2.5 text-sm">
            <Icon className={cn('mt-0.5 size-4 shrink-0', className)} aria-hidden />
            <span className="flex flex-col gap-0.5">
              <span>{reasonLabel(code)}</span>
              <code className="font-mono text-[11px] text-muted-foreground">{code}</code>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
