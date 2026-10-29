/**
 * The environment a policy is evaluated in.
 *
 * It used to be read from the action request body, which made it a claim: a
 * caller could name DEMO to drop PRODUCTION-scoped protective rules out of
 * scope, or name PRODUCTION to reach production-only logic. The shipped policy
 * does not scope by environment, so nothing broke — but the engine supported
 * the construct, and a tenant's own policy could rely on it.
 *
 * It is now derived from the authenticated principal: the agent row for an
 * agent credential, the tenant's default environment for a human or service
 * credential. The request body may only *ask* for an environment, and the API
 * refuses a request whose ask disagrees with the derived one.
 *
 * The engine deliberately ignores `input.environment` — the requested value. A
 * policy engine that can be handed an environment it did not derive is a policy
 * engine whose scope the caller controls, and every field it resolves would
 * inherit that lie.
 */
import type { Environment, PolicyEvaluationInput } from '@permitzero/domain';

/** The environment that scopes rules and conditions for this action. */
export function effectiveEnvironment(input: PolicyEvaluationInput): Environment {
  return input.principal.environment;
}
