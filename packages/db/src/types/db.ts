import type { Future } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { QueryBuilder } from './query'
import type { DbError } from './runtime'

export type DBContext = QueryBuilder

export interface DBActions extends Record<string, AnyType> {
  close(): Future<void, DbError>
}
