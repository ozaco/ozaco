import { attempt, operation } from 'std:effect'
import { isSuccess } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { SSE_DONE } from '../const'
import type { AiDef } from '../types'

interface RawToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

interface RawChatResponse {
  model?: string
  choices?: {
    message?: {
      role?: string
      content?: string | null
      name?: string
      tool_calls?: RawToolCall[]
    }
    finish_reason?: string | null
  }[]
  usage?: RawUsage
}

interface RawEmbedResponse {
  data?: { embedding?: number[] }[]
}

interface RawSttResponse {
  text?: string
}

interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface RawToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface RawStreamChunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: RawToolCallDelta[] }
    finish_reason?: string | null
  }[]
  usage?: RawUsage | null
}

interface RawTranscriptChunk {
  type?: string
  delta?: string
}

/** Normalize a raw `usage` block into `Usage`, or `undefined` when absent. Shared across responses. */
const parseUsage = (raw: RawUsage | null | undefined): AiDef.Usage | undefined =>
  raw
    ? {
        promptTokens: raw.prompt_tokens,
        completionTokens: raw.completion_tokens,
        totalTokens: raw.total_tokens,
      }
    : undefined

/** Map the raw `tool_calls` of a chat message into `ToolCall[]`, or `undefined` when absent. */
const parseToolCalls = (raw: RawToolCall[] | undefined): AiDef.ToolCall[] | undefined => {
  if (!raw || raw.length === 0) {
    return undefined
  }
  return raw.map(call => ({
    id: call.id ?? '',
    name: call.function?.name ?? '',
    arguments: call.function?.arguments ?? '',
  }))
}

/** Map raw streaming `tool_calls` fragments into `ToolCallDelta[]`, or `undefined` when absent. */
const parseToolCallDeltas = (
  raw: RawToolCallDelta[] | undefined,
): AiDef.ToolCallDelta[] | undefined => {
  if (!raw || raw.length === 0) {
    return undefined
  }
  return raw.map((call, fallbackIndex) => {
    const delta: AiDef.ToolCallDelta = { index: call.index ?? fallbackIndex }
    if (call.id !== undefined) {
      delta.id = call.id
    }
    if (call.function?.name !== undefined) {
      delta.name = call.function.name
    }
    if (call.function?.arguments !== undefined) {
      delta.arguments = call.function.arguments
    }
    return delta
  })
}

/** Normalize a `/chat/completions` response into a `ChatResult`. Pure — used directly in tests. */
export const parseChatResponse = (body: unknown, fallbackModel: string): AiDef.ChatResult => {
  const raw = (body ?? {}) as RawChatResponse
  const choice = raw.choices?.[0]
  const content = choice?.message?.content ?? ''
  const toolCalls = parseToolCalls(choice?.message?.tool_calls)
  const message: AiDef.Message = {
    role: (choice?.message?.role as AiDef.Role | undefined) ?? 'assistant',
    content,
    ...(toolCalls ? { toolCalls } : {}),
  }
  return {
    message,
    text: content,
    model: raw.model ?? fallbackModel,
    finishReason: choice?.finish_reason ?? undefined,
    usage: parseUsage(raw.usage),
    toolCalls,
  }
}

/** Pull the embedding vectors out of an `/embeddings` response. Pure — used directly in tests. */
export const parseEmbedResponse = (body: unknown): number[][] => {
  const raw = (body ?? {}) as RawEmbedResponse
  return (raw.data ?? []).map(entry => entry.embedding ?? [])
}

/** Pull the transcription text out of an `/audio/transcriptions` response. */
export const parseSttResponse = (body: unknown): string => {
  const raw = (body ?? {}) as RawSttResponse
  return raw.text ?? ''
}

/**
 * Parse a single streaming `/chat/completions` SSE `data:` payload (the JSON after `data: `) into a
 * `ChatStreamChunk`: `delta` is the incremental content (`''` when none), `toolCalls` carries any
 * tool-call fragments, `finishReason` the terminal reason, and `usage` the totals on the final
 * include-usage chunk. Returns `undefined` for the `[DONE]` sentinel (or an empty/unparseable
 * payload). Tool-call `arguments` are PARTIAL — the consumer accumulates them. Pure — used in tests.
 */
export const parseChatChunk = operation(function* (data: string) {
  const payload = data.trim()
  if (payload === SSE_DONE || payload.length === 0) {
    return undefined
  }
  // an unparseable chunk degrades to an empty delta (matches the previous try/catch) — `attempt`
  // captures the decode failure instead of propagating it and halting the stream
  const parsed = yield* attempt(JsonCodec.actions.parse(payload))
  if (!isSuccess(parsed)) {
    return { delta: '' }
  }
  const chunk = parsed.value as RawStreamChunk
  const choice = chunk.choices?.[0]
  const result: AiDef.ChatStreamChunk = { delta: choice?.delta?.content ?? '' }
  const toolCalls = parseToolCallDeltas(choice?.delta?.tool_calls)
  if (toolCalls) {
    result.toolCalls = toolCalls
  }
  if (choice?.finish_reason) {
    result.finishReason = choice.finish_reason
  }
  const usage = parseUsage(chunk.usage)
  if (usage) {
    result.usage = usage
  }
  return result
})

/**
 * Extract the transcript delta from a single streaming `/audio/transcriptions` SSE payload. Returns
 * the delta text for a `transcript.text.delta` event, `''` for any other event (e.g. `*.done`), or
 * `undefined` for the `[DONE]` sentinel that ends the stream. Pure — used directly in tests.
 */
export const parseTranscriptDelta = operation(function* (data: string) {
  const payload = data.trim()
  if (payload === SSE_DONE || payload.length === 0) {
    return undefined
  }
  const parsed = yield* attempt(JsonCodec.actions.parse(payload))
  if (!isSuccess(parsed)) {
    return ''
  }
  const chunk = parsed.value as RawTranscriptChunk
  return chunk.type === 'transcript.text.delta' ? (chunk.delta ?? '') : ''
})
