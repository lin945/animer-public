#!/usr/bin/env node
/**
 * functions/ 目录的语法检查。
 *
 * 为什么需要：`functions/` 不在任何 tsconfig 的 include 里（它的类型环境是 Workers 运行时，
 * 不是 DOM 也不是 Node），所以 `npm run type-check`（vue-tsc）覆盖不到它。
 * Wrangler 用 esbuild 打包 Pages Functions 时会直接剥掉类型、不做类型检查，
 * 于是 functions/ 里的低级语法错误只会在真正请求时才炸。
 *
 * 这里用 esbuild 做一次转译（只验语法，不做类型检查），把错误提前暴露出来。
 *
 * 用法：npm run check:api
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { transformSync } from 'esbuild'

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|mts|js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

const root = resolve('functions')
let files = []
try {
  files = walk(root)
} catch {
  files = []
}

const lines = []
let bad = 0
for (const f of files) {
  const label = relative(process.cwd(), f)
  try {
    transformSync(readFileSync(f, 'utf8'), { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: f })
    lines.push('OK   ' + label)
  } catch (e) {
    bad++
    const detail = (e.errors || [])
      .map((x) => `  line ${x.location?.line ?? '?'}:${x.location?.column ?? '?'} ${x.text}`)
      .join('\n')
    lines.push('ERR  ' + label + '\n' + (detail || '  ' + e.message))
  }
}
lines.push(bad ? `\nFAILED: ${bad} / ${files.length}` : `\nALL OK (${files.length} files)`)

const outPath = resolve('log/check-api.txt')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
process.exit(bad ? 1 : 0)

