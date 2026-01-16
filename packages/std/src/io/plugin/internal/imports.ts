import { throwable } from 'std:result'

import { FSError } from '../../const'

export const importFs = () => throwable(() => import('node:fs/promises'), FSError)
