// The browser the UI tests drive. BROWSER=webkit (default: the Mac app's engine) | chromium | msedge | chrome (the installed
// Edge or Chrome, nothing to download: what Windows uses). PLATFORM=Win32 makes the page believe it runs on Windows
// (navigator.platform), so the Ctrl+ / "this computer" labels can be checked on a Mac. macOnly() ends a Mac-only test cleanly.
import { webkit, chromium } from 'playwright';

const name = process.env.BROWSER || 'webkit', fake = process.env.PLATFORM;
if (!['webkit', 'chromium', 'msedge', 'chrome'].includes(name)) throw new Error(`BROWSER=${name}: webkit, chromium, msedge or chrome`);
const type = name === 'webkit' ? webkit : chromium, channel = { msedge: 'msedge', chrome: 'chrome' }[name];
const pretend = fake && `Object.defineProperty(Navigator.prototype, 'platform', { get: () => ${JSON.stringify(fake)} });
  Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });`;

export const browser = {
  async launch(opts = {}) {
    const b = await type.launch({ ...opts, ...(channel ? { channel } : {}) });
    if (fake) { // every context the test makes gets the fake platform
      const newContext = b.newContext.bind(b);
      b.newContext = async (...a) => { const c = await newContext(...a); await c.addInitScript(pretend); return c; };
      b.newPage = async (...a) => (await b.newContext(...a)).newPage();
    }
    return b;
  },
};

export function macOnly(what) {
  if (process.platform === 'darwin') return;
  console.log(`SKIP ${what}: Mac only`);
  process.exit(0);
}
