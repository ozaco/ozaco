import { action } from '../base/action'
import type { Operation } from '../types/operation'

/** Convert a promise into an {@link Operation} — resume once the promise settles. */
export const until = <T>(promise: Promise<T>): Operation<T> =>
  action<T>((resolve, reject) => {
    promise.then(resolve).catch(reject)
    return () => {}
  }, 'until')
