import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(new URL('../log/', import.meta.url), { recursive: true })
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  'pages', 'functions', 'build', 'functions', '--outdir', 'log/pages-worker',
  '--build-output-directory', 'dist', '--output-routes-path', 'log/pages-routes.json',
  '--compatibility-date', '2026-08-29', '--minify',
], { cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: 'log/pages-build.txt' } })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
