import { createContext } from 'std:effect'

import type { DocsDef } from '../types'

export const DocsRef = createContext<DocsDef.Context>('server:docs:ctx')
export const SpecRef = createContext<DocsDef.OpenAPIDocument>('server:docs:spec')
export const SwaggerHtmlRef = createContext<string>('server:docs:swagger-html', '')
export const CompiledRef = createContext<DocsDef.CompiledEntry[]>('server:docs:compiled', [])
