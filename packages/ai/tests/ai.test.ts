import { JsonCodec } from 'std:codec'
import { each, run, sleep } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import { fetchImpl } from 'std:fetch'
import { install } from 'std:plugin'
import { isFailure, isSuccess } from 'std:result'

import { describe, expect, it } from 'bun:test'

import type { AiDef } from '../src'
import { AI, AiErrors, OpenAICompatible } from '../src'
import {
  parseChatChunk,
  parseChatResponse,
  parseEmbedResponse,
  parseTranscriptDelta,
} from '../src/internal/parse'
import { buildChatBody, buildEmbedBody, buildSttForm, buildTtsBody } from '../src/internal/payload'
import { joinUrl, statusTag } from '../src/internal/request'

const CTX: AiDef.Context = {
  apiKey: 'sk-test',
  baseURL: 'https://example.test/v1',
  model: 'gpt-4o-mini',
  headers: {},
}

// A fetch stub that records the last request and returns a canned Response.
const stubFetch = (make: () => Response) => {
  const calls: { input: unknown; init: RequestInit | undefined }[] = []
  const impl: FetchDef.Impl = (input, init) => {
    calls.push({ input, init })
    return Promise.resolve(make())
  }
  return { impl, calls }
}

describe('@ozaco/ai — payload builders', () => {
  it('builds a chat body with snake_case fields and drops undefined', () => {
    const body = buildChatBody(CTX, [{ role: 'user', content: 'hi' }], {
      temperature: 0.5,
      maxTokens: 64,
      topP: 0.9,
    })
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      max_tokens: 64,
      top_p: 0.9,
    })
    expect('stream' in body).toBe(false)
  })

  it('sets stream:true only for the streaming variant and honors model override', () => {
    const body = buildChatBody(CTX, [{ role: 'user', content: 'hi' }], {
      model: 'local',
      stream: true,
    })
    expect(body.model).toBe('local')
    expect(body.stream).toBe(true)
  })

  it('includes tools and maps toolChoice to tool_choice', () => {
    const tool: AiDef.Tool = {
      type: 'function',
      function: { name: 'get_weather', description: 'weather', parameters: { type: 'object' } },
    }
    const auto = buildChatBody(CTX, [{ role: 'user', content: 'hi' }], {
      tools: [tool],
      toolChoice: 'auto',
    })
    expect(auto.tools).toEqual([tool])
    expect(auto.tool_choice).toBe('auto')

    const forced = buildChatBody(CTX, [{ role: 'user', content: 'hi' }], {
      tools: [tool],
      toolChoice: { name: 'get_weather' },
    })
    expect(forced.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } })
  })

  it('serializes assistant tool_calls and a tool result message', () => {
    const body = buildChatBody(CTX, [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
      },
      { role: 'tool', content: '21C', toolCallId: 'call_1' },
    ])
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[1]!.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      },
    ])
    expect(messages[2]).toEqual({ role: 'tool', content: '21C', tool_call_id: 'call_1' })
  })

  it('builds an embed body', () => {
    expect(buildEmbedBody(CTX, ['a', 'b'], { dimensions: 256 })).toEqual({
      model: 'gpt-4o-mini',
      input: ['a', 'b'],
      dimensions: 256,
    })
  })

  it('builds a tts body', () => {
    expect(buildTtsBody(CTX, 'hello', { voice: 'alloy', format: 'mp3' })).toEqual({
      model: 'gpt-4o-mini',
      input: 'hello',
      voice: 'alloy',
      response_format: 'mp3',
    })
  })

  it('omits response_format when unset and emits each variant when set', () => {
    const base = buildChatBody(CTX, [{ role: 'user', content: 'hi' }])
    expect('response_format' in base).toBe(false)

    const text = buildChatBody(CTX, [{ role: 'user', content: 'hi' }], {
      responseFormat: { type: 'text' },
    })
    expect(text.response_format).toEqual({ type: 'text' })

    const jsonObject = buildChatBody(CTX, [{ role: 'user', content: 'hi' }], {
      responseFormat: { type: 'json_object' },
    })
    expect(jsonObject.response_format).toEqual({ type: 'json_object' })

    const jsonSchema = buildChatBody(CTX, [{ role: 'user', content: 'hi' }], {
      responseFormat: {
        type: 'json_schema',
        jsonSchema: { name: 'weather', schema: { type: 'object' }, strict: true },
      },
    })
    expect(jsonSchema.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'weather', schema: { type: 'object' }, strict: true },
    })
  })

  it('builds an stt multipart form', () => {
    const form = buildSttForm(CTX, new Uint8Array([1, 2, 3]), {
      filename: 'clip.wav',
      language: 'en',
    })
    expect(form.get('model')).toBe('gpt-4o-mini')
    expect(form.get('language')).toBe('en')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })
})

