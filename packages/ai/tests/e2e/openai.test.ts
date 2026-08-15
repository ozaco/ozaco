import type { Helpers } from 'ai:core'
import { Ai, AiClient, AiErrors } from 'ai:core'
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { FetchClient } from 'std:fetch'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { afterAll, describe, expect, it } from 'bun:test'

import type { OpenAIProviderOptions } from 'ai:impl/openai'
import { OpenAIProvider } from 'ai:impl/openai'
import { JsonCodec } from 'std:codec/impl/json'

import { drain, runScoped } from '../helpers'

import type { ProviderScript, SuiteChatTurn, SuiteStream } from './helpers'
import { runProviderSuite } from './helpers'

// ---------------------------------------------------------------------------
// The local OpenAI-compatible server fixture — no network, no env gating.
// ---------------------------------------------------------------------------

type Special = 'mid-stream-error' | 'garbage-chunk' | 'split-event' | 'stall'

interface RecordedRequest {
  readonly path: string
  readonly auth: string | null
  readonly headers: Headers
  readonly body?: AnyType
  readonly form?: Record<string, unknown>
}

interface ServerState {
  script: ProviderScript
  chatIndex: number
  streamIndex: number
  special: Special | undefined
  requests: RecordedRequest[]
}

const state: ServerState = {
  script: {},
  chatIndex: 0,
  streamIndex: 0,
  special: undefined,
  requests: [],
}

const prime = (script?: ProviderScript): void => {
  state.script = script ?? {}
  state.chatIndex = 0
  state.streamIndex = 0
  state.special = undefined
  state.requests = []
}

const encoder = new TextEncoder()

const sseFrame = (payload: unknown): string =>
  `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`

const wireDelta = (chunk: Helpers.ChatDelta): Record<string, unknown> => {
  const frame: Record<string, unknown> = {}
  const delta: Record<string, unknown> = {}
  if (chunk.text !== undefined) {
    delta.content = chunk.text
  }
  if (chunk.toolCalls) {
    delta.tool_calls = chunk.toolCalls.map(fragment => ({
      index: fragment.index,
      ...(fragment.id === undefined ? {} : { id: fragment.id }),
      function: {
        ...(fragment.name === undefined ? {} : { name: fragment.name }),
        ...(fragment.arguments === undefined ? {} : { arguments: fragment.arguments }),
      },
    }))
  }
  frame.choices =
    Object.keys(delta).length > 0 || chunk.finishReason
      ? [{ index: 0, delta, finish_reason: chunk.finishReason ?? null }]
      : []
  if (chunk.usage) {
    frame.usage = {
      prompt_tokens: chunk.usage.promptTokens,
      completion_tokens: chunk.usage.completionTokens,
      total_tokens: chunk.usage.totalTokens,
    }
  }
  return frame
}

const sseResponse = (stream: SuiteStream, special: Special | undefined): Response => {
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (special === 'split-event') {
        const whole = sseFrame(wireDelta({ text: 'AB' }))
        controller.enqueue(encoder.encode(whole.slice(0, 14)))
        await Bun.sleep(5)
        controller.enqueue(encoder.encode(whole.slice(14)))
        controller.enqueue(encoder.encode(sseFrame('[DONE]')))
        controller.close()
        return
      }
      if (special === 'mid-stream-error') {
        controller.enqueue(encoder.encode(sseFrame(wireDelta({ text: 'partial' }))))
        await Bun.sleep(2)
        controller.enqueue(
          encoder.encode(sseFrame({ error: { message: 'boom mid-stream', type: 'server_error' } })),
        )
        controller.close()
        return
      }
      if (special === 'garbage-chunk') {
        controller.enqueue(encoder.encode('data: totally{{garbage\n\n'))
        controller.close()
        return
      }
      for (const chunk of stream.chunks) {
        controller.enqueue(encoder.encode(sseFrame(wireDelta(chunk))))
        // oxlint-disable-next-line no-await-in-loop
        await Bun.sleep(1)
      }
      if (!stream.hang) {
        controller.enqueue(encoder.encode(sseFrame('[DONE]')))
        controller.close()
      }
    },
  })
  return new Response(readable, { headers: { 'content-type': 'text/event-stream' } })
}

