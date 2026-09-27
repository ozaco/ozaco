import { createContext } from 'std:effect'

import type { CodecDef } from '../types/codec'

export const CodecRegistryContext = createContext<CodecDef[]>('std:codec:registry', [])
