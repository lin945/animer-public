// 搜索数据源冒烟测试：验证 Bangumi 目录搜索可用且返回中文数据。
// 用法：node scripts/smoke-search.mjs [关键词]
// 优先用 node fetch（用户机器直连）；失败时回退 curl（沙箱仅代理出口可达，curl 会读 HTTPS_PROXY）。
import { execFileSync } from 'node:child_process'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const kw = process.argv[2] || '鬼灭之刃'
const url = `https://api.bgm.tv/search/subject/${encodeURIComponent(kw)}?type=2&responseGroup=medium`

async function fetchJson(u) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.json()
  } catch {
    const out = execFileSync('curl', ['-sSL', '-A', UA, '-H', 'Accept: application/json', u], {
      maxBuffer: 16 * 1024 * 1024,
    })
    return JSON.parse(out.toString('utf8'))
  }
}

try {
  const j = await fetchJson(url)
  const list = j.list || []
  if (list.length === 0) {
    console.error(`FAIL: 关键词「${kw}」无结果 (results=${j.results})`)
    process.exit(1)
  }
  console.log(`OK: results=${j.results}, 展示前 3 条:`)
  for (const x of list.slice(0, 3)) {
    const cover = (x.images?.large || '').replace('http://', 'https://')
    console.log(`  - id=${x.id} | ${x.name_cn || x.name} | 集数=${x.eps ?? '?'} | cover=${cover ? '有' : '无'}`)
  }
  console.log('SMOKE TEST PASSED')
} catch (e) {
  console.error('FAIL:', e?.message || e)
  process.exit(1)
}

