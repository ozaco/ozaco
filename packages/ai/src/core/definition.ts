// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { useContext } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'

import { DEFAULT_MAX_ROUNDS } from './const'
import { AiErrors } from './errors'
import { runToolLoop } from './internal/loop'
import {
  resolveChatSpec,
  resolveEmbedSpec,
  resolveSpeechSpec,
  resolveTranscribeSpec,
} from './internal/resolve'
import { withRetry } from './internal/retry'
import { AiProvider } from './provider'
import type { AiDef } from './types/ai'
import type { Helpers } from './types/helpers'

/**
 * The app-facing AI protocol. Install a provider (`ai:impl/*`), then {@link AiClient}; drive it
 * through `Ai.actions.*` (chat / chatStream / embed / tts / ttsStream / stt). The context is the
 * resolved client state ({@link AiDef.Context}) — resolve it anywhere with {@link useAi}.
 * `JsonCodec` is a baseline dependency: the tool loop (de)serializes tool arguments and results
 * through it, so `install(JsonCodec)` alongside the provider.
 */
const AiProtocol = defineProtocol<AiDef.Context, AiDef.Actions>({
  name: 'ai',
  version: '0.1.0',
  description: 'Provider-agnostic AI client plugin',
})

export const Ai = AiProtocol

const AiClientImpl = AiProtocol.implement<AiDef.Context, [options?: AiDef.Options]>({
  name: 'ai-client',
  version: '0.1.0',
  description: 'The spec-resolving AI client over the installed provider',
  *setup(options) {
    const info = yield* AiProvider.context.get()
    if (!info) {
      return yield* fail(
        AiErrors.Configuration,
        'no ai provider installed — install an ai:impl/* provider before AiClient',
      )
    }
    return {
      provider: info,
      models: { ...options?.models },
      defaults: { ...options?.defaults },
      retries: options?.retries ?? 0,
    }
  },
})

export const AiClient: AiDef = AiClientImpl.build({
  *chat(messages: Helpers.MessagesInit, options: AiDef.ChatOptions = {}) {
    const state = yield* useContext(AiProtocol)
    const spec = yield* resolveChatSpec({ state, messages, options, streaming: false })
    const retries = options.retries ?? state.retries
    if (options.run) {
      return yield* runToolLoop({
        spec,
        run: options.run,
        maxRounds: options.maxRounds ?? DEFAULT_MAX_ROUNDS,
        retries,
      })
    }
    return yield* withRetry(retries, () => AiProvider.actions.chat(spec))
  },

  *chatStream(messages: Helpers.MessagesInit, options: AiDef.ChatStreamOptions = {}) {
    const state = yield* useContext(AiProtocol)
    const spec = yield* resolveChatSpec({ state, messages, options, streaming: true })
    return yield* AiProvider.actions.chatStream(spec)
  },

  *embed(input: string | readonly string[], options: AiDef.EmbedOptions = {}) {
    const state = yield* useContext(AiProtocol)
    const spec = yield* resolveEmbedSpec({ state, input, options })
    return yield* withRetry(options.retries ?? state.retries, () => AiProvider.actions.embed(spec))
  },

  *tts(text: string, options: AiDef.SpeechOptions = {}) {
    const state = yield* useContext(AiProtocol)
    const spec = yield* resolveSpeechSpec({ state, text, options })
    return yield* AiProvider.actions.tts(spec)
  },

  *ttsStream(text: string, options: AiDef.SpeechOptions = {}) {
    const state = yield* useContext(AiProtocol)
    const spec = yield* resolveSpeechSpec({ state, text, options })
    return yield* AiProvider.actions.ttsStream(spec)
  },

  *stt(audio: Uint8Array | Blob, options: AiDef.TranscribeOptions = {}) {
    const state = yield* useContext(AiProtocol)
    const spec = yield* resolveTranscribeSpec({ state, audio, options })
    return yield* AiProvider.actions.stt(spec)
  },
})

/** Resolve the installed client state (provider info, per-modality models, merged defaults). */
export const useAi = (): Operation<AiDef.Context> => AiProtocol.context.expect()
