import type { Helpers } from 'ai:core'
import { Ai, AiClient, AiErrors } from 'ai:core'
import { attempt } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import type { MockChatResult, MockScript } from 'ai:impl/mock'
import { MockProvider } from 'ai:impl/mock'
import { JsonCodec } from 'std:codec/impl/json'

import { runScoped } from '../helpers'

import type { ProviderScript, SuiteChatTurn } from './helpers'
import { runProviderSuite } from './helpers'

const turnResponse = (turn: SuiteChatTurn | undefined): AnyType => {
  if (!turn) {
    return fail(AiErrors.Configuration, 'suite chat script exhausted')
  }
  switch (turn.kind) {
    case 'text': {
      return { text: turn.text } satisfies MockChatResult
    }
    case 'tool-calls': {
      return { toolCalls: turn.calls } satisfies MockChatResult
    }
    default: {
      if (turn.error === 'auth') {
        return fail(AiErrors.Auth, 'scripted auth failure')
      }
      if (turn.error === 'rate-limit') {
        return turn.retryAfterSeconds === undefined
          ? fail(AiErrors.RateLimit, 'scripted rate limit')
          : fail(AiErrors.RateLimit, 'scripted rate limit', `retry-after:${turn.retryAfterSeconds}`)
      }
      return fail(AiErrors.BadResponse, 'scripted bad response')
    }
  }
}

/** Translate the neutral suite script into the mock's own scripting surface. */
const toMockScript = (script?: ProviderScript): MockScript => {
  if (!script) {
    return {}
  }
  const out: { -readonly [K in keyof MockScript]: MockScript[K] } = {}
  if (script.capabilities) {
    out.capabilities = script.capabilities
  }
  if (script.chat) {
    const turns = [...script.chat]
    out.chat = () => turnResponse(turns.shift())
  }
  if (script.chatStream) {
    out.chatStream = {
      queue: script.chatStream.map(stream => ({
        chunks: stream.chunks,
        ...(stream.hang ? { hang: true } : {}),
      })),
    }
  }
  if (script.embed) {
    out.embed = script.embed
  }
  if (script.tts) {
    out.tts = script.tts
    out.ttsStream = { chunks: [script.tts] }
  }
  if (script.stt !== undefined) {
    out.stt = script.stt
  }
  return out
}

runProviderSuite({
  label: 'mock',
  restrictable: true,
  capabilities: {
    chat: true,
    chatStream: true,
    tools: true,
    json: true,
    embed: true,
    tts: true,
    stt: true,
  },
  install: script =>
    (function* () {
      yield* install(JsonCodec)
      return yield* install(MockProvider, toMockScript(script))
    })(),
})

describe('mock provider extras', () => {
  it('records every received spec in the calls log', async () => {
    await runScoped(function* () {
      const mock = yield* install(MockProvider, { chat: { text: 'hi' } })
      yield* install(AiClient, { models: { chat: 'model-chat', embed: 'model-embed' } })
      yield* Ai.actions.chat('one')
      yield* Ai.actions.chat('two')
      yield* Ai.actions.embed(['a', 'b'])
      expect(mock.calls.chat).toHaveLength(2)
      expect(mock.calls.chat.map((spec: Helpers.ChatSpec) => spec.model)).toEqual([
        'model-chat',
        'model-chat',
      ])
      expect(mock.calls.embed[0]!.input).toEqual(['a', 'b'])
      expect(mock.calls.embed[0]!.model).toBe('model-embed')
    })
  })

  it('an explicit queue is consumed call by call and fails cleanly when exhausted', async () => {
    await runScoped(function* () {
      yield* install(MockProvider, {
        chat: { queue: [{ text: 'first' }, { text: 'second' }] },
      })
      yield* install(AiClient, { models: { chat: 'm' } })
      expect((yield* Ai.actions.chat('1')).text).toBe('first')
      expect((yield* Ai.actions.chat('2')).text).toBe('second')
      const outcome = yield* attempt(Ai.actions.chat('3'))
      expect((outcome as AnyType).error).toBe(AiErrors.Configuration)
    })
  })
})
