import { describe, expect, test } from 'bun:test'

import {
  addFiles,
  formatBytes,
  moveFile,
  removeFile,
  renameField,
  totalSize,
} from '../src/lib/upload'

const file = (name: string, size: number): File =>
  new File([new Uint8Array(size)], name, { type: 'application/octet-stream' })

describe('upload list helpers', () => {
  test('addFiles appends with unique ids and the given field name', () => {
    const list = addFiles(addFiles([], [file('a.txt', 1)], 'upload'), [file('b.txt', 2)])

    expect(list).toHaveLength(2)
    expect(list[0]?.field).toBe('upload')
    expect(list[1]?.field).toBe('file')
    expect(new Set(list.map(entry => entry.id)).size).toBe(2)
  })

  test('removeFile drops by id and leaves the rest untouched', () => {
    const list = addFiles([], [file('a.txt', 1), file('b.txt', 2)])
    const next = removeFile(list, list[0]!.id)

    expect(next).toHaveLength(1)
    expect(next[0]?.file.name).toBe('b.txt')
  })

  test('moveFile reorders within bounds and no-ops at the edges', () => {
    const list = addFiles([], [file('a', 1), file('b', 1), file('c', 1)])
    const down = moveFile(list, list[0]!.id, 1)

    expect(down.map(entry => entry.file.name)).toEqual(['b', 'a', 'c'])

    const clampedTop = moveFile(list, list[0]!.id, -1)

    expect(clampedTop.map(entry => entry.file.name)).toEqual(['a', 'b', 'c'])

    const missing = moveFile(list, 'nope', 1)

    expect(missing.map(entry => entry.file.name)).toEqual(['a', 'b', 'c'])
  })

  test('renameField updates only the target entry', () => {
    const list = addFiles([], [file('a', 1), file('b', 1)])
    const next = renameField(list, list[1]!.id, 'attachment')

    expect(next[0]?.field).toBe('file')
    expect(next[1]?.field).toBe('attachment')
  })

  test('totalSize sums file sizes', () => {
    const list = addFiles([], [file('a', 10), file('b', 32)])

    expect(totalSize(list)).toBe(42)
  })
})

describe('formatBytes', () => {
  test('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB')
    expect(formatBytes(5.25 * 1024 * 1024 * 1024)).toBe('5.3 GB')
    expect(formatBytes(-1)).toBe('0 B')
  })
})
