import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHeaders, headersForPath } from './e2e/static-headers.mjs';

const rules = parseHeaders(await readFile(new URL('../public/_headers', import.meta.url), 'utf8'));

test('app navigation remains inline; helper alone downloads as an attachment', () => {
  for (const path of ['/', '/admin', '/admin/', '/watch/101', '/calendar', '/assets/index.js']) {
    const headers = headersForPath(rules, path);
    assert.equal(headers['content-disposition'], undefined, path);
    assert.match(headers['content-security-policy'], /object-src 'none'/, path);
    assert.equal(headers['x-content-type-options'], 'nosniff', path);
  }
  assert.equal(headersForPath(rules, '/animer-access-helper.html')['content-disposition'], 'attachment; filename="animer-access-helper.html"');
  assert.equal(headersForPath(rules, '/animer-access-helperXhtml')['content-disposition'], undefined);
});

test('admin-only privacy headers never leak into public routes', () => {
  for (const path of ['/admin', '/admin/', '/admin/nested']) {
    const headers = headersForPath(rules, path);
    assert.equal(headers['referrer-policy'], 'no-referrer', path);
    assert.equal(headers['cache-control'], 'no-store', path);
    assert.equal(headers['x-robots-tag'], 'noindex, nofollow', path);
  }
  for (const path of ['/', '/watch/101', '/administrator']) {
    const headers = headersForPath(rules, path);
    assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin', path);
    assert.equal(headers['x-robots-tag'], undefined, path);
  }
});

test('header parser handles CRLF, comments, wildcard scopes and case-insensitive overrides', () => {
  const parsed = parseHeaders('# comment\r\n/*\r\n  X-Test: global\r\n\r\n/assets/*.js\r\n  x-test: script\r\n/exact.html\r\n  X-Other: https://fixture.invalid:123\r\n');
  assert.deepEqual(headersForPath(parsed, '/assets/app.js'), { 'x-test': 'script' });
  assert.deepEqual(headersForPath(parsed, '/assets/app.css'), { 'x-test': 'global' });
  assert.deepEqual(headersForPath(parsed, '/exact.html'), { 'x-test': 'global', 'x-other': 'https://fixture.invalid:123' });
  assert.deepEqual(headersForPath(parsed, '/exactXhtml'), { 'x-test': 'global' });
});
