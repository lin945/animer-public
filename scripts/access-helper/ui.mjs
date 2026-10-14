const origin = document.querySelector('#origin')
const output = document.querySelector('#access-link')
const hashOutput = document.querySelector('#access-hash')
const status = document.querySelector('#status')
const generate = document.querySelector('#generate')
let generation = 0
const clear = () => { generation++; output.value = ''; hashOutput.value = ''; status.textContent = '已清除本页内容。剪贴板不会自动修改。'; generate.disabled = false }
document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault()
  if (generate.disabled) return
  clear()
  let site
  try { site = new URL(origin.value); if (site.protocol !== 'https:' || site.origin !== origin.value) throw new Error() }
  catch { status.textContent = '请输入完整 HTTPS 站点源，不带路径或结尾斜杠。'; return }
  if (!crypto?.subtle || !crypto.getRandomValues) { status.textContent = '浏览器不支持安全密码学功能，请在可信浏览器中打开此文件。'; return }
  const current = ++generation
  generate.disabled = true
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  bytes.fill(0)
  try {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
    if (current === generation) {
      output.value = `${site.origin}/admin#access=${token}`
      hashOutput.value = Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')
      status.textContent = '已在本地生成。仅将哈希作为 ADMIN_ACCESS_TOKEN_HASH Secret 保存到 Cloudflare。管理链接授予完整管理权限，请存入自己的密码管理器，不要发到聊天或仓库。'
    }
    hash.fill(0)
  } catch { if (current === generation) status.textContent = '生成失败，请重试。' }
  finally { token = ''; if (current === generation) generate.disabled = false }
})
document.querySelector('#clear').addEventListener('click', clear)
window.addEventListener('pagehide', clear)
