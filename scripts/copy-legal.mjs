import { copyFile, mkdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)
await access(new URL('index.html', dist))
await mkdir(dist, { recursive: true })
for (const filename of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) {
  await copyFile(new URL(filename, root), new URL(filename, dist))
}
console.log(`Copied legal notices into ${fileURLToPath(dist)}`)
