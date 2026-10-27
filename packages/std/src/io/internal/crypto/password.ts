import type { Operation } from 'std:effect'
import { attempt, until } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

import { IOErrors } from '../../errors'
import type { Helpers } from '../../types/helpers'
import type { IODef } from '../../types/io'

/*
 * Password hashing. Three algorithms, one self-describing PHC string each:
 *
 *   - `argon2id` (the default) and `bcrypt` run on the runtime's NATIVE hasher — Bun ships one
 *     (`Bun.password`), Node does not: there they fail `std:io.unsupported` rather than fall back
 *     to something weaker behind the caller's back.
 *   - `scrypt` runs on `node:crypto` on Bun and Node alike (`$scrypt$ln=16,r=8,p=1$<salt>$<key>`,
 *     base64 without padding as PHC writes it), so a digest made on one runtime verifies on the
 *     other. OWASP-strength defaults: N = 2^16, r = 8, p = 1, 16-byte salt, 32-byte key.
 *
 * `verify` tells the algorithm from the digest's prefix: a scrypt digest is checked here, a
 * native one by the native hasher, anything else (a malformed or foreign string) is `false` —
 * never a failure, so a stored garbage digest reads like a wrong password. A scrypt digest asking
 * for more than 2^20 is refused as malformed: the cost is the digest's to name, not to inflate.
 */

const SCRYPT_LOG_N = 16
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAX_LOG_N = 20
const SALT_BYTES = 16
const KEY_BYTES = 32

const SCRYPT_DIGEST =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u
const NATIVE_DIGEST = /^\$(?:argon2(?:id|i|d)|2[aby])\$/u

/** The password every `reject` is checked against — real work, never a real user. */
const DECOY = 'ozaco:password:decoy'

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replace(/=+$/u, '')

const scryptKey = (
  plain: string,
  salt: Uint8Array,
  params: { logN: number; r: number; p: number },
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    scrypt(
      plain,
      salt,
      KEY_BYTES,
      {
        N: 2 ** params.logN,
        r: params.r,
        p: params.p,
        // scrypt needs 128 * N * r bytes; headroom so the derivation is not rejected
        maxmem: 256 * 2 ** params.logN * params.r,
      },
      (error, key) => {
        if (error) {
          reject(error)
        } else {
          resolve(new Uint8Array(key))
        }
      },
    )
  })

function* scryptHash(plain: string, options?: IODef.PasswordOptions): Operation<string> {
  const logN = Math.min(options?.cost ?? SCRYPT_LOG_N, SCRYPT_MAX_LOG_N)
  const salt = new Uint8Array(randomBytes(SALT_BYTES))
  const key = yield* until(scryptKey(plain, salt, { logN, r: SCRYPT_R, p: SCRYPT_P }))

  return `$scrypt$ln=${logN},r=${SCRYPT_R},p=${SCRYPT_P}$${base64(salt)}$${base64(key)}`
}

function* scryptVerify(plain: string, digest: string): Operation<boolean> {
  const match = SCRYPT_DIGEST.exec(digest)

  if (!match) {
    return false
  }

  const params = { logN: Number(match[1]), r: Number(match[2]), p: Number(match[3]) }
  const salt = new Uint8Array(Buffer.from(match[4]!, 'base64'))
  const expected = new Uint8Array(Buffer.from(match[5]!, 'base64'))

  if (params.logN > SCRYPT_MAX_LOG_N || expected.length !== KEY_BYTES) {
    return false
  }

  const key = yield* until(scryptKey(plain, salt, params))

  return timingSafeEqual(key, expected)
}

/**
 * The `password` actions over an optional native hasher (`null` where the runtime has none).
 */
export const createPassword = (native: Helpers.NativePassword | null): IODef.Password => {
  let decoy: string | null = null

  const hash: IODef.Password['hash'] = function* (plain, options) {
    const algorithm = options?.algorithm ?? 'argon2id'

    if (algorithm === 'scrypt') {
      return yield* scryptHash(plain, options)
    }

    if (!native) {
      return yield* fail(
        IOErrors.Unsupported,
        `password.hash: "${algorithm}" needs the runtime's native hasher (Bun); use { algorithm: 'scrypt' }`,
      )
    }

    return yield* until(native.hash(plain, { ...options, algorithm }))
  }

  const verify: IODef.Password['verify'] = function* (plain, digest) {
    if (digest.startsWith('$scrypt$')) {
      return yield* scryptVerify(plain, digest)
    }

    if (!NATIVE_DIGEST.test(digest)) {
      return false
    }

    if (!native) {
      return yield* fail(
        IOErrors.Unsupported,
        "password.verify: an argon2 / bcrypt digest needs the runtime's native hasher (Bun)",
      )
    }

    // a digest the native hasher cannot parse is a wrong password, not a failure
    const outcome = yield* attempt(() => until(native.verify(plain, digest)))

    return isFailure(outcome) ? false : outcome.value
  }

  const reject: IODef.Password['reject'] = function* (plain) {
    if (decoy === null) {
      decoy = yield* hash(DECOY, native ? undefined : { algorithm: 'scrypt' })
    }

    yield* verify(plain, decoy)

    return false
  }

  return { hash, verify, reject }
}
