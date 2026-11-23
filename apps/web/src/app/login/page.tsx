'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@permitzero/ui';
import { useAuth } from '@/lib/auth';
import { VinylMark } from '@/components/vinyl';
import { haptic } from '@/lib/haptics';

export default function LoginPage(): React.JSX.Element {
  const { token, setToken } = useAuth();
  const router = useRouter();
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (token) router.replace('/');
  }, [token, router]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-sm border border-primary/30 bg-primary/5">
          <VinylMark size={28} />
        </span>
        <span className="font-mono text-base font-semibold tracking-tight">
          Permit<span className="text-primary">Zero</span>
        </span>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" aria-hidden />
            Sign in with a token
          </CardTitle>
          <CardDescription>
            Paste an agent, operator, or approver token. Who you are decides what you may see and do.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = value.trim();
              if (trimmed.length < 16) {
                setError('That does not look like a token — it should start with “pz_”.');
                return;
              }
              setError(null);
              haptic('confirm');
              setToken(trimmed);
              router.push('/');
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="token">Bearer token</Label>
              <Input
                id="token"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="pz_…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>
            {error ? (
              <Alert variant="destructive" title="Check the token">
                {error}
              </Alert>
            ) : null}
            <Button type="submit" disabled={value.trim().length === 0}>
              Sign in
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Running the demo? Seed the database first — the seed prints where it saved ready-made tokens for every
              role.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
