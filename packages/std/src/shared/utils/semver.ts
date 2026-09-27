import { compareParsed, parse, parseComparator } from '../internal/semver'
import type { Helpers } from '../types/helpers'

/**
 * Order two semver strings by precedence: `-1` / `0` / `1` (a `sort` comparator). Prereleases
 * rank below their release and compare field by field (numeric < alphanumeric); build metadata
 * is ignored. A string that is not a version ranks below every version (two of them are equal).
 */
export const compareVersions = (a: string, b: string): -1 | 0 | 1 => {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) {
    return left ? 1 : right ? -1 : 0
  }

  return compareParsed(left, right) as -1 | 0 | 1
}

/**
 * Whether `version` satisfies `range`. A range is `||`-separated alternatives, each a
 * space-separated AND of comparators: exact (`1.2.3`, `=1.2.3`), `>=` / `>` / `<=` / `<`, caret
 * (`^1.2.3` — no change to the leftmost non-zero field), tilde (`~1.2.3` — patch-level), and
 * x-ranges (`1.x`, `1.2.*`, `1`, `*`, `''`). Prereleases compare by plain semver precedence (no
 * npm-style "same tuple" opt-in): `1.0.0-rc.1` satisfies `>=0.9.0` and not `^1.0.0`. An invalid
 * version or comparator never matches.
 */
export const satisfies = (version: string, range: string): boolean => {
  const target = parse(version)
  if (!target) {
    return false
  }

  return range.split('||').some(alternative => {
    const tokens = alternative.trim().split(/\s+/u).filter(Boolean)
    const comparators: Helpers.Comparator[] = []

    for (const token of tokens) {
      const parsed = parseComparator(token)
      if (!parsed) {
        return false
      }
      comparators.push(...parsed)
    }

    return comparators.every(comparator => comparator(target))
  })
}
