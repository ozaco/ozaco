import type { CorsOrigin } from '../types'

export interface CorsContext {
  origin: CorsOrigin
  methods: string
  allowedHeaders: string
  exposedHeaders: string | null
  credentials: boolean
  maxAge: string
  preflightStatus: number
}
