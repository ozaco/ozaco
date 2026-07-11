import type { Plugin } from 'std:plugin'

import type { SERVICE } from '../const'

export interface Service<
  TContext = unknown,
  TArgs extends unknown[] = unknown[],
  TActions = unknown,
> extends Plugin<TContext, TArgs, TActions> {
  _st: typeof SERVICE
}

export namespace Service {}
