import type { RawParse } from '../types/internal'

const looksLikeValue = (token: string | undefined): token is string =>
  token !== undefined && (token === '-' || !token.startsWith('-'))

/**
 * Split argv into option values, positionals, and a `--` rest. `booleanFields` (which never consume
 * a value) and `aliases` (token → canonical field, covering both long names and short flags) come
 * from the action's schema + `short` map. Supports `--flag`, `--flag=v`, `--no-flag`, `-abc`, `-n5`,
 * repeated flags (→ array), and `-vvv`.
 */
export const tokenize = (
  args: string[],
  booleanFields: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
): RawParse => {
  const options = new Map<string, string[]>()
  const positionals: string[] = []
  const rest: string[] = []
  const errors: string[] = []

  const push = (name: string, value: string): void => {
    const list = options.get(name) ?? []
    list.push(value)
    options.set(name, list)
  }

  let i = 0
  while (i < args.length) {
    const token = args[i]!

    if (token === '--') {
      rest.push(...args.slice(i + 1))
      break
    }

    if (token.startsWith('--')) {
      let body = token.slice(2)

      if (body.startsWith('no-')) {
        const negated = aliases.get(body.slice(3))
        if (negated !== undefined && booleanFields.has(negated)) {
          push(negated, 'false')
          i += 1
          continue
        }
      }

      let inlineValue: string | undefined
      const equals = body.indexOf('=')
      if (equals !== -1) {
        inlineValue = body.slice(equals + 1)
        body = body.slice(0, equals)
      }

      const name = aliases.get(body)
      if (name === undefined) {
        errors.push(`unknown option --${body}`)
        i += 1
        continue
      }

      if (booleanFields.has(name)) {
        push(name, inlineValue ?? 'true')
        i += 1
        continue
      }
      if (inlineValue !== undefined) {
        push(name, inlineValue)
        i += 1
        continue
      }
      if (!looksLikeValue(args[i + 1])) {
        errors.push(`option --${body} requires a value`)
        i += 1
        continue
      }
      push(name, args[i + 1]!)
      i += 2
      continue
    }

    if (token.startsWith('-') && token !== '-') {
      const chars = token.slice(1)
      let consumedNext = false

      for (let c = 0; c < chars.length; c += 1) {
        const flag = chars[c]!
        const name = aliases.get(flag)
        if (name === undefined) {
          errors.push(`unknown option -${flag}`)
          continue
        }

        if (booleanFields.has(name)) {
          push(name, 'true')
          continue
        }

        const remainder = chars.slice(c + 1)
        if (remainder.length > 0) {
          push(name, remainder.startsWith('=') ? remainder.slice(1) : remainder)
          break
        }
        if (!looksLikeValue(args[i + 1])) {
          errors.push(`option -${flag} requires a value`)
          break
        }
        push(name, args[i + 1]!)
        consumedNext = true
        break
      }

      i += consumedNext ? 2 : 1
      continue
    }

    positionals.push(token)
    i += 1
  }

  return { options, positionals, rest, errors }
}
