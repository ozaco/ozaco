import type { SwaggerOptions } from './types'

export const buildSwaggerHtml = ({ openapi, title }: SwaggerOptions): string => {
  const safeTitle = title.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const safeUrl = JSON.stringify(openapi)

  return `<!DOCTYPE html>
<html lang='en'>
<head>
  <meta charset='UTF-8' />
  <title>${safeTitle}</title>
  <meta name='viewport' content='width=device-width, initial-scale=1' />
  <link rel='stylesheet' href='https://unpkg.com/swagger-ui-dist@5/swagger-ui.css' />
  <style>body{margin:0;background:#fafafa}</style>
</head>
<body>
<div id='swagger-ui'></div>
<script src='https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js' crossorigin></script>
<script src='https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js' crossorigin></script>
<script>
  window.onload = function () {
    window.ui = SwaggerUIBundle({
      url: ${safeUrl},
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
    })
  }
</script>
</body>
</html>`
}
