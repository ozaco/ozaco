import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

export function* withHost<T>(op: Helpers.HostOperation<T>): Operation<T> {
  const global = globalThis as Record<string, unknown>

  // oxlint-disable-next-line unicorn/no-typeof-undefined
  if (typeof global.Deno !== 'undefined') {
    return yield* op.deno()
  } else if (
    // oxlint-disable-next-line unicorn/no-typeof-undefined
    typeof global.Bun !== 'undefined' &&
    // oxlint-disable-next-line unicorn/no-typeof-undefined
    Object.prototype.toString.call(typeof global.process === 'undefined' ? 0 : global.process) ===
      '[object process]'
  ) {
    return yield* op.bun()
  } else if (
    // oxlint-disable-next-line unicorn/no-typeof-undefined
    Object.prototype.toString.call(typeof global.process === 'undefined' ? 0 : global.process) ===
    '[object process]'
  ) {
    return yield* op.node()
  }

  return yield* op.browser()
}
