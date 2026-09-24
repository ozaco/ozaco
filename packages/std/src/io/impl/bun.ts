import { until } from 'std:effect'
import { IO, IO_FLAGS, toPath } from 'std:io'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'
import { hasFlag } from 'std:shared'

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
import { webHash, webHmac, webRandomBytes } from '../internal/crypto/web'
import { readEnv } from '../internal/env'
import { readFileFlow, writeFileFlow } from '../internal/fs/flow'
import { sharedFs, writeFlagOf } from '../internal/fs/shared'
import { watchPath } from '../internal/fs/watch'
import { tcpConnect, tcpListen, udpBind } from '../internal/net/sockets'
import { readCwd, readHomeDir, readInterfaces, readPlatform, readTmpDir } from '../internal/net/sys'
import { createExpandHome } from '../internal/path/home'
import { nodePath } from '../internal/path/node'
import { bunExec, bunSpawn } from '../internal/process/bun'
import { createS3 } from '../internal/s3/create'
import { fromReadable } from '../internal/stream/from-readable'
import { toReadable } from '../internal/stream/to-readable'
import { processToTerminal } from '../internal/stream/to-terminal'
import type { IODef } from '../types/io'

export const BunIO = IO.implement({
  name: 'std/bun-io',
  version: pkg.version,
  *setup() {
    return null
  },
}).build({
  ...sharedFs,

  env: readEnv,

  randomBytes: webRandomBytes,
  ulid: ulidId,
  uuid: uuidId,
  hlc: hlcToken,
  decodeHlc: hlcDecode,
  observeHlc: hlcObserve,
  hmac: webHmac,
  hash: withEncoding(webHash),
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
    const p = toPath(path)
    const buf = yield* until(Bun.file(p).arrayBuffer())
    return new Uint8Array(buf)
  },

  *readText(path, encoding) {
    const p = toPath(path)
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case
    if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
      const buf = yield* until(Bun.file(p).arrayBuffer())
      const decoder = new TextDecoder(encoding)
      return decoder.decode(buf)
    }
    return yield* until(Bun.file(p).text())
  },

  *write(path, data, options) {
    const flags = options?.flags

    if (!flags) {
      yield* until(Bun.write(toPath(path), data))
      return
    }
    const flag = writeFlagOf(flags)
    yield* until(fs.writeFile(toPath(path), data, { flag }))
  },

  *copy(src, dest, options) {
    // oxlint-disable-next-line unicorn/prefer-ternary
    if (hasFlag(options?.flags ?? IO_FLAGS.none, IO_FLAGS.exclusive)) {
      yield* until(fs.copyFile(toPath(src), toPath(dest), 1))
    } else {
      yield* until(Bun.write(toPath(dest), Bun.file(toPath(src))))
    }
  },

  *rename(src, dest, options) {
    if (hasFlag(options?.flags ?? IO_FLAGS.none, IO_FLAGS.exclusive)) {
      // `Bun.file().exists()` is `false` for a directory: an existing DIRECTORY destination
      // bypasses this guard on Bun (NodeIO fails `IOErrors.Exists` via `fs.access`).
      const destExists = yield* until(Bun.file(toPath(dest)).exists())
      if (destExists) {
        return yield* fail(IOErrors.Exists, `destination already exists: ${toPath(dest)}`)
      }
    }
    yield* until(fs.rename(toPath(src), toPath(dest)))
  },

  *exists(path) {
    // `Bun.file(dir).exists()` reports `false` for directories — use `fs.access` (matches NodeIO) so
    // `exists` answers "path exists" for files and directories alike. NOTE: `rename` (EXCLUSIVE
    // guard) and `ensureFile` below still consult `Bun.file().exists()`, so a directory at the
    // target slips past their checks on Bun (NodeIO's `fs.access` sees it) — a known divergence,
    // pinned by tests/io/node.test.ts.
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
    // `Bun.file(dir).exists()` is `false` for a directory, so `ensureFile('<dir>')` falls through
    // to `Bun.write` and fails on Bun, whereas NodeIO (`fs.access`) treats it as a no-op.
    const fileExists = yield* until(Bun.file(p).exists())
    if (!fileExists) {
      yield* until(Bun.write(p, ''))
    }
  },

  join: nodePath.join,
  dirname: nodePath.dirname,
  basename: nodePath.basename,
  extname: nodePath.extname,
  isAbsolute: nodePath.isAbsolute,

  exec: bunExec,
  spawn: bunSpawn,

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

  *s3(options?: IODef.S3Options) {
    return createS3(new (Bun.S3Client as AnyType)(options ?? {}))
  },
})
