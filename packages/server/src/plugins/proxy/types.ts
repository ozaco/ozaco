export namespace ProxyDef {
  export interface Options {
    /** the mount path the proxied node appears under here (`'/api'`): a request to
     * `/api/<path>` goes to `<target>/<path>`, its query kept. */
    readonly prefix: string

    /** the upstream node's origin (`'http://127.0.0.1:3000'`). */
    readonly target: string

    /** also bridge WebSocket upgrades under the prefix to the upstream (`ws://` / `wss://` after
     * the target's scheme). Default `true`. */
    readonly ws?: boolean | undefined

    /** headers added to every forwarded request (over the caller's). */
    readonly headers?: Readonly<Record<string, string>> | undefined
  }

  export interface Config {
    readonly prefix: string
    readonly target: URL
    readonly ws: boolean
    readonly headers: Readonly<Record<string, string>>
  }
}
