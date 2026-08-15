// oxlint-disable import/exports-last
import type { Helpers, ProviderDef } from 'ai:core'
import { accumulateToolCalls, Ai, AiClient, AiErrors, AiProvider, useProvider } from 'ai:core'
import type { Operation } from 'std:effect'
import { attempt, run, scoped } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { concat, drain, runScoped } from '../helpers'

/** One scripted chat turn in the NEUTRAL suite format each target translates. */
export type SuiteChatTurn =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool-calls'; readonly calls: readonly Helpers.ToolCall[] }
  | {
      readonly kind: 'error'
      readonly error: 'auth' | 'rate-limit' | 'bad-response'
      readonly retryAfterSeconds?: number
    }

export interface SuiteStream {
  readonly chunks: readonly Helpers.ChatDelta[]
  /** Keep the stream open after the chunks (teardown tests). */
  readonly hang?: boolean
}

/** What a provider under test must be primed to answer. Data-only, so the openai target can
 * translate it into HTTP fixtures while the mock target scripts it directly. */
export interface ProviderScript {
  readonly capabilities?: Partial<ProviderDef.Capabilities>
  /** Successive chat completions, consumed call by call. */
  readonly chat?: readonly SuiteChatTurn[]
  /** Successive chat streams. */
  readonly chatStream?: readonly SuiteStream[]
  /** Vectors for one embed call. */
  readonly embed?: readonly (readonly number[])[]
  readonly tts?: Uint8Array
  readonly stt?: string
}

/** One provider binding under end-to-end test. */
export interface ProviderTarget {
  /** Must equal the provider's `info.provider` name. */
  readonly label: string
  readonly capabilities: ProviderDef.Capabilities
  /** Whether `install` honors `script.capabilities` restrictions (mock only). */
  readonly restrictable: boolean
  /** Install a FRESH provider primed with the script into the current scope. */
  readonly install: (script?: ProviderScript) => Operation<unknown>
}

interface CapturedSpecs {
  readonly chat: Helpers.ChatSpec[]
  readonly embed: Helpers.EmbedSpec[]
  readonly tts: Helpers.SpeechSpec[]
  readonly stt: AnyType[]
}

/** Install `AiProvider.around` capture middleware — the seam the suite asserts resolved specs
 * through, which doubles as coverage OF the middleware seam. */
function* captureSpecs(): Operation<CapturedSpecs> {
  const captured: CapturedSpecs = { chat: [], embed: [], tts: [], stt: [] }
  const capture =
    (bucket: AnyType[]) =>
    (args: AnyType[], next: AnyType): AnyType =>
      (function* () {
        bucket.push(args[0])
        return yield* next(...args)
      })()
  yield* AiProvider.around({
    chat: capture(captured.chat),
    embed: capture(captured.embed),
    tts: capture(captured.tts),
    stt: capture(captured.stt),
  } as AnyType)
  return captured
}

/**
 * The full-surface end-to-end suite every provider must pass: info/capabilities, spec resolution
 * (per-modality models, sampling merge, normalization), the tool loop, stream accumulation, error
 * classification with retry, speech/transcription, and scope-teardown behavior.
 */