describe('@ozaco/ai — parsers', () => {
  it('parses a chat response', () => {
    const result = parseChatResponse(
      {
        model: 'gpt-4o-mini',
        choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
      'fallback',
    )
    expect(result.text).toBe('hello')
    expect(result.message.role).toBe('assistant')
    expect(result.finishReason).toBe('stop')
    expect(result.usage?.totalTokens).toBe(5)
  })

  it('parses embedding vectors', () => {
    expect(parseEmbedResponse({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3] }] })).toEqual(
      [[0.1, 0.2], [0.3]],
    )
  })

  it('parses chat stream chunks and the [DONE] sentinel', () => {
    expect(parseChatChunk('{"choices":[{"delta":{"content":"He"}}]}')).toEqual({ delta: 'He' })
    expect(parseChatChunk('[DONE]')).toBeUndefined()
    expect(parseChatChunk('{"choices":[{"delta":{}}]}')).toEqual({ delta: '' })
  })

  it('parses a chat chunk finish_reason and tool-call deltas', () => {
    expect(
      parseChatChunk(
        String.raw`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\"ci"}}]},"finish_reason":null}]}`,
      ),
    ).toEqual({
      delta: '',
      toolCalls: [{ index: 0, id: 'call_1', name: 'get_weather', arguments: '{"ci' }],
    })
    expect(
      parseChatChunk(
        String.raw`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\":\"P"}}]}}]}`,
      ),
    ).toEqual({ delta: '', toolCalls: [{ index: 0, arguments: 'ty":"P' }] })
  })

  it('parses a final usage chunk', () => {
    expect(
      parseChatChunk(
        '{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      ),
    ).toEqual({
      delta: '',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    })
  })

  it('parses transcript deltas, ignores non-delta events, and the [DONE] sentinel', () => {
    expect(parseTranscriptDelta('{"type":"transcript.text.delta","delta":"He"}')).toBe('He')
    expect(parseTranscriptDelta('{"type":"transcript.text.done","text":"Hello"}')).toBe('')
    expect(parseTranscriptDelta('[DONE]')).toBeUndefined()
  })

  it('parses tool_calls out of a chat response', () => {
    const result = parseChatResponse(
      {
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'fallback',
    )
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ])
    expect(result.message.toolCalls?.[0]?.name).toBe('get_weather')
  })

  it('leaves toolCalls undefined when the response has none', () => {
    const result = parseChatResponse(
      { choices: [{ message: { role: 'assistant', content: 'hi' } }] },
      'fallback',
    )
    expect(result.toolCalls).toBeUndefined()
  })

  it('maps statuses to error tags', () => {
    expect(statusTag(401)).toBe(AiErrors.Auth)
    expect(statusTag(429)).toBe(AiErrors.RateLimit)
    expect(statusTag(500)).toBe(AiErrors.Request)
  })

  it('joins urls tolerating slashes', () => {
    expect(joinUrl('https://x/v1/', '/chat/completions')).toBe('https://x/v1/chat/completions')
  })
})

