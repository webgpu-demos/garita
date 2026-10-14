// Checks the intro overlay in a headless browser: opens, plays, the controls work, Skip and Escape close it, and it
// stays away from automated renders and deep links. Used locally (VP9 stand-in for the H.264 file, which open-source
// Chromium cannot decode) and on a runner with Google Chrome (the real file).
//   node tools/intro-test.mjs <site url> <out dir> [--chrome] [--webm file]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.NODE_PATH ? process.env.NODE_PATH + '/' : import.meta.url);
const { chromium } = require(process.env.PW_MODULE || 'playwright-core');
const [base, out] = process.argv.slice(2);
const chrome = process.argv.includes('--chrome');
const webm = process.argv.includes('--webm') ? process.argv[process.argv.indexOf('--webm') + 1] : null;
fs.mkdirSync(out, { recursive: true });
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=user-gesture-required'];
const browser = await chromium.launch({ ...(chrome ? { channel: 'chrome' } : process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
async function page(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.w ?? 1600, height: opts.h ?? 900 }, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  const logs = [];
  p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
  if (webm) await p.route('**/media/*.mp4', (r) => r.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(webm) }));
  p.logs = logs;
  return p;
}
const st = (p) => p.evaluate(() => {
  const r = document.querySelector('.intro'), v = r?.querySelector('video');
  return r ? { open: true, t: +v.currentTime.toFixed(2), paused: v.paused, muted: v.muted, ready: v.readyState, src: v.currentSrc.split('/').pop(), err: v.error?.code ?? null,
    skipDraw: !!globalThis.__garitaSkipDraw, sound: r.querySelector('.intro-sound')?.textContent, big: !r.querySelector('.intro-big').hidden, focus: document.activeElement?.className } : { open: false, skipDraw: !!globalThis.__garitaSkipDraw };
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// (the first scene frame after the intro closes can block a software-GL page for seconds)
const gone = (p) => p.waitForFunction(() => !document.querySelector('.intro'), null, { timeout: 30000 }).then(() => true, () => false);
const q = (u, extra) => base + (base.includes('?') ? '&' : '?') + 'post=basic&scale=0.3' + (extra ? '&' + extra : '');

// 1. forced open: plays (muted, autoplay with sound refused), Sound on, pause, seek, Escape closes
{
  const p = await page();
  await p.goto(q('', 'intro=1'), { waitUntil: 'domcontentloaded' });
  await wait(6000);
  let s = await st(p); check('opens and plays', s.open && !s.paused && s.t > 0.5, JSON.stringify(s));
  check('muted autoplay when sound is refused', s.muted === true, `muted=${s.muted}`);
  check('skips drawing the hidden scene', s.skipDraw === true);
  check('Skip button has focus', /intro-skip/.test(s.focus ?? ''), s.focus);
  await p.screenshot({ path: `${out}/1-playing.jpg`, type: 'jpeg', quality: 80 });
  await p.click('.intro-sound'); await wait(400); s = await st(p);
  check('Sound on unmutes', s.muted === false && !s.paused, JSON.stringify(s));
  await p.keyboard.press('k'); await wait(300); s = await st(p); check('k pauses', s.paused === true);
  await p.screenshot({ path: `${out}/2-paused.jpg`, type: 'jpeg', quality: 80 });
  await p.keyboard.press(' '); await wait(300); s = await st(p); check('space resumes', s.paused === false);
  const t0 = s.t; await p.keyboard.press('ArrowRight'); await wait(300); s = await st(p); check('arrow seeks forward', s.t >= t0 + 4, `${t0} -> ${s.t}`);
  await p.keyboard.press('w');         // must not reach the camera
  await p.keyboard.press('Escape'); const g1 = await gone(p); s = await st(p);
  check('Escape closes and the scene draws again', g1 && !s.open && !s.skipDraw, JSON.stringify(s));
  await p.screenshot({ path: `${out}/3-after-escape.jpg`, type: 'jpeg', quality: 80 });
  check('no console errors from the intro', !p.logs.some((l) => /intro/i.test(l)), p.logs.join(' | ').slice(0, 300));
  await p.context().close();
}
// 2. first plain visit plays by itself (webdriver aside: forced with intro=1 then reload shows it is remembered?)
//    Plain visit in an automated browser must NOT play.
{
  const p = await page();
  await p.goto(q(''), { waitUntil: 'domcontentloaded' }); await wait(4000);
  check('not shown to an automated browser without ?intro=1', !(await st(p)).open);
  await p.goto(q('', 'intro=1&select=municipio:72127'), { waitUntil: 'domcontentloaded' }); await wait(3000);
  check('?intro=1 wins over a deep link', (await st(p)).open);
  await p.click('.intro-skip');
  check('Skip intro closes', await gone(p));
  await p.context().close();
}
// 3. reduced motion: opens paused on the poster with a Play button; the button plays with sound
{
  const p = await page({ reduced: true, w: 390, h: 844 });
  await p.goto(q('', 'intro=1'), { waitUntil: 'domcontentloaded' }); await wait(4000);
  let s = await st(p); check('reduced motion: paused with Play button', s.open && s.paused && s.big, JSON.stringify(s));
  await p.screenshot({ path: `${out}/4-reduced-phone.jpg`, type: 'jpeg', quality: 80 });
  await p.click('.intro-big'); await wait(2500); s = await st(p);
  check('Play button plays with sound', !s.paused && s.muted === false, JSON.stringify(s));
  await p.screenshot({ path: `${out}/5-phone-playing.jpg`, type: 'jpeg', quality: 80 });
  await p.context().close();
}
// 4. About sheet replays it
{
  const p = await page();
  await p.goto(q('', 'about=1'), { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('button.tb-brand', { timeout: 120000 }); await wait(1500);
  await p.click('button.tb-brand'); await wait(500);
  await p.screenshot({ path: `${out}/6-about.jpg`, type: 'jpeg', quality: 80 });
  await p.click("button:has-text('Watch the intro')"); await wait(3000);
  const s = await st(p); check('About: Watch the intro plays with sound', s.open && !s.paused && s.muted === false, JSON.stringify(s));
  await p.context().close();
}
// 5. the end closes it: jump near the end
{
  const p = await page();
  await p.goto(q('', 'intro=1'), { waitUntil: 'domcontentloaded' }); await wait(4000);
  await p.evaluate(() => { const v = document.querySelector('.intro video'); v.currentTime = Math.max(0, v.duration - 1.0); });
  check('closes at the end', await gone(p));
  await p.context().close();
}
// 7. the file cannot load (404): the overlay must not stay over the app
{
  const p = await page();
  await p.route('**/media/*.mp4', (r) => r.fulfill({ status: 404, contentType: 'text/html', body: 'not found' }));
  await p.goto(q('', 'intro=1'), { waitUntil: 'domcontentloaded' });
  check('missing file: closes by itself', await gone(p));
  await p.context().close();
}
// 6. a real first visit (the automation flag masked): plays by itself once, remembered; a deep link never plays it
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
  if (webm) await ctx.route('**/media/*.mp4', (r) => r.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(webm) }));
  const p = await ctx.newPage();
  await p.goto(base, { waitUntil: 'domcontentloaded' }); await wait(6000);
  let s = await st(p); check('first plain visit: plays by itself', s.open && !s.paused && s.t > 0.5, JSON.stringify(s));
  await p.screenshot({ path: `${out}/7-first-visit.jpg`, type: 'jpeg', quality: 80 });
  await p.reload({ waitUntil: 'domcontentloaded' }); await wait(4000);
  check('second visit: not again', !(await st(p)).open);
  const about = await p.evaluate(() => !!document.querySelector('.about'));
  check('About did not pop up instead', !about);
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx2.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
  const p2 = await ctx2.newPage();
  await p2.goto(base + '?select=municipio:72127', { waitUntil: 'domcontentloaded' }); await wait(4000);
  check('first visit by a deep link: not shown', !(await st(p2)).open);
  await ctx2.close();
}
fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
console.log(results.filter((r) => r.ok).length, '/', results.length, 'passed');
await browser.close();
