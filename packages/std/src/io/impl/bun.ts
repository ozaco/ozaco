import { operation, until } from 'std:effect'
import type { WalkEntry } from 'std:io'
import { IO, toPath } from 'std:io'

import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { mapStat, walkRecursive } from './node-shared'

export const BunIO = IO.implement({
  name: 'bun-io',
  version: '0.0.1',
  *setup() {},
}).build({
  read: operation(function* (path) {
    const p = toPath(path)
    const buf = yield* until(Bun.file(p).arrayBuffer())
    return new Uint8Array(buf)
  }, 'io:read'),

  readText: operation(function* (path, encoding) {
    const p = toPath(path)
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case
    if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
      const buf = yield* until(Bun.file(p).arrayBuffer())
      const decoder = new TextDecoder(encoding)
      return decoder.decode(buf)
    }
    return yield* until(Bun.file(p).text())
  }, 'io:read'),

  write: operation(function* (path, data) {
    yield* until(Bun.write(toPath(path), data))
  }, 'io:write'),

  writeText: operation(function* (path, content) {
    yield* until(Bun.write(toPath(path), content))
  }, 'io:write'),

  append: operation(function* (path, data) {
    yield* until(fs.appendFile(toPath(path), data))
  }, 'io:write'),

  appendText: operation(function* (path, content) {
    yield* until(fs.appendFile(toPath(path), content))
  }, 'io:write'),

  copy: operation(function* (src, dest) {
    yield* until(Bun.write(toPath(dest), Bun.file(toPath(src))))
  }, 'io:copy'),

  rename: operation(function* (src, dest) {
    yield* until(fs.rename(toPath(src), toPath(dest)))
  }, 'io:rename'),

  rm: operation(function* (path, options) {
    yield* until(fs.rm(toPath(path), options))
  }, 'io:rm'),

  exists: operation(function* (path) {
    return yield* until(Bun.file(toPath(path)).exists())
  }, 'io:exists'),

  stat: operation(function* (path) {
    const s = yield* until(fs.stat(toPath(path)))
    return mapStat(s)
  }, 'io:stat'),

  lstat: operation(function* (path) {
    const s = yield* until(fs.lstat(toPath(path)))
    return mapStat(s)
  }, 'io:stat'),

  readdir: operation(function* (path) {
    return yield* until(fs.readdir(toPath(path)))
  }, 'io:dir'),

  ensureDir: operation(function* (path) {
    yield* until(fs.mkdir(toPath(path), { recursive: true }))
  }, 'io:dir'),

  ensureFile: operation(function* (path) {
    const p = toPath(path)
    const dir = dirname(p)
    yield* until(fs.mkdir(dir, { recursive: true }))
    const fileExists = yield* until(Bun.file(p).exists())
    if (!fileExists) {
      yield* until(Bun.write(p, ''))
    }
  }, 'io:dir'),

  emptyDir: operation(function* (path) {
    const p = toPath(path)
    yield* until(fs.mkdir(p, { recursive: true }))
    const entries = yield* until(fs.readdir(p))
    for (const entry of entries) {
      yield* until(fs.rm(join(p, entry), { recursive: true, force: true }))
    }
  }, 'io:dir'),

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
  }, 'io:walk'),
})
