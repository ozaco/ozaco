// oxlint-disable unicorn/text-encoding-identifier-case

import { until } from 'std:effect'
import { IO, IO_FLAGS, toPath } from 'std:io'
import { fail } from 'std:result'
import { hasFlag } from 'std:shared'

import { createHash, createHmac, randomBytes as nodeRandomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname } from 'node:path'

import pkg from '../../../package.json'
import { IOErrors } from '../errors'
import { withEncoding } from '../internal/crypto/encode'
import { hlcDecode, hlcObserve, hlcToken } from '../internal/crypto/hlc'
import {
  decryptSecret,
  encryptSecret,
  generateSignKeyPair,
  signData,
  verifyData,
} from '../internal/crypto/node'
import { ulidId } from '../internal/crypto/ulid'
import { uuidId } from '../internal/crypto/uuid'
import { readEnv } from '../internal/env'
import { readFileFlow, writeFileFlow } from '../internal/fs/flow'
import { sharedFs, writeFlagOf } from '../internal/fs/shared'
import { watchPath } from '../internal/fs/watch'
import { tcpConnect, tcpListen, udpBind } from '../internal/net/sockets'
import { readCwd, readHomeDir, readInterfaces, readPlatform, readTmpDir } from '../internal/net/sys'
import { createExpandHome } from '../internal/path/home'
import { nodePath } from '../internal/path/node'
import { nodeExec, nodeSpawn } from '../internal/process/node'
import { createS3 } from '../internal/s3/create'
import { fetchS3Client } from '../internal/s3/fetch'
import { fromReadable } from '../internal/stream/from-readable'
import { toReadable } from '../internal/stream/to-readable'
import { processToTerminal } from '../internal/stream/to-terminal'
import type { IODef } from '../types/io'

const toNodeHash = (alg: IODef.HashAlgorithm) =>
  alg === 'SHA-256' ? 'sha256' : alg === 'SHA-384' ? 'sha384' : 'sha512'

/**
 * The IO impl for Node (and any runtime with the `node:*` builtins but no `Bun` global, e.g. Deno).
 * Nothing inside this monorepo installs it — every first-party package runs on Bun — it ships for
 * consumers on those runtimes. The fs handlers that need no Bun API are written the same way as
 * `BunIO`'s; where the two DO differ (parent-directory creation, directory destinations, text
 * encodings, process failure tags) the difference is stated on the `IODef.Actions` member.
 */
export const NodeIO = IO.implement({
  name: 'std/node-io',
  version: pkg.version,
  *setup() {
    return null
  },
}).build({
  ...sharedFs,

  env: readEnv,

  *randomBytes(length) {
    return new Uint8Array(nodeRandomBytes(length))
  },

  ulid: ulidId,
  uuid: uuidId,
  hlc: hlcToken,
  decodeHlc: hlcDecode,
  observeHlc: hlcObserve,

  *hmac(algorithm, key, data) {
    const mac = createHmac(toNodeHash(algorithm), key).update(data).digest()
    return new Uint8Array(mac)
  },

  hash: withEncoding(function* (algorithm, data) {
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

  *read(path) {
    const buf = yield* until(fs.readFile(toPath(path)))
    return new Uint8Array(buf)
  },

  *readText(path, encoding) {
    return yield* until(
      fs.readFile(toPath(path), { encoding: (encoding ?? 'utf-8') as BufferEncoding }),
    )
  },

  *write(path, data, options) {
    const f = options?.flags ?? IO_FLAGS.none
    const flag = writeFlagOf(f)
    yield* until(fs.writeFile(toPath(path), data, { flag }))
  },

  *copy(src, dest, options) {
    const mode = hasFlag(options?.flags ?? IO_FLAGS.none, IO_FLAGS.exclusive) ? 1 : 0
    yield* until(fs.copyFile(toPath(src), toPath(dest), mode))
  },

  *rename(src, dest, options) {
    if (hasFlag(options?.flags ?? IO_FLAGS.none, IO_FLAGS.exclusive)) {
      let destExists = false
      try {
        yield* until(fs.access(toPath(dest)))
        destExists = true
      } catch {
        // dest doesn't exist, safe to rename
      }
      if (destExists) {
        return yield* fail(IOErrors.Exists, `destination already exists: ${toPath(dest)}`)
      }
    }
    yield* until(fs.rename(toPath(src), toPath(dest)))
  },

  *exists(path) {
    try {
      yield* until(fs.access(toPath(path)))
      return true
    } catch {
      return false
    }
  },

  *ensureFile(path) {
    const p = toPath(path)
    const dir = dirname(p)
    yield* until(fs.mkdir(dir, { recursive: true }))
    try {
      yield* until(fs.access(p))
    } catch {
      yield* until(fs.writeFile(p, ''))
    }
  },

  join: nodePath.join,
  dirname: nodePath.dirname,
  basename: nodePath.basename,
  extname: nodePath.extname,
  isAbsolute: nodePath.isAbsolute,

  exec: nodeExec,
  spawn: nodeSpawn,

  tcpListen,
  tcpConnect,
  udpBind,
  ip: readInterfaces,
  tmpdir: readTmpDir,
  cwd: readCwd,
  homeDir: readHomeDir,
  expandHome: createExpandHome(readHomeDir, nodePath.join),
  platform: readPlatform,
  toTerminal: processToTerminal,

  // Node has no built-in S3; use the dependency-free SigV4-over-fetch client.
  *s3(options?: IODef.S3Options) {
    return createS3(fetchS3Client(options ?? {}))
  },
})
