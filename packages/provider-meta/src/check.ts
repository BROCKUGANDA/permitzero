#!/usr/bin/env tsx
/**
 * Connectivity check for the Meta Model API. Loads and validates the
 * provider config, then runs one tiny screening call against the live API.
 * Prints the outcome (never the key) and exits non-zero on any failure.
 *
 * Usage: MODEL_API_KEY=... MODEL_ID=... npm run model:check -w @permitzero/provider-meta
 */
import { MetaProviderClient, MetaProviderError } from './client.js';
import { loadMetaConfig } from './config.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadMetaConfig();
  } catch (err) {
    console.error(`model:check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  console.log(`model:check: provider ${config.baseUrl} model ${config.modelId}`);
  const client = new MetaProviderClient(config);
  const started = Date.now();
  try {
    const result = await client.analyze({
      toolName: 'invoice.read',
      operation: 'read',
      taskPurpose: 'Connectivity check. Not a real action.',
      argumentsJson: { invoice_id: 'CHECK' },
      evidenceRefs: [],
      untrustedTexts: [],
    });
    console.log(
      `model:check: ok in ${Date.now() - started}ms — schema ${result.hints.schemaVersion}, ` +
        `${result.hints.instructionInjectionIndicators.length} indicator(s), prompt ${result.promptVersion}.`,
    );
  } catch (err) {
    if (err instanceof MetaProviderError) {
      console.error(`model:check: ${err.errorClass}${err.status ? ` (HTTP ${err.status})` : ''} — ${err.message}`);
    } else {
      console.error(`model:check: unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

await main();
