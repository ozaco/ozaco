import { operation, until } from 'std:effect'
import type { WalkEntry } from 'std:io'
import { IO, IO_FLAGS, toPath } from 'std:io'
import { fail } from 'std:result'
import { hasFlag } from 'std:shared'

import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  decryptSecret,
  encryptSecret,
  generateSignKeyPair,
  signData,
  verifyData,
} from '../internal/crypto'
import { readEnv } from '../internal/env'
import { fromReadable } from '../internal/from-readable'
import { tcpConnect, tcpListen, udpBind } from '../internal/net'
import { mapStat, walkRecursive } from '../internal/node-shared'
import { nodePath } from '../internal/path-node'
import { bunExec, bunSpawn } from '../internal/process-bun'
import { readFileStream, writeFileStream } from '../internal/stream'
import { readInterfaces, readTmpDir } from '../internal/sys'
import { toReadable } from '../internal/to-readable'
import { ulidId } from '../internal/ulid'
import { uuidId } from '../internal/uuid'
import { watchPath } from '../internal/watch'
import { webHash, webHmac, webRandomBytes } from '../internal/webcrypto'

export const BunIO = IO.implement({
  name: 'bun-io',
  version: '0.0.1',
  *setup() {
    return null
  },
}).build({
  env: readEnv,

  randomBytes: webRandomBytes,
  ulid: ulidId,
  uuid: uuidId,
  hmac: webHmac,
  hash: webHash,
  encrypt: encryptSecret,
  decrypt: decryptSecret,
  generateKeyPair: generateSignKeyPair,
  sign: signData,
  verify: verifyData,

  fromReadable,
  toReadable,
  readStream: path => readFileStream(toPath(path)),
  watch: (path, options) => watchPath(toPath(path), options),
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
        return yield* fail('exists', `destination already exists: ${toPath(dest)}`)
      }
    }
    yield* until(fs.rename(toPath(src), toPath(dest)))
  }),

  rm: operation(function* (path, options) {
    yield* until(fs.rm(toPath(path), options))
  }),

  exists: operation(function* (path) {
    // `Bun.file(dir).exists()` reports `false` for directories — use `fs.access` (matches NodeIO) so
    // `exists` answers "path exists" for files and directories alike.
    try {
      yield* until(fs.access(toPath(path)))
      return true
    } catch {
      return false
    }
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

  join: nodePath.join,
  dirname: nodePath.dirname,
  basename: nodePath.basename,
  extname: nodePath.extname,
  isAbsolute: nodePath.isAbsolute,

  chmod: operation(function* (path, mode) {
    yield* until(fs.chmod(toPath(path), mode))
  }),
  symlink: operation(function* (target, path, type) {
    yield* until(fs.symlink(toPath(target), toPath(path), type))
  }),
  readlink: operation(function* (path) {
    return yield* until(fs.readlink(toPath(path)))
  }),

  exec: bunExec,
  spawn: bunSpawn,

  tcpListen,
  tcpConnect,
  udpBind,
  ip: readInterfaces,
  tmpdir: readTmpDir,
})
