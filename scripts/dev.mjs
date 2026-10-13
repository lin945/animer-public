#!/usr/bin/env node
/**
 * 本地一键启动：前端（Vite）+ 后端（Cloudflare Pages Functions）。
 *
 * 做的事：
 *   1. 应用本地 D1 迁移（把 migrations/*.sql 灌进本地 sqlite，失败不阻塞启动）；
 *   2. 起后端 wrangler pages dev（Functions + 本地 D1/KV 模拟），端口 8788；
 *   3. 起前端 vite dev server，端口 5173，并把 /api/* 反代到 8788。
 *
 * 用法：
 *   npm run dev                 # 一键前后端
 *   SKIP_DB_MIGRATE=1 npm run dev   # 跳过迁移（例如离线）
 *   API_PORT=9000 WEB_PORT=3000 npm run dev
 *
 * Ctrl+C 会同时关闭前后端。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'

const API_PORT = process.env.API_PORT || '8788'
const WEB_PORT = process.env.WEB_PORT || '5173'
const DB_NAME = process.env.DB_NAME || 'animer-db'
const PERSIST_TO = '.wrangler/state'
// API-only 的静态目录：前端资源由 Vite 提供，这里只为了让 pages dev 有个 assets 目录
const ASSETS_DIR = 'public'

const binPath = (name) => path.join(ROOT, 'node_modules', '.bin', IS_WIN ? `${name}.cmd` : name)

// 本机若设了 HTTP_PROXY/HTTPS_PROXY（公司代理、抓包工具等），
// 子进程可能把 127.0.0.1 的请求也丢给代理，导致 /api 反代 502（upstream connect failed）。
// 强制把 loopback 加进 NO_PROXY，让本地前后端直连。
function envWithLocalNoProxy() {
  const env = { ...process.env }
  const local = ['localhost', '127.0.0.1', '::1']
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const cur = env[key] ? env[key].split(',').map((s) => s.trim()).filter(Boolean) : []
    const merged = [...new Set([...cur, ...local])]
    env[key] = merged.join(',')
  }
  return env
}

const CHILD_ENV = envWithLocalNoProxy()
CHILD_ENV.API_ORIGIN = process.env.API_ORIGIN || `http://127.0.0.1:${API_PORT}`

function log(tag, msg) {
  process.stdout.write(`\x1b[2m[${tag}]\x1b[0m ${msg}\n`)
}

// Windows 下用 shell 执行 .cmd 时，路径含空格必须自己加引号（Node 不会自动处理）
const quote = (cmd) => (IS_WIN && cmd.includes(' ') ? `"${cmd}"` : cmd)

function run(cmd, args, { inherit = true } = {}) {
  return spawnSync(quote(cmd), args, {
    cwd: ROOT,
    stdio: inherit ? 'inherit' : 'pipe',
    shell: IS_WIN,
    env: CHILD_ENV,
  })
}

// ---------- 0. 依赖检查 ----------
const wrangler = binPath('wrangler')
const vite = binPath('vite')
for (const [name, p] of [
  ['wrangler', wrangler],
  ['vite', vite],
]) {
  if (!existsSync(p)) {
    console.error(`✖ 未找到 ${name}（${p}）。请先执行： npm install`)
    process.exit(1)
  }
}

// ---------- 1. 本地 D1 迁移（尽力而为） ----------
mkdirSync(path.join(ROOT, '.wrangler'), { recursive: true })

if (process.env.SKIP_DB_MIGRATE === '1') {
  log('db', '已跳过迁移（SKIP_DB_MIGRATE=1）')
} else {
  log('db', `应用本地 D1 迁移 → ${DB_NAME}（${PERSIST_TO}）`)
  const r = run(wrangler, ['d1', 'migrations', 'apply', DB_NAME, '--local', '--persist-to', PERSIST_TO])
  if (r.status !== 0) {
    // 迁移失败不阻塞：空库时后端已有优雅降级（media-sources 返回 []，
    // 点首页「🔄 刷新订阅」即可重新灌源）。
    log('db', '⚠️ 本地迁移未成功，继续启动（可在启动后重跑：npm run db:local）')
  } else {
    log('db', '✅ 本地 D1 就绪')
  }
}

// ---------- 2. 前后端进程 ----------
const children = []
let shuttingDown = false

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) killTree(c)
  setTimeout(() => process.exit(code), 200)
}

function start(tag, args) {
  const isVite = tag === 'web'
  const child = spawn(quote(isVite ? vite : wrangler), args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN,
    env: CHILD_ENV,
    // 非 Windows 下单独建进程组，便于整组回收
    detached: !IS_WIN,
  })
  children.push(child)
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    log(tag, `进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
    shutdown(code ?? 0)
  })
  child.on('error', (err) => {
    log(tag, '启动失败：' + err.message)
    shutdown(1)
  })
  return child
}

process.on('SIGINT', () => {
  log('dev', '收到 Ctrl+C，关闭前后端…')
  shutdown(0)
})
process.on('SIGTERM', () => shutdown(0))
process.on('exit', () => {
  if (!shuttingDown) for (const c of children) killTree(c)
})

console.log(`
\x1b[1m🍥 animer 本地开发\x1b[0m
  前端  → http://localhost:${WEB_PORT}
  后端  → http://localhost:${API_PORT}  (Functions /api/*，本地 D1 + KV)
  提示  → 打开前端地址即可，/api 已自动反代到后端；Ctrl+C 同时退出
`)

start('api', [
  'pages',
  'dev',
  ASSETS_DIR,
  '--port',
  API_PORT,
  '--persist-to',
  PERSIST_TO,
])
start('web', ['--port', WEB_PORT])

