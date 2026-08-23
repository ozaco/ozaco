// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { fail } from 'std:result'

import { AiErrors } from '../errors'
import type { AiDef } from '../types/ai'
import type { Helpers } from '../types/helpers'
import { normalizeMessages } from '../utils'

const SAMPLING_KEYS = [
  'temperature',
  'topP',
  'maxTokens',
  'stop',
  'seed',
  'frequencyPenalty',
  'presencePenalty',
] as const

/** Per-call sampling over the install defaults, dropping `undefined` entries. */
const mergeSampling = (defaults: AiDef.Defaults, options: Helpers.Sampling): Helpers.Sampling => {
  const merged: Record<string, unknown> = {}
  for (const key of SAMPLING_KEYS) {
    const value = options[key] ?? defaults[key]
    if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged as Helpers.Sampling
}

const missingModel = (modality: keyof AiDef.Models) =>
  fail(
    AiErrors.Configuration,
    `no ${modality} model configured — pass options.model or install AiClient with models.${modality}`,
  )

interface ChatInput {
  readonly state: AiDef.Context
  readonly messages: Helpers.MessagesInit
  readonly options: AiDef.ChatStreamOptions
  readonly streaming: boolean
}

/** Resolve a chat call into a {@link Helpers.ChatSpec}: capability gates, per-modality model,
 * sampling merge, message normalization. */
export function* resolveChatSpec(input: ChatInput): Operation<Helpers.ChatSpec> {
  const { state, options } = input
  const { capabilities } = state.provider
  if (input.streaming ? !capabilities.chatStream : !capabilities.chat) {
    return yield* fail(
      AiErrors.Unsupported,
      `the "${state.provider.provider}" provider does not support ${input.streaming ? 'chatStream' : 'chat'}`,
    )
  }
  const tools = options.tools ?? []
  if (tools.length > 0 && !capabilities.tools) {
    return yield* fail(
      AiErrors.Unsupported,
      `the "${state.provider.provider}" provider does not support tools`,
    )
  }
  const output = options.output ?? 'text'
  if (output !== 'text' && !capabilities.json) {
    return yield* fail(
      AiErrors.Unsupported,
      `the "${state.provider.provider}" provider does not support structured output`,
    )
  }
  const model = options.model ?? state.models.chat
  if (!model) {
    return yield* missingModel('chat')
  }
  return {
    model,
    messages: normalizeMessages(input.messages),
    tools,
    toolChoice: options.toolChoice ?? 'auto',
    output,
    sampling: mergeSampling(state.defaults, options),
    ...(options.extra ? { extra: options.extra } : {}),
  }
}

interface EmbedInput {
  readonly state: AiDef.Context
  readonly input: string | readonly string[]
  readonly options: AiDef.EmbedOptions
}

export function* resolveEmbedSpec(input: EmbedInput): Operation<Helpers.EmbedSpec> {
  const { state, options } = input
  if (!state.provider.capabilities.embed) {
    return yield* fail(
      AiErrors.Unsupported,
      `the "${state.provider.provider}" provider does not support embed`,
    )
  }
  const model = options.model ?? state.models.embed
  if (!model) {
    return yield* missingModel('embed')
  }
  return {
    model,
    input: typeof input.input === 'string' ? [input.input] : input.input,
    ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
    ...(options.extra ? { extra: options.extra } : {}),
  }
}

interface SpeechInput {
  readonly state: AiDef.Context
  readonly text: string
  readonly options: AiDef.SpeechOptions
}

export function* resolveSpeechSpec(input: SpeechInput): Operation<Helpers.SpeechSpec> {
  const { state, options } = input
  if (!state.provider.capabilities.tts) {
    return yield* fail(
      AiErrors.Unsupported,
      `the "${state.provider.provider}" provider does not support tts`,
    )
  }
  const model = options.model ?? state.models.tts
  if (!model) {
    return yield* missingModel('tts')
  }
  const voice = options.voice ?? state.defaults.voice
  if (!voice) {
    return yield* fail(
      AiErrors.Configuration,
      'no speech voice configured — pass options.voice or install AiClient with defaults.voice',
    )
  }
  return {
    model,
    voice,
    text: input.text,
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.speed === undefined ? {} : { speed: options.speed }),
    ...(options.extra ? { extra: options.extra } : {}),
  }
}

interface TranscribeInput {
  readonly state: AiDef.Context
  readonly audio: Uint8Array | Blob
  readonly options: AiDef.TranscribeOptions
}

export function* resolveTranscribeSpec(input: TranscribeInput): Operation<Helpers.TranscribeSpec> {
  const { state, options } = input
  if (!state.provider.capabilities.stt) {
    return yield* fail(
      AiErrors.Unsupported,
      `the "${state.provider.provider}" provider does not support stt`,
    )
  }
  const model = options.model ?? state.models.stt
  if (!model) {
    return yield* missingModel('stt')
  }
  return {
    model,
    audio: input.audio,
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(options.filename === undefined ? {} : { filename: options.filename }),
    ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    ...(options.extra ? { extra: options.extra } : {}),
  }
}
