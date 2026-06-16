import { createTags } from 'std:shared'

/** Env vars the daemon reads. The supervisor sets `strategy`/`mode`/`role` on each forked child, so a
 * replica re-running the same entry resolves its identity from these alone. */
export const DAEMON_ENV = {
  strategy: 'DAEMON_STRATEGY',
  count: 'DAEMON_COUNT',
  mode: 'DAEMON_MODE',
  role: 'DAEMON_ROLE',
  service: 'SERVICE',
} as const

export const DaemonErrors = createTags(
  'server:daemon',

  'unsupported-strategy',
  'missing-script',
  'spawn',
)
