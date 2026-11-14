// AI tab > This computer: the panel names this computer (memory, cores, GPU, video encoder, AI backend) and, per AI job,
// where it runs (Apple GPU / NVIDIA / CPU / the GPU PC) or why not; in both motion modes. Run against a server on a scratch
// library, optionally started with CUTROOM_PROFILE (e.g. win:cuda:12:32) to see that computer's choices:
//   B=http://127.0.0.1:<port> [SHOTS=<dir>] node tests/this_computer.mjs
import { browser } from './browser.mjs';

const B = process.env.B || 'http://127.0.0.1:4610', fails = [];
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(got)}`}`); if (!ok) fails.push(name); };
const caps = await (await fetch(`${B}/api/ai/caps`)).json();
const b = await browser.launch();
try {
  for (const rm of ['reduce', 'no-preference']) {
    const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
    await page.goto(`${B}/`, { waitUntil: 'load' });
    await page.click('button[data-tab="ai"]');
    await page.waitForFunction(() => document.querySelectorAll('#macCaps .mc').length > 0, null, { timeout: 15000 });
    const ui = await page.evaluate(() => ({
      head: [...document.querySelectorAll('h4')].map(h => h.textContent).filter(t => /This (computer|Mac)$/.test(t)),
      sum: document.querySelector('#macSum').textContent,
      rows: [...document.querySelectorAll('#macCaps .mc')].map(r => ({ kind: r.dataset.cap, off: r.classList.contains('off'), text: r.textContent })),
    }));
    check(`${rm}: the panel is headed "This computer"`, ui.head.length === 1 && ui.head[0] === 'This computer', ui.head);
    check(`${rm}: the summary names the encoder and the AI backend`, ui.sum.includes(caps.encoder) && ui.sum.includes('AI models:'), ui.sum);
    check(`${rm}: every AI job listed`, ui.rows.length === caps.jobs.length, ui.rows.length);
    const bad = caps.jobs.filter(j => { const r = ui.rows.find(x => x.kind === j.kind); return !r || r.off !== !!j.refused
      || (j.refused ? !r.text.includes('Not on this computer') : !r.text.includes('On ')); });
    check(`${rm}: each job says where it runs, or why not (${caps.jobs.filter(j => j.refused).length} refused)`, !bad.length, bad.map(j => j.kind));
    if (process.env.SHOTS) {
      await page.locator('#macCaps').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.SHOTS}/this-computer-${rm}.png` });
    }
    console.log(`${rm}: ${ui.sum}`);
  }
} finally {
  await b.close();
}
console.log(fails.length ? `${fails.length} FAILED` : 'this computer: all ok');
process.exit(fails.length ? 1 : 0);
