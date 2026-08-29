/** The shapes this module passes around inside itself. */
export namespace Helpers {
  export interface Clock {
    ts: number
    counter: number
  }

  export interface SpawnConfig {
    cwd?: string
    env?: Record<string, string>
    timeout?: number
  }

  export interface Config {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken: string | undefined
    readonly region: string
    readonly bucket: string
    readonly endpoint: string | undefined
  }
}
