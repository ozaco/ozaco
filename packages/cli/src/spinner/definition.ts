import { Spinner } from 'cli:core'

import { bar, group, start } from './internal/actions'

export const DefaultSpinner = Spinner.implement({
  name: 'cli/default-spinner',
  version: '0.0.0',
  *setup() {
    return {}
  },
}).build({
  start,
  bar,
  group,
})
