import { Table } from 'cli:core'

import { table } from './internal/actions'

export const DefaultTable = Table.implement({
  name: 'cli/default-table',
  version: '0.0.0',
  *setup() {
    return {}
  },
}).build({
  table,
})
