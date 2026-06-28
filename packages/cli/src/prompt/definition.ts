import { Prompt } from 'cli:core'

import { autocomplete } from './internal/actions/autocomplete'
import { confirm } from './internal/actions/confirm'
import { multiselect } from './internal/actions/multiselect'
import { number } from './internal/actions/number'
import { password } from './internal/actions/password'
import { path } from './internal/actions/path'
import { select } from './internal/actions/select'
import { text } from './internal/actions/text'

export const DefaultPrompt = Prompt.implement({
  name: 'cli/default-prompt',
  version: '0.0.0',
  *setup() {
    return {}
  },
}).build({
  text,
  password,
  number,
  confirm,
  select,
  multiselect,
  autocomplete,
  path,
})
