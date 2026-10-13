import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const media = await readFile(new URL('./fixtures/synthetic.mp4', import.meta.url));
const origin = 'http://127.0.0.1:4173';
export const subject = (id = 101, title = `测试番剧 ${id}`) => ({
  id, name: `Synthetic Anime ${id}`, name_cn: title, summary: '原创合成测试媒体', eps: 3,
  date: '2026-10-01', images: { large: '/fixture-cover.svg' },
  tags: [{ name: '冒险' }], rating: { score: 8.5, total: 100 }, rank: 40,
});
export const test = base.extend({
  fixture: [async ({ context, page }, use, testInfo) => {
    const requests = [], unexpected = [], errors = [];
    const overrides = new Map();
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { unexpected.push(url.href); await route.abort(); return; }
      const path = url.pathname;
      if (path === '/fixture-cover.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="#289bb6"/><circle cx="150" cy="150" r="85" fill="#ffdc77"/></svg>' });
      if (path === '/fixture.mp4' || path === '/api/play') return route.fulfill({ contentType: 'video/mp4', body: media });
      if (!path.startsWith('/api/')) return route.continue();
      requests.push({ path, query: Object.fromEntries(url.searchParams), method: route.request().method() });
      const override = overrides.get(path);
      if (override) return override(route, url);
      let data, status = 200;
      if (path === '/api/bgm-search') data = { list: [subject()] };
      else if (path === '/api/bgm-subject') data = subject(Number(url.searchParams.get('id')));
      else if (path === '/api/bgm-calendar') data = [{ weekday: { id: 2, cn: '星期二', en: 'Tue' }, items: [subject()] }];
      else if (path === '/api/media-sources') data = { mediaSources: [1, 2].map(id => ({ id, name: `本地测试源 ${id}`, enabled: 1, health: 'ok', only_supports_players: [] })) };
      else if (path === '/api/search') data = { items: [{ name: url.searchParams.get('keyword'), url: `${origin}/fixture-subject/${url.searchParams.get('sourceId')}` }], health: 'ok' };
      else if (path === '/api/episodes') {
        const id = url.searchParams.get('sourceId');
        const items = [1, 2, 3].map(n => ({ name: `第${n}集`, url: `${origin}/fixture-episode/${id}/${n}`, channel: '默认线路' }));
        data = { items, channels: [{ name: '默认线路', items }] };
      } else if (path === '/api/resolve') data = { streamUrl: `${origin}/fixture.mp4?ep=${encodeURIComponent(url.searchParams.get('episodeUrl'))}`, kind: 'file', via: 'local-fixture', failureKind: null, headers: {} };
      else if (path === '/api/danmaku') data = { items: [] };
      else if (path === '/api/admin/session') { status = 401; data = { error: 'Unauthorized fixture session' }; }
      else { unexpected.push(url.href); status = 500; data = { error: 'Unmocked API' }; }
      await route.fulfill({ status, json: data });
    });
    await use({ requests, overrides });
    await testInfo.attach('network-audit', { body: JSON.stringify({ requests, unexpected, errors }, null, 2), contentType: 'application/json' });
    expect(unexpected, 'No external requests or unmocked APIs').toEqual([]);
    expect(errors, 'No uncaught browser errors').toEqual([]);
  }, { auto: true }],
});
export { expect };
export async function readyVideo(page) {
  await expect.poll(() => page.locator('video').evaluate(v => v.readyState >= 3 && v.videoWidth > 0)).toBe(true);
  await expect(page.locator('.stage > .status')).toHaveCount(0);
  await page.locator('video').evaluate(v => v.pause());
}
export async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
