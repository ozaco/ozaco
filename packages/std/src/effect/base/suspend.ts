import type { Operation } from '../types/operation'

import { action } from './action'

/**
 * Indefinitely pause execution of the current operation. A suspended operation remains paused until
 * its enclosing scope is destroyed, at which point it proceeds as though return had been called
 * from the point of suspension.
 */
export const suspend = (): Operation<void> => action(() => () => {}, 'suspend')
