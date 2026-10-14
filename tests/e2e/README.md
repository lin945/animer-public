# Local-only browser regression tests

Run `npm ci`, `npm run check`, `npx playwright install --with-deps chromium`,
then `npm run test:e2e`. GitHub Actions runs the same commands on Ubuntu with
Node 24. Desktop Chromium and mobile Chromium (Pixel 7 emulation) execute the
same browser flows. Mobile emulation is not a physical Android-device test.

The static server serves the built `dist` and has no production API/database
connection. Playwright supplies all API responses and fails any unmocked API
or off-origin request. Service workers are disabled to keep interception
complete. The original synthetic 45-second MP4 is checked in; it has no anime
content, account information or external media dependency. Fixtures do not
exercise live scraping, upstream reliability, real authentication sessions, server-side capability validation or D1.

Tests cover navigation/back/forward, out-of-order search, same-episode manual
source switching, stale episode resolution, preference/progress persistence,
recent-history navigation, cancelled/deactivated auto-next, and unauthenticated
admin isolation. Capability-admin tests cover a synthetic access exchange,
verified-session reload, missing/malformed links, exchange errors, navigation
cancellation, immediate logout clearing, and token removal from URLs, history,
referrers and web storage. Exchange/session/logout are mocked locally; real
server authentication and cookie guarantees belong to backend tests. All tests
check uncaught browser errors and network isolation.

The standalone access-helper test loads its built HTML with `setContent` after
an intercepted empty localhost document establishes a secure WebCrypto context.
It replaces `crypto.getRandomValues` with deterministic synthetic bytes before
loading the helper, so no real credential is generated. It verifies SHA-256
against Node crypto, invalid-origin recovery, clearing, enforced hash-based CSP,
and zero helper network requests or browser-storage access.
Desktop/mobile navigation and the admin gate also check horizontal overflow.

Reports, failure screenshots/traces and per-test network audits are written to
`log/e2e/` (ignored by Git) and uploaded as CI artifacts. CI uses no deployment
secrets and never publishes the application. Browser execution must occur in an
environment where Chromium is allowed; do not bypass sandbox denials.

Official workflow references:
- https://playwright.dev/docs/ci-intro
- https://github.com/actions/checkout
- https://github.com/actions/setup-node
- https://github.com/actions/upload-artifact
