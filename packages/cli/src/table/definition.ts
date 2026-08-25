import { defineProtocol } from 'std:plugin'

import pkg from '../../package.json'

import { table } from './internal/actions'
import type { TableDef } from './types/table'

/**
 * The table protocol: streaming, alignment-safe tables. Interactive terminals get an in-place live
 * window drawn through the render lease; non-interactive outputs get append-only plain text. All
 * widths are measured ANSI-stripped, so styled cells can never skew a column.
 */
export const Table = defineProtocol<TableDef.Context, TableDef.Actions>({
  name: 'cli-table',
  version: pkg.version,
  description: 'Streaming terminal tables',
})

export const DefaultTable = Table.implement<TableDef.Context, []>({
  name: 'cli-default-table',
  version: pkg.version,
  description: 'The built-in table renderer',
  *setup() {
    return {}
  },
}).build({
  table,
})
