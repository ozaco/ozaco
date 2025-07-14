import type { cryptoTags } from './tag'

declare global {
  namespace Std {
    // ------------ Errors ------------
    interface Error {
      'std/crypto': typeof cryptoTags
    }

    namespace Crypto {
      type Module = 'modern' | 'legacy' | 'unsafe' | 'shared'
      type Uuid = `${string}-${string}-${string}-${string}-${string}`

      interface Api {
        id: (length?: number) => Std.Result<string, 'std/crypto.$id', `std/crypto.${Std.Crypto.Module}`[]>
        uuid: () => Std.Result<Std.Crypto.Uuid, 'std/crypto.$uuid', `std/crypto.${Std.Crypto.Module}`[]>
        ulid: () => Std.Result<
          string,
          'std/results.invalid-usage' | 'std/crypto.ulid-time' | 'std/crypto.ulid-random',
          ('std/results.$safe' | 'std/crypto.$ulid' | `std/crypto.${Std.Crypto.Module}`)[]
        >
        parseUlid: (
          value: string,
        ) => Std.Result<
          Date,
          'std/results.invalid-usage' | 'std/crypto.ulid-parse-time' | 'std/crypto.$ulidParse',
          ('std/results.$safe' | 'std/crypto.$ulidParse' | `std/crypto.${Std.Crypto.Module}`)[]
        >
      }
    }
  }
}
