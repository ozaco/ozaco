import { createTags } from 'std:shared'

/**
 * The single env var the daemon reads. It names the module THIS process owns; the cluster supervisor
 * sets it on every child it forks, so a replica re-running the same entry resolves its own identity.
 *
 *   unset      → monolith: owns and serves every module (the plain `bun entry.ts` dev path)
 *   'gateway'  → edge: mounts + documents every route, owns nothing
 *   '<module>' → service: owns exactly that module, headless
 */
export const DAEMON_ENV = {
  service: 'SERVICE',
} as const

/** Reserved `SERVICE` value for an edge replica — it routes and documents, it never runs a service. */
export const GATEWAY_ROLE = 'gateway'

export const DaemonErrors = createTags(
  'server:daemon',

  'spawn',
)
