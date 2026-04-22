import type { Future } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { QueryBuilder } from './query'
import type { DbError } from './runtime'

const DB_PROTOCOL = Symbol.for('@ozaco/db.protocol')

export type DBContext = QueryBuilder

export interface DBActions extends Record<string, AnyType> {
  close(): Future<void, DbError>
}

export const DB = defineProtocol<DBContext, unknown, [unknown], DBActions>({
  name: 'db',
  version: '0.0.1',
  subtype: DB_PROTOCOL,
})
