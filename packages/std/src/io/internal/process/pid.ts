import type { Operation } from 'std:effect'
import { asFailure } from 'std:result'

import { IOErrors } from '../../errors'

/**
 * The signal-0 probe behind `IO.actions.processAlive`: `process.kill(pid, 0)` delivers nothing
 * and tells whether the pid is taken. Its rejection is folded through the `IOErrors` matchers —
 * `EPERM` (`std:io.access-denied`) is a process this one may not signal, so it EXISTS; `ESRCH`
 * (`std:io.not-found`) is none; anything else (an invalid pid) is raised as folded.
 */
export function* processAlive(pid: number): Operation<boolean> {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    const failure = asFailure(error, IOErrors)

    if (failure.error === IOErrors.AccessDenied) {
      return true
    }

    if (failure.error === IOErrors.NotFound) {
      return false
    }

    return yield* failure
  }
}

/** `IO.actions.signal`: `process.kill` to any pid, its rejection folded (`ESRCH` →
 * `std:io.not-found`, `EPERM` → `std:io.access-denied`, else `std:result.unknown`). */
export function* signalProcess(pid: number, signal: number | string = 'SIGTERM'): Operation<void> {
  try {
    process.kill(pid, signal as NodeJS.Signals | number)
  } catch (error) {
    return yield* asFailure(error, IOErrors)
  }
}
