/**
 * Waits for a specified amount of time and returns a default value passed as a parameter
 */
export const wait = async <T = true>(ms: number, defaultValue?: T): Promise<T> => {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve((defaultValue ?? true) as T)
    }, ms)
  })
}
