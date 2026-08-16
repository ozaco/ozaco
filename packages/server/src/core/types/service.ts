import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { SERVICE } from '../const'

import type { Action } from './action'
import type { Schema } from './channel'

/** The variance-relaxed action map every service carries. */
export type ActionMap = Record<string, Action<AnyType, AnyType>>

export interface ServiceConfig<TActions extends ActionMap = ActionMap> {
  readonly name: string
  readonly version?: string | undefined
  readonly description?: string | undefined
  readonly actions: TActions
  /** Reactive events this service emits (payload schemas feed the docs manifest). */
  readonly events?: Record<string, Schema> | undefined
  /** Runs when the service is registered on a broker, inside the broker's scope. */
  readonly setup?: (() => Operation<void>) | undefined
}

/**
 * A plain branded service: a named bag of actions plus optional setup. Registered on a broker with
 * `Broker.actions.register(service)`; addressed by object (typed) or by name (dynamic).
 */
export interface Service<TActions extends ActionMap = ActionMap> {
  readonly _t: typeof SERVICE
  readonly name: string
  readonly version: string
  readonly description?: string | undefined
  readonly actions: TActions
  readonly events: Record<string, Schema>
  readonly setup?: (() => Operation<void>) | undefined
}

/** The action keys of a service. */
export type ActionKey<S extends Service> = keyof S['actions'] & string

/** The params type of one service action. */
export type ArgsOf<S extends Service, K extends ActionKey<S>> =
  S['actions'][K] extends Action<infer P, infer _R> ? P : never

/** The result type of one service action. */
export type ReturnsOf<S extends Service, K extends ActionKey<S>> =
  S['actions'][K] extends Action<infer _P, infer R> ? R : never
