// oxlint-disable unicorn/text-encoding-identifier-case

import { operation, until } from 'std:effect'
import type { S3Options, WalkEntry } from 'std:io'
import { IO, IO_FLAGS, toPath } from 'std:io'
import { fail } from 'std:result'
import { hasFlag } from 'std:shared'

import { createHash, createHmac, randomBytes as nodeRandomBytes } from 'node:crypto'
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
import { readFileFlow, writeFileFlow } from '../internal/flow'
import { fromReadable } from '../internal/from-readable'
import { hlcDecode, hlcObserve, hlcToken } from '../internal/hlc'
import { tcpConnect, tcpListen, udpBind } from '../internal/net'
import { mapStat, walkRecursive } from '../internal/node-shared'
import { nodePath } from '../internal/path-node'
import { nodeExec, nodeSpawn } from '../internal/process-node'
import { createS3 } from '../internal/s3'
import { fetchS3Client } from '../internal/s3-fetch'
import { readInterfaces, readTmpDir } from '../internal/sys'
import { toReadable } from '../internal/to-readable'
import { ulidId } from '../internal/ulid'
import { uuidId } from '../internal/uuid'
import { watchPath } from '../internal/watch'
import type { HashAlgorithm } from '../types/common'

const toNodeHash = (alg: HashAlgorithm) =>
  alg === 'SHA-256' ? 'sha256' : alg === 'SHA-384' ? 'sha384' : 'sha512'

export const NodeIO = IO.implement({
  name: 'node-io',
  version: '0.0.1',
  *setup() {
    return null
  },
}).build({
  env: readEnv,

  randomBytes: operation(function* (length) {
    return new Uint8Array(nodeRandomBytes(length))
  }),

  ulid: ulidId,
  uuid: uuidId,
  hlc: hlcToken,
  decodeHlc: hlcDecode,
  observeHlc: hlcObserve,

  hmac: operation(function* (algorithm, key, data) {
    const mac = createHmac(toNodeHash(algorithm), key).update(data).digest()
    return new Uint8Array(mac)
  }),

  hash: operation(function* (algorithm, data) {
    const digest = createHash(toNodeHash(algorithm)).update(data).digest()
    return new Uint8Array(digest)
  }),
  encrypt: encryptSecret,
  decrypt: decryptSecret,
  generateKeyPair: generateSignKeyPair,
  sign: signData,
  verify: verifyData,

  fromReadable,
  toReadable,
  readFlow: path => readFileFlow(toPath(path)),
  watch: (path, options) => watchPath(toPath(path), options),
  writeFlow: (path, source, options) => writeFileFlow(toPath(path), source, options?.flags),

  read: operation(function* (path) {
    const buf = yield* until(fs.readFile(toPath(path)))
    return new Uint8Array(buf)
  }),

  readText: operation(function* (path, encoding) {
    return yield* until(
      fs.readFile(toPath(path), { encoding: (encoding ?? 'utf-8') as BufferEncoding }),
    )
  }),

  write: operation(function* (path, data, options) {
    const f = options?.flags ?? IO_FLAGS.NONE
    const flag = hasFlag(f, IO_FLAGS.APPEND)
      ? hasFlag(f, IO_FLAGS.EXCLUSIVE)
        ? 'ax'
        : 'a'
      : hasFlag(f, IO_FLAGS.EXCLUSIVE)
        ? 'wx'
        : 'w'
    yield* until(fs.writeFile(toPath(path), data, { flag }))
  }),

  append: operation(function* (path, data) {
    yield* until(fs.appendFile(toPath(path), data))
  }),

  copy: operation(function* (src, dest, options) {
    const mode = hasFlag(options?.flags ?? IO_FLAGS.NONE, IO_FLAGS.EXCLUSIVE) ? 1 : 0
    yield* until(fs.copyFile(toPath(src), toPath(dest), mode))
  }),

  rename: operation(function* (src, dest, options) {
    if (hasFlag(options?.flags ?? IO_FLAGS.NONE, IO_FLAGS.EXCLUSIVE)) {
      let destExists = false
      try {
        yield* until(fs.access(toPath(dest)))
        destExists = true
      } catch {
        // dest doesn't exist, safe to rename
      }
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
    try {
      yield* until(fs.access(p))
    } catch {
      yield* until(fs.writeFile(p, ''))
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

  exec: nodeExec,
  spawn: nodeSpawn,

  tcpListen,
  tcpConnect,
  udpBind,
  ip: readInterfaces,
  tmpdir: readTmpDir,

  // Node has no built-in S3; use the dependency-free SigV4-over-fetch client.
  s3: operation(function* (options?: S3Options) {
    return createS3(fetchS3Client(options ?? {}))
  }),
})
