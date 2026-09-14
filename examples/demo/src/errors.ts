/** The demo's failure taxonomies: the tag, its status and the failer declared ONCE — the
 * action publishes `errors: xErrors.statuses`, the handler raises `xErrors.someTag(...)`. */
import { serviceErrors } from 'server:core'

export const accountErrors = serviceErrors('account', { 'unknown-user': 404 })
export const mediaErrors = serviceErrors('media', { 'not-found': 404 })

/** the todos resource's own taxonomy, wired per-op via crud `ops`. */
export const todosErrors = serviceErrors('todos', { protected: 423 })

/** the reports service: `flaky` is retried away by the resilience option, `boom` is asked for. */
export const reportsErrors = serviceErrors('reports', { flaky: 500, boom: 500 })

/** the rtc page build step. */
export const rtcErrors = serviceErrors('rtc', { build: 500 })
