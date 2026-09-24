import type { Helpers } from '../types/helpers'

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

const parse = (version: string): Helpers.Version | undefined => {
  const match = VERSION.exec(version.trim())
  if (!match) {
    return undefined
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

// semver §11: numeric identifiers compare numerically and sort BELOW alphanumeric ones
const compareIdentifier = (a: string, b: string): number => {
  const aNumeric = /^\d+$/u.test(a)
  const bNumeric = /^\d+$/u.test(b)

  if (aNumeric && bNumeric) {
    return Math.sign(Number(a) - Number(b))
  }
  if (aNumeric !== bNumeric) {
    return aNumeric ? -1 : 1
  }
  return a < b ? -1 : a > b ? 1 : 0
}

const compareParsed = (a: Helpers.Version, b: Helpers.Version): number => {
  const core =
    Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch)
  if (core !== 0) {
    return core
  }

  // a prerelease ranks BELOW its release (`1.0.0-rc.1 < 1.0.0`)
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length)
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let at = 0; at < length; at += 1) {
    const left = a.prerelease[at]
    const right = b.prerelease[at]
    // the shorter identifier list ranks lower when every shared field is equal
    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1
    }
    const order = compareIdentifier(left, right)
    if (order !== 0) {
      return order
    }
  }
  return 0
}

type Comparator = (version: Helpers.Version) => boolean

const at = (major: number, minor: number, patch: number): Helpers.Version => ({
  major,
  minor,
  patch,
  prerelease: [],
})

const gte =
  (bound: Helpers.Version): Comparator =>
  version =>
    compareParsed(version, bound) >= 0
const lt =
  (bound: Helpers.Version): Comparator =>
  version =>
    compareParsed(version, bound) < 0

const isWild = (part: string | undefined) =>
  part === undefined || part === 'x' || part === 'X' || part === '*'

// `1`, `1.x`, `1.2.*`, `*` → the half-open range the wildcard spans
const xRange = (parts: string[]): Comparator[] | undefined => {
  const [major, minor] = parts.map(Number)
  if (isWild(parts[0])) {
    return []
  }
  if (isWild(parts[1])) {
    return [gte(at(major!, 0, 0)), lt(at(major! + 1, 0, 0))]
  }
  if (isWild(parts[2])) {
    return [gte(at(major!, minor!, 0)), lt(at(major!, minor! + 1, 0))]
  }
  return undefined
}

// one comparator token — `^1.2.3`, `~1.2`, `>=1.0.0`, `<2`, `=1.2.3`, `1.2.3`, `1.x`, `*`
const parseComparator = (token: string): Comparator[] | undefined => {
  const match = /^(\^|~|>=|<=|>|<|=)?v?(.*)$/u.exec(token)
  const operator = match?.[1] ?? ''
  const body = match?.[2] ?? ''

  const [core = '', ...rest] = body.split(/(?=[-+])/u)
  const parts = core.split('.')
  if (parts.length > 3 || parts.some(part => !isWild(part) && !/^\d+$/u.test(part))) {
    return undefined
  }
  const wild = parts.length < 3 || parts.some(isWild)

  if (wild) {
    const range = xRange(parts)
    if (!range) {
      return undefined
    }
    // `*` spans everything, whatever operator leads it
    if (operator === '' || operator === '=' || isWild(parts[0])) {
      return range
    }
    // a partial bound behaves like its range's edges: `>=1.2` = `>=1.2.0`, `<2` = `<2.0.0`,
    // `>1.2` = `>=1.3.0`, `<=1.2` = `<1.3.0`; `^` / `~` fall through to the full-version rules
    const lower = at(Number(parts[0]) || 0, Number(parts[1]) || 0, 0)
    if (operator === '>=') {
      return [gte(lower)]
    }
    if (operator === '<') {
      return [lt(lower)]
    }
    const upper = isWild(parts[1]) ? at(lower.major + 1, 0, 0) : at(lower.major, lower.minor + 1, 0)
    if (operator === '>') {
      return [gte(upper)]
    }
    if (operator === '<=') {
      return [lt(upper)]
    }
    if (operator === '~') {
      return [gte(lower), lt(upper)]
    }
    // `^1.x` / `^0.2` — the caret spans the leftmost non-zero given field
    return [gte(lower), lt(lower.major > 0 || isWild(parts[1]) ? at(lower.major + 1, 0, 0) : upper)]
  }

  const version = parse([core, ...rest].join(''))
  if (!version) {
    return undefined
  }

  switch (operator) {
    case '>=': {
      return [gte(version)]
    }
    case '>': {
      return [candidate => compareParsed(candidate, version) > 0]
    }
    case '<=': {
      return [candidate => compareParsed(candidate, version) <= 0]
    }
    case '<': {
      return [lt(version)]
    }
    case '~': {
      return [gte(version), lt(at(version.major, version.minor + 1, 0))]
    }
    case '^': {
      // the caret allows changes that do not touch the leftmost non-zero field
      const upper =
        version.major > 0
          ? at(version.major + 1, 0, 0)
          : version.minor > 0
            ? at(0, version.minor + 1, 0)
            : at(0, 0, version.patch + 1)
      return [gte(version), lt(upper)]
    }
    default: {
      return [candidate => compareParsed(candidate, version) === 0]
    }
  }
}

/**
 * Order two semver strings by precedence: `-1` / `0` / `1` (a `sort` comparator). Prereleases
 * rank below their release and compare field by field (numeric < alphanumeric); build metadata
 * is ignored. Throws a `TypeError` for an input that is not a version — compare trusted strings.
 */
export const compareVersions = (a: string, b: string): -1 | 0 | 1 => {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) {
    throw new TypeError(`not a semver version: ${left ? b : a}`)
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
    const comparators: Comparator[] = []

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
