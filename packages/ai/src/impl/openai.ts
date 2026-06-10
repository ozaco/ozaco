import { operation, useContext } from 'std:effect'
import { fail } from 'std:result'

import { DEFAULT_BASE_URL } from '../const'
import { AI_PROTOCOL } from '../definitions'
import { AiErrors } from '../errors'
import { parseChatResponse, parseEmbedResponse, parseSttResponse } from '../internal/parse'
import { buildChatBody, buildEmbedBody, buildSttForm, buildTtsBody } from '../internal/payload'
import { failStatus, postForm, postJson } from '../internal/request'
import { byteStream, chatChunkStream, transcriptStream } from '../internal/sse'
import type { AiDef } from '../types'

/**
 * OpenAI-compatible AI implementation. Install with provider config:
 *
 * ```ts
 * yield* install(OpenAICompatible, { apiKey, baseURL, model })
 * const out = yield* AI.actions.chat([{ role: 'user', content: 'hi' }])
 * ```
 *
 * Works against api.openai.com and any OpenAI-compatible server (incl. local) via `baseURL`.
 */
export const OpenAICompatible = AI_PROTOCOL.implement({
  name: 'ozaco/openai-compatible',
  version: '0.0.1',
  description: 'OpenAI-compatible AI client over std:fetch',

  *setup(config: AiDef.Config) {
    if (!config.apiKey) {
      return yield* fail(AiErrors.Auth, 'OpenAICompatible: `apiKey` is required')
    }

    const context: AiDef.Context = {
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      model: config.model,
      headers: { ...config.headers },
    }

    return context
  },
}).build({
  chat: operation(function* (messages: AiDef.Message[], options: AiDef.ChatOptions = {}) {
    const ctx = yield* useContext(AI_PROTOCOL)
    const { url, response } = yield* postJson(
      ctx,
      'chat/completions',
      buildChatBody(ctx, messages, options),
    )
    if (!response.ok) {
      return yield* failStatus(url, response)
    }
    const body = yield* response.json()
    return parseChatResponse(body, options.model ?? ctx.model ?? '')
  }),

  chatStream: operation(function* (messages: AiDef.Message[], options: AiDef.ChatOptions = {}) {
    const ctx = yield* useContext(AI_PROTOCOL)
    const { url, response } = yield* postJson(
      ctx,
      'chat/completions',
      buildChatBody(ctx, messages, { ...options, stream: true }),
    )
    if (!response.ok) {
      return yield* failStatus(url, response)
    }
    const raw = yield* response.raw()
    return yield* chatChunkStream(raw)
  }),

  embed: operation(function* (input: string | string[], options: AiDef.EmbedOptions = {}) {
    const ctx = yield* useContext(AI_PROTOCOL)
    const { url, response } = yield* postJson(
      ctx,
      'embeddings',
      buildEmbedBody(ctx, input, options),
    )
    if (!response.ok) {
      return yield* failStatus(url, response)
    }
    const body = yield* response.json()
    return parseEmbedResponse(body)
  }),

  tts: operation(function* (text: string, options: AiDef.TtsOptions = {}) {
    const ctx = yield* useContext(AI_PROTOCOL)
    const { url, response } = yield* postJson(ctx, 'audio/speech', buildTtsBody(ctx, text, options))
    if (!response.ok) {
      return yield* failStatus(url, response)
    }
    return yield* response.bytes()
  }),

  ttsStream: operation(function* (text: string, options: AiDef.TtsOptions = {}) {
    const ctx = yield* useContext(AI_PROTOCOL)
    const { url, response } = yield* postJson(ctx, 'audio/speech', buildTtsBody(ctx, text, options))
    if (!response.ok) {
      return yield* failStatus(url, response)
    }
    const raw = yield* response.raw()
    return yield* byteStream(raw)
  }),

  stt: operation(function* (audio: Uint8Array | Blob, options: AiDef.SttOptions = {}) {
    const ctx = yield* useContext(AI_PROTOCOL)
    const { url, response } = yield* postForm(
      ctx,
      'audio/transcriptions',
      buildSttForm(ctx, audio, options),
    )
    if (!response.ok) {
      return yield* failStatus(url, response)
    }
    const body = yield* response.json()
    return parseSttResponse(body)
  }),

  sttStream: operation(function* (audio: Uint8Array | Blob, options: AiDef.SttOptions = {}) {
    const ctx = yield* useContext(AI_PROTOCOL)
    const { url, response } = yield* postForm(
      ctx,
      'audio/transcriptions',
      buildSttForm(ctx, audio, { ...options, stream: true }),
    )
    if (!response.ok) {
      return yield* failStatus(url, response)
    }
    const raw = yield* response.raw()
    return yield* transcriptStream(raw)
  }),
})
