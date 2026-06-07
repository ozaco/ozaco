import { createContext } from 'std:effect'

import type { CodecDef } from '../types'

export const CodecRegistryContext = createContext<CodecDef[]>('std:codec:registry', [])
