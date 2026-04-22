export type CorsOrigin =
  | '*'
  | true
  | string
  | readonly string[]
  | RegExp
  | ((origin: string) => boolean)

export interface CorsOptions {
  origin?: CorsOrigin
  methods?: readonly string[]
  allowedHeaders?: readonly string[]
  exposedHeaders?: readonly string[]
  credentials?: boolean
  maxAge?: number | string
  preflightStatus?: number
}
