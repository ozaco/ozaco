/**
 * A codec that cannot parse / decode / stringify fails with ONE level: its operation's tag, the
 * parser's own message, the parser error kept as `raw` — never a nested `std:result.unknown`.
 */
import { CodecErrors } from 'std:codec'
import { attempt, run } from 'std:effect'
import type { Result } from 'std:result'
import { formatFailure, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'
import { TomlCodec } from 'std:codec/impl/toml'
import { YamlCodec } from 'std:codec/impl/yaml'

const encoder = new TextEncoder()

const summary = (outcome: unknown) => {
  if (!isFailure(outcome)) {
    return 'no-failure'
  }

  const failure = outcome as Result.Failure<unknown>

  return {
    tag: failure.error,
    hasMessage: failure.message.length > 0,
    causes: failure.causes.filter(isFailure).length,
    raw: (failure.raw as Error | undefined)?.name,
    // parser messages span lines (TOML / YAML quote the source): count the `Caused by:` headers
    levels: 1 + (formatFailure(failure, { chain: true }).match(/^Caused by: /gmu) ?? []).length,
  }
}

describe('codec failures are one level: the operation tag, the parser message, raw', () => {
  it('JsonCodec parse / decode / stringify', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()

      const cyclic: Record<string, unknown> = {}

      cyclic.self = cyclic

      return {
        parse: summary(yield* attempt(() => JsonCodec.actions.parse('{oops'))),
        decode: summary(yield* attempt(() => JsonCodec.actions.decode(encoder.encode('{oops')))),
        stringify: summary(yield* attempt(() => JsonCodec.actions.stringify(cyclic))),
      }
    })

    const expected = (tag: string, raw: string) => ({
      tag,
      hasMessage: true,
      causes: 0,
      raw,
      levels: 1,
    })

    expect(unwrap(outcome)).toEqual({
      parse: expected(CodecErrors.Parse, 'SyntaxError'),
      decode: expected(CodecErrors.Decode, 'SyntaxError'),
      stringify: expected(CodecErrors.Stringify, 'TypeError'),
    })
  })

  it('TomlCodec and YamlCodec parse', async () => {
    const outcome = await run(function* () {
      yield* TomlCodec.use()
      yield* YamlCodec.use()

      return {
        toml: summary(yield* attempt(() => TomlCodec.actions.parse('key = = broken'))),
        yaml: summary(yield* attempt(() => YamlCodec.actions.parse('a: [unclosed'))),
      }
    })

    const seen = unwrap(outcome) as Record<string, ReturnType<typeof summary>>

    expect(seen).toMatchObject({
      toml: { tag: CodecErrors.Parse, hasMessage: true, causes: 0, levels: 1 },
      yaml: { tag: CodecErrors.Parse, hasMessage: true, causes: 0, levels: 1 },
    })
  })
})
