import { defineProtocol } from 'std:plugin'

import { PALETTE, PROMPT, REGISTRY, SPINNER, TABLE, TERMINAL } from './const'
import type { PaletteDef } from './types/palette'
import type { PromptDef } from './types/prompt'
import type { RegistryDef } from './types/registry'
import type { SpinnerDef } from './types/spinner'
import type { TableDef } from './types/table'
import type { TerminalDef } from './types/terminal'

export const Terminal = defineProtocol<
  TerminalDef.Context,
  [options?: TerminalDef.Options],
  TerminalDef.Actions
>({
  name: 'cli/terminal',
  version: '0.0.1',
  subtype: TERMINAL,
})

export const Palette = defineProtocol<
  PaletteDef.Context,
  [options?: PaletteDef.Options],
  PaletteDef.Actions
>({
  name: 'cli/palette',
  version: '0.0.1',
  subtype: PALETTE,
})

export const Spinner = defineProtocol<
  SpinnerDef.Context,
  [options?: SpinnerDef.Options],
  SpinnerDef.Actions
>({
  name: 'cli/spinner',
  version: '0.0.1',
  subtype: SPINNER,
})

export const Prompt = defineProtocol<
  PromptDef.Context,
  [options?: PromptDef.Options],
  PromptDef.Actions
>({
  name: 'cli/prompt',
  version: '0.0.1',
  subtype: PROMPT,
})

export const Registry = defineProtocol<
  RegistryDef.Context,
  [options?: RegistryDef.Options],
  RegistryDef.Actions
>({
  name: 'cli/registry',
  version: '0.0.1',
  subtype: REGISTRY,
})

export const Table = defineProtocol<
  TableDef.Context,
  [options?: TableDef.Options],
  TableDef.Actions
>({
  name: 'cli/table',
  version: '0.0.1',
  subtype: TABLE,
})
