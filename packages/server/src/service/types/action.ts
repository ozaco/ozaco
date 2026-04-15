import type { Operation } from 'std:effect'
import type { StandardSchemaV1 } from 'std:shared'

import type { ACTION } from '../const'

export interface ActionMeta {
  _at: typeof ACTION
  input?: StandardSchemaV1
  output?: StandardSchemaV1
}

export type Action<TArgs extends unknown[] = unknown[], TReturn = unknown, TError = unknown> = ((
  ...args: TArgs
) => Operation<TReturn, TError>) &
  ActionMeta
