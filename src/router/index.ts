import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

import SearchView from '@/views/SearchView.vue'

// 路由约定：
//   /            搜索页（目录层）
//   /watch/:id   详情/播放页，id 为 Bangumi subject id
// 详情页元信息（BangumiSubject）由 store 的内存 + sessionStorage 缓存提供，
// 直链/刷新时回退到后端 /api/bgm-subject 拉取，所以 URL 本身就是可分享的。
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'search',
    component: SearchView,
  },
  {
    path: '/watch/:id',
    name: 'watch',
    component: () => import('@/views/WatchView.vue'),
    props: (route) => ({ id: Number(route.params.id) }),
  },
  { path: '/calendar', name: 'calendar', component: () => import('@/views/CalendarView.vue') },
  { path: '/admin', name: 'admin', component: () => import('@/views/AdminView.vue'), meta: { sensitive: true } },
  // 未知路径（含旧书签）回到搜索页
  {
    path: '/:pathMatch(.*)*',
    redirect: { name: 'search' },
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  // 前进/后退还原滚动位置，新导航回到顶部
  scrollBehavior(to, _from, savedPosition) {
    if (to.hash) return { el: to.hash, top: 100 }
    return savedPosition ?? { top: 0 }
  },
})

