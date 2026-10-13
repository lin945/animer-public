#!/usr/bin/env node
/**
 * 把 log/pipeline-report.json 压成可读摘要（log/pipeline-summary.txt）。
 *
 * 分阶段测试（npm run test:pipeline）的完整证据是 JSON，几百上千行，
 * 出问题时最需要的是「每个源卡在哪一步、证据是什么」这一张表。
 *
 * 用法：
 *   npm run report                  # 读 log/pipeline-report.json
 *   npm run report -- other.json    # 指定报告文件
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LOG_DIR = path.resolve(process.cwd(), 'log')
const src = process.argv[2] ? path.resolve(process.argv[2]) : path.join(LOG_DIR, 'pipeline-report.json')
const out = path.join(LOG_DIR, 'pipeline-summary.txt')

const r = JSON.parse(readFileSync(src, 'utf8'))
const L = []
L.push(`BASE=${r.base}  TERM=${r.term}  at=${r.at}`)
L.push(
  `端到端 ${r.summary.endToEnd}/${r.summary.total}；通过 ${JSON.stringify(r.summary.ok)}；失败 ${JSON.stringify(r.summary.fail)}`
)
L.push(`卡点分布（从多到少）：${r.summary.bottleneck || '无'}`)
L.push('')

for (const s of r.sources) {
  L.push(
    `--- #${s.id} ${s.name}  ${s.failedAt ? 'FAIL@' + s.failedAt : 'OK'}` +
      `  kw=${s.usedKeyword || s.hitKeyword || '-'}  eps=${s.episodes?.count ?? 0}` +
      (s.resolve?.via ? `  via=${s.resolve.via}` : '') +
      (s.resolve?.failureKind ? `  [${s.resolve.failureKind}]` : '')
  )
  if (s.failedAt === 'S3_search') {
    for (const t of s.searchTries || []) {
      L.push(
        `    kw="${t.keyword}" http=${t.http} count=${t.count} up=${t.upstreamStatus} len=${t.bodyLength}` +
          ` nodes=${t.matchNames}/${t.matchLinks} failure=${t.failureKind || '-'} note=${t.note || '-'}`
      )
    }
    if (s.evidence?.S3) L.push(`    判定：${s.evidence.S3.verdict}；证据 ${JSON.stringify(s.evidence.S3)}`)
    continue
  }
  L.push(
    `    S4: ${JSON.stringify({
      count: s.episodes?.count,
      up: s.episodes?.upstreamStatus,
      len: s.episodes?.bodyLength,
      nodes: s.episodes?.matchNodes,
      note: s.episodes?.note,
    })}`
  )
  if (s.resolve) {
    L.push(
      `    S5: ${JSON.stringify({
        streamUrl: s.resolve.streamUrl,
        kind: s.resolve.kind,
        via: s.resolve.via,
        failureKind: s.resolve.failureKind,
        up: s.resolve.upstreamStatus,
        len: s.resolve.bodyLength,
        blocked: s.resolve.blocked,
        note: s.resolve.note,
        iframes: s.resolve.iframes,
        playerHint: s.resolve.playerHint,
      })}`
    )
    if (s.resolve.attempts) L.push(`    S5.取流尝试：${JSON.stringify(s.resolve.attempts)}`)
  }
  if (s.play) L.push(`    S6: ${JSON.stringify(s.play)}`)
}

writeFileSync(out, L.join('\n') + '\n', 'utf8')
console.log(`摘要 → ${path.relative(process.cwd(), out)}`)

