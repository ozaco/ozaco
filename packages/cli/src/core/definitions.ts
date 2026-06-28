import { defineProtocol } from 'std:plugin'

import { PALETTE, PROMPT, SPINNER, TERMINAL } from './const'
import type { PaletteDef } from './types/palette'
import type { PromptDef } from './types/prompt'
import type { SpinnerDef } from './types/spinner'
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

export const Palette = defineProtocol<
  PaletteDef.Context,
  unknown,
  [options?: PaletteDef.Options],
  PaletteDef.Actions
>({
  name: 'cli/palette',
  version: '0.0.1',
  subtype: PALETTE,
})

export const Spinner = defineProtocol<
  SpinnerDef.Context,
  unknown,
  [options?: SpinnerDef.Options],
  SpinnerDef.Actions
>({
  name: 'cli/spinner',
  version: '0.0.1',
  subtype: SPINNER,
})

export const Prompt = defineProtocol<
  PromptDef.Context,
  unknown,
  [options?: PromptDef.Options],
  PromptDef.Actions
>({
  name: 'cli/prompt',
  version: '0.0.1',
  subtype: PROMPT,
})
