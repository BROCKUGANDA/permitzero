/**
 * Simulation-only environment guard.
 *
 * The first commercial release has no live payment-rail path. Provider
 * credentials may remain in an operator's environment during migration, but
 * LIVE_FINANCE_ENABLED is not a supported switch: naming it fails closed at
 * boot instead of constructing a dormant Wise/Stripe route.
 */
const TRUTHY = ['1', 'true', 'yes', 'on'];

function assertLiveFinanceDisabled(env: NodeJS.ProcessEnv): void {
  if (TRUTHY.includes((env['LIVE_FINANCE_ENABLED'] ?? '').trim().toLowerCase())) {
    throw new Error('LIVE_FINANCE_ENABLED is forbidden: this release is simulation-only.');
  }
}

/** @deprecated Simulation-only release: always null, or throws if live finance is requested. */
export function liveFinanceWiringFromEnv(env: NodeJS.ProcessEnv = process.env): null {
  assertLiveFinanceDisabled(env);
  return null;
}

/** @deprecated Simulation-only release: always null, or throws if live finance is requested. */
export function connectOAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): null {
  assertLiveFinanceDisabled(env);
  return null;
}
