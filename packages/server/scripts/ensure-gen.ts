/**
 * The embedded pages (`panel.gen.ts`, `console.gen.ts`) are git-ignored and written by
 * `moon run panel:embed` / `moon run observe:embed`. A task dep from here would cycle the
 * project graph (server → panel → client → server), so builds self-heal instead: when a gen
 * module is missing, write a placeholder that tells the reader how to get the real page.
 * The demo tasks depend on the embed tasks, so anything user-facing gets the real thing.
 */
const targets: readonly { path: string; name: string; embed: string }[] = [
  {
    path: `${import.meta.dir}/../src/plugins/docs/internal/panel.gen.ts`,
    name: 'PANEL_HTML',
    embed: 'moon run panel:embed',
  },
  {
    path: `${import.meta.dir}/../src/plugins/observe/internal/console.gen.ts`,
    name: 'CONSOLE_HTML',
    embed: 'moon run observe:embed',
  },
]

for (const target of targets) {
  // oxlint-disable-next-line no-await-in-loop -- two files, sequential on purpose
  if (await Bun.file(target.path).exists()) {
    continue
  }

  const html =
    '<!doctype html><html><head><title>ozaco</title></head>' +
    `<body>placeholder — run \`${target.embed}\` for the real page</body></html>`

  // oxlint-disable-next-line no-await-in-loop
  await Bun.write(
    target.path,
    `// placeholder written by scripts/ensure-gen.ts — \`${target.embed}\` replaces it\n` +
      `export const ${target.name}: string = ${JSON.stringify(html)}\n`,
  )
  console.log(`[ensure-gen] wrote placeholder ${target.path}`)
}
