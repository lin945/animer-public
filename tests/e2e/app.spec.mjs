import { test, expect, subject, readyVideo, noOverflow } from './fixtures.mjs';

test('search, calendar, watch and browser back/forward navigation', async ({ page, fixture }) => {
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(1);
  await noOverflow(page);
  await page.getByRole('link', { name: '新番日历', exact: true }).click();
  await expect(page.locator('.calendar-page article')).toHaveCount(1);
  await noOverflow(page);
  await page.locator('.calendar-page article').click();
  await readyVideo(page);
  await expect(page.locator('.episodes li.active')).toHaveText('第1集');
  await noOverflow(page);
  await page.goBack();
  await expect(page.locator('.calendar-page article')).toBeVisible();
  await page.goForward();
  await expect(page.locator('.episodes li.active')).toHaveText('第1集');
  expect(fixture.requests.filter(r => r.path.startsWith('/api/admin'))).toEqual([]);
});

test('a late search cannot overwrite the newer search', async ({ page, fixture }) => {
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(1);
  let releaseOld;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  let oldStarted = false, oldFinished = false;
  fixture.overrides.set('/api/bgm-search', async (route, url) => {
    const old = url.searchParams.get('q') === 'old';
    if (old) { oldStarted = true; await oldGate; }
    try { await route.fulfill({ json: { list: [subject(old ? 201 : 202, old ? '旧结果' : '新结果')] } }); }
    catch { /* Aborted stale fetch is the expected cancellation path. */ }
    finally { if (old) oldFinished = true; }
  });
  const input = page.getByRole('textbox', { name: '搜索番剧目录', exact: true });
  await input.fill('old');
  await input.press('Enter');
  await expect.poll(() => oldStarted).toBe(true);
  await input.fill('new');
  await input.press('Enter');
  await expect(page.locator('.card h3')).toHaveText('新结果');
  releaseOld();
  await expect.poll(() => oldFinished).toBe(true);
  await expect(page.locator('.card h3')).toHaveText('新结果');
});

test('manual source switch keeps the episode and latest episode wins', async ({ page, fixture }) => {
  await page.goto('/watch/101');
  await readyVideo(page);
  await page.locator('.episodes li').nth(1).click();
  await readyVideo(page);
  await page.locator('.controls select').selectOption('2');
  await expect.poll(() => fixture.requests.filter(r => r.path === '/api/resolve').at(-1)?.query.episodeUrl).toContain('/2/2');
  await readyVideo(page);
  await expect(page.locator('.episodes li.active')).toHaveText('第2集');
  let releaseOld;
  const gate = new Promise(resolve => { releaseOld = resolve; });
  let started = false, finished = false;
  fixture.overrides.set('/api/resolve', async (route, url) => {
    const ep = url.searchParams.get('episodeUrl');
    const old = ep.endsWith('/1');
    if (old) { started = true; await gate; }
    try { await route.fulfill({ json: { streamUrl: `http://127.0.0.1:4173/fixture.mp4?ep=${encodeURIComponent(ep)}`, kind: 'file', headers: {} } }); }
    catch { /* The cancelled request may already be closed. */ }
    finally { if (old) finished = true; }
  });
  await page.locator('.episodes li').nth(0).click();
  await expect.poll(() => started).toBe(true);
  await page.locator('.episodes li').nth(2).click();
  await readyVideo(page);
  releaseOld();
  await expect.poll(() => finished).toBe(true);
  await expect(page.locator('.episodes li.active')).toHaveText('第3集');
  await expect(page.locator('video')).toHaveAttribute('src', /%2F2%2F3/);
});

test('preferences and watch progress survive reload and appear in recent history', async ({ page }) => {
  await page.goto('/watch/101');
  await readyVideo(page);
  await page.locator('.player-tools select').selectOption('1.5');
  await page.getByRole('checkbox', { name: '自动下一集' }).check();
  await page.getByRole('spinbutton').fill('12');
  await page.getByRole('spinbutton').blur();
  await page.locator('video').evaluate(v => { v.currentTime = 15; v.dispatchEvent(new Event('timeupdate')); v.dispatchEvent(new Event('pause')); });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('animer:recent:v1'))[0].position)).toBeGreaterThanOrEqual(15);
  await page.reload();
  await readyVideo(page);
  await expect(page.locator('.player-tools select')).toHaveValue('1.5');
  await expect(page.getByRole('checkbox', { name: '自动下一集' })).toBeChecked();
  await expect(page.getByRole('spinbutton')).toHaveValue('12');
  await expect.poll(() => page.locator('video').evaluate(v => v.currentTime)).toBeGreaterThanOrEqual(14);
  await page.getByRole('link', { name: '找番', exact: true }).click();
  await expect(page.locator('.recent-card')).toHaveCount(1);
  await expect(page.locator('.recent-card')).toContainText('第1集');
  await page.locator('.recent-card').click();
  await expect(page).toHaveURL(/\/watch\/101$/);
});

test('cancel and navigation stop auto-next countdown', async ({ page, fixture }) => {
  await page.goto('/watch/101');
  await readyVideo(page);
  await page.clock.install();
  await page.getByRole('checkbox', { name: '自动下一集' }).check();
  await page.locator('video').evaluate(v => v.dispatchEvent(new Event('ended')));
  await page.getByRole('button', { name: '取消自动连播' }).click();
  const resolves = () => fixture.requests.filter(r => r.path === '/api/resolve').length;
  const before = resolves();
  await page.clock.fastForward(6000);
  await expect(page.locator('.episodes li.active')).toHaveText('第1集');
  expect(resolves()).toBe(before);
  await page.locator('video').evaluate(v => v.dispatchEvent(new Event('ended')));
  await expect(page.getByRole('button', { name: '取消自动连播' })).toBeVisible();
  await page.getByRole('link', { name: '找番', exact: true }).click();
  await page.clock.fastForward(6000);
  expect(resolves()).toBe(before);
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
});

test('unauthenticated admin probes session only and never loads management data', async ({ page, fixture }) => {
  await page.goto('/admin');
  await expect(page.getByText('请使用站点所有者的 GitHub 账号登录。')).toBeVisible();
  await noOverflow(page);
  expect(fixture.requests.filter(r => r.path.startsWith('/api/admin'))).toEqual([
    { path: '/api/admin/session', query: {}, method: 'GET' },
  ]);
  await expect(page.locator('.source-row')).toHaveCount(0);
});


test('a single non-exact candidate is manually selectable and danmaku settings stay local', async ({page, fixture}) => {
  fixture.overrides.set('/api/search', async route => route.fulfill({json:{items:[{name:'不同名称的候选',url:'http://127.0.0.1:4173/fixture-subject/1'}]}}));
  await page.goto('/watch/101');
  const candidate=page.getByRole('button',{name:'不同名称的候选',exact:true});
  await expect(candidate).toBeVisible();
  await candidate.click();
  await readyVideo(page);
  await page.getByText('弹幕设置',{exact:true}).click();
  await expect(page.getByText('设置仅保存在当前浏览器。弹幕只读。')).toBeVisible();
  await page.getByRole('textbox',{name:'屏蔽关键词'}).fill('local-filter');
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('animer:danmaku:settings:v1')||'{}').blocklist)).toBe('local-filter');
  expect(fixture.requests.filter(request=>request.method!=='GET')).toEqual([]);
  await noOverflow(page);
});
