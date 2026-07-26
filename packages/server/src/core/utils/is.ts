import { isPlugin, isProtocol } from 'std:plugin'
import type { Result } from 'std:result'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { isObject } from 'std:shared'

import { ACTION, DataType, SERVICE } from '../const'
import type { Action } from '../types/action'
import type { Outcome } from '../types/common'
import type { Service } from '../types/service'

export const isService = (value: unknown): value is Service =>
  (isProtocol(value) || isPlugin(value)) && (value as AnyType)._st === SERVICE

export const isAction = (value: unknown): value is Action =>
  typeof value === 'function' && (value as AnyType)._t === ACTION

/**
 * Does this action's DECLARATION say it answers with a lane?
 *
 * Ask the declaration, never the value. The predicate this replaces inspected the RESULT — and
 * because `isStream` is satisfied by anything iterable, it had to exclude strings, arrays and
 * typed arrays by hand and still got it wrong in both directions: a buffered `Uint8Array` was
 * pumped chunk by chunk, and a lane that happened to be empty was sent as a value. `wire` was
 * resolved once, at definition time, from something the author actually wrote.
 */
export const producesLane = (action: Action.Meta | undefined): boolean =>
  action?.wire.produces.some(type => type !== DataType.normal) ?? false

/** The mirror: does the call carry a lane INTO the action? */
export const acceptsLane = (action: Action.Meta | undefined): boolean =>
  action?.wire.accepts.some(type => type !== DataType.normal) ?? false

/**
 * Did this call fail, and with an {@link Outcome.Fault}?
 *
 * Both questions at once, because at a call site they are never asked separately. `attempt` cannot
 * know what a failure carries so it hands back `unknown`; this is what says "a call faulted" and
 * gives you `.error.tag` without a cast.
 *
 * A `false` says only "not a faulted call" — it may be a success, or a failure raised by something
 * outside the call path. Reach for `isSuccess` when that is the question.
 */
export const isFault = (value: unknown): value is Result.Failure<Outcome.Fault> =>
  isFailure(value) && isObject(value.error) && typeof (value.error as AnyType).tag === 'string'

/**
 * The tag a failure carries, whether or not it is wrapped in a {@link Outcome.Fault}.
 *
 * A Fault is the CALL PATH's contract — it exists so a
 * surface can find the status an action had already set. An application's own callback (`when`,
 * `onFailure`) asked a simpler question, and answering it with the envelope means every predicate
 * ever written as `f.error === 'boom'` silently stops matching.
 */
export const tagOf = (error: unknown): unknown =>
  isObject(error) && typeof (error as AnyType).tag === 'string' ? (error as AnyType).tag : error

/** The same failure, with its fault unwrapped to the plain tag an application expects. */
export const untagged = <T extends { error: unknown }>(failure: T): T =>
  ({ ...failure, error: tagOf(failure.error) }) as T
