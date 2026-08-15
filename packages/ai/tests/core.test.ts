import { accumulateToolCalls, normalizeMessage, normalizeMessages, textOf } from 'ai:core'

import { describe, expect, it } from 'bun:test'

describe('accumulateToolCalls', () => {
  it('stitches fragments by index: first non-empty id/name wins, arguments concatenate', () => {
    const calls = accumulateToolCalls()
    calls.add([{ index: 0, id: 'call-1', name: 'lookup', arguments: '{"q":' }])
    calls.add([{ index: 0, arguments: '"x"' }])
    calls.add(undefined)
    calls.add([{ index: 0, id: 'ignored-later-id', arguments: '}' }])
    expect(calls.collect()).toEqual([{ id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' }])
  })

  it('keeps parallel calls separate and orders them by stream index', () => {
    const calls = accumulateToolCalls()
    calls.add([{ index: 1, id: 'b', name: 'second', arguments: '{}' }])
    calls.add([{ index: 0, id: 'a', name: 'first' }])
    calls.add([{ index: 0, arguments: '{"ok":true}' }])
    expect(calls.collect()).toEqual([
      { id: 'a', name: 'first', arguments: '{"ok":true}' },
      { id: 'b', name: 'second', arguments: '{}' },
    ])
  })
})

describe('message normalization', () => {
  it('a bare string becomes a user text message', () => {
    expect(normalizeMessages('hello')).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'hello' }] },
    ])
  })

  it('content sugar becomes parts; normalized messages pass through untouched', () => {
    const sugared = normalizeMessage({ role: 'system', content: 'be brief' })
    expect(sugared.role).toBe('system')
    expect(sugared.parts).toEqual([{ kind: 'text', text: 'be brief' }])

    const full = {
      role: 'assistant' as const,
      parts: [{ kind: 'text' as const, text: 'done' }],
      toolCalls: [{ id: '1', name: 'x', arguments: '{}' }],
    }
    expect(normalizeMessage(full)).toBe(full)

    const toolResult = normalizeMessage({
      role: 'tool',
      content: 'result',
      name: 'x',
      toolCallId: '1',
    })
    expect(toolResult.toolCallId).toBe('1')
    expect(toolResult.name).toBe('x')
  })

  it('textOf flattens the text parts', () => {
    expect(
      textOf({
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'a' },
          { kind: 'text', text: 'b' },
        ],
      }),
    ).toBe('ab')
    expect(textOf({ role: 'assistant', parts: [] })).toBe('')
  })
})
