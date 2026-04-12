// oxlint-disable unicorn/text-encoding-identifier-case

import { operation, until } from 'std:effect'
import type { WalkEntry } from 'std:io'
import { IO, toPath } from 'std:io'

import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { mapStat, walkRecursive } from './node-shared'

export const NodeIO = IO.implement({
  name: 'node-io',
  version: '0.0.1',
  *setup() {},
}).build({
  read: operation(function* (path) {
    const buf = yield* until(fs.readFile(toPath(path)))
    return new Uint8Array(buf)
  }, 'io:read'),

  readText: operation(function* (path, encoding) {
    return yield* until(
      fs.readFile(toPath(path), { encoding: (encoding ?? 'utf-8') as BufferEncoding }),
    )
  }, 'io:read'),

  write: operation(function* (path, data) {
    yield* until(fs.writeFile(toPath(path), data))
  }, 'io:write'),

  writeText: operation(function* (path, content) {
    yield* until(fs.writeFile(toPath(path), content, 'utf-8'))
  }, 'io:write'),

  append: operation(function* (path, data) {
    yield* until(fs.appendFile(toPath(path), data))
  }, 'io:write'),

  appendText: operation(function* (path, content) {
    yield* until(fs.appendFile(toPath(path), content, 'utf-8'))
  }, 'io:write'),

  copy: operation(function* (src, dest) {
    yield* until(fs.copyFile(toPath(src), toPath(dest)))
  }, 'io:copy'),

  rename: operation(function* (src, dest) {
    yield* until(fs.rename(toPath(src), toPath(dest)))
  }, 'io:rename'),

  rm: operation(function* (path, options) {
    yield* until(fs.rm(toPath(path), options))
  }, 'io:rm'),

  exists: operation(function* (path) {
    try {
      yield* until(fs.access(toPath(path)))
      return true
    } catch {
      return false
    }
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
    try {
      yield* until(fs.access(p))
    } catch {
      yield* until(fs.writeFile(p, ''))
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
