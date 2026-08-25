// oxlint-disable import/exports-last
import type { Helpers } from 'ai:core'
import { AiErrors, textOf } from 'ai:core'
import { CodecErrors } from 'std:codec'
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { classifyError } from './common'
import { SSE_DONE } from './sse'

/** Drop `undefined` entries so the provider never sees explicit `undefined` fields. */
const compact = (record: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (record[key] !== undefined) {
      out[key] = record[key]
    }
  }
  return out
}

const encodeMessage = (message: Helpers.Message): Record<string, unknown> =>
  compact({
    role: message.role,
    content: textOf(message),
    name: message.name,
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.length
      ? message.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      : undefined,
  })

/** NEUTRAL {@link Helpers.ToolSpec} → the OpenAI `{ type: 'function', function: {…} }` wire
 * shape. */
const encodeTool = (tool: Helpers.ToolSpec): Record<string, unknown> => ({
  type: 'function',
  function: compact({
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
  }),
})

const encodeToolChoice = (choice: Helpers.ToolChoice): unknown =>
  typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } }

const encodeOutput = (output: Helpers.OutputSpec): Record<string, unknown> | undefined => {
  if (output === 'text') {
    return undefined
  }
  if (output === 'json') {
    return { type: 'json_object' }
  }
  return {
    type: 'json_schema',
    json_schema: compact({
      name: output.name ?? 'response',
      schema: output.schema,
      strict: output.strict,
    }),
  }
}

/** Build the `/chat/completions` request body. Pure — used directly in tests. */
export const chatBody = (spec: Helpers.ChatSpec, stream: boolean): Record<string, unknown> =>
  compact({
    model: spec.model,
    messages: spec.messages.map(encodeMessage),
    temperature: spec.sampling.temperature,
    top_p: spec.sampling.topP,
    max_tokens: spec.sampling.maxTokens,
    stop: spec.sampling.stop,
    seed: spec.sampling.seed,
    frequency_penalty: spec.sampling.frequencyPenalty,
    presence_penalty: spec.sampling.presencePenalty,
    tools: spec.tools.length > 0 ? spec.tools.map(encodeTool) : undefined,
    tool_choice:
      spec.tools.length > 0 && spec.toolChoice !== 'auto'
        ? encodeToolChoice(spec.toolChoice)
        : undefined,
    response_format: encodeOutput(spec.output),
    stream: stream || undefined,
    // ask for the final usage frame on streams
    stream_options: stream ? { include_usage: true } : undefined,
    ...spec.extra,
  })

/** Build the `/embeddings` request body. Pure — used directly in tests. */
export const embedBody = (spec: Helpers.EmbedSpec): Record<string, unknown> =>
  compact({
    model: spec.model,
    input: spec.input,
    dimensions: spec.dimensions,
    ...spec.extra,
  })

/** Build the `/audio/speech` request body. Pure — used directly in tests. */
export const speechBody = (spec: Helpers.SpeechSpec): Record<string, unknown> =>
  compact({
    model: spec.model,
    input: spec.text,
    voice: spec.voice,
    response_format: spec.format,
    speed: spec.speed,
    ...spec.extra,
  })

/** Build the multipart `/audio/transcriptions` form. Pure — used directly in tests. */
export const transcribeForm = (spec: Helpers.TranscribeSpec): FormData => {
  const form = new FormData()
  const blob =
    spec.audio instanceof Blob
      ? spec.audio
      : new Blob([spec.audio as AnyType], { type: spec.contentType ?? 'application/octet-stream' })
  form.append('file', blob, spec.filename ?? 'audio')
  form.append('model', spec.model)
  if (spec.language !== undefined) {
    form.append('language', spec.language)
  }
  if (spec.prompt !== undefined) {
    form.append('prompt', spec.prompt)
  }
  for (const key of Object.keys(spec.extra ?? {})) {
    form.append(key, String(spec.extra![key]))
  }
  return form
}

const decodeUsage = (raw: AnyType): Helpers.Usage | undefined =>
  raw && typeof raw === 'object'
    ? {
        promptTokens: raw.prompt_tokens,
        completionTokens: raw.completion_tokens,
        totalTokens: raw.total_tokens,
      }
    : undefined

function* decodeToolCalls(raw: AnyType): Operation<readonly Helpers.ToolCall[]> {
  if (raw === undefined || raw === null) {
    return []
  }
  if (!Array.isArray(raw)) {
    return yield* fail(AiErrors.BadResponse, 'openai returned malformed tool_calls')
  }
  return raw.map(call => ({
    id: String(call?.id ?? ''),
    name: String(call?.function?.name ?? ''),
    arguments: String(call?.function?.arguments ?? ''),
  }))
}

