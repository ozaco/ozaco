import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { SERVICE } from '../const'

import type { ActionMeta } from './action'

export interface Service<
  TContext = unknown,
  TError = unknown,
  TArgs extends unknown[] = unknown[],
  TActions = unknown,
> extends Plugin<TContext, TError, TArgs, TActions> {
  _st: typeof SERVICE
  meta: Map<string, ActionMeta<AnyType>>
}
