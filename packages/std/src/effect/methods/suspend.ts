import type { Operation } from '../types/operation'

import { action } from './action'

export const suspend = (): Operation<void> => action(() => () => {}, 'suspend')
