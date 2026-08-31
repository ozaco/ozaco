/** Everything the demo pins as a constant — one place, instead of environment variables. */
import { account } from './internal/services/account'
import { cluster } from './internal/services/cluster'
import { feed } from './internal/services/feed'
import { live } from './internal/services/live'
import { media } from './internal/services/media'
import { reports } from './internal/services/reports'
import { rtc } from './internal/services/rtc'
import { todos } from './internal/services/todos'

export const APP_NAME = 'demo'
export const APP_VERSION = '1.0.0'

/** the transport subject prefix every node of the cluster shares. */
export const TRANSPORT_PREFIX = 'demo'

/** HS256 signing secret — a DEMO value, change it for anything real. */
export const AUTH_SECRET = 'demo-secret-change-me'
export const ACCESS_TTL_MS = 15 * 60 * 1000
export const READY_TIMEOUT_MS = 30_000
export const HOSTNAME = '127.0.0.1'

/** every service of the demo — a monolith hosts them all, the cluster splits them up. */
export const services = [account, todos, feed, media, reports, live, rtc, cluster] as const
