import type { AnyType } from 'std:shared'

import type { Server as HttpServer } from 'node:http'

export namespace NodeEdgeDef {
  export interface State {
    server: HttpServer | null
    wss: AnyType | null
  }
}
