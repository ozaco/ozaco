import { z } from 'zod'

/** Phantom carriers (never present at runtime) that let a {@link WizardActionDef}'s call-args + result
 * types travel with the def: `ARGS` keys the call input, `RESULT` the call return. */
export declare const ARGS: unique symbol
export declare const RESULT: unique symbol

/** Broker event name carrying a committed DB write across nodes. */
export const CHANGE_EVENT = 'ozaco:db:change'

// no-argument actions accept an omitted body: `undefined` input coerces to `{}` (so a `Query<never>`
// called with no args validates), while an explicit `{}` still passes.
export const EMPTY_ARGS = z.object({}).default({})

/**
 * How long a `_realtime` WebSocket may hold a connection with NOTHING subscribed before the server
 * hangs up (0 disables it, overridable per resource with `realtimeIdleMs`).
 *
 * A socket only becomes useful once a `watch` is ACCEPTED — the access guard runs there, not at the
 * handshake. So a client that never subscribes, or one whose every subscription was refused, used
 * to sit on a live connection forever: an unauthenticated caller could park sockets for free. A
 * healthy client subscribes immediately, so this never fires on one.
 */
export const REALTIME_IDLE_MS = 30_000
