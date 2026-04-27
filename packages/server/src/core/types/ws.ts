import type { Future, Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Helpers } from './helpers'

export interface WsTransformerContext {
  open?: ((ws: unknown) => Operation<void, unknown>) | undefined
  close?: ((ws: unknown, code: number, reason: string) => Operation<void, unknown>) | undefined
}

export interface WsTransformerActions extends Record<string, AnyType> {
  upgrade: (req: unknown, runtime: unknown) => Future<boolean, unknown>
  onOpen: (ws: unknown) => Future<void, unknown>
  onMessage: (ws: unknown, message: unknown) => Future<void, unknown>
  onClose: (ws: unknown, code: number, reason: string) => Future<void, unknown>

  settings: <T extends Helpers.WsTransformerOptions>(
    options: T,
  ) => Future<T & { method: string; transformer: AnyType }, unknown>
}
