import { EMPTY_ARGS } from '../const'
import type { ArgsSpec, WizardActionDef } from '../types'

/** Resolve an action's validator, defaulting no-argument actions to an empty object. */
export const resolveActionArgs = (action: WizardActionDef): ArgsSpec => action.args ?? EMPTY_ARGS
