<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ApiError, subscriptionStatus, syncSubscriptions, type SubscriptionStatus } from '../api'

const props = defineProps<{ authenticated?: boolean; sessionSignal?: AbortSignal }>()
const emit = defineEmits<{ 'access-error': [error: ApiError]; synced: [] }>()
const controller = new AbortController()
function cancel() { controller.abort(); status.value = null; msg.value = '' }
if (props.sessionSignal?.aborted) controller.abort()
props.sessionSignal?.addEventListener('abort', cancel, { once: true })
function accessError(error: unknown) {
  if (error instanceof ApiError && [401, 403, 503].includes(error.status)) {
    controller.abort()
    emit('access-error', error)
  }
}
const status = ref<SubscriptionStatus | null>(null)
const loading = ref(false)
const syncing = ref(false)
const msg = ref('')

async function load() {
  if (!props.authenticated || controller.signal.aborted) return
  loading.value = true
  try {
    const result = await subscriptionStatus(controller.signal)
    if (!controller.signal.aborted) status.value = result
  } catch (e: any) {
    if (controller.signal.aborted) return
    accessError(e)
    status.value = {
      ok: false,
      subscriptions: [],
      totalSources: 0,
      error: e?.message || String(e),
    }
  } finally {
    loading.value = false
  }
}

async function refresh() {
  if (!props.authenticated || syncing.value || controller.signal.aborted) return
  syncing.value = true
  msg.value = ''
  try {
    const r = await syncSubscriptions(controller.signal)
    if (controller.signal.aborted) return
    if (r.ok) {
      emit('synced')
      const created = r.created ? '（首次自动导入 animeko 默认源）' : ''
      msg.value = `同步完成${created}：共处理 ${r.synced ?? 0} 个播放源，当前可用 ${r.totalSources ?? 0} 个`
    } else {
      msg.value = '同步失败：' + (r.error || '未知错误')
    }
  } catch (e: any) {
    if (controller.signal.aborted) return
    accessError(e)
    msg.value = '同步请求失败：' + (e?.message || e)
  } finally {
    syncing.value = false
    await load()
  }
}

function fmtTime(ts: number | null): string {
  if (!ts) return '从未同步'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(load)
onBeforeUnmount(() => { cancel(); props.sessionSignal?.removeEventListener('abort', cancel) })
</script>

<template>
  <section v-if="authenticated" class="sub-status">
    <div class="head">
      <span class="title">📡 订阅源状态</span>
      <button class="refresh" :disabled="syncing" @click="refresh">
        {{ syncing ? '同步中…' : '🔄 刷新订阅' }}
      </button>
    </div>

    <div v-if="loading" class="line muted">加载中…</div>

    <template v-else-if="status">
      <div v-if="!status.ok" class="line warn">
        无法读取订阅状态：{{ status.error }}
      </div>
      <template v-else>
        <div class="line">
          可用播放源：<b>{{ status.totalSources }}</b> 个 ·
          订阅源：<b>{{ status.subscriptions.length }}</b> 个
        </div>
        <ul class="subs">
          <li v-for="s in status.subscriptions" :key="s.id">
            <span class="dot" :class="{ on: s.source_count > 0 }"></span>
            <span class="name">{{ s.name }}</span>
            <span class="meta">（{{ s.source_count }} 源 · 上次同步 {{ fmtTime(s.last_synced_at) }}）</span>
          </li>
          <li v-if="status.subscriptions.length === 0" class="muted">
            暂无订阅源，点击「刷新订阅」自动导入 animeko 默认源。
          </li>
        </ul>
      </template>
    </template>

    <div v-if="msg" class="line msg">{{ msg }}</div>
  </section>
</template>

<style scoped>
.sub-status {
  max-width: 720px;
  margin: 0 auto 20px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.title {
  font-weight: 600;
}
.refresh {
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.refresh:disabled {
  opacity: 0.6;
  cursor: default;
}
.line {
  font-size: 14px;
  margin: 4px 0;
}
.muted {
  color: var(--muted);
}
.warn {
  color: #ad6018;
}
.msg {
  color: var(--accent);
}
.subs {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
}
.subs li {
  font-size: 13px;
  padding: 3px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #666;
  flex: none;
}
.dot.on {
  background: #4caf50;
}
.name {
  font-weight: 600;
}
.meta {
  color: var(--muted);
}
</style>

