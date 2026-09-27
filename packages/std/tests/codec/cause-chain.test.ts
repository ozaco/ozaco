/**
 * A codec that cannot parse / decode / stringify fails with its tag and what it was doing
 * (`cannot parse the text as JSON`), the parser's own throw folded under it by `asFailure`
 * (`std:result.unknown`, its serialized text the message, the parser error kept as `raw`).
 */
import { CodecErrors } from 'std:codec'
import { attempt, run } from 'std:effect'
import type { Result } from 'std:result'
import { ResultErrors, formatFailure, isFailure, unwrap } from 'std:result'

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
  const [nested] = failure.causes
  return {
    tag: failure.error,
    message: failure.message,
    inner: isFailure(nested) ? nested.error : undefined,
    raw: isFailure(nested) ? (nested.raw as Error).name : undefined,
    // parser messages span lines (TOML / YAML quote the source): count the `Caused by:` headers
    levels: 1 + (formatFailure(failure, { chain: true }).match(/^Caused by: /gmu) ?? []).length,
  }
}

describe('codec failures keep the parser error as their cause', () => {
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

    const seen = unwrap(outcome)
    const expected = (tag: string, message: string, raw: string) => ({
      tag,
      message,
      inner: ResultErrors.Unknown,
      raw,
      levels: 2,
    })
    expect(seen).toEqual({
      parse: expected(CodecErrors.Parse, 'cannot parse the text as JSON', 'SyntaxError'),
      decode: expected(CodecErrors.Decode, 'cannot decode the bytes as JSON', 'SyntaxError'),
      stringify: expected(CodecErrors.Stringify, 'cannot stringify the value as JSON', 'TypeError'),
    })

    // the run settles to the raised failure itself
    const failure = await run(function* () {
      yield* JsonCodec.use()
      return yield* JsonCodec.actions.parse('{oops')
    })
    const [nested] = isFailure(failure) ? failure.causes : []
    expect(isFailure(nested) && nested.raw).toBeInstanceOf(SyntaxError)
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
      toml: {
        tag: CodecErrors.Parse,
        message: 'cannot parse the text as TOML',
        inner: ResultErrors.Unknown,
        levels: 2,
      },
      yaml: {
        tag: CodecErrors.Parse,
        message: 'cannot parse the text as YAML',
        inner: ResultErrors.Unknown,
        levels: 2,
      },
    })
  })
})
