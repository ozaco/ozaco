import type { Future, Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { ACTION, DataType } from '../const'

import type { Channel } from './channel'

export interface Action<
  TArgs extends unknown[] = AnyType[],
  TReturn = AnyType,
> extends Action.Meta<unknown> {
  (...args: TArgs): Operation<TReturn>
}

export namespace Action {
  /**
   * Everything a node that does NOT host this action still needs to know about it.
   *
   * A gateway mounts a service, holds its actions and never runs one — so the shape of a call (does
   * it take bytes, does it answer with a stream, is it duplex) has to be readable from here,
   * statically, at mount time. The action's own body decides too late and in the wrong process.
   */
  export interface Meta<TSchema = unknown> {
    _t: typeof ACTION

    title?: string
    description?: string

    /**
     * As WRITTEN by the author: a bare schema (sugar for one `normal` value channel), one channel,
     * or several. Kept so tooling can read the original intent; nothing routes off it directly.
     */
    input?: TSchema | Channel.Declaration
    output?: Channel.Declaration

    /**
     * As RESOLVED by `defineAction`, and the only form anything routes off.
     *
     * It exists as a field rather than as a rule in prose because the obligation used to live in a
     * docstring beside a hand-written value — so a byte stream tagged as a value compiled fine, and
     * three carriers each answered "is this a stream?" by inspecting the return value instead.
     */
    wire: Wire

    settings: Future<unknown>[]
  }

  export interface Wire {
    /** at most one channel per DataType — see `Source` */
    input: Channel[]
    output: Channel[]

    /** the set a carrier opens before dispatching; derived from `input` */
    accepts: DataType[]
    /** the set a carrier must be ready to receive back; derived from `output` */
    produces: DataType[]
  }
}
