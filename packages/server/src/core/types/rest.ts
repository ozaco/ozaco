import type { Future } from 'std:effect'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ActionRequest, ActionResponse } from './action'
import type { Helpers } from './helpers'

export interface RestTransformerContext {
  statusMap?: Record<string, number> | undefined
  maxBodyBytes?: number | undefined
}

export interface RestTransformerActions extends Record<string, AnyType> {
  toInternal: (
    req: unknown,
    res: unknown,
    meta: unknown,
  ) => Future<[req: ActionRequest, res: ActionResponse, body: unknown], unknown>

  // oxlint-disable-next-line max-params
  fromInternal: (
    req: ActionRequest | null,
    res: ActionResponse | null,
    ret: Result<unknown, unknown>,
    meta: unknown,
  ) => Future<AnyType, unknown>

  settings: <T extends Helpers.RestTransformerOptions>(
    options: T,
  ) => Future<T & { transformer: AnyType }, unknown>
}
