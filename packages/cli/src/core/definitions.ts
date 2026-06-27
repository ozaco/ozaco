import { defineProtocol } from 'std:plugin'

import { TERMINAL } from './const'
import type { TerminalDef } from './types/terminal'

export const Terminal = defineProtocol<
  TerminalDef.Context,
  unknown,
  [options?: TerminalDef.Options],
  TerminalDef.Actions
>({
  name: 'cli/terminal',
  version: '0.0.1',
  subtype: TERMINAL,
})
