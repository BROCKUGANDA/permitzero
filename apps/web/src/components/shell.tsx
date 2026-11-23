'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  FlaskConical,
  LayoutDashboard,
  LogOut,
  PlusCircle,
  ScrollText,
  UserRound,
  Plug,
  LineChart,
  Webhook,
} from 'lucide-react';
import { Button, Skeleton } from '@permitzero/ui';
import { RequireAuth, useAuth } from '@/lib/auth';
import { ApiError, useMe, useStatus } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@permitzero/ui';
import { VinylMark } from './vinyl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/primitives';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/actions', label: 'Actions', icon: ScrollText },
  { href: '/actions/new', label: 'New request', icon: PlusCircle },
  { href: '/connected-accounts', label: 'Connected accounts', icon: Plug },
  { href: '/market-data', label: 'Market data', icon: LineChart },
  { href: '/webhooks', label: 'Webhooks', icon: Webhook },
] as const;

function UserMenu(): React.JSX.Element {
  const { me, error, isLoading } = useMe();
  const { signOut } = useAuth();

  React.useEffect(() => {
    if (error instanceof ApiError && error.status === 401) signOut();
  }, [error, signOut]);

  if (isLoading) return <Skeleton className="h-9 w-28" />;
  if (!me) return <></>;
  const role = me.roles[0]?.toLowerCase().replace(/_/g, ' ') ?? me.actor_type.toLowerCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => haptic('tick')}>
          <UserRound aria-hidden />
          <span className="max-w-40 truncate">{me.display_name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <span className="block font-semibold normal-case text-foreground">{me.display_name}</span>
          <span className="block font-normal capitalize">
            {role} · {me.environment.toLowerCase()}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut()}>
          <LogOut className="size-4" aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SyntheticBanner(): React.JSX.Element | null {
  const { status } = useStatus();
  if (!status?.synthetic_data_mode) return null;
  return (
    <div className="flex items-center justify-center gap-2 border-b border-signal/30 bg-signal/10 px-4 py-1.5 font-mono text-[11px] font-medium uppercase tracking-wider text-signal">
      <FlaskConical className="size-3.5" aria-hidden />
      <span>Demonstration data — every record here is synthetic. Nothing here moves real money.</span>
    </div>
  );
}

function ShellFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const reduced = useReducedMotion();

  return (
    <div className="flex min-h-screen flex-col">
      <SyntheticBanner />
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="group flex items-center gap-2.5" onClick={() => haptic('tick')}>
            <span className="grid size-8 place-items-center rounded-sm border border-primary/30 bg-primary/5 transition-colors group-hover:border-primary/60">
              <VinylMark size={26} />
            </span>
            <span className="font-mono text-sm font-semibold tracking-[0.02em]">
              Permit<span className="text-primary">Zero</span>
            </span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="Primary">
            {NAV.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => haptic('tick')}
                  className={cn(
                    'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-3 py-1.5 font-mono text-xs font-medium transition-colors',
                    active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-sm border border-primary/25 bg-primary/10"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  ) : null}
                  <item.icon className="relative size-4" aria-hidden />
                  <span className="relative hidden xl:inline">{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:flex">
              <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
              Console
            </span>
            <UserMenu />
          </div>
        </div>
      </header>
      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={pathname}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6"
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? undefined : { opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          {children}
        </motion.main>
      </AnimatePresence>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <RequireAuth>
      <ShellFrame>{children}</ShellFrame>
    </RequireAuth>
  );
}
