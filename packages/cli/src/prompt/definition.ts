// oxlint-disable import/exports-last
import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import pkg from '../../package.json'

import { autocomplete } from './internal/actions/autocomplete'
import { confirm } from './internal/actions/confirm'
import { multiselect } from './internal/actions/multiselect'
import { number } from './internal/actions/number'
import { password } from './internal/actions/password'
import { path } from './internal/actions/path'
import { select } from './internal/actions/select'
import { text } from './internal/actions/text'
import type { PromptDef } from './types/prompt'

/**
 * The prompt protocol: interactive question flows over the installed `Terminal` + `Palette`. Every
 * prompt runs inside a raw-mode `session` and draws through the render lease; cancel (ctrl+c /
 * ctrl+d / esc) fails `cli.cancelled`, a non-interactive terminal fails `cli.not-interactive`.
 */
export const Prompt = defineProtocol<PromptDef.Context, PromptDef.Actions>({
  name: 'cli-prompt',
  version: pkg.version,
  description: 'Interactive terminal prompts',
})

export const DefaultPrompt = Prompt.implement<PromptDef.Context, []>({
  name: 'cli-default-prompt',
  version: pkg.version,
  description: 'The built-in prompt set',
  *setup() {
    return {}
  },
}).build({
  text,
  password,
  number,
  confirm,
  // the generic type parameters of select/multiselect/autocomplete live on the Actions interface;
  // `operation()` erases them on the value side, so the members are pinned via the contract type
  select: select as AnyType,
  multiselect: multiselect as AnyType,
  autocomplete: autocomplete as AnyType,
  path,
} satisfies Record<keyof PromptDef.Actions, AnyType> as AnyType as PromptDef.Actions)
