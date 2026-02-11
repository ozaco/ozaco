import type { Runtime } from '../const'

export interface Options {
  runtime?: Runtime | undefined
  autoPerm?: boolean | undefined
}

export interface Context {
  runtime: Runtime | null
  autoPerm?: boolean
}
