import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test, expect, noOverflow } from './fixtures.mjs';

// Deterministic fixture only; this test never generates a usable owner secret.
const syntheticBytes = Buffer.alloc(32, 11);
const syntheticToken = syntheticBytes.toString('base64url');
const syntheticOrigin = 'https://fixture.invalid';

test('offline access helper enforces CSP, recovers from invalid origin, and computes a synthetic SHA-256 without storage or network', async ({ page }) => {
  // A locally fulfilled empty document supplies a secure localhost origin for
  // native WebCrypto. This bootstrap never reaches a server or external host.
  await page.route('http://127.0.0.1:4173/__offline_helper_context__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local fixture</title>' }));
  await page.goto('/__offline_helper_context__');
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.evaluate(() => {
    window.__helperStorageAccess = [];
    window.__helperRandomCalls = 0;
    Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('Expected a 256-bit fixture request');
      window.__helperRandomCalls++;
      bytes.fill(11);
      return bytes;
    } });
    for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
      Object.defineProperty(window, name, { configurable: true, get() {
        window.__helperStorageAccess.push(name);
        throw new Error(`Offline helper must not access ${name}`);
      } });
    }
  });
  const html = await readFile(new URL('../../dist/animer-access-helper.html', import.meta.url), 'utf8');
  await page.setContent(html);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("form-action 'none'");
  expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
  expect(await page.evaluate(() => new Promise(resolve => {
    document.addEventListener('securitypolicyviolation', event => resolve(event.effectiveDirective), { once: true });
    const script = document.createElement('script');
    script.textContent = 'window.__unauthorizedHelperScript = true';
    document.body.append(script);
  }))).toMatch(/^script-src/);
  expect(await page.evaluate(() => window.__unauthorizedHelperScript)).toBeUndefined();
  const origin = page.locator('#origin');
  const link = page.locator('#access-link');
  const hash = page.locator('#access-hash');
  const submit = page.getByRole('button', { name: '在本地生成管理链接', exact: true });
  await origin.fill(`${syntheticOrigin}/unwanted-path`);
  await submit.click();
  await expect(page.getByRole('status')).toContainText('请输入完整 HTTPS 站点源');
  await expect(link).toHaveValue('');
  await expect(hash).toHaveValue('');
  expect(await page.evaluate(() => window.__helperRandomCalls)).toBe(0);
  await origin.fill(syntheticOrigin);
  await submit.click();
  await expect(link).toHaveValue(`${syntheticOrigin}/admin#access=${syntheticToken}`);
  await expect(hash).toHaveValue(createHash('sha256').update(syntheticToken, 'utf8').digest('hex'));
  expect(Buffer.from(syntheticToken, 'base64url')).toEqual(syntheticBytes);
  expect(await page.evaluate(() => window.__helperRandomCalls)).toBe(1);
  await expect(page.getByRole('status')).toContainText('已在本地生成');
  await expect(submit).toBeEnabled();
  await noOverflow(page);
  await page.getByRole('button', { name: '清除本页内容', exact: true }).click();
  await expect(link).toHaveValue('');
  await expect(hash).toHaveValue('');
  await expect(page.getByRole('status')).toContainText('已清除本页内容');
  expect(await page.evaluate(() => window.__helperStorageAccess)).toEqual([]);
  expect(requests, 'The helper must not issue any request').toEqual([]);
});