export const runProviderSuite = (target: ProviderTarget): void => {
  describe(`e2e — ${target.label}`, () => {
    it('reports provider info and capabilities', async () => {
      await runScoped(function* () {
        yield* target.install()
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const info = yield* useProvider()
        expect(info.provider).toBe(target.label)
        expect(info.capabilities).toEqual(target.capabilities)
      })
    })

    it('chat: resolves the chat model, normalizes messages, returns the normalized result', async () => {
      await runScoped(function* () {
        yield* target.install({ chat: [{ kind: 'text', text: 'hello from the model' }] })
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const specs = yield* captureSpecs()

        const result = yield* Ai.actions.chat('hi there')
        expect(result.text).toBe('hello from the model')
        expect(result.message.role).toBe('assistant')
        expect(result.toolCalls).toEqual([])
        expect(result.finishReason).toBe('stop')

        expect(specs.chat[0]!.model).toBe('model-chat')
        expect(specs.chat[0]!.messages).toEqual([
          { role: 'user', parts: [{ kind: 'text', text: 'hi there' }] },
        ])
        expect(specs.chat[0]!.toolChoice).toBe('auto')
        expect(specs.chat[0]!.output).toBe('text')
      })
    })

    it('per-modality models: chat and embed resolve independently, per-call model wins', async () => {
      await runScoped(function* () {
        yield* target.install({
          chat: [
            { kind: 'text', text: 'one' },
            { kind: 'text', text: 'two' },
          ],
          embed: [[0.5, 0.25]],
        })
        yield* install(AiClient, { models: { chat: 'model-chat', embed: 'model-embed' } })
        const specs = yield* captureSpecs()

        yield* Ai.actions.chat('x')
        const embedded = yield* Ai.actions.embed('vectorize me')
        yield* Ai.actions.chat('y', { model: 'model-override' })

        expect(specs.chat[0]!.model).toBe('model-chat')
        expect(specs.chat[1]!.model).toBe('model-override')
        expect(specs.embed[0]!.model).toBe('model-embed')
        expect(specs.embed[0]!.input).toEqual(['vectorize me'])
        expect(embedded.vectors).toEqual([[0.5, 0.25]])
        expect(embedded.model).toBe('model-embed')
      })
    })

    it('sampling: install defaults merge UNDER per-call options', async () => {
      await runScoped(function* () {
        yield* target.install({ chat: [{ kind: 'text', text: 'ok' }] })
        yield* install(AiClient, {
          models: { chat: 'model-chat' },
          defaults: { temperature: 0.5, maxTokens: 128 },
        })
        const specs = yield* captureSpecs()
        yield* Ai.actions.chat('x', { temperature: 0.9, topP: 0.7 })
        expect(specs.chat[0]!.sampling).toEqual({ temperature: 0.9, topP: 0.7, maxTokens: 128 })
      })
    })

    it('an unconfigured modality model fails ai.configuration before any dispatch', async () => {
      await runScoped(function* () {
        yield* target.install()
        yield* install(AiClient)
        const chat = yield* attempt(Ai.actions.chat('hi'))
        expect((chat as AnyType).error).toBe(AiErrors.Configuration)
        const embed = yield* attempt(Ai.actions.embed('hi'))
        expect((embed as AnyType).error).toBe(AiErrors.Configuration)
      })
    })

    it('tool loop: invokes handlers, appends the round-trip messages, returns the final answer', async () => {
      await runScoped(function* () {
        yield* target.install({
          chat: [
            {
              kind: 'tool-calls',
              calls: [{ id: 'call-1', name: 'add', arguments: '{"a":2,"b":3}' }],
            },
            { kind: 'text', text: 'the sum is 5' },
          ],
        })
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const specs = yield* captureSpecs()
        const seen: AnyType[] = []

        const result = yield* Ai.actions.chat('add 2 and 3', {
          tools: [{ name: 'add', description: 'add two numbers', schema: { type: 'object' } }],
          run: {
            add: args =>
              (function* () {
                seen.push(args)
                return { sum: Number(args.a) + Number(args.b) }
              })() as Operation<unknown>,
          },
        })

        expect(result.text).toBe('the sum is 5')
        expect(seen).toEqual([{ a: 2, b: 3 }])
        expect(specs.chat).toHaveLength(2)
        const second = specs.chat[1]! as AnyType
        expect(second.messages).toHaveLength(3)
        expect(second.messages[1].role).toBe('assistant')
        expect(second.messages[1].toolCalls).toEqual([
          { id: 'call-1', name: 'add', arguments: '{"a":2,"b":3}' },
        ])
        expect(second.messages[2]).toMatchObject({
          role: 'tool',
          name: 'add',
          toolCallId: 'call-1',
        })
        expect(second.messages[2].parts[0].text).toBe('{"sum":5}')
      })
    })

    it('tool loop: exceeding maxRounds fails ai.request', async () => {
      await runScoped(function* () {
        const turn: SuiteChatTurn = {
          kind: 'tool-calls',
          calls: [{ id: 'c', name: 'noop', arguments: '{}' }],
        }
        yield* target.install({ chat: [turn, turn] })
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const outcome = yield* attempt(
          Ai.actions.chat('loop', {
            tools: [{ name: 'noop' }],
            maxRounds: 2,
            run: {
              noop: () =>
                (function* () {
                  return 'ok'
                })() as Operation<unknown>,
            },
          }),
        )
        expect((outcome as AnyType).error).toBe(AiErrors.Request)
      })
    })

    it('tool loop: malformed tool-call arguments fail ai.bad-response', async () => {
      await runScoped(function* () {
        yield* target.install({
          chat: [{ kind: 'tool-calls', calls: [{ id: 'c', name: 'add', arguments: 'not-json' }] }],
        })
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const outcome = yield* attempt(
          Ai.actions.chat('x', {
            tools: [{ name: 'add' }],
            run: {
              add: () =>
                (function* () {
                  return 'unreachable'
                })() as Operation<unknown>,
            },
          }),
        )
        expect((outcome as AnyType).error).toBe(AiErrors.BadResponse)
      })
    })

    it('chatStream: text, split tool-call fragments and usage accumulate across chunks', async () => {
      await runScoped(function* () {
        yield* target.install({
          chatStream: [
            {
              chunks: [
                { text: 'he' },
                { toolCalls: [{ index: 0, id: 'call-9', name: 'lookup', arguments: '{"q":' }] },
                { toolCalls: [{ index: 0, arguments: '"x"}' }] },
                { text: 'llo' },
                { finishReason: 'tool_calls' },
                { usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
              ],
            },
          ],
        })
        yield* install(AiClient, { models: { chat: 'model-chat' } })

        const flow = yield* Ai.actions.chatStream('go')
        const { values, close } = yield* drain(flow)
        expect(close).toBe(true)

        expect(values.map(value => value.text ?? '').join('')).toBe('hello')
        const calls = accumulateToolCalls()
        for (const value of values) {
          calls.add(value.toolCalls)
        }
        expect(calls.collect()).toEqual([{ id: 'call-9', name: 'lookup', arguments: '{"q":"x"}' }])
        expect(values.some(value => value.finishReason === 'tool_calls')).toBe(true)
        expect(values.at(-1)?.usage?.totalTokens).toBe(3)
      })
    })

    it('classifies credential rejections as ai.auth', async () => {
      await runScoped(function* () {
        yield* target.install({ chat: [{ kind: 'error', error: 'auth' }] })
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const outcome = yield* attempt(Ai.actions.chat('hi'))
        expect((outcome as AnyType).error).toBe(AiErrors.Auth)
      })
    })

    it('classifies throttling as ai.rate-limit and carries the retry-after cause', async () => {
      await runScoped(function* () {
        yield* target.install({
          chat: [{ kind: 'error', error: 'rate-limit', retryAfterSeconds: 7 }],
        })
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const outcome = yield* attempt(Ai.actions.chat('hi'))
        expect(isFailure(outcome)).toBe(true)
        expect((outcome as AnyType).error).toBe(AiErrors.RateLimit)
        expect((outcome as AnyType).causes).toContain('retry-after:7')
      })
    })

    it('a garbage 2xx body fails ai.bad-response instead of degrading', async () => {
      await runScoped(function* () {
        yield* target.install({ chat: [{ kind: 'error', error: 'bad-response' }] })
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const outcome = yield* attempt(Ai.actions.chat('hi'))
        expect((outcome as AnyType).error).toBe(AiErrors.BadResponse)
      })
    })

    it('retries rate limits when asked; the default budget is 0 (off)', async () => {
      await runScoped(function* () {
        yield* target.install({
          chat: [
            { kind: 'error', error: 'rate-limit', retryAfterSeconds: 0 },
            { kind: 'text', text: 'recovered' },
          ],
        })
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const result = yield* Ai.actions.chat('hi', { retries: 1 })
        expect(result.text).toBe('recovered')
      })
      await runScoped(function* () {
        yield* target.install({
          chat: [
            { kind: 'error', error: 'rate-limit', retryAfterSeconds: 0 },
            { kind: 'text', text: 'never reached' },
          ],
        })
        yield* install(AiClient, { models: { chat: 'model-chat' } })
        const outcome = yield* attempt(Ai.actions.chat('hi'))
        expect((outcome as AnyType).error).toBe(AiErrors.RateLimit)
      })
    })

    it('tts resolves model + voice and returns the clip; ttsStream streams the same bytes', async () => {
      await runScoped(function* () {
        const clip = new Uint8Array([1, 2, 3, 4])
        yield* target.install({ tts: clip })
        yield* install(AiClient, {
          models: { tts: 'model-tts' },
          defaults: { voice: 'test-voice' },
        })
        const specs = yield* captureSpecs()

        const bytes = yield* Ai.actions.tts('say this')
        expect([...bytes]).toEqual([1, 2, 3, 4])
        expect(specs.tts[0]!.model).toBe('model-tts')
        expect(specs.tts[0]!.voice).toBe('test-voice')
        expect(specs.tts[0]!.text).toBe('say this')

        const flow = yield* Ai.actions.ttsStream('say this', { voice: 'other-voice' })
        const { values, close } = yield* drain(flow)
        expect(close).toBe(true)
        expect([...concat(values)]).toEqual([1, 2, 3, 4])
      })
    })

    it('tts without a configured voice fails ai.configuration', async () => {
      await runScoped(function* () {
        yield* target.install()
        yield* install(AiClient, { models: { tts: 'model-tts' } })
        const outcome = yield* attempt(Ai.actions.tts('say this'))
        expect((outcome as AnyType).error).toBe(AiErrors.Configuration)
      })
    })

    it('stt resolves the model and returns the transcript', async () => {
      await runScoped(function* () {
        yield* target.install({ stt: 'transcribed text' })
        yield* install(AiClient, { models: { stt: 'model-stt' } })
        const specs = yield* captureSpecs()
        const text = yield* Ai.actions.stt(new Uint8Array([9, 9]), {
          language: 'en',
          filename: 'clip.wav',
          contentType: 'audio/wav',
        })
        expect(text).toBe('transcribed text')
        expect(specs.stt[0]!.model).toBe('model-stt')
        expect(specs.stt[0]!.language).toBe('en')
      })
    })

    it.skipIf(!target.restrictable)('a restricted capability fails ai.unsupported', async () => {
      await runScoped(function* () {
        yield* target.install({
          capabilities: { embed: false, tts: false },
          chat: [{ kind: 'text', text: 'still works' }],
        })
        yield* install(AiClient, {
          models: { chat: 'model-chat', embed: 'model-embed', tts: 'model-tts' },
          defaults: { voice: 'v' },
        })
        const embed = yield* attempt(Ai.actions.embed('x'))
        expect((embed as AnyType).error).toBe(AiErrors.Unsupported)
        const tts = yield* attempt(Ai.actions.tts('x'))
        expect((tts as AnyType).error).toBe(AiErrors.Unsupported)
        const chat = yield* Ai.actions.chat('x')
        expect(chat.text).toBe('still works')
      })
    })

    it('scope teardown resolves promptly with a stream mid-flight', async () => {
      const task = run(() =>
        scoped(function* () {
          yield* target.install({
            chatStream: [{ chunks: [{ text: 'first' }], hang: true }],
          })
          yield* install(AiClient, { models: { chat: 'model-chat' } })
          const flow = yield* Ai.actions.chatStream('stream on')
          const subscription = yield* flow
          const first = yield* subscription.next()
          expect((first.value as AnyType).text).toBe('first')
          return 'closed'
        }),
      )
      const winner = await Promise.race([
        task.then(() => 'completed'),
        new Promise(resolve => {
          setTimeout(() => resolve('timeout'), 3000)
        }),
      ])
      expect(winner).toBe('completed')
    })
  })
}
