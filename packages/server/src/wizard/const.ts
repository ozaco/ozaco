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
