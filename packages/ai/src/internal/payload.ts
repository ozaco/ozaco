import type { AnyType } from 'std:shared'

import type { AiDef } from '../types'

/** Drop `undefined` entries so we never send `null`/`undefined` fields the provider may reject. */
const compact = (record: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (record[key] !== undefined) {
      out[key] = record[key]
    }
  }
  return out
}

/** Serialize one message into the OpenAI wire shape, threading tool-call fields when present. */
const serializeMessage = (message: AiDef.Message): Record<string, unknown> =>
  compact({
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
  })

/** Map a `ToolChoice` to the OpenAI `tool_choice` wire shape. */
const serializeToolChoice = (choice: AiDef.ToolChoice): unknown =>
  typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } }

/** Map a `ResponseFormat` to the OpenAI `response_format` wire shape (camelCase → snake_case). */
const serializeResponseFormat = (format: AiDef.ResponseFormat): unknown =>
  format.type === 'json_schema'
    ? {
        type: 'json_schema',
        json_schema: compact({
          name: format.jsonSchema.name,
          schema: format.jsonSchema.schema,
          strict: format.jsonSchema.strict,
        }),
      }
    : format

/** Per-call chat options plus the internal `stream` flag the streaming variant sets. */
export type ChatBodyOptions = AiDef.ChatOptions & { stream?: boolean }

/** Per-call STT options plus the internal `stream` flag the streaming variant sets. */
export type SttFormOptions = AiDef.SttOptions & { stream?: boolean }

/** Build the `/chat/completions` request body. Pure — used directly in tests. */
export const buildChatBody = (
  ctx: AiDef.Context,
  messages: AiDef.Message[],
  options: ChatBodyOptions = {},
): Record<string, unknown> =>
  compact({
    model: options.model ?? ctx.model,
    messages: messages.map(serializeMessage),
    temperature: options.temperature,
    top_p: options.topP,
    max_tokens: options.maxTokens,
    stop: options.stop,
    frequency_penalty: options.frequencyPenalty,
    presence_penalty: options.presencePenalty,
    seed: options.seed,
    tools: options.tools,
    tool_choice: options.toolChoice ? serializeToolChoice(options.toolChoice) : undefined,
    response_format: options.responseFormat
      ? serializeResponseFormat(options.responseFormat)
      : undefined,
    stream: options.stream || undefined,
    // ask the provider to emit a final usage chunk on the streaming variant (#3).
    stream_options: options.stream ? { include_usage: true } : undefined,
    ...options.extra,
  })

/** Build the `/embeddings` request body. Pure — used directly in tests. */
export const buildEmbedBody = (
  ctx: AiDef.Context,
  input: string | string[],
  options: AiDef.EmbedOptions = {},
): Record<string, unknown> =>
  compact({
    model: options.model ?? ctx.model,
    input,
    dimensions: options.dimensions,
    ...options.extra,
  })

/** Build the `/audio/speech` request body. Pure — used directly in tests. */
export const buildTtsBody = (
  ctx: AiDef.Context,
  text: string,
  options: AiDef.TtsOptions = {},
): Record<string, unknown> =>
  compact({
    model: options.model ?? ctx.model,
    input: text,
    voice: options.voice,
    response_format: options.format,
    speed: options.speed,
    ...options.extra,
  })

/**
 * Build the multipart `/audio/transcriptions` form. Set `options.stream` to ask the provider for an
 * SSE transcript stream (used by `sttStream`). Pure — used directly in tests.
 */
export const buildSttForm = (
  ctx: AiDef.Context,
  audio: Uint8Array | Blob,
  options: SttFormOptions = {},
): FormData => {
  const form = new FormData()
  const blob =
    audio instanceof Blob
      ? audio
      : new Blob([audio as AnyType], { type: options.contentType ?? 'application/octet-stream' })

  form.append('file', blob, options.filename ?? 'audio')
  const model = options.model ?? ctx.model
  if (model !== undefined) {
    form.append('model', model)
  }
  if (options.language !== undefined) {
    form.append('language', options.language)
  }
  if (options.prompt !== undefined) {
    form.append('prompt', options.prompt)
  }
  if (options.stream) {
    form.append('stream', 'true')
  }
  if (options.extra) {
    for (const key of Object.keys(options.extra)) {
      form.append(key, options.extra[key] as string)
    }
  }
  return form
}
