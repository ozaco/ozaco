import type { Stream } from 'std:effect'
import { createContext } from 'std:effect'

import type { Key } from '../types/common'

/** The decoded key stream bound for the duration of a `Terminal.session()`. */
export const KeyStreamContext = createContext<Stream<Key, void>>('cli:keys')
