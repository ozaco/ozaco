/**
 * Where the telemetry entrypoints (`scripts/lgtm.ts`, `scripts/openobserve.ts`) ship — the one
 * place the demo reads the environment: a collector's address and credentials belong to the
 * deployment, not to the code. The defaults match the local containers the scripts document.
 *
 * - `OTLP_URL` — the OTLP/HTTP collector (`http://localhost:4318`, `grafana/otel-lgtm`)
 * - `OO_URL`, `OO_ORG`, `OO_USER`, `OO_PASS` — OpenObserve (`http://localhost:5080`, `default`,
 *   `root@ozaco.dev`, `Ozaco-pass1!`; OpenObserve refuses to boot without a strong root password)
 */
import type { OpenObserveTarget, OtlpTarget } from '../src'
import { OTLP_URL } from '../src'

/** The variable's value, else `fallback` (unset and blank alike). */
const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback

/** The OTLP/HTTP collector: `OTLP_URL`, else the local `grafana/otel-lgtm` one. */
export const otlpTarget = (): OtlpTarget => ({ url: env('OTLP_URL', OTLP_URL) })

/** OpenObserve over its OTLP endpoints, basic auth with the root (or an ingestion) user. */
export const openObserveTarget = (): OpenObserveTarget => ({
  url: env('OO_URL', 'http://localhost:5080'),
  org: env('OO_ORG', 'default'),
  auth: { user: env('OO_USER', 'root@ozaco.dev'), pass: env('OO_PASS', 'Ozaco-pass1!') },
})
