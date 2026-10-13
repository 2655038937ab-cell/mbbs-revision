/* Shared bits for the formula regression suite.
 *
 * Everything here is deliberately dependency-light: the suite is run with the
 * bundled DSH node and a Playwright checkout that run.sh symlinks into
 * tests/formula-regression/node_modules (ESM resolves bare specifiers from the
 * importing file's directory, and NODE_PATH does not apply to `import`).
 */

// Where the app under test lives. The read-only checks may be pointed at any
// instance; the checks that write real data call assertLocal() first.
export const BASE = process.env.BASE || "http://127.0.0.1:8757";

// PW_CHROME lets a caller pin a browser binary (run.sh finds the cached
// chrome-headless-shell); otherwise fall back to an installed Chrome.
export const LAUNCH_OPTS = process.env.PW_CHROME
  ? { headless: true, executablePath: process.env.PW_CHROME }
  : { headless: true, channel: "chrome" };

/* Refuse to touch a non-local instance. Every check in the write group PUTs a
 * real record (and restores it afterwards, verifying the md5) — that must never
 * happen against production. Read-only checks skip this.
 */
export function assertLocal(base = BASE) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):/.test(base)) {
    console.error(`refusing to run against ${base}: this check writes real data (it restores it, but still).`);
    console.error("point BASE at http://127.0.0.1:8757, or use online-readonly.mjs for the online smoke.");
    process.exit(2);
  }
}
