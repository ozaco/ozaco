import type { JWTAlgorithm } from '../types'

export interface BaseAuthContext {
  issuer: string | null
  audience: string | null
  algorithm: JWTAlgorithm

  verificationTTL: number
}
