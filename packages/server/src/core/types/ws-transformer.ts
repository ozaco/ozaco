import type { Future, Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

export interface WsOptions {
  open?: (ws: unknown) => Operation<void, unknown>
  close?: (ws: unknown, code: number, reason: string) => Operation<void, unknown>
}

export interface WsTransformerContext {
  open: WsOptions['open'] | null
  close: WsOptions['close'] | null
}

export interface WsTransformerOptions {
  path: string
}

export interface WsTransformerActions extends Record<string, AnyType> {
  upgrade: (req: Request, runtime: unknown) => Future<boolean, unknown>
  onOpen: (ws: unknown) => Future<void, unknown>
  onMessage: (ws: unknown, message: unknown) => Future<void, unknown>
  onClose: (ws: unknown, code: number, reason: string) => Future<void, unknown>

  settings: <T extends WsTransformerOptions>(
    options: T,
  ) => Future<T & { method: string; transformer: AnyType }, unknown>
}