const errorResponse = (turn: SuiteChatTurn & { kind: 'error' }): Response => {
  if (turn.error === 'auth') {
    return Response.json(
      { error: { message: 'invalid api key', code: 'invalid_api_key' } },
      { status: 401 },
    )
  }
  if (turn.error === 'rate-limit') {
    return Response.json(
      { error: { message: 'rate limited', code: 'rate_limit_exceeded' } },
      { status: 429, headers: { 'retry-after': String(turn.retryAfterSeconds ?? 1) } },
    )
  }
  return new Response('this is not json {{', {
    headers: { 'content-type': 'application/json' },
  })
}

const completionBody = (turn: SuiteChatTurn, model: string): Record<string, unknown> => {
  if (turn.kind === 'tool-calls') {
    return {
      id: 'chatcmpl-test',
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: turn.calls.map(call => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
  }
  const text = turn.kind === 'text' ? turn.text : ''
  return {
    id: 'chatcmpl-test',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  }
}

const record = (path: string, req: Request, extra: Partial<RecordedRequest>): void => {
  state.requests.push({
    path,
    auth: req.headers.get('authorization'),
    headers: req.headers,
    ...extra,
  })
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (state.special === 'stall') {
      await Bun.sleep(5000)
      return new Response('late')
    }
    if (pathname.endsWith('/chat/completions')) {
      const body = (await req.json()) as AnyType
      record('chat/completions', req, { body })
      if (body.stream) {
        if (state.special) {
          return sseResponse({ chunks: [] }, state.special)
        }
        const stream = state.script.chatStream?.[state.streamIndex] ?? { chunks: [] }
        state.streamIndex += 1
        return sseResponse(stream, undefined)
      }
      const turn = state.script.chat?.[state.chatIndex] ?? { kind: 'text', text: 'ok' }
      state.chatIndex += 1
      if (turn.kind === 'error') {
        return errorResponse(turn)
      }
      return Response.json(completionBody(turn, body.model))
    }
    if (pathname.endsWith('/embeddings')) {
      const body = (await req.json()) as AnyType
      record('embeddings', req, { body })
      const vectors = state.script.embed ?? (body.input as string[]).map(() => [0])
      return Response.json({
        data: vectors.map((vector, index) => ({ index, embedding: vector })),
        model: body.model,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })
    }
    if (pathname.endsWith('/audio/speech')) {
      const body = (await req.json()) as AnyType
      record('audio/speech', req, { body })
      return new Response(state.script.tts ?? new Uint8Array([0]))
    }
    if (pathname.endsWith('/audio/transcriptions')) {
      // Bun's formData() rewrites file.type from the filename extension (.wav -> audio/x-wav),
      // so the declared part content-type is read from the raw multipart body instead.
      const raw = await req.clone().text()
      const partType = raw
        .split('\r\n')
        .find(line => line.toLowerCase().startsWith('content-type:'))
      const form = await req.formData()
      const file = form.get('file') as File | null
      record('audio/transcriptions', req, {
        form: {
          model: form.get('model'),
          language: form.get('language'),
          fileName: file?.name ?? null,
          fileType: partType?.slice('content-type:'.length).trim() ?? null,
        },
      })
      return Response.json({ text: state.script.stt ?? '' })
    }
    return new Response('not found', { status: 404 })
  },
})

const base = `http://127.0.0.1:${server.port}/v1`

afterAll(() => {
  server.stop(true)
})

const installOpenAI = (
  script?: ProviderScript,
  options?: Partial<OpenAIProviderOptions>,
): Operation<unknown> =>
  (function* () {
    prime(script)
    yield* install(FetchClient)
    yield* install(JsonCodec)
    return yield* install(OpenAIProvider, { apiKey: 'test-key', baseUrl: base, ...options })
  })()

// ---------------------------------------------------------------------------
// The shared provider suite + openai-specific wire/transport coverage.
// ---------------------------------------------------------------------------

runProviderSuite({
  label: 'openai',
  restrictable: false,
  capabilities: {
    chat: true,
    chatStream: true,
    tools: true,
    json: true,
    embed: true,
    tts: true,
    stt: true,
  },
  install: script => installOpenAI(script),
})

