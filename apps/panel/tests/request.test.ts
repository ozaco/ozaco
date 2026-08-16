import { describe, expect, test } from 'bun:test'

import { buildRequest, classifyContentType, fillPath } from '../src/lib/request'
import { addFiles } from '../src/lib/upload'

describe('fillPath', () => {
  test('fills :params and reports the consumed names', () => {
    const { path, used } = fillPath('/todos/:id/notes/:noteId', { id: 'a b', noteId: 7, x: 1 })

    expect(path).toBe('/todos/a%20b/notes/7')
    expect([...used]).toEqual(['id', 'noteId'])
  })

  test('missing params fill as empty segments', () => {
    expect(fillPath('/todos/:id', {}).path).toBe('/todos/')
  })
})

describe('buildRequest', () => {
  test('GET: leftover args become the query string, objects JSON-encoded', () => {
    const built = buildRequest(
      { method: 'GET', path: '/todos/:id' },
      { args: { id: '42', filter: { done: true }, q: 'text' }, base: 'http://api' },
    )

    expect(built.method).toBe('GET')
    expect(built.bodyKind).toBe('none')
    expect(built.body).toBeUndefined()
    expect(built.url).toBe('http://api/todos/42?filter=%7B%22done%22%3Atrue%7D&q=text')
  })

  test('POST: leftover args become a JSON body, path params never leak into it', () => {
    const built = buildRequest(
      { method: 'POST', path: '/todos/:id' },
      { args: { id: 'x', title: 'hi' }, token: 'tok' },
    )

    expect(built.url).toBe('/todos/x')
    expect(built.bodyKind).toBe('json')
    expect(built.headers['content-type']).toBe('application/json')
    expect(built.headers['authorization']).toBe('Bearer tok')
    expect(JSON.parse(built.body as string)).toEqual({ title: 'hi' })
  })

  test('empty token adds no authorization header', () => {
    const built = buildRequest({ method: 'GET', path: '/x' }, { args: {}, token: '' })

    expect(built.headers['authorization']).toBeUndefined()
  })

  test('files ALWAYS switch to multipart with fields first, then files in order', () => {
    const alpha = new File(['aaa'], 'alpha.txt', { type: 'text/plain' })
    const beta = new File(['bb'], 'beta.bin', { type: 'application/octet-stream' })
    const files = addFiles(addFiles([], [alpha], 'upload'), [beta], 'extra')

    const built = buildRequest(
      { method: 'POST', path: '/files/:bucket' },
      { args: { bucket: 'docs', label: 'test', meta: { k: 1 } }, files },
    )

    expect(built.url).toBe('/files/docs')
    expect(built.bodyKind).toBe('multipart')
    expect(built.headers['content-type']).toBeUndefined()

    const entries = [...(built.body as FormData).entries()]

    // fields FIRST (the edge merges leading fields into params), files after, order preserved
    expect(entries.map(([name]) => name)).toEqual(['label', 'meta', 'upload', 'extra'])
    expect(entries[0]?.[1]).toBe('test')
    expect(entries[1]?.[1]).toBe('{"k":1}')

    const third = entries[2]?.[1] as unknown as File
    const fourth = entries[3]?.[1] as unknown as File

    expect(third.name).toBe('alpha.txt')
    expect(fourth.name).toBe('beta.bin')
  })

  test('files force multipart even on GET routes', () => {
    const file = new File(['x'], 'x.txt')
    const built = buildRequest(
      { method: 'GET', path: '/x' },
      { args: { q: '1' }, files: addFiles([], [file]) },
    )

    expect(built.bodyKind).toBe('multipart')
    expect([...(built.body as FormData).keys()]).toEqual(['q', 'file'])
  })
})

describe('classifyContentType', () => {
  test('classifies the edge content types', () => {
    expect(classifyContentType('application/json')).toBe('json')
    expect(classifyContentType('application/json; charset=utf-8')).toBe('json')
    expect(classifyContentType('application/x-ndjson')).toBe('ndjson')
    expect(classifyContentType('text/event-stream')).toBe('sse')
    expect(classifyContentType('application/octet-stream')).toBe('bytes')
    expect(classifyContentType('text/html; charset=utf-8')).toBe('text')
    expect(classifyContentType('image/png')).toBe('bytes')
    expect(classifyContentType(null)).toBe('bytes')
  })
})
