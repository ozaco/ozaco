import type { AnyType } from '../types/common'

import { flattenEntries } from './path'

/** Flatten a nested object into ONE level of dotted keys (`{ a: { b: 1 } }` → `{ 'a.b': 1 }`);
 * functions, arrays and primitives are leaves. The object form of `flattenEntries`. */
export const flatten = (obj: Record<string, AnyType>, prefix = ''): Record<string, AnyType> =>
  Object.fromEntries(flattenEntries(obj, prefix).map(entry => [entry.key, entry.value]))
