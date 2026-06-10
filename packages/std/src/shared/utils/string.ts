import type { KebabToPascal } from '../types/string'

export const kebabToPascal = <S extends string>(s: S) =>
  s
    .split('-')
    .filter(Boolean)
    .map(p => p[0]!.toUpperCase() + p.slice(1))
    .join('') as KebabToPascal<S>
