import type { Helpers, ProviderDef } from 'ai:core'
import { AiProvider } from 'ai:core'
import { useContext } from 'std:effect'

import pkg from '../../../package.json'

import { completeChatResult, resolveResponder, scriptedFlow, StateRef } from './internal'
import type { Helpers as Own } from './types/helpers'
import type { MockInfo, MockScript } from './types/mock'

const FULL: ProviderDef.Capabilities = {
  chat: true,
  chatStream: true,
  tools: true,
  json: true,
  embed: true,
  tts: true,
  stt: true,
}

/**
 * The zero-dependency scripted provider — the reference `AiProvider` implementation and the
 * natural test/dev backend. Script responses per action (a value, an explicit `{ queue }`, or a
 * function of the resolved spec), stream from provided chunks, restrict capabilities, and assert
 * on the received specs via the returned context's `calls` log:
 *
 * ```ts
 * const mock = yield* install(MockProvider, { chat: { text: 'hi there' } })
 * yield* install(AiClient, { models: { chat: 'test-model' } })
 * const result = yield* Ai.actions.chat('hello')
 * mock.calls.chat[0].model // 'test-model'
 * ```
 */
export const MockProvider = AiProvider.implement<MockInfo, [script?: MockScript]>({
  name: 'mock',
  version: pkg.version,
  description: 'Scripted in-memory AI provider for tests and development',
  *setup(script) {
    const state: Own.MockState = {
      script: script ?? {},
      cursors: new Map(),
      calls: { chat: [], chatStream: [], embed: [], tts: [], ttsStream: [], stt: [] },
    }
    yield* StateRef.set(state)
    return {
      provider: 'mock',
      capabilities: { ...FULL, ...script?.capabilities },
      calls: state.calls,
    }
  },
}).build({
  *chat(spec: Helpers.ChatSpec) {
    const state = yield* useContext(StateRef)
    state.calls.chat.push(spec)
    const partial = yield* resolveResponder({
      state,
      key: 'chat',
      spec,
      responder: state.script.chat,
      fallback: {},
    })
    return completeChatResult(spec, partial)
  },

  *chatStream(spec: Helpers.ChatSpec) {
    const state = yield* useContext(StateRef)
    state.calls.chatStream.push(spec)
    const script = yield* resolveResponder({
      state,
      key: 'chatStream',
      spec,
      responder: state.script.chatStream,
      fallback: { chunks: [] },
    })
    return scriptedFlow(script)
  },

  *embed(spec: Helpers.EmbedSpec) {
    const state = yield* useContext(StateRef)
    state.calls.embed.push(spec)
    const vectors = yield* resolveResponder({
      state,
      key: 'embed',
      spec,
      responder: state.script.embed,
      fallback: spec.input.map(() => [0]),
    })
    return { vectors, model: spec.model, usage: undefined }
  },

  *tts(spec: Helpers.SpeechSpec) {
    const state = yield* useContext(StateRef)
    state.calls.tts.push(spec)
    return yield* resolveResponder({
      state,
      key: 'tts',
      spec,
      responder: state.script.tts,
      fallback: new Uint8Array(0),
    })
  },

  *ttsStream(spec: Helpers.SpeechSpec) {
    const state = yield* useContext(StateRef)
    state.calls.ttsStream.push(spec)
    const script = yield* resolveResponder({
      state,
      key: 'ttsStream',
      spec,
      responder: state.script.ttsStream,
      fallback: { chunks: [] },
    })
    return scriptedFlow(script)
  },

  *stt(spec: Helpers.TranscribeSpec) {
    const state = yield* useContext(StateRef)
    state.calls.stt.push(spec)
    return yield* resolveResponder({
      state,
      key: 'stt',
      spec,
      responder: state.script.stt,
      fallback: '',
    })
  },
})
