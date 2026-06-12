import { CoreStatusMap, DEFAULT_STATUS } from '../const'

export const statusFor = (
  code: unknown,
  ...overrides: Array<Record<string, number> | null | undefined>
): number => {
  if (typeof code !== 'string') {
    return DEFAULT_STATUS
  }
  for (const map of overrides) {
    if (map && code in map) {
      return map[code]!
    }
  }
  return CoreStatusMap[code as keyof typeof CoreStatusMap] ?? DEFAULT_STATUS
}
