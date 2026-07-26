import { Broker, DataType } from '@ozaco/server/core'
import type { Operation } from '@ozaco/std/effect'

/**
 * Call by address, with plain arguments.
 *
 * All this does is wrap each argument as a `normal` source — the answer needs no unwrapping, because
 * `call` hands back what the action returned. Reach for `Broker.actions.exchange` where a test cares
 * about the status or a lane.
 */
export const call = <T = unknown>(
  service: unknown,
  path: string,
  ...args: unknown[]
): Operation<T> =>
  Broker.actions.call(
    service as never,
    path as never,
    args.map(value => ({ type: DataType.normal, value })),
  ) as Operation<T>
