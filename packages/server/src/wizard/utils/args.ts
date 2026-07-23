import { z } from 'zod'

import type { ArgsSpec, WizardActionDef } from '../types'

// no-argument actions accept an omitted body: `undefined` input coerces to `{}` (so a `Query<never>`
// called with no args validates), while an explicit `{}` still passes.
const EMPTY_ARGS = z.object({}).default({})

/** Resolve an action's validator, defaulting no-argument actions to an empty object. */
export const resolveActionArgs = (action: WizardActionDef): ArgsSpec => action.args ?? EMPTY_ARGS
