/**
 * TLS material for an outgoing connection — the portable subset of Bun's `tls` option (fetch
 * init, `WebSocket` constructor options). PEM strings or raw bytes; `rejectUnauthorized: false`
 * accepts a peer whose certificate does not verify (tests / self-signed dev endpoints only).
 * Runtimes without the extension ignore it.
 */
export interface TlsOptions {
  ca?: string | Uint8Array | Array<string | Uint8Array> | undefined
  cert?: string | Uint8Array | Array<string | Uint8Array> | undefined
  key?: string | Uint8Array | Array<string | Uint8Array> | undefined
  rejectUnauthorized?: boolean | undefined
}
