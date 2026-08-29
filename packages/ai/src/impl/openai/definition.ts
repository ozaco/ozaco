import type { Helpers, ProviderDef } from 'ai:core'
import { AiErrors, AiProvider } from 'ai:core'
import { useContext } from 'std:effect'
import { Fetch } from 'std:fetch'
import { fail } from 'std:result'

import pkg from '../../../package.json'

import {
  createState,
  formInit,
  jsonInit,
  readBytes,
  readJson,
  send,
  StateRef,
} from './internal/common'
import { byteFlow, sseFlow } from './internal/sse'
import {
  chatBody,
  decodeChatDelta,
  decodeChatResult,
  decodeEmbedResult,
  decodeTranscription,
  embedBody,
  speechBody,
  transcribeForm,
} from './internal/wire'
import type { OpenAIProviderOptions } from './types/openai'

const CAPABILITIES: ProviderDef.Capabilities = {
  chat: true,
  chatStream: true,
  tools: true,
  json: true,
  embed: true,
  tts: true,
  stt: true,
}

/**
 * The OpenAI-compatible provider — talks to the network EXCLUSIVELY through the `Fetch` plugin
 * and (de)serializes every JSON wire payload through the installed `JsonCodec`, so both
 * `install(FetchClient)` (any options) and `install(JsonCodec)` must come first:
 *
 * ```ts
 * yield* install(FetchClient)
 * yield* install(JsonCodec)
 * yield* install(OpenAIProvider, { apiKey, baseUrl })
 * yield* install(AiClient, { models: { chat: 'gpt-4o-mini' } })
 * ```
 *
 * Works against api.openai.com and any OpenAI-compatible server (incl. local) via `baseUrl`.
 * Every capability is supported; backend errors classify into `AiErrors` tags and malformed 2xx
 * bodies fail `ai.bad-response`.
 */
export const OpenAIProvider = AiProvider.implement<
  ProviderDef.Info,
  [options: OpenAIProviderOptions]
>({
  name: 'openai',
  version: pkg.version,
  description: 'OpenAI-compatible AI provider over std:fetch',
  *setup(options) {
    if (!(yield* Fetch.context.get())) {
      return yield* fail(
        AiErrors.Configuration,
        'std:fetch is not installed — install(FetchClient) before the openai provider',
      )
    }
    if (!options.apiKey) {
      return yield* fail(AiErrors.Configuration, 'the openai provider requires an apiKey')
    }
    yield* StateRef.set(createState(options))
    return { provider: 'openai', capabilities: CAPABILITIES }
  },
}).build({
  *chat(spec: Helpers.ChatSpec) {
    const state = yield* useContext(StateRef)
    const init = yield* jsonInit(state, chatBody(spec, false))
    const response = yield* send(state, 'chat/completions', init)
    return yield* decodeChatResult(yield* readJson(response), spec.model)
  },

  *chatStream(spec: Helpers.ChatSpec) {
    const state = yield* useContext(StateRef)
    const init = yield* jsonInit(state, chatBody(spec, true))
    const response = yield* send(state, 'chat/completions', init)
    const raw = yield* response.raw()
    return yield* sseFlow(raw, decodeChatDelta)
  },

  *embed(spec: Helpers.EmbedSpec) {
    const state = yield* useContext(StateRef)
    const init = yield* jsonInit(state, embedBody(spec))
    const response = yield* send(state, 'embeddings', init)
    return yield* decodeEmbedResult(yield* readJson(response), spec)
  },

  *tts(spec: Helpers.SpeechSpec) {
    const state = yield* useContext(StateRef)
    const init = yield* jsonInit(state, speechBody(spec))
    const response = yield* send(state, 'audio/speech', init)
    return yield* readBytes(response)
  },

  *ttsStream(spec: Helpers.SpeechSpec) {
    const state = yield* useContext(StateRef)
    const init = yield* jsonInit(state, speechBody(spec))
    const response = yield* send(state, 'audio/speech', init)
    const raw = yield* response.raw()
    return yield* byteFlow(raw)
  },

  *stt(spec: Helpers.TranscribeSpec) {
    const state = yield* useContext(StateRef)
    const response = yield* send(
      state,
      'audio/transcriptions',
      formInit(state, transcribeForm(spec)),
    )
    return yield* decodeTranscription(yield* readJson(response))
  },
})
