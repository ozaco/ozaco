import type { cryptoTags } from './tag'

declare global {
  namespace Std {
    // ------------ Errors ------------
    interface Error {
      'std/crypto': typeof cryptoTags
    }

    namespace Crypto {
      type Module = 'modern' | 'legacy' | 'unsafe'
      type Uuid = `${string}-${string}-${string}-${string}-${string}`

      interface Api {
        id: (length?: number) => Std.Result<string, 'std/crypto.$id', `std/crypto.${Std.Crypto.Module}`[]>
        uuid: () => Std.Result<Std.Crypto.Uuid, 'std/crypto.$uuid', `std/crypto.${Std.Crypto.Module}`[]>
      }
    }
  }
}
