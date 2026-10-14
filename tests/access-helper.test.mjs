import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

test('offline access helper is self-contained with exact CSP and no transmission/storage APIs', async () => {
  execFileSync(process.execPath,['scripts/build-access-helper.mjs'])
  const html = await readFile('dist/animer-access-helper.html','utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  assert.ok(html.includes(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`))
  assert.match(html,/connect-src 'none'/)
  assert.match(html,/form-action 'none'/)
  assert.doesNotMatch(script,/\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB)\b/)
  assert.doesNotMatch(html,/<(?:script|link|img)[^>]+(?:src|href)=/)
  assert.match(script,/getRandomValues\(new Uint8Array\(32\)\)/)
  assert.match(script,/SHA-256/)
  assert.match(script,/pagehide/)
  assert.match(html,/完整管理权限|管理站点/)
})
