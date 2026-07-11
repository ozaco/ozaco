import { mapError, operation, until } from 'std:effect'
import { fail } from 'std:result'
import type { Result } from 'std:result'

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPair as genKeyPair,
  randomBytes,
  scrypt,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto'

import type { KeyPair } from '../types/common'

/*
 * Secret-based authenticated encryption, hardened for maximum security:
 *
 *   - AES-256-GCM (NIST AEAD): confidentiality + integrity; a wrong secret or ANY tampering fails.
 *   - Key derived from the secret with scrypt — memory-hard, so brute-forcing the secret is far
 *     costlier on GPUs/ASICs than a plain PBKDF2. OWASP-strength params (N=2^16, r=8, p=1 ~= 64 MB).
 *   - Random 16-byte salt (per message) => a fresh key every time; random 12-byte GCM nonce.
 *   - A version byte enables algorithm agility and is authenticated as GCM AAD, so a downgrade/
 *     tamper of the header is rejected. decrypt() only accepts the exact version it knows, with
 *     fixed KDF params => no attacker-controlled cost, so no memory-exhaustion DoS via a crafted header.
 *   - The derived key buffer is zeroed after use (best-effort in a GC'd runtime).
 *
 * Packed layout:  version(1) || salt(16) || iv(12) || tag(16) || ciphertext
 * Uses node:crypto (native in Bun and Node) so ciphertext is identical across both runtimes.
 */

const encoder = new TextEncoder()

const VERSION = 1
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const HEADER_BYTES = 1 + SALT_BYTES + IV_BYTES + TAG_BYTES

const SCRYPT_N = 2 ** 16
const SCRYPT_R = 8
const SCRYPT_P = 1
// scrypt needs ~128 * N * r bytes (=64 MB here); give maxmem headroom so it is not rejected.
const SCRYPT_MAXMEM = 128 * 1024 * 1024

const deriveKey = operation(function* (secret: string, salt: Uint8Array) {
  return yield* until(
    new Promise<Buffer>((resolve, reject) => {
      scrypt(
        encoder.encode(secret),
        salt,
        KEY_BYTES,
        { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
        (error, key) => {
          if (error) {
            reject(error)
          } else {
            resolve(key)
          }
        },
      )
    }),
  )
})

export const encryptSecret = operation(function* (data: Uint8Array | string, secret: string) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)

  const key = yield* deriveKey(secret, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Uint8Array.of(VERSION))
  const ct = Buffer.concat([cipher.update(bytes), cipher.final()])
  const tag = cipher.getAuthTag()
  key.fill(0)

  const out = new Uint8Array(HEADER_BYTES + ct.length)
  out[0] = VERSION
  out.set(salt, 1)
  out.set(iv, 1 + SALT_BYTES)
  out.set(tag, 1 + SALT_BYTES + IV_BYTES)
  out.set(ct, HEADER_BYTES)
  return out
})

export const decryptSecret = operation(function* (data: Uint8Array, secret: string) {
  if (data.length < HEADER_BYTES) {
    return yield* fail('decrypt-failed', 'ciphertext is too short')
  }
  if (data[0] !== VERSION) {
    return yield* fail('decrypt-failed', `unsupported ciphertext version: ${data[0]}`)
  }

  const salt = data.subarray(1, 1 + SALT_BYTES)
  const iv = data.subarray(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES)
  const tag = data.subarray(1 + SALT_BYTES + IV_BYTES, HEADER_BYTES)
  const ct = data.subarray(HEADER_BYTES)

  const key = yield* deriveKey(secret, salt)
  const plain = yield* mapError(
    // The GCM tag is verified by decipher.final(), which throws on a wrong secret or tampering;
    // the throw rejects the promise, which the runtime surfaces here (no bare try/catch).
    until(
      new Promise<Buffer>(resolve => {
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
        decipher.setAAD(Uint8Array.of(VERSION))
        decipher.setAuthTag(tag)
        const out = Buffer.concat([decipher.update(ct), decipher.final()])
        key.fill(0)
        resolve(out)
      }),
    ),
    failure => {
      key.fill(0)
      return fail(
        'decrypt-failed',
        'decryption failed — wrong secret or corrupted data',
        ...failure.causes,
      ) as Result.Failure<unknown>
    },
  )
  return new Uint8Array(plain)
})

/*
 * Digital signatures via Ed25519 (modern, fast, small 64-byte signatures, no parameter footguns).
 * `sign` proves authorship with the private key; `verify` checks it with the public key — the
 * authenticity complement to encrypt/decrypt (e.g. a publisher signs an artifact, everyone verifies).
 * Keys are portable DER bytes: public = SPKI, private = PKCS8 (round-trip via generateKeyPair).
 */

export const generateSignKeyPair = operation(function* () {
  return yield* until(
    new Promise<KeyPair>((resolve, reject) => {
      genKeyPair(
        'ed25519',
        {
          publicKeyEncoding: { format: 'der', type: 'spki' },
          privateKeyEncoding: { format: 'der', type: 'pkcs8' },
        },
        (error, publicKey, privateKey) => {
          if (error) {
            reject(error)
          } else {
            resolve({
              publicKey: new Uint8Array(publicKey as unknown as Buffer),
              privateKey: new Uint8Array(privateKey as unknown as Buffer),
            })
          }
        },
      )
    }),
  )
})

export const signData = operation(function* (data: Uint8Array | string, privateKey: Uint8Array) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return yield* mapError(
    // createPrivateKey / sign are synchronous and throw on a malformed key; the throw rejects the
    // promise, surfaced here as a tagged failure (no bare try/catch).
    until(
      new Promise<Uint8Array>(resolve => {
        const key = createPrivateKey({ key: Buffer.from(privateKey), format: 'der', type: 'pkcs8' })
        resolve(new Uint8Array(nodeSign(null, bytes, key)))
      }),
    ),
    failure =>
      fail(
        'sign-failed',
        'signing failed — invalid private key',
        ...failure.causes,
      ) as Result.Failure<unknown>,
  )
})

export const verifyData = operation(function* (
  data: Uint8Array | string,
  signature: Uint8Array,
  publicKey: Uint8Array,
) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return yield* mapError(
    // A bad signature returns `false`; only a malformed public key throws -> tagged failure.
    until(
      new Promise<boolean>(resolve => {
        const key = createPublicKey({ key: Buffer.from(publicKey), format: 'der', type: 'spki' })
        resolve(nodeVerify(null, bytes, key, signature))
      }),
    ),
    failure =>
      fail(
        'verify-failed',
        'verification failed — invalid public key',
        ...failure.causes,
      ) as Result.Failure<unknown>,
  )
})
