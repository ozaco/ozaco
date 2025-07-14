import type { cryptoTags } from './tag'

declare global {
  namespace Std {
    // ------------ Errors ------------
    interface Error {
      'std/crypto': typeof cryptoTags
    }

    namespace Crypto {
      type Module = 'modern' | 'legacy' | 'unsafe'

      interface Api {
        id: (length?: number) => Std.Result<string, 'std/crypto.$id', `std/crypto.${Std.Crypto.Module}`[]>
      }
    }
  }
}
