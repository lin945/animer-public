# Local-only browser regression tests

Run `npm ci`, `npm run check`, `npx playwright install --with-deps chromium`,
then `npm run test:e2e`. GitHub Actions runs the same commands on Ubuntu with
Node 24. Desktop Chromium and mobile Chromium (Pixel 7 emulation) execute the
same six flows. Mobile emulation is not a physical Android-device test.

The static server serves the built `dist` and has no production API/database
connection. Playwright supplies all API responses and fails any unmocked API
or off-origin request. Service workers are disabled to keep interception
complete. The original synthetic 45-second MP4 is checked in; it has no anime
content, account information or external media dependency. Fixtures do not
exercise live scraping, upstream reliability, authentication providers or D1.

Tests cover navigation/back/forward, out-of-order search, same-episode manual
source switching, stale episode resolution, preference/progress persistence,
recent-history navigation, cancelled/deactivated auto-next, and unauthenticated
admin isolation. All tests check uncaught browser errors and network isolation.
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
