const indexOfSubstrings = function* (str: string, searchValue: string) {
  let i = 0
  while (true) {
    const r = str.indexOf(searchValue, i)
    if (r !== -1) {
      yield r
      i = r + 1
    } else {
      return
    }
  }
}

// partial fix for https://github.com/oven-sh/bun/issues/14493
export const fixExports = (rawCode: string) => {
  let code = rawCode

  const exportLocations = [...indexOfSubstrings(code, 'export')]

  const seenExports = new Set<string>()

  for (const exportLocation of exportLocations) {
    const line = code.slice(exportLocation).split('\n')[0]

    if (
      !line?.startsWith('export ') ||
      line.startsWith('export const') ||
      line.startsWith('export let') ||
      line.startsWith('export var') ||
      line.startsWith('export function') ||
      line.startsWith('export class') ||
      line.startsWith('export default ') ||
      line?.includes('${')
    ) {
      continue
    }

    let codeBlock = line

    if (!line.endsWith(';')) {
      const ending = code.indexOf('};', exportLocation)
      codeBlock = code
        .slice(exportLocation, ending + 2)
        .split('\n')
        .join(' ')
        .replaceAll('  ', '')
    }

    const rawExports = codeBlock
      .slice(codeBlock.indexOf('{') + 1, codeBlock.indexOf('}'))
      .split(',')
      .map(exportName => exportName.trim())

    const exports = rawExports.map(exportName => {
      if (exportName.includes('as')) {
        // biome-ignore lint/style/noNonNullAssertion: Redundant
        return exportName.split(' as ')[1]!
      }

      return exportName
    })

    const removeExports: string[] = []

    for (const exportName of exports) {
      if (seenExports.has(exportName)) {
        removeExports.push(exportName)

        continue
      }

      seenExports.add(exportName)
    }

    if (removeExports.length === exports.length) {
      code = code.replace(codeBlock, '')

      return code
    }

    for (const exportName of removeExports) {
      const rawExport = rawExports[exports.indexOf(exportName)]

      if (!rawExport) {
        continue
      }

      if (rawExport.includes('as')) {
        code = code.replace(rawExport, '')
      } else {
        console.error(`unhandled export: ${rawExport}`)
      }
    }
  }

  return code
}
