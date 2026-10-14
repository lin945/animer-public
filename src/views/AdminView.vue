<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ApiError, adminSession, adminAccess, adminLogout, adminMediaSources, checkSourceHealth, updateSource, type MediaSource } from '../api'
import SubscriptionStatus from './SubscriptionStatus.vue'
import { takeAdminAccess, clearAdminAccess, ADMIN_ACCESS_EVENT } from '../admin-access'

const authorized = ref(false)
const verifying = ref(false)
const gateStatus = ref(0)
const sources = ref<MediaSource[]>([])
const busy = ref(false)
const message = ref('')
const login = ref('')
const loggingOut = ref(false)
const logoutFailed = ref(false)
let controller = new AbortController()
const gateMessage = computed(() => ({
  401: '此页面需要有效的管理链接。请通过站点所有者提供的链接访问。',
  403: '无法验证管理访问权限。请使用有效的管理链接。',
  429: '请求过于频繁，请稍后使用管理链接重试。',
  503: '管理访问暂不可用，请联系站点所有者。',
}[gateStatus.value] || '暂时无法验证管理员身份，请稍后重试。'))

function handleError(error: unknown) {
  if (controller.signal.aborted) return
  if (error instanceof ApiError && [401, 403, 503].includes(error.status)) {
    authorized.value = false
    gateStatus.value = error.status
    sources.value = []
    login.value = ''
    message.value = ''
    controller.abort()
  } else {
    message.value = error instanceof Error ? error.message : '请求失败，请稍后重试。'
  }
}
async function loadSources() {
  const request = controller
  const result = await adminMediaSources(request.signal)
  if (!request.signal.aborted && request === controller && authorized.value) sources.value = result
}
async function refreshSources() {
  if (!authorized.value || controller.signal.aborted) return
  try { await loadSources() } catch (error) { handleError(error) }
}
async function verify() {
  if (verifying.value || loggingOut.value) return
  controller.abort()
  controller = new AbortController()
  const request = controller
  verifying.value = true
  authorized.value = false
  sources.value = []
  message.value = ''
  gateStatus.value = 0
  login.value = ''
  logoutFailed.value = false
  try {
    const access = takeAdminAccess()
    if (access.present) {
      if (!access.token) throw new ApiError(403, '无效的管理链接')
      let exchange: Promise<void>
      try { exchange = adminAccess(access.token, request.signal) } finally { access.token = null }
      await exchange
      if (request.signal.aborted || request !== controller) return
    }
    const session = await adminSession(request.signal)
    if (request.signal.aborted || request !== controller) return
    login.value = session?.login || ''
    authorized.value = true
    await loadSources()
  } catch (error) {
    if (request === controller && !request.signal.aborted) handleError(error)
  } finally {
    if (request === controller) verifying.value = false
  }
}
async function run(action: () => Promise<unknown>, success: string) {
  if (!authorized.value || busy.value) return
  const request = controller
  busy.value = true
  message.value = ''
  try {
    await action()
    if (request.signal.aborted || request !== controller) return
    await loadSources()
    if (request.signal.aborted || request !== controller) return
    message.value = success
  } catch (error) {
    if (request === controller && !request.signal.aborted) handleError(error)
  } finally {
    if (request === controller) busy.value = false
  }
}
async function logout() {
  if (loggingOut.value) return
  clearAdminAccess()
  // Abort parent and subscription requests before any logout network operation.
  controller.abort()
  controller = new AbortController()
  const request = controller
  authorized.value = false
  sources.value = []
  login.value = ''
  message.value = ''
  busy.value = false
  verifying.value = false
  gateStatus.value = 401
  loggingOut.value = true
  logoutFailed.value = false
  try {
    await adminLogout(request.signal)
  } catch {
    if (!request.signal.aborted) {
      logoutFailed.value = true
      message.value = '管理数据已从页面清除，但退出登录尚未确认，请重试。'
    }
  } finally {
    if (request === controller) loggingOut.value = false
  }
}
function toggle(source: MediaSource) {
  return run(() => updateSource(source.id, { enabled: !source.enabled }, controller.signal), '播放源状态已更新。')
}
function checkHealth() {
  return run(async () => {
    const result = await checkSourceHealth(undefined, controller.signal)
    if (!result.ok) throw new Error(result.error || '健康检查失败')
  }, '健康检查已完成。')
}
function receiveAccess() {
  // Do not race a logout cookie response with a new session exchange.
  if (loggingOut.value) { clearAdminAccess(); return }
  controller.abort()
  verifying.value = false
  void verify()
}
onMounted(() => {
  if (typeof window !== 'undefined') window.addEventListener(ADMIN_ACCESS_EVENT, receiveAccess)
  return verify()
})
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener(ADMIN_ACCESS_EVENT, receiveAccess)
  clearAdminAccess()
  controller.abort()
  sources.value = []
  authorized.value = false
  login.value = ''
  message.value = ''
})
</script>

