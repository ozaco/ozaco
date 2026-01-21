import { Runtime } from '../const'

export const detectRuntime = (): Runtime => {
  if (typeof globalThis.process !== 'undefined' && globalThis.process.versions) {
    if ((globalThis.process.versions as Record<string, unknown>).bun) {
      return Runtime.bun
    }
    if (globalThis.process.versions.node) {
      return Runtime.node
    }
  }
  if (typeof window !== 'undefined' || typeof self !== 'undefined') {
    return Runtime.browser
  }
  return Runtime.unknown
}
