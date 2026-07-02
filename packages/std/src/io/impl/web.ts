import type { Stream } from 'std:effect'
import { operation, resource } from 'std:effect'
import type { StreamClose } from 'std:io'
import { IO } from 'std:io'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { readWebEnv } from '../internal/env'
import { fromReadable } from '../internal/from-readable'
import { toReadable } from '../internal/to-readable'
import { webHash, webHmac, webRandomBytes } from '../internal/webcrypto'

/** The browser has no filesystem — these actions fail clearly instead of pretending to work. */
const unsupported = (action: string): AnyType =>
  operation(function* () {
    return yield* fail('io-unsupported', `IO.${action} is not available in a web environment`)
  })

const unsupportedStream = (action: string): Stream<Uint8Array, StreamClose> =>
  resource(function* () {
    return yield* fail('io-unsupported', `IO.${action} is not available in a web environment`)
  }) as Stream<Uint8Array, StreamClose>

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
  hmac: webHmac,
  hash: webHash,
  encrypt: unsupported('encrypt'),
  decrypt: unsupported('decrypt'),
  generateKeyPair: unsupported('generateKeyPair'),
  sign: unsupported('sign'),
  verify: unsupported('verify'),

  fromReadable,
  toReadable,
  readStream: () => unsupportedStream('readStream'),
  writeStream: unsupported('writeStream'),

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

  chmod: unsupported('chmod'),
  symlink: unsupported('symlink'),
  readlink: unsupported('readlink'),
  exec: unsupported('exec'),
  spawn: unsupported('spawn'),

  tcpListen: unsupported('tcpListen'),
  tcpConnect: unsupported('tcpConnect'),
  udpBind: unsupported('udpBind'),
  ip: unsupported('ip'),
})
