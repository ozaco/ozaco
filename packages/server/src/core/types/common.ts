import type { Result } from 'std:result'

import type { Carried, Source } from './source'

/**
 * What goes out.
 *
 * The address is kept as the two things it is made of: `service` is the registered name and `path`
 * is the dotted key `flatten` produced from the actions record. A single formatted string would
 * need a separator, an escape rule and a parser that can fail — three chances to disagree about a
 * fact both ends already hold.
 */
export interface Request {
  origin: Source.Origin

  service: string
  path: string

  /**
   * Wire-safe by construction. `unknown` values cannot be, and the moment a header map may hold a
   * live object it stops being obvious which parts of it survive a hop.
   */
  meta: Record<string, string>

  /** what the call carries; every source names its own kind, so there is no second list of kinds */
  sources: Source.Any[]

  /**
   * What this call carries and what its answer will hold, projected from the target's declaration.
   *
   * The caller supplies it because the caller is the one holding a definition — a gateway mounts a
   * service and reads its actions without ever running one. A carrier needs `receives` BEFORE it
   * sends, since a return channel has to exist before the answer does. Absent when the call was
   * addressed by bare name, and then a carrier has to be conservative.
   */
  wire?: { sends: Carried[]; receives: Carried[] }
}

/**
 * What comes back.
 *
 * Symmetric with {@link Request} on purpose: whatever can travel out must be able to travel back. A
 * status or a header set by an action running on another node used to have nowhere to go, because
 * the reply carried a value and nothing else.
 */
export interface Response<T = unknown> {
  status: number | undefined
  meta: Record<string, string>

  /** Narrowing on `type` gives the action's own return type back, not `unknown`. */
  sources: Source.Any<T>[]
}

export namespace Response {
  /**
   * The part an action may write, through `useResponse()`.
   *
   * A draft, not the Response itself: an action states a status and headers, it does not get to
   * invent what came back on the wire. The sources come from what it returned and from the channels
   * it declared.
   */
  export interface Draft {
    status: number | undefined
    meta: Record<string, string>
  }
}

/**
 * How a call ended, REIFIED — what `attempt(() => Broker.actions.call(…))` hands back.
 *
 * Not a return type, and it cannot be: an operation that returns a `Result` has it unwrapped by the
 * runtime, because a Result IS this system's control flow. So a call answers with a `Response` and
 * FAILS otherwise, and this names the value you get when you catch that instead of propagating it.
 */
export type Outcome<T = unknown> = Result<Response<T>, Outcome.Fault>

export namespace Outcome {
  /** The handler never got to decide. Distinct from a handler that decided to fail. */
  export type Halt = 'cancelled' | 'timeout' | 'shutdown'

  /**
   * What the failure side adds.
   *
   * The previous core tracked completion with a `let completed = false` straddling try/catch/finally
   * and could not tell a handler that FAILED (an answer) from one that was CUT SHORT (no answer) —
   * so every 4xx an application returned was logged as a cancelled handler. `halted` says the
   * handler never decided; `response` carries what it had already set if it did.
   *
   * `message` and `causes` are NOT copied here; they stay on the `Result.Failure` this is attached
   * to. One home each.
   */
  export interface Fault {
    tag: string
    halted?: Halt
    response?: Response
  }
}