<template>
  <section class="admin">
    <header><p class="eyebrow">ANIMER · ADMIN</p><h1>播放源管理</h1><p>管理订阅与源健康状态。通过专属管理链接验证访问权限。</p></header>
    <div v-if="!authorized" class="panel gate" role="status" aria-live="polite">
      <template v-if="loggingOut">正在退出登录…</template>
      <template v-else-if="verifying">正在验证管理员身份…</template>
      <template v-else>
        <h2>{{ gateStatus === 401 ? '需要管理访问权限' : gateStatus ? `访问受限 · ${gateStatus}` : '无法连接管理服务' }}</h2>
        <p>{{ gateMessage }}</p>
        <p v-if="message" role="alert">{{ message }}</p>
        <button v-if="logoutFailed" @click="logout">重试退出登录</button>
        <button v-else @click="verify">重新验证现有会话</button>
      </template>
    </div>
    <template v-else>
      <div class="toolbar session"><p>管理会话已验证<span v-if="login"> · {{ login }}</span></p><button @click="logout">退出登录</button></div>
      <SubscriptionStatus :authenticated="authorized" :session-signal="controller.signal" @access-error="handleError" @synced="refreshSources" />
      <section class="panel">
        <div class="toolbar"><h2>播放源</h2><button :disabled="busy || verifying" @click="checkHealth">{{ busy ? '处理中…' : '检查健康状态' }}</button></div>
        <p v-if="message" role="status">{{ message }}</p>
        <p v-if="verifying">正在加载播放源…</p>
        <p v-else-if="sources.length === 0">暂无播放源。可先同步订阅。</p>
        <ul class="sources">
          <li v-for="source in sources" :key="source.id">
            <div><strong>{{ source.name }}</strong><p>{{ source.health || 'unknown' }} · {{ source.enabled ? '已启用' : '已停用' }}</p><p v-if="source.health_reason">{{ source.health_reason }}</p></div>
            <div class="actions"><button :disabled="busy" @click="toggle(source)">{{ source.enabled ? '停用' : '启用' }}</button></div>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.admin { max-width: 900px; margin: 0 auto; }
.admin header { margin-bottom: 28px; }
.eyebrow { color: var(--accent); font-size: 12px; letter-spacing: .15em; }
h1 { margin: 8px 0; } h2 { font-size: 18px; margin: 0; }
p { color: var(--muted); line-height: 1.7; }
.panel { border: 1px solid var(--border); border-radius: 14px; background: var(--surface); padding: 22px; margin-bottom: 20px; }
.toolbar, .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }.toolbar { justify-content: space-between; }
button { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 9px 13px; color: var(--text); cursor: pointer; font: inherit; font-size: 13px; }
button:disabled { opacity: .5; cursor: wait; }
.sources { list-style: none; padding: 0; }.sources > li { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: 12px; padding: 18px 0; border-bottom: 1px solid var(--border); }.sources p { margin: 4px 0; font-size: 13px; overflow-wrap: anywhere; }
</style>
