import { createContext } from 'std:effect'

import type { DocsContext } from '../types'

import type { CompiledEntry, OpenAPIDocument } from './types'

export const DocsRef = createContext<DocsContext>('server:docs:ctx')
export const SpecRef = createContext<OpenAPIDocument>('server:docs:spec')
export const SwaggerHtmlRef = createContext<string>('server:docs:swagger-html', '')
export const CompiledRef = createContext<CompiledEntry[]>('server:docs:compiled', [])
