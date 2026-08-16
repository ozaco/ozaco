import { describe, expect, test } from 'bun:test'

import { createSseParser } from '../src/lib/sse'

const ENCODER = new TextEncoder()

const collect = () => {
  const events: string[] = []
  const comments: string[] = []
  const parser = createSseParser({
    onData: data => events.push(data),
    onComment: comment => comments.push(comment),
  })

  return { events, comments, parser }
}

const feed = (parser: { push: (chunk: Uint8Array) => void }, ...chunks: string[]) => {
  for (const chunk of chunks) {
    parser.push(ENCODER.encode(chunk))
  }
}

describe('createSseParser', () => {
  test('parses the edge contract: comment opener then data frames', () => {
    const { events, comments, parser } = collect()

    feed(parser, ': ok\n\ndata: {"type":"sync","id":"w1"}\n\n')

    expect(comments).toEqual(['ok'])
    expect(events).toEqual(['{"type":"sync","id":"w1"}'])
  })

  test('handles chunks split at arbitrary byte boundaries', () => {
    const { events, parser } = collect()

    feed(parser, 'data: {"a"', ':1}\n', '\ndata: {"b":2}', '\n\n')

    expect(events).toEqual(['{"a":1}', '{"b":2}'])
  })

  test('handles a split INSIDE the data: field token', () => {
    const { events, parser } = collect()

    feed(parser, 'da', 'ta', ': {"x":', 'true}\n\n')

    expect(events).toEqual(['{"x":true}'])
  })

  test('handles CRLF line endings and split CRLF pairs', () => {
    const { events, comments, parser } = collect()

    feed(parser, ': ok\r', '\n\r\ndata: {"y":1}\r\n', '\r\n')

    expect(comments).toEqual(['ok'])
    expect(events).toEqual(['{"y":1}'])
  })

  test('joins multiple data lines of one event with newlines', () => {
    const { events, parser } = collect()

    feed(parser, 'data: first\ndata: second\n\n')

    expect(events).toEqual(['first\nsecond'])
  })

  test('a data line with no space after the colon still parses', () => {
    const { events, parser } = collect()

    feed(parser, 'data:{"z":3}\n\n')

    expect(events).toEqual(['{"z":3}'])
  })

  test('ignores unknown fields (event/id/retry)', () => {
    const { events, parser } = collect()

    feed(parser, 'event: message\nid: 42\nretry: 1000\ndata: payload\n\n')

    expect(events).toEqual(['payload'])
  })

  test('end() flushes a final event missing its trailing blank line', () => {
    const { events, parser } = collect()

    feed(parser, 'data: tail')
    parser.end()

    expect(events).toEqual(['tail'])
  })

  test('end() without pending data dispatches nothing', () => {
    const { events, parser } = collect()

    feed(parser, ': ping\n\n')
    parser.end()

    expect(events).toEqual([])
  })

  test('one byte at a time still yields the exact payload', () => {
    const { events, parser } = collect()
    const wire = 'data: {"n":7}\n\n'

    feed(parser, ...wire.split(''))

    expect(events).toEqual(['{"n":7}'])
  })
})
