import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { ACTION } from '../const'

import type { Action } from './action'
import type { RestTransformerActions, RestTransformerContext } from './rest'
import type { RouterActions, RouterContext } from './router'
import type { Service } from './service'
import type { WsTransformerActions, WsTransformerContext } from './ws'

export namespace Helpers {
  export interface ActionMeta<TSchema> {
    _t: typeof ACTION
    _r: boolean

    input?: TSchema
    output?: StandardSchemaV1

    title?: string
    description?: string

    allow?: AnyType[]
    deny?: AnyType[]
    settings?: Future<unknown, unknown>[]
  }

  export type DefaultRouter = Plugin<RouterContext, unknown, unknown[], RouterActions>

  export type DefaultRestTransformer = Plugin<
    RestTransformerContext,
    unknown,
    [options?: { statusMap?: Record<string, number> }],
    RestTransformerActions
  >

  export type DefaultWsTransformer = Plugin<
    WsTransformerContext,
    unknown,
    [options?: WsTransformerContext],
    WsTransformerActions
  >

  export interface RestTransformerOptions {
    method: string
    path: string
    files?: string[] | RegExp | ((key: string) => boolean)
    statusMap?: Record<string, number>
  }

  export interface WsTransformerOptions {
    path: string
  }

  export interface TransformerSetting {
    method: string
    path: string
    transformer: AnyType
  }

  export interface TransformerMeta {
    sym: symbol
    key?: string
    prefix: string
    target: Action | Service
    setting: TransformerSetting & Partial<RestTransformerOptions>
    params: Record<string, unknown>
  }
}
