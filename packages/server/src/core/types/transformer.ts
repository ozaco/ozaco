import type { Future } from 'std:effect'
import type { Result } from 'std:result'
import type { AnyType, EmptyType } from 'std:shared'

import type { ActionContext, ActionRequest, ActionResponse } from 'server:service'

export type RestTransformerContext = EmptyType

export interface RestTransformerOptions {
  method: string
  path: string
  files?: string[] | RegExp | ((key: string) => boolean)
}

export interface RestTransformerActions extends Record<string, AnyType> {
  toInternal: (
    req: unknown,
    res: unknown,
    meta: unknown,
  ) => Future<[req: ActionRequest, res: ActionResponse], unknown>

  toContext: (
    req: ActionRequest,
    res: ActionResponse,
    meta: unknown,
  ) => Future<ActionContext<unknown>, unknown>

  fromInternal: (
    req: ActionRequest | null,
    res: ActionResponse | null,
    ret: Result<unknown, unknown>,
  ) => Future<AnyType, unknown>

  settings: <T extends RestTransformerOptions>(
    options: T,
  ) => Future<T & { transformer: AnyType }, unknown>
}