describe('openai provider — wire & transport', () => {
  it('sends bearer auth by default and the computed header overrides user headers', async () => {
    await runScoped(function* () {
      yield* installOpenAI(undefined, {
        headers: { Authorization: 'user-clobber-attempt', 'x-extra': 'yes' },
      })
      yield* install(AiClient, { models: { chat: 'm' } })
      yield* Ai.actions.chat('hi')
      const request = state.requests[0]!
      expect(request.auth).toBe('Bearer test-key')
      expect(request.headers.get('x-extra')).toBe('yes')
    })
  })

  it('auth kind "header" carries the key under the custom name instead of authorization', async () => {
    await runScoped(function* () {
      yield* installOpenAI(undefined, { auth: { kind: 'header', name: 'X-Api-Key' } })
      yield* install(AiClient, { models: { chat: 'm' } })
      yield* Ai.actions.chat('hi')
      const request = state.requests[0]!
      expect(request.headers.get('x-api-key')).toBe('test-key')
      expect(request.auth).toBeNull()
    })
  })

  it('converts neutral tools, tool choice, output and sampling to the OpenAI wire shape', async () => {
    await runScoped(function* () {
      yield* installOpenAI()
      yield* install(AiClient, { models: { chat: 'm' } })
      yield* Ai.actions.chat('x', {
        tools: [{ name: 'add', description: 'adds', schema: { type: 'object' } }],
        toolChoice: { name: 'add' },
        output: { schema: { type: 'object' }, name: 'answer', strict: true },
        temperature: 0.1,
        maxTokens: 5,
        stop: ['END'],
      })
      const body = state.requests[0]!.body
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: { name: 'add', description: 'adds', parameters: { type: 'object' } },
        },
      ])
      expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'add' } })
      expect(body.response_format).toEqual({
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
      })
      expect(body.temperature).toBe(0.1)
      expect(body.max_tokens).toBe(5)
      expect(body.stop).toEqual(['END'])
      expect(body.stream).toBeUndefined()
    })
  })

  it('streaming requests set stream and ask for the usage frame', async () => {
    await runScoped(function* () {
      yield* installOpenAI({ chatStream: [{ chunks: [{ text: 'a' }] }] })
      yield* install(AiClient, { models: { chat: 'm' } })
      const flow = yield* Ai.actions.chatStream('x')
      yield* drain(flow)
      const body = state.requests[0]!.body
      expect(body.stream).toBe(true)
      expect(body.stream_options).toEqual({ include_usage: true })
    })
  })

  it('a mid-stream error frame closes the stream with a classified failure', async () => {
    await runScoped(function* () {
      yield* installOpenAI()
      yield* install(AiClient, { models: { chat: 'm' } })
      state.special = 'mid-stream-error'
      const flow = yield* Ai.actions.chatStream('x')
      const { values, close } = yield* drain(flow)
      expect(values.map(value => value.text ?? '').join('')).toBe('partial')
      expect(isFailure(close)).toBe(true)
      expect((close as AnyType).error).toBe(AiErrors.Request)
      expect((close as AnyType).message).toContain('boom mid-stream')
    })
  })

  it('a garbage SSE chunk closes the stream with ai.bad-response', async () => {
    await runScoped(function* () {
      yield* installOpenAI()
      yield* install(AiClient, { models: { chat: 'm' } })
      state.special = 'garbage-chunk'
      const flow = yield* Ai.actions.chatStream('x')
      const { values, close } = yield* drain(flow)
      expect(values).toEqual([])
      expect(isFailure(close)).toBe(true)
      expect((close as AnyType).error).toBe(AiErrors.BadResponse)
    })
  })

  it('an SSE event split across network chunks is reassembled', async () => {
    await runScoped(function* () {
      yield* installOpenAI()
      yield* install(AiClient, { models: { chat: 'm' } })
      state.special = 'split-event'
      const flow = yield* Ai.actions.chatStream('x')
      const { values, close } = yield* drain(flow)
      expect(close).toBe(true)
      expect(values.map(value => value.text ?? '').join('')).toBe('AB')
    })
  })

  it('a stalled request fails ai.timeout under timeoutMs', async () => {
    await runScoped(function* () {
      yield* installOpenAI(undefined, { timeoutMs: 100 })
      yield* install(AiClient, { models: { chat: 'm' } })
      state.special = 'stall'
      const outcome = yield* attempt(Ai.actions.chat('x'))
      state.special = undefined
      expect((outcome as AnyType).error).toBe(AiErrors.Timeout)
    })
  })

  it('stt uploads multipart with the file name, content type and fields', async () => {
    await runScoped(function* () {
      yield* installOpenAI({ stt: 'hello' })
      yield* install(AiClient, { models: { stt: 'model-stt' } })
      const text = yield* Ai.actions.stt(new Uint8Array([1, 2]), {
        language: 'tr',
        filename: 'clip.wav',
        contentType: 'audio/wav',
      })
      expect(text).toBe('hello')
      const request = state.requests[0]!
      expect(request.form).toEqual({
        model: 'model-stt',
        language: 'tr',
        fileName: 'clip.wav',
        fileType: 'audio/wav',
      })
    })
  })
})
