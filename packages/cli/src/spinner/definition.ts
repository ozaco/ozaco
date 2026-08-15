import { defineProtocol } from 'std:plugin'

import { bar, group, start } from './internal/actions'
import type { SpinnerDef } from './types/spinner'

/**
 * The spinner protocol: transient progress feedback (single spinners, bars, nested task trees)
 * drawn through the exclusive render lease — so a spinner can never interleave with a live table
 * or a prompt, and the cursor is restored on every exit path.
 */
export const Spinner = defineProtocol<SpinnerDef.Context, SpinnerDef.Actions>({
  name: 'cli-spinner',
  version: '0.1.0',
  description: 'Spinners, progress bars and task trees',
})

export const DefaultSpinner = Spinner.implement<SpinnerDef.Context, []>({
  name: 'cli-default-spinner',
  version: '0.1.0',
  description: 'The built-in spinner renderer',
  *setup() {
    return {}
  },
}).build({
  start,
  bar,
  group,
})
