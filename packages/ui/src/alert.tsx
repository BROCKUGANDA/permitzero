import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from './utils/cn.js';

const alertVariants = cva(
  'flex items-start gap-3 rounded-lg border p-4 text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:mt-0.5',
  {
    variants: {
      variant: {
        info: 'border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100',
        success:
          'border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
        warning:
          'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100',
        destructive: 'border-destructive/30 bg-destructive/5 text-destructive dark:text-red-200',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

const icons = { info: Info, success: CheckCircle2, warning: AlertTriangle, destructive: XCircle } as const;

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
  title?: string;
}

function Alert({ className, variant = 'info', title, children, ...props }: AlertProps): React.JSX.Element {
  const Icon = icons[variant ?? 'info'];
  return (
    <div
      role={variant === 'destructive' ? 'alert' : 'status'}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <Icon aria-hidden />
      <div className="flex flex-col gap-1">
        {title ? <p className="font-semibold leading-none">{title}</p> : null}
        <div className="leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

export { Alert, alertVariants };
