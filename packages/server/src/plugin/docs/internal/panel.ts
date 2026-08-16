import type { Manifest } from '../types'

import { PANEL_HTML } from './panel.gen'

/**
 * The bundled docs panel: the React app from `apps/panel`, built by Vite into ONE self-contained
 * HTML page (inline CSS + inline JS, ZERO external requests) and embedded as the generated
 * `panel.gen.ts` string module — regenerate with `moon run panel:embed` after a panel change.
 *
 * No per-request templating: the page derives the docs mount path from `location.pathname`
 * (so non-default `path` mounts work unchanged) and requests same-origin by default — hosts
 * serving the panel from ANOTHER origin inject `window.__OZACO_PANEL__ = { base }` before the
 * bundle runs. The manifest parameter only preserves the serving signature `definition.ts`
 * dispatches (the document itself is fetched live from `GET <path>/manifest`).
 */
export const buildPanelHtml = (_manifest: Manifest): string => PANEL_HTML
