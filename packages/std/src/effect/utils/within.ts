import type { Operation, Scope } from '../types/operation'

/**
 * Run `op` inside ANOTHER scope while the caller keeps ownership of it. The op resolves its
 * contexts (and parents its children) from `scope`, but its lifetime belongs to the caller:
 *
 * - a failure is raised to the caller ONLY — it never tears `scope` down (unlike a supervised
 *   `scope.run`);
 * - halting the caller halts the op (unlike a detached `scope.run`, which keeps running);
 * - closing `scope` halts the op too — the caller then sees `EffectErrors.Halted`.
 */
export function* within<T>(scope: Scope, op: () => Operation<T>): Operation<T> {
  const task = scope.run(op, { detached: true })

  try {
    return yield* task
  } finally {
    // a no-op once the task settled; when the CALLER is unwinding, this interrupts the op and
    // waits for its teardown before the caller's own unwind continues
    yield* task.halt()
  }
}
