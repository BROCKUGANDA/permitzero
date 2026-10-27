'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FlaskConical, LayoutDashboard, LogOut, PlusCircle, ScrollText, UserRound } from 'lucide-react';
import { Button, Skeleton } from '@permitzero/ui';
import { RequireAuth, useAuth } from '@/lib/auth';
import { ApiError, useMe, useStatus } from '@/lib/api';
import { cn } from '@permitzero/ui';
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
        <Button variant="outline" size="sm" className="gap-2">
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
    <div className="flex items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-xs font-medium text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      <FlaskConical className="size-3.5" aria-hidden />
      <span>Demonstration data — every record here is synthetic. Nothing here moves real money.</span>
    </div>
  );
}

function ShellFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen flex-col">
      <SyntheticBanner />
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary font-mono text-sm font-bold text-primary-foreground">
              P
            </span>
            <span className="text-[15px] font-semibold tracking-tight">PermitZero</span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="Primary">
            {NAV.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <item.icon className="size-4" aria-hidden />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto">
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
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
