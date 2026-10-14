import { test, expect, noOverflow } from './fixtures.mjs';

// Synthetic capability only: never put a real owner access link in tests or CI.
const token = Buffer.alloc(32, 7).toString('base64url');
const session = { authenticated: true, login: 'owner', provider: 'link' };
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
function mockAdmin(fixture, page, { status = 200, accessGate, logoutGate, authenticated = false } = {}) {
  const state = { authenticated, accessCalls: 0, logoutCalls: 0, accessFinished: false };
  fixture.overrides.set('/api/admin/session', route => route.fulfill({
    status: state.authenticated ? 200 : 401,
    json: state.authenticated ? session : { error: 'Unauthorized fixture session' },
  }));
  fixture.overrides.set('/api/auth/access', async route => {
    state.accessCalls++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-admin-request']).toBe('1');
    expect(route.request().headers()['content-type']).toContain('application/json');
    expect(route.request().postDataJSON()).toEqual({ token });
    expect(new URL(page.url()).hash, 'Strip fragment before exchanging the capability').toBe('');
    if (accessGate) await accessGate.promise;
    state.authenticated = status === 200;
    try { await route.fulfill({ status, json: status === 200 ? session : { error: 'Invalid or unavailable access link' } }); }
    catch { /* Cancellation intentionally aborts a pending exchange. */ }
    finally { state.accessFinished = true; }
  });
  fixture.overrides.set('/api/auth/logout', async route => {
    state.logoutCalls++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-admin-request']).toBe('1');
    if (logoutGate) await logoutGate.promise;
    state.authenticated = false;
    await route.fulfill({ json: { ok: true } });
  });
  fixture.overrides.set('/api/admin/media-sources', route => {
    expect(state.authenticated, 'Management data requires an authenticated session').toBe(true);
    return route.fulfill({ json: { mediaSources: [{ id: 1, name: '本地管理测试源', enabled: 1, health: 'ok' }] } });
  });
  fixture.overrides.set('/api/admin/subscription-status', route => {
    expect(state.authenticated).toBe(true);
    return route.fulfill({ json: { ok: true, subscriptions: [], totalSources: 1 } });
  });
  return state;
}
const managementRequests = fixture => fixture.requests.filter(r => r.path.startsWith('/api/admin/') && r.path !== '/api/admin/session');
async function noCredentialPersistence(page) {
  const saved = await page.evaluate(() => JSON.stringify({
    local: { ...localStorage }, session: { ...sessionStorage }, history: history.state, url: location.href,
  }));
  expect(saved).not.toContain(token);
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.locator('.admin input[type="password"], .admin input[name="username"]')).toHaveCount(0);
}
function auditCapabilityRequests(page) {
  const leaked = [];
  page.on('request', request => {
    if (request.url().includes(token) || (request.headers().referer || '').includes(token)) leaked.push(request.url());
    if (request.postData()?.includes(token) && new URL(request.url()).pathname !== '/api/auth/access') leaked.push(request.url());
  });
  return leaked;
}

test('capability link exchanges once, strips history and survives session reload; logout clears management immediately', async ({ page, fixture }) => {
  const accessGate = gate(), logoutGate = gate();
  const state = mockAdmin(fixture, page, { accessGate, logoutGate });
  const leaked = auditCapabilityRequests(page);
  await page.goto(`/admin#access=${token}`);
  await expect.poll(() => state.accessCalls).toBe(1);
  await noCredentialPersistence(page);
  expect(managementRequests(fixture)).toEqual([]);
  accessGate.release();
  await expect(page.getByText('本地管理测试源', { exact: true })).toBeVisible();
  await expect(page.locator('.session')).toContainText('owner');
  const sessionIndex = fixture.requests.findIndex(r => r.path === '/api/admin/session');
  expect(sessionIndex).toBeGreaterThanOrEqual(0);
  expect(fixture.requests.findIndex(r => r.path === '/api/admin/media-sources')).toBeGreaterThan(sessionIndex);
  await noCredentialPersistence(page);
  await noOverflow(page);
  await page.getByRole('link', { name: '找番', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(1);
  await page.goBack();
  await expect(page.getByText('本地管理测试源', { exact: true })).toBeVisible();
  await noCredentialPersistence(page);
  await page.reload();
  await expect(page.getByText('本地管理测试源', { exact: true })).toBeVisible();
  expect(state.accessCalls).toBe(1);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect.poll(() => state.logoutCalls).toBe(1);
  await expect(page.getByText('本地管理测试源', { exact: true })).toHaveCount(0);
  await expect(page.locator('.sub-status')).toHaveCount(0);
  logoutGate.release();
  await expect(page.locator('.gate')).toBeVisible();
  await page.reload();
  await expect(page.locator('.gate')).toBeVisible();
  await expect(page.getByText('本地管理测试源', { exact: true })).toHaveCount(0);
  expect(state.accessCalls).toBe(1);
  expect(leaked).toEqual([]);
  await noCredentialPersistence(page);
});

for (const fragment of ['', '#access=invalid']) {
  test(`missing or malformed capability is restricted (${fragment || 'missing'})`, async ({ page, fixture }) => {
    const state = mockAdmin(fixture, page);
    await page.goto(`/admin${fragment}`);
    await expect(page.locator('.gate')).toBeVisible();
    await expect(page.getByRole('button', { name: '重新验证现有会话', exact: true })).toBeVisible();
    expect(state.accessCalls).toBe(0);
    expect(managementRequests(fixture)).toEqual([]);
    await noCredentialPersistence(page);
    await noOverflow(page);
  });
}

for (const status of [401, 429]) {
  test(`capability exchange ${status} never mounts management data`, async ({ page, fixture }) => {
    const state = mockAdmin(fixture, page, { status });
    await page.goto(`/admin#access=${token}`);
    await expect.poll(() => state.accessFinished).toBe(true);
    await expect(page.getByRole('button', { name: '重新验证现有会话', exact: true })).toBeVisible();
    await expect(page.locator('.gate')).toBeVisible();
    expect(managementRequests(fixture)).toEqual([]);
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0);
    expect(state.accessCalls).toBe(1);
    await noCredentialPersistence(page);
    await noOverflow(page);
  });
}

test('navigation aborts a pending capability exchange and ignores the late response', async ({ page, fixture }) => {
  const accessGate = gate();
  const state = mockAdmin(fixture, page, { accessGate });
  await page.goto(`/admin#access=${token}`);
  await expect.poll(() => state.accessCalls).toBe(1);
  await page.getByRole('link', { name: '找番', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(1);
  accessGate.release();
  await expect.poll(() => state.accessFinished).toBe(true);
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  expect(managementRequests(fixture)).toEqual([]);
  await noCredentialPersistence(page);
});

test('same-page capability fragment is scrubbed before a fresh exchange', async ({ page, fixture }) => {
  const state = mockAdmin(fixture, page);
  await page.goto('/admin');
  await expect(page.getByRole('button', { name: '重新验证现有会话', exact: true })).toBeVisible();
  await page.evaluate(value => { location.hash = `access=${value}`; }, token);
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await expect.poll(() => state.accessCalls).toBe(1);
  await expect(page.getByText('本地管理测试源', { exact: true })).toBeVisible();
  await noCredentialPersistence(page);
  await page.reload();
  await expect(page.getByText('本地管理测试源', { exact: true })).toBeVisible();
  expect(state.accessCalls).toBe(1);
});