describe('@ozaco/ai — OpenAICompatible (mocked fetch)', () => {
  it('chat posts to /chat/completions with auth and returns the assistant text', async () => {
    const { impl, calls } = stubFetch(() =>
      Response.json({
        model: 'gpt-4o-mini',
        choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      }),
    )

    const result = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x', baseURL: 'https://api.test/v1' })
        return yield* AI.actions.chat([{ role: 'user', content: 'ping' }])
      })
    })

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value.text).toBe('pong')
    }

    const call = calls[0]!
    const init = call.init!
    expect(String(call.input)).toBe('https://api.test/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-x')
    expect(JSON.parse(init.body as string).messages[0].content).toBe('ping')
  })

  it('embed returns vectors', async () => {
    const { impl } = stubFetch(() => Response.json({ data: [{ embedding: [1, 2, 3] }] }))

    const result = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x' })
        return yield* AI.actions.embed('hi')
      })
    })

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual([[1, 2, 3]])
    }
  })

  it('maps a 429 to a rate-limit failure', async () => {
    const { impl } = stubFetch(() => new Response('slow down', { status: 429 }))

    const result = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x' })
        return yield* AI.actions.chat([{ role: 'user', content: 'ping' }])
      })
    })

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(result.error).toBe(AiErrors.RateLimit)
    }
  })

  it('decodes a structured error body via the codec and surfaces error.message', async () => {
    const { impl } = stubFetch(
      () =>
        new Response('{"error":{"message":"bad input","type":"invalid_request_error"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const result = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(JsonCodec)
        yield* install(OpenAICompatible, { apiKey: 'sk-x', baseURL: 'https://api.test/v1' })
        return yield* AI.actions.chat([{ role: 'user', content: 'ping' }])
      })
    })

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(result.error).toBe(AiErrors.Request)
      expect(result.message).toContain('bad input')
      expect(result.message).toContain('400')
    }
  })

  it('refines the tag from a structured insufficient_quota error to rate-limit', async () => {
    const { impl } = stubFetch(
      () =>
        new Response('{"error":{"message":"quota exceeded","type":"insufficient_quota"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const result = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(JsonCodec)
        yield* install(OpenAICompatible, { apiKey: 'sk-x' })
        return yield* AI.actions.chat([{ role: 'user', content: 'ping' }])
      })
    })

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(result.error).toBe(AiErrors.RateLimit)
      expect(result.message).toContain('quota exceeded')
    }
  })

  it('falls back to the body text when the error body is not codec-decodable', async () => {
    const { impl } = stubFetch(
      () =>
        new Response('upstream exploded', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
    )

    const result = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(JsonCodec)
        yield* install(OpenAICompatible, { apiKey: 'sk-x' })
        return yield* AI.actions.chat([{ role: 'user', content: 'ping' }])
      })
    })

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(result.error).toBe(AiErrors.Request)
      expect(result.message).toContain('upstream exploded')
    }
  })

  it('chatStream yields rich chunks (delta + finish + final usage) and requests include_usage', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
      'data: [DONE]\n\n'
    const { impl, calls } = stubFetch(
      () =>
        new Response(new Blob([sse]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )

    const result = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x' })
        const stream = yield* AI.actions.chatStream([{ role: 'user', content: 'hi' }])
        const chunks: AiDef.ChatStreamChunk[] = []
        for (const chunk of yield* each(stream)) {
          chunks.push(chunk)
          yield* each.next()
        }
        return chunks
      })
    })

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      const chunks = result.value
      expect(chunks.map(c => c.delta).join('')).toBe('Hello')
      expect(chunks.some(c => c.finishReason === 'stop')).toBe(true)
      const last = chunks.at(-1)!
      expect(last.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 })
    }

    // the streaming body asks the provider for the final usage chunk
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('chatStream surfaces tool-call deltas (partial argument fragments) per chunk', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Paris\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n'
    const { impl } = stubFetch(
      () =>
        new Response(new Blob([sse]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )

    const result = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x' })
        const stream = yield* AI.actions.chatStream([{ role: 'user', content: 'weather?' }], {
          tools: [{ type: 'function', function: { name: 'get_weather' } }],
        })
        const chunks: AiDef.ChatStreamChunk[] = []
        for (const chunk of yield* each(stream)) {
          chunks.push(chunk)
          yield* each.next()
        }
        return chunks
      })
    })

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      const chunks = result.value
      // the consumer accumulates partial `arguments` fragments sharing the same `index`
      const args = chunks
        .flatMap(c => c.toolCalls ?? [])
        .filter(tc => tc.index === 0)
        .map(tc => tc.arguments ?? '')
        .join('')
      expect(args).toBe('{"city":"Paris"}')
      expect(chunks.flatMap(c => c.toolCalls ?? []).find(tc => tc.name)?.name).toBe('get_weather')
      expect(chunks.some(c => c.finishReason === 'tool_calls')).toBe(true)
    }
  })

  it('halting a chatStream aborts the underlying request (barge-in)', async () => {
    let captured: AbortSignal | undefined
    let aborted = false

    // an SSE body that emits one chunk then stalls open forever
    const impl: FetchDef.Impl = (_input, init) => {
      captured = init?.signal ?? undefined
      captured?.addEventListener('abort', () => {
        aborted = true
      })
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'),
          )
          // never close → the connection stays open until aborted
        },
      })
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      )
    }

    const task = run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x' })
        const stream = yield* AI.actions.chatStream([{ role: 'user', content: 'hi' }])
        for (const _chunk of yield* each(stream)) {
          // hold the consuming scope open after reading a chunk; halt arrives from outside
          yield* sleep(1_000_000)
          yield* each.next()
        }
      })
    })

    await sleep(20)
    expect(captured).toBeDefined()
    expect(captured!.aborted).toBe(false)
    expect(aborted).toBe(false)

    await task.halt()
    await sleep(5)

    expect(captured!.aborted).toBe(true)
    expect(aborted).toBe(true)
  })

  it('ttsStream yields the audio as a byte stream', async () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5, 6])
    const { impl, calls } = stubFetch(
      () =>
        new Response(new Blob([audio]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    )

    const out = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x', baseURL: 'https://api.test/v1' })
        const stream = yield* AI.actions.ttsStream('hello', { voice: 'alloy', format: 'mp3' })
        const chunks: Uint8Array[] = []
        for (const chunk of yield* each(stream)) {
          chunks.push(chunk)
          yield* each.next()
        }
        return chunks
      })
    })

    expect(isSuccess(out)).toBe(true)
    if (isSuccess(out)) {
      const joined = Uint8Array.from(out.value.flatMap(chunk => Array.from(chunk)))
      expect(Array.from(joined)).toEqual(Array.from(audio))
    }
    expect(String(calls[0]!.input)).toBe('https://api.test/v1/audio/speech')
  })

  it('sttStream parses SSE transcript deltas and sets stream in the form', async () => {
    const sse =
      'data: {"type":"transcript.text.delta","delta":"He"}\n\n' +
      'data: {"type":"transcript.text.delta","delta":"llo"}\n\n' +
      'data: {"type":"transcript.text.done","text":"Hello"}\n\n' +
      'data: [DONE]\n\n'
    const { impl, calls } = stubFetch(
      () =>
        new Response(new Blob([sse]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )

    const out = await run(function* () {
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x', baseURL: 'https://api.test/v1' })
        const stream = yield* AI.actions.sttStream(new Uint8Array([9, 9, 9]), {
          model: 'whisper-1',
        })
        const parts: string[] = []
        for (const part of yield* each(stream)) {
          parts.push(part)
          yield* each.next()
        }
        return parts
      })
    })

    expect(isSuccess(out)).toBe(true)
    if (isSuccess(out)) {
      expect(out.value.join('')).toBe('Hello')
    }
    expect(String(calls[0]!.input)).toBe('https://api.test/v1/audio/transcriptions')
    const form = calls[0]!.init!.body as FormData
    expect(form.get('stream')).toBe('true')
  })

  it('chat with tools sends tools/tool_choice and parses tool_calls; a tool reply serializes', async () => {
    const tool: AiDef.Tool = {
      type: 'function',
      function: { name: 'get_weather', parameters: { type: 'object' } },
    }

    const first = await run(function* () {
      const { impl, calls } = stubFetch(() =>
        Response.json({
          model: 'gpt-4o',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      )
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x', baseURL: 'https://api.test/v1' })
        const result = yield* AI.actions.chat([{ role: 'user', content: 'weather in Paris?' }], {
          tools: [tool],
          toolChoice: 'auto',
        })
        return { result, body: JSON.parse(calls[0]!.init!.body as string) }
      })
    })

    expect(isSuccess(first)).toBe(true)
    if (isSuccess(first)) {
      expect(first.value.body.tools).toEqual([tool])
      expect(first.value.body.tool_choice).toBe('auto')
      expect(first.value.result.toolCalls).toEqual([
        { id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      ])
    }

    const second = await run(function* () {
      const { impl, calls } = stubFetch(() =>
        Response.json({
          model: 'gpt-4o',
          choices: [
            { message: { role: 'assistant', content: 'It is sunny.' }, finish_reason: 'stop' },
          ],
        }),
      )
      return yield* fetchImpl.with(impl, function* () {
        yield* install(OpenAICompatible, { apiKey: 'sk-x', baseURL: 'https://api.test/v1' })
        const result = yield* AI.actions.chat([
          { role: 'user', content: 'weather in Paris?' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
          },
          { role: 'tool', content: '{"tempC":21}', toolCallId: 'call_1' },
        ])
        return { result, body: JSON.parse(calls[0]!.init!.body as string) }
      })
    })

    expect(isSuccess(second)).toBe(true)
    if (isSuccess(second)) {
      const messages = second.value.body.messages as Record<string, unknown>[]
      expect(messages[2]).toEqual({ role: 'tool', content: '{"tempC":21}', tool_call_id: 'call_1' })
      expect(second.value.result.text).toBe('It is sunny.')
    }
  })

  it('rejects an empty apiKey at install time', async () => {
    const result = await run(function* () {
      return yield* install(OpenAICompatible, { apiKey: '' })
    })
    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(result.error).toBe(AiErrors.Auth)
    }
  })
})