/** Normalize a `/chat/completions` response; a body without a message fails `ai.bad-response`. */
export function* decodeChatResult(
  body: unknown,
  fallbackModel: string,
): Operation<Helpers.ChatResult> {
  const raw = body as AnyType
  const choice = raw?.choices?.[0]
  const rawMessage = choice?.message
  if (!rawMessage || typeof rawMessage !== 'object') {
    return yield* fail(AiErrors.BadResponse, 'openai returned a chat completion without a message')
  }
  const text = typeof rawMessage.content === 'string' ? rawMessage.content : ''
  const toolCalls = yield* decodeToolCalls(rawMessage.tool_calls)
  const message: Helpers.Message = {
    role: 'assistant',
    parts: text ? [{ kind: 'text', text }] : [],
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  }
  return {
    message,
    text,
    toolCalls,
    finishReason: choice.finish_reason ?? undefined,
    usage: decodeUsage(raw.usage),
    model: typeof raw.model === 'string' ? raw.model : fallbackModel,
  }
}

/** Normalize an `/embeddings` response; a body without a vector array fails `ai.bad-response`. */
export function* decodeEmbedResult(
  body: unknown,
  spec: Helpers.EmbedSpec,
): Operation<Helpers.EmbedResult> {
  const raw = body as AnyType
  if (!Array.isArray(raw?.data)) {
    return yield* fail(AiErrors.BadResponse, 'openai returned an embeddings response without data')
  }
  const vectors: (readonly number[])[] = []
  for (const entry of raw.data) {
    if (!Array.isArray(entry?.embedding)) {
      return yield* fail(AiErrors.BadResponse, 'openai returned an embedding without a vector')
    }
    vectors.push(entry.embedding as number[])
  }
  return {
    vectors,
    model: typeof raw.model === 'string' ? raw.model : spec.model,
    usage: decodeUsage(raw.usage),
  }
}

/** Pull the transcript out of an `/audio/transcriptions` response; anything else fails. */
export function* decodeTranscription(body: unknown): Operation<string> {
  const text = (body as AnyType)?.text
  if (typeof text !== 'string') {
    return yield* fail(
      AiErrors.BadResponse,
      'openai returned a transcription response without text',
    )
  }
  return text
}

const decodeToolCallDeltas = (raw: AnyType): readonly Helpers.ToolCallDelta[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined
  }
  return raw.map((call, fallbackIndex) => {
    const delta: { -readonly [K in keyof Helpers.ToolCallDelta]: Helpers.ToolCallDelta[K] } = {
      index: typeof call?.index === 'number' ? call.index : fallbackIndex,
    }
    if (call?.id !== undefined) {
      delta.id = String(call.id)
    }
    if (call?.function?.name !== undefined) {
      delta.name = String(call.function.name)
    }
    if (call?.function?.arguments !== undefined) {
      delta.arguments = String(call.function.arguments)
    }
    return delta
  })
}

/**
 * Parse one streaming `/chat/completions` SSE payload into a {@link Helpers.ChatDelta};
 * `undefined` for the `[DONE]` sentinel. A mid-stream `{"error":{…}}` frame RAISES its classified
 * failure and an unparseable chunk raises `ai.bad-response` — either closes the stream with that
 * Failure instead of silently forwarding an empty delta.
 */
export function* decodeChatDelta(data: string): Operation<Helpers.ChatDelta | undefined> {
  if (data === SSE_DONE) {
    return undefined
  }
  const outcome = yield* attempt(JsonCodec.actions.parse<AnyType>(data))
  if (isFailure(outcome)) {
    if (outcome.error !== CodecErrors.Parse) {
      return yield* outcome
    }
    return yield* fail(AiErrors.BadResponse, 'openai stream carried an unparseable chunk')
  }
  const payload: AnyType = outcome.value
  const errorFrame = payload?.error
  if (errorFrame && typeof errorFrame === 'object') {
    const detail = errorFrame.message ?? (yield* JsonCodec.actions.stringify(errorFrame))
    return yield* fail(classifyError(0, errorFrame), `openai stream reported an error: ${detail}`)
  }
  const choice = payload?.choices?.[0]
  const delta: { -readonly [K in keyof Helpers.ChatDelta]: Helpers.ChatDelta[K] } = {}
  if (typeof choice?.delta?.content === 'string' && choice.delta.content.length > 0) {
    delta.text = choice.delta.content
  }
  const fragments = decodeToolCallDeltas(choice?.delta?.tool_calls)
  if (fragments) {
    delta.toolCalls = fragments
  }
  if (choice?.finish_reason) {
    delta.finishReason = choice.finish_reason
  }
  const usage = decodeUsage(payload?.usage)
  if (usage) {
    delta.usage = usage
  }
  return delta
}
