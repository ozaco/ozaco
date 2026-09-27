/**
 * No package source flattens a failure it replaces or reinvents the cause chain: a rewrap nests the
 * inner failure — `fail(Tag, message, inner)` / `appendCauses(hook, inner)` — never
 * `fail(Tag, message, ...inner.causes)`; a caught error is never stringified into a CAUSE
 * (`String(error)`, `serializeError(error)`, `.message`) — it is nested as is (its message may
 * still be the failure's message); nothing grafts a `cause` field onto a failure
 * (`Object.assign(f, { cause })`); and the removed `failFrom` is used nowhere.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '../../../..')
const PACKAGES = join(ROOT, 'packages')

/** Every `packages/<name>/src` on disk — the scan enforces all of them. */
const PACKAGE_ROOTS = readdirSync(PACKAGES, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join('packages', entry.name, 'src'))
  .filter(dir => existsSync(join(ROOT, dir)))

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  )

const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])

/** The top-level arguments of the call whose `(` sits at `start` (strings skipped, not parsed). */
const argumentsAt = (text: string, start: number): string[] => {
  const args: string[] = []
  let depth = 0
  let current = ''
  let quote = ''

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index] as string
    if (quote) {
      current += char
      if (char === '\\') {
        current += text[index + 1] ?? ''
        index += 1
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }
    if (OPEN.has(char)) {
      depth += 1
    } else if (CLOSE.has(char)) {
      if (depth === 0) {
        args.push(current.trim())
        return args.filter(arg => arg.length > 0)
      }
      depth -= 1
    } else if (char === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += char
  }

  return args
}

/** Every `name(` call in `text` (not a member call, not a declaration) with its arguments. */
const callsOf = (text: string, name: string) =>
  [...text.matchAll(new RegExp(`(?<![\\w.$])${name}\\(`, 'gu'))].map(match => ({
    line: text.slice(0, match.index).split('\n').length,
    args: argumentsAt(text, (match.index ?? 0) + name.length),
  }))

const FLATTENED = /^\.\.\.[\w$.]+\.causes$/u
const STRINGIFIED = /\bString\(|\bserializeError\(|\.message\b/u
/** An object literal argument carrying a `cause` key (`{ cause }`, `{ cause: x }`, `{ …, cause }`). */
const CAUSE_FIELD = /^\{[^]*(?<![\w$.])cause\s*[:,}]/u
const FAIL_FROM = /(?<![\w$])failFrom\b/gu

/** What `text` (the file at `where`) does against the causes model. */
const offendersIn = (text: string, where: (line: number) => string): string[] => {
  const causesOf = (name: string, from: number) =>
    callsOf(text, name).flatMap(({ line, args }) =>
      args
        .slice(from)
        .flatMap(arg =>
          FLATTENED.test(arg)
            ? [`${where(line)} ${name}(…, ${arg}) folds another failure's causes in`]
            : STRINGIFIED.test(arg)
              ? [`${where(line)} ${name}(…, ${arg}) stringifies a cause`]
              : [],
        ),
    )

  const grafted = callsOf(text, String.raw`Object\.assign`).flatMap(({ line, args }) =>
    args
      .slice(1)
      .flatMap(arg =>
        CAUSE_FIELD.test(arg) ? [`${where(line)} Object.assign(…, ${arg}) grafts a cause`] : [],
      ),
  )

  const removed = [...text.matchAll(FAIL_FROM)].map(
    match => `${where(text.slice(0, match.index).split('\n').length)} failFrom is removed`,
  )

  return [
    ...causesOf('fail', 2),
    ...['appendCauses', 'asFailure'].flatMap(name => causesOf(name, 1)),
    ...grafted,
    ...removed,
  ]
}

const offenders = (roots: readonly string[]): string[] =>
  roots
    .map(root => join(ROOT, root))
    .flatMap(sources)
    .flatMap(file =>
      offendersIn(readFileSync(file, 'utf8'), line => `${relative(ROOT, file)}:${line}`),
    )

describe('rewrap sites keep the inner failure', () => {
  it('the scanner finds the patterns it forbids', () => {
    const sample = [
      'fail(Tags.A, errorMessage(failure.error), ...failure.causes)',
      "appendCauses(asFailure(hookError), 'masked', ...failure.causes)",
      'fail(Tags.B, msg, String(error))',
      'appendCauses(asFailure(x), serializeError(error))',
      'Object.assign(hook, { cause: failure })',
      'Object.assign(failure, { remote }, { cause })',
      "import { failFrom } from 'std:result'",
      'return failFrom(inner, Tags.C, msg)',
      // allowed: nesting the inner failure, a cause-less Object.assign, a native Error cause
      'fail(Tags.D, error.message, error)',
      'appendCauses(hook, failure)',
      "Object.assign(error, { code: 'E' })",
      "new Error('x', { cause: inner })",
    ].join('\n')

    expect(offendersIn(sample, line => `sample:${line}`)).toEqual([
      "sample:1 fail(…, ...failure.causes) folds another failure's causes in",
      'sample:3 fail(…, String(error)) stringifies a cause',
      "sample:2 appendCauses(…, ...failure.causes) folds another failure's causes in",
      'sample:4 appendCauses(…, serializeError(error)) stringifies a cause',
      'sample:5 Object.assign(…, { cause: failure }) grafts a cause',
      'sample:6 Object.assign(…, { cause }) grafts a cause',
      'sample:7 failFrom is removed',
      'sample:8 failFrom is removed',
    ])
  })

  it('scans every package source', () => {
    expect(PACKAGE_ROOTS).toEqual(
      expect.arrayContaining([
        'packages/ai/src',
        'packages/cli/src',
        'packages/client/src',
        'packages/db/src',
        'packages/devkit/src',
        'packages/server/src',
        'packages/std/src',
        'packages/transport/src',
      ]),
    )
  })

  it('no package source flattens, stringifies or grafts a cause, or uses failFrom', () => {
    expect(offenders(PACKAGE_ROOTS)).toEqual([])
  })
})
