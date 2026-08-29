// oxlint-disable import/no-default-export -- vite config files must default-export
import { kitResolve } from '@ozaco/devkit/resolve'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [kitResolve.vite(), react(), tailwindcss(), viteSingleFile()],
  build: { target: 'es2022' },
})
