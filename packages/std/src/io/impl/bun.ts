import { operation, until } from 'std:effect'
import type { WalkEntry } from 'std:io'
import { IO, IO_TAGS, toPath } from 'std:io'

import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { mapStat, walkRecursive } from './node-shared'
import { fromReadable } from './stream'

export const BunIO = IO.implement({
  name: 'bun-io',
  version: '0.0.1',
  *setup() {},
}).build({
  fromReadable,

  read: operation(function* (path) {
    const p = toPath(path)
    const buf = yield* until(Bun.file(p).arrayBuffer())
    return new Uint8Array(buf)
  }, IO_TAGS.read),

  readText: operation(function* (path, encoding) {
    const p = toPath(path)
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case
    if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
      const buf = yield* until(Bun.file(p).arrayBuffer())
      const decoder = new TextDecoder(encoding)
      return decoder.decode(buf)
    }
    return yield* until(Bun.file(p).text())
  }, IO_TAGS.readText),

  write: operation(function* (path, data) {
    yield* until(Bun.write(toPath(path), data))
  }, IO_TAGS.write),

  append: operation(function* (path, data) {
    yield* until(fs.appendFile(toPath(path), data))
  }, IO_TAGS.append),

  copy: operation(function* (src, dest) {
    yield* until(Bun.write(toPath(dest), Bun.file(toPath(src))))
  }, IO_TAGS.copy),

  rename: operation(function* (src, dest) {
    yield* until(fs.rename(toPath(src), toPath(dest)))
  }, IO_TAGS.rename),

  rm: operation(function* (path, options) {
    yield* until(fs.rm(toPath(path), options))
  }, IO_TAGS.rm),

  exists: operation(function* (path) {
    return yield* until(Bun.file(toPath(path)).exists())
  }, IO_TAGS.exists),

  stat: operation(function* (path) {
    const s = yield* until(fs.stat(toPath(path)))
    return mapStat(s)
  }, IO_TAGS.stat),

  lstat: operation(function* (path) {
    const s = yield* until(fs.lstat(toPath(path)))
    return mapStat(s)
  }, IO_TAGS.lstat),

  readdir: operation(function* (path) {
    return yield* until(fs.readdir(toPath(path)))
  }, IO_TAGS.readdir),

  ensureDir: operation(function* (path) {
    yield* until(fs.mkdir(toPath(path), { recursive: true }))
  }, IO_TAGS.enureDir),

  ensureFile: operation(function* (path) {
    const p = toPath(path)
    const dir = dirname(p)
    yield* until(fs.mkdir(dir, { recursive: true }))
    const fileExists = yield* until(Bun.file(p).exists())
    if (!fileExists) {
      yield* until(Bun.write(p, ''))
    }
  }, IO_TAGS.enureFile),

  emptyDir: operation(function* (path) {
    const p = toPath(path)
    yield* until(fs.mkdir(p, { recursive: true }))
    const entries = yield* until(fs.readdir(p))
    for (const entry of entries) {
      yield* until(fs.rm(join(p, entry), { recursive: true, force: true }))
    }
  }, IO_TAGS.emptyDir),

  walk: operation(function* (root, options) {
    const p = toPath(root)
    const results: WalkEntry[] = []
    yield* walkRecursive(
      p,
      {
        maxDepth: options?.maxDepth ?? Number.POSITIVE_INFINITY,
        includeFiles: options?.includeFiles ?? true,
        includeDirs: options?.includeDirs ?? true,
        followSymlinks: options?.followSymlinks ?? false,
        match: options?.match,
        skip: options?.skip,
      },
      0,
      results,
    )
    return results
  }, IO_TAGS.walk),
})
