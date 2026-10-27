'use client';

/**
 * Token auth for the dashboard. The bearer token lives in localStorage (this
 * is an operator console, not a bank vault — the API treats possession of the
 * token as identity either way). Signing out wipes it and the cached data.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

const TOKEN_KEY = 'pz_token';

export interface AuthContextValue {
  token: string | null;
  /** True once the stored token has been read. Guards must wait for this:
   * redirecting on the initial null would bounce freshly loaded sessions. */
  hydrated: boolean;
  setToken: (token: string) => void;
  signOut: () => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

function readStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [token, setTokenState] = React.useState<string | null>(null);
  const [hydrated, setHydrated] = React.useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  React.useEffect(() => {
    setTokenState(readStoredToken());
    setHydrated(true);
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      token: hydrated ? token : null,
      hydrated,
      setToken: (next: string) => {
        try {
          window.localStorage.setItem(TOKEN_KEY, next);
        } catch {
          // Private mode: the session still works until reload.
        }
        setTokenState(next);
      },
      signOut: () => {
        try {
          window.localStorage.removeItem(TOKEN_KEY);
        } catch {
          // Already gone.
        }
        setTokenState(null);
        queryClient.clear();
        router.push('/login');
      },
    }),
    [token, hydrated, queryClient, router],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Route guard: sends visitors without a token to /login. Waits for
 * hydration first so a freshly loaded session is never bounced. */
export function RequireAuth({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { token, hydrated } = useAuth();
  const router = useRouter();
  React.useEffect(() => {
    if (hydrated && token === null) router.replace('/login');
  }, [hydrated, token, router]);
  if (!hydrated || token === null) return <></>;
  return <>{children}</>;
}
