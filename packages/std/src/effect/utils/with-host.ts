import type { Operation } from '../types/operation'
import type { Utils } from '../types/utils'

export function* withHost<T>(op: Utils.HostOperation<T>): Operation<T> {
  const host = globalThis as Record<string, unknown>

  if (host.Deno !== undefined) {
    return yield* op.deno()
  } else if (
    Object.prototype.toString.call(host.process === undefined ? 0 : host.process) ===
    '[object process]'
  ) {
    // node and bun both take this branch
    return yield* op.node()
  }

  return yield* op.browser()
}
