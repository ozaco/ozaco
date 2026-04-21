import { operation, until } from 'std:effect'
import type { WalkEntry } from 'std:io'
import { hasFlag, IO, IO_FLAGS, toPath } from 'std:io'

import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { mapStat, walkRecursive } from '../internal/node-shared'
import { fromReadable, readFileStream, writeFileStream } from '../internal/stream'

export const BunIO = IO.implement({
  name: 'bun-io',
  version: '0.0.1',
  *setup() {},
}).build({
  fromReadable,
  readStream: path => readFileStream(toPath(path)),
  writeStream: (path, source, options) => writeFileStream(toPath(path), source, options?.flags),

  read: operation(function* (path) {
    const p = toPath(path)
    const buf = yield* until(Bun.file(p).arrayBuffer())
    return new Uint8Array(buf)
  }),

  readText: operation(function* (path, encoding) {
    const p = toPath(path)
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case
    if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
      const buf = yield* until(Bun.file(p).arrayBuffer())
      const decoder = new TextDecoder(encoding)
      return decoder.decode(buf)
    }
    return yield* until(Bun.file(p).text())
  }),

  write: operation(function* (path, data, options) {
    const flags = options?.flags

    if (!flags) {
      yield* until(Bun.write(toPath(path), data))
      return
    }
    const flag = hasFlag(flags, IO_FLAGS.APPEND)
      ? hasFlag(flags, IO_FLAGS.EXCLUSIVE)
        ? 'ax'
        : 'a'
      : hasFlag(flags, IO_FLAGS.EXCLUSIVE)
        ? 'wx'
        : 'w'
    yield* until(fs.writeFile(toPath(path), data, { flag }))
  }),

  append: operation(function* (path, data) {
    yield* until(fs.appendFile(toPath(path), data))
  }),

  copy: operation(function* (src, dest, options) {
    // oxlint-disable-next-line unicorn/prefer-ternary
    if (hasFlag(options?.flags ?? IO_FLAGS.NONE, IO_FLAGS.EXCLUSIVE)) {
      yield* until(fs.copyFile(toPath(src), toPath(dest), 1))
    } else {
      yield* until(Bun.write(toPath(dest), Bun.file(toPath(src))))
    }
  }),

  rename: operation(function* (src, dest, options) {
    if (hasFlag(options?.flags ?? IO_FLAGS.NONE, IO_FLAGS.EXCLUSIVE)) {
      const destExists = yield* until(Bun.file(toPath(dest)).exists())
      if (destExists) {
        throw new Error('destination already exists')
      }
    }
    yield* until(fs.rename(toPath(src), toPath(dest)))
  }),

  rm: operation(function* (path, options) {
    yield* until(fs.rm(toPath(path), options))
  }),

  exists: operation(function* (path) {
    return yield* until(Bun.file(toPath(path)).exists())
  }),

  stat: operation(function* (path) {
    const s = yield* until(fs.stat(toPath(path)))
    return mapStat(s)
  }),

  lstat: operation(function* (path) {
    const s = yield* until(fs.lstat(toPath(path)))
    return mapStat(s)
  }),

  readdir: operation(function* (path, options) {
    return yield* until(fs.readdir(toPath(path), options))
  }),

  ensureDir: operation(function* (path) {
    yield* until(fs.mkdir(toPath(path), { recursive: true }))
  }),

  ensureFile: operation(function* (path) {
    const p = toPath(path)
    const dir = dirname(p)
    yield* until(fs.mkdir(dir, { recursive: true }))
    const fileExists = yield* until(Bun.file(p).exists())
    if (!fileExists) {
      yield* until(Bun.write(p, ''))
    }
  }),

  emptyDir: operation(function* (path) {
    const p = toPath(path)
    yield* until(fs.mkdir(p, { recursive: true }))
    const entries = yield* until(fs.readdir(p))
    for (const entry of entries) {
      yield* until(fs.rm(join(p, entry), { recursive: true, force: true }))
    }
  }),

  walk: operation(function* (root, options) {
    const p = toPath(root)
    const results: WalkEntry[] = []
    yield* walkRecursive(
      p,
      {
        flags: options?.flags ?? IO_FLAGS.FILES | IO_FLAGS.DIRS,
        maxDepth: options?.maxDepth ?? Number.POSITIVE_INFINITY,
        match: options?.match,
        skip: options?.skip,
      },
      0,
      results,
    )
    return results
  }),
})
