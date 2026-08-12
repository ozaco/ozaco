import type { Flow } from 'std:effect'
import { operation, resource } from 'std:effect'
import type { FlowClose } from 'std:io'
import { IO } from 'std:io'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { readWebEnv } from '../internal/env'
import { fromReadable } from '../internal/from-readable'
import { webPath } from '../internal/path-web'
import { createS3 } from '../internal/s3'
import { toReadable } from '../internal/to-readable'
import { ulidId } from '../internal/ulid'
import { uuidId } from '../internal/uuid'
import { webHash, webHmac, webRandomBytes } from '../internal/webcrypto'

/** The browser has no filesystem — these actions fail clearly instead of pretending to work. */
const unsupported = (action: string): AnyType =>
  operation(function* () {
    return yield* fail('io-unsupported', `IO.${action} is not available in a web environment`)
  })

const unsupportedFlow = (action: string): Flow<Uint8Array, FlowClose> =>
  resource(function* () {
    return yield* fail('io-unsupported', `IO.${action} is not available in a web environment`)
  }) as Flow<Uint8Array, FlowClose>

/**
 * The web implementation of `std:io`. Crypto (`randomBytes`/`hmac`/`hash`) runs on the Web Crypto
 * API and `env` reads a best-effort source — enough for the client broker's tracer span ids and any
 * crypto-dependent plugin (auth/codec). Filesystem and file-stream actions are unsupported (the
 * browser has no fs); `fromReadable` still works for adapting an existing web `ReadableStream`.
 */
export const WebIO = IO.implement({
  name: 'web-io',
  version: '0.0.1',
  *setup() {
    return null
  },
}).build({
  env: readWebEnv,

  randomBytes: webRandomBytes,
  ulid: ulidId,
  uuid: uuidId,
  hmac: webHmac,
  hash: webHash,
  encrypt: unsupported('encrypt'),
  decrypt: unsupported('decrypt'),
  generateKeyPair: unsupported('generateKeyPair'),
  sign: unsupported('sign'),
  verify: unsupported('verify'),

  fromReadable,
  toReadable,
  readFlow: () => unsupportedFlow('readFlow'),
  watch: () => unsupportedFlow('watch') as AnyType,
  writeFlow: unsupported('writeFlow'),

  read: unsupported('read'),
  readText: unsupported('readText'),
  write: unsupported('write'),
  append: unsupported('append'),
  copy: unsupported('copy'),
  rename: unsupported('rename'),
  rm: unsupported('rm'),
  exists: unsupported('exists'),
  stat: unsupported('stat'),
  lstat: unsupported('lstat'),
  readdir: unsupported('readdir'),
  ensureDir: unsupported('ensureDir'),
  ensureFile: unsupported('ensureFile'),
  emptyDir: unsupported('emptyDir'),
  walk: unsupported('walk'),

  join: webPath.join,
  dirname: webPath.dirname,
  basename: webPath.basename,
  extname: webPath.extname,
  isAbsolute: webPath.isAbsolute,

  chmod: unsupported('chmod'),
  symlink: unsupported('symlink'),
  readlink: unsupported('readlink'),
  exec: unsupported('exec'),
  spawn: unsupported('spawn'),

  tcpListen: unsupported('tcpListen'),
  tcpConnect: unsupported('tcpConnect'),
  udpBind: unsupported('udpBind'),
  ip: unsupported('ip'),
  tmpdir: unsupported('tmpdir'),

  // The browser must not hold S3 credentials; the client is constructible but every op fails
  // `io-unsupported`.
  s3: operation(function* () {
    return createS3(null)
  }),
})
