// End-to-end checks for Bible Sharing Tool: functional, performance and usability.
//
//   npm test                                    starts `wrangler dev` (so _headers / CSP apply as in production)
//   BASE_URL=https://bible.poncethelion.com npm test     runs against a deployed site instead
//   CHROME_PATH=/path/to/chrome npm test        if Chrome isn't in the default macOS location
//   BROWSER=webkit npm test                     Safari's engine (once: npx playwright-core install webkit);
//                                               the throttled performance checks need Chrome and are skipped
//
// Verse text really comes from bible.helloao.org until the whole translation is saved, so a network
// connection is needed. Exits non-zero if any check fails.
import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WEBKIT = process.env.BROWSER === 'webkit';
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const API_HOST = 'bible.helloao.org';

// Performance budgets, on a throttled mid-range phone (4x slower CPU, ~1.6 Mbps / 150 ms network).
const BUDGET = {
  shellKB: 450,          // the app itself on a first visit (page, fonts, icons), compressed as sent
  sharedMs: 3000,        // tapping a share link until the study is on screen
  firstPassageMs: 4000,  // opening a study until the first passage's text is on screen
  nextMs: 300,           // tapping Next once the study is pre-loaded
  savedBibleKB: 1200,    // one translation's Old + New Testament, as downloaded (brotli)
  longTaskMs: 250,       // longest main-thread block while reading from the saved Bible
  textCacheKB: 1024,     // localStorage used by 60 opened passages
};

// ---------- tiny harness ----------
let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  cond ? passed++ : failed++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
}
const section = name => console.log(`\n${name}`);
// The app's CSP blocks eval, which Playwright's waitForFunction relies on, so poll from here instead.
async function until(page, fn, arg, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(50)) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
  }
  return false;
}
const hasText = page => until(page, () => !!(document.querySelector('#scripture sup') || document.querySelector('.err-text')));
const scripture = page => page.evaluate(() => document.getElementById('scripture')?.innerText || '');
const showsText = (page, words) => until(page, w => (document.getElementById('scripture')?.innerText || '').includes(w), words);

async function makeStudy(page, base, title, refs, readers = []) {
  await page.goto(base);
  await page.click('[data-act=new]');
  await page.fill('.title-input', title);
  await page.fill('#addRefs', refs);
  await page.click('[data-act=add]');
  for (const [i, r] of readers.entries()) await page.fill(`[data-field=reader][data-idx="${i}"]`, r);
  return page.evaluate(t => db.lists.find(l => l.title === t).id, title);
}

// Watch a page: requests by host, console errors, CSP violations.
function watch(page) {
  const w = { hosts: new Set(), errors: [], bible: [], requests: 0 };
  page.on('pageerror', e => w.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') w.errors.push(m.text()); });
  page.on('request', r => {
    const u = new URL(r.url());
    w.hosts.add(u.host);
    w.requests++;
    if (u.pathname.startsWith('/bible/')) w.bible.push({ path: u.pathname, at: Date.now() });
  });
  return w;
}

// Wait until the service worker has cached the app and controls the page, so going offline is a fair test.
const swReady = page => page.evaluate(async () => {
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  return true;
});

async function throttle(page, ctx) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  return cdp;
}

function contrast(fg, bg) {
  const lum = c => {
    const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => (v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4));
    return .2126 * r + .7152 * g + .0722 * b;
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + .05) / (b + .05);
}

// ---------- server ----------
let server, BASE = process.env.BASE_URL;
if (!BASE) {
  BASE = 'http://127.0.0.1:8799/';
  server = spawn('npx', ['wrangler', 'dev', '--port', '8799', '--ip', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise(r => setTimeout(r, 1000));
    up = await fetch(BASE).then(r => r.ok).catch(() => false);
  }
  if (!up) { console.error('wrangler dev did not start'); server.kill(); process.exit(1); }
}
if (!BASE.endsWith('/')) BASE += '/';
const OWN_HOST = new URL(BASE).host;
const browser = WEBKIT ? await webkit.launch() : await chromium.launch({ executablePath: CHROME });
console.log(`Browser: ${WEBKIT ? 'WebKit (Safari engine)' : 'Chrome'} ${browser.version()}`);

try {
  // =====================================================================
  section('Functional');
  {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: 'dark', acceptDownloads: true });
    const p = await ctx.newPage(), w = watch(p);
    await p.goto(BASE);
    await p.evaluate(() => { localStorage.clear(); localStorage.setItem('bst:text', '{}'); });
    await p.reload();
    check('old text cache is cleaned up', await p.evaluate(() => localStorage.getItem('bst:text') === null));

    // book search, readers, markdown note
    await p.click('[data-act=new]');
    await p.fill('.title-input', 'Iron Sharpens Iron');
    await p.click('#addRefs');
    await p.keyboard.type('phil');
    check('typing "phil" suggests Philippians', await until(p, () => /Philippians/.test(document.getElementById('ac')?.innerText || '')));
    await p.fill('#addRefs', 'Eccl 4:9-10; Prov 27:17; Acts 2:42; Heb 10:24-25');
    await p.click('[data-act=add]');
    check('four passages added', await p.evaluate(() => db.lists[0].items.length === 4));
    for (const [i, r] of ['Adam', 'Roy', 'Noemi', 'Nympha'].entries()) await p.fill(`[data-field=reader][data-idx="${i}"]`, r);
    await p.fill('[data-field=note][data-idx="1"]', 'We grow **together**');
    await p.waitForTimeout(300);
    const id = await p.evaluate(() => db.lists[0].id);

    // reading: buttons, keyboard, Finish
    await p.goto(`${BASE}#/present/${id}/0`); await hasText(p);
    check('first passage text shows (from the API)', (await scripture(p)).includes('Two are better than one'));
    await p.click('.dock .next');
    check('Next goes to passage 2, with its reader and note', await showsText(p, 'iron') && /2\s*\/\s*4/.test(await p.textContent('.stage-top')) && /<(b|strong)>together<\/(b|strong)>/.test(await p.innerHTML('#slide')) && (await p.textContent('#slide')).includes('Roy'));
    await p.keyboard.press('ArrowRight');
    check('Right arrow key goes forward', await showsText(p, 'apostles'));
    await p.keyboard.press('ArrowLeft');
    check('Left arrow key goes back', await showsText(p, 'iron'));
    await p.goto(`${BASE}#/present/${id}/3`); await hasText(p);
    check('last passage shows Finish instead of Next', (await p.textContent('.dock .next')).includes('Finish'));

    // saving the whole Bible
    const saved = await until(p, () => savedStatus('bsb'), null, 20000);
    const ot = w.bible.find(r => r.path === '/bible/bsb-ot.json'), nt = w.bible.find(r => r.path === '/bible/bsb-nt.json');
    check('whole BSB saved in the background (Old + New Testament)', saved && ot && nt);
    check('both testaments download in parallel', ot && nt && Math.abs(ot.at - nt.at) < 200);
    const viaApi = await p.evaluate(async () => { chapterCache.clear(); savedParts.clear(); return 1; });
    check('same text from the saved copy as from the API (incl. words of Jesus)', viaApi && await p.evaluate(async () => {
      const read = () => Promise.all([getChapter('web', 'MAT', 5), getChapter('kjv', 'JHN', 3), getChapter('bsb', 'PSA', 23)]).then(JSON.stringify);
      const api = await read();
      await saveBibleOffline('web'); await saveBibleOffline('kjv');
      chapterCache.clear(); savedParts.clear();
      return api === await read();
    }));
    const before = w.requests;
    await p.evaluate(() => { chapterCache.clear(); return Promise.all([getChapter('bsb', 'RUT', 1), getChapter('bsb', 'REV', 21)]); });
    check('after saving, chapters load with no network', w.requests === before, `${w.requests - before} requests`);

    // words of Jesus, no pilcrows
    await p.evaluate(() => { db.settings.inline = 'kjv'; save(); });
    const kid = await makeStudy(p, BASE, 'Red letters', 'John 3:16; Matt 11:28-30');
    await p.goto(`${BASE}#/present/${kid}/0`); await hasText(p);
    check('KJV: words of Jesus in red', await p.evaluate(() => document.querySelectorAll('#scripture .wj').length > 0));
    check('KJV: no ¶ marks', !(await scripture(p)).includes('¶'));
    await p.evaluate(() => { db.settings.inline = 'bsb'; save(); });

    // settings status
    await p.goto(`${BASE}#/settings`);
    check('settings says the Bible is saved for offline', await until(p, () => document.getElementById('offlineStatus')?.textContent.startsWith('✓')));

    // offline: app opens, brand-new study across both testaments
    await swReady(p);
    await ctx.setOffline(true);
    await p.goto(BASE); await p.reload();   // a real page load, answered by the service worker
    check('app opens offline', await until(p, () => !!document.querySelector('[data-act=new]')));
    const oid = await makeStudy(p, BASE, 'Offline', 'Ruth 1:16-17; Isa 40:31; Rev 21:4');
    let allText = true;
    for (const i of [0, 1, 2]) {
      await p.goto(`${BASE}#/present/${oid}/${i}`);
      if (!(await hasText(p)) || !(await p.$('#scripture sup')) || (await scripture(p)).includes('offline')) allText = false;
    }
    check('offline: a brand-new study shows every passage', allText);
    await ctx.setOffline(false);

    // share link, opened by someone else
    await p.goto(`${BASE}#/list/${id}`);
    const shareUrl = await p.evaluate(i => location.href.split('#')[0] + '#share=' + encodeShare(db.lists.find(l => l.id === i)), id);
    const friend = await (await browser.newContext({ ...PHONE, colorScheme: 'light' })).newPage();
    const fw = watch(friend);
    await friend.goto(shareUrl);
    check('share link opens the study for someone else', await until(friend, () => document.querySelector('.page-title')?.textContent === 'Iron Sharpens Iron'));
    await friend.click('.btn.primary.lg'); await hasText(friend);
    check('...and they can start reading', (await scripture(friend)).includes('Two are better'));
    await friend.goto(shareUrl); await friend.click('[data-act=saveShared]');
    check('...and save a copy', await until(friend, () => db.lists.length === 1 && location.hash.startsWith('#/list/')));
    check('friend: no errors', fw.errors.length === 0, fw.errors.slice(0, 2).join(' | '));

    // backup round trip
    await p.goto(`${BASE}#/settings/privacy`);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act=export]')]);
    const file = join(mkdtempSync(join(tmpdir(), 'bst-')), 'backup.json');
    await dl.saveAs(file);
    const count = await p.evaluate(() => db.lists.length);
    await p.evaluate(() => { localStorage.removeItem('bst:v1'); }); await p.reload();
    await p.goto(`${BASE}#/settings/privacy`);
    await p.setInputFiles('#importFile', file);
    check('backup export + import restores every study', await until(p, n => db.lists.length === n, count));

    // the passage cache stays bounded, and study edits survive a full storage
    const n = await p.evaluate(async () => {
      for (let i = 0; i < 350; i++) await getPassage({ b: 'PSA', c1: 1 + (i % 150), c2: 1 + (i % 150), v1: 1, v2: 1 + Math.floor(i / 150) }, 'bsb');
      return Object.keys(JSON.parse(localStorage.getItem('bst:text2'))).length;
    });
    check('passage cache is capped (350 opened → ≤ 300 kept)', n <= 300, `${n} kept`);
    const kept = await p.evaluate(() => {
      const junk = [];
      try { for (let i = 0; i < 1e4; i++) { localStorage.setItem('junk' + i, 'x'.repeat(256 * 1024)); junk.push('junk' + i); } } catch (e) {}
      try { for (let i = 0; i < 1e4; i++) { localStorage.setItem('fill' + i, 'x'.repeat(1024)); junk.push('fill' + i); } } catch (e) {}
      db.lists[0].title = 'Saved when storage was full ' + 'x'.repeat(4000);
      save();
      const ok = JSON.parse(localStorage.getItem('bst:v1')).lists[0].title.startsWith('Saved when storage was full');
      junk.forEach(k => localStorage.removeItem(k));
      db.lists[0].title = 'Iron Sharpens Iron'; save();
      return ok;
    });
    check('storage full: study edits still save (passage cache is given up first)', kept);

    // old BSB passages carry over to the new cache; other translations are refetched (they gain red letters)
    const mig = await browser.newContext({ ...PHONE });
    const m = await mig.newPage();
    await m.goto(BASE);
    await m.evaluate(() => { localStorage.clear(); localStorage.setItem('bst:text', JSON.stringify({ 'bsb|PHP 4:6-7': [{ c: 4, v: 6, t: 'x' }], 'web|JHN 3:16': [{ c: 3, v: 16, t: 'y' }] })); });
    await m.reload();
    check('old cached BSB passages are kept, others dropped', await m.evaluate(() => { const c = JSON.parse(localStorage.getItem('bst:text2')); return !!c['bsb|PHP 4:6-7'] && !c['web|JHN 3:16']; }));
    await mig.close();

    // no Cache Storage at all (e.g. some private modes): text still comes from the API
    const nc = await browser.newContext({ ...PHONE });
    await nc.addInitScript(() => Object.defineProperty(window, 'caches', { value: undefined }));
    const q = await nc.newPage(), qw = watch(q);
    const qid = await makeStudy(q, BASE, 'No cache', 'Prov 27:17');
    await q.goto(`${BASE}#/present/${qid}/0`);
    check('without Cache Storage, text still loads from the API', await showsText(q, 'iron'));
    check('...with no errors', qw.errors.length === 0, qw.errors.slice(0, 2).join(' | '));
    await nc.close();

    // storage that refuses every write (blocked, or full for good): the app still starts
    const ro = await browser.newContext({ ...PHONE });
    await ro.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('blocked', 'QuotaExceededError'); }; });
    const rp = await ro.newPage(), rw = watch(rp);
    await rp.goto(BASE);
    check('storage blocked: the app still opens', await until(rp, () => !!document.querySelector('[data-act=new]')));
    check('...and says it couldn’t save, with no errors', await until(rp, () => /Couldn’t save/.test(document.getElementById('toast').textContent)) && rw.errors.length === 0, rw.errors.join(' | '));
    await ro.close();

    // started offline: saving resumes as soon as the connection is back
    const late = await browser.newContext({ ...PHONE });
    const lp = await late.newPage();
    await lp.goto(BASE); await swReady(lp);
    await late.setOffline(true);
    await lp.evaluate(() => caches.delete('bst-bible-v1'));
    await lp.reload(); await lp.waitForTimeout(3500);
    const savedOffline = await lp.evaluate(() => savedStatus('bsb'));
    await late.setOffline(false);
    check('started offline: Bible saves once back online', !savedOffline && await until(lp, () => savedStatus('bsb'), null, 20000));
    await late.close();

    // offline before the Bible is saved: a passage never opened explains itself and still offers "Open in"
    const cold = await browser.newContext({ ...PHONE });
    await cold.route('**/bible/*.json', r => r.abort());
    // the editor pre-loads the passage from the API; keep it out of the browser's HTTP cache too
    await cold.route(`https://${API_HOST}/**`, r => r.abort());
    const c = await cold.newPage();
    const cid = await makeStudy(c, BASE, 'Cold', 'Phil 4:6-7');
    await c.evaluate(() => { localStorage.setItem('bst:text2', '{}'); });
    await swReady(c);
    await cold.setOffline(true);
    await c.reload(); await c.goto(`${BASE}#/present/${cid}/0`); await hasText(c);
    check('offline before saving: friendly message, "Open in" still there',
      (await scripture(c)).includes('offline') && await c.isVisible('.dock .open'));
    await cold.close();

    // Cloudflare adds its Web Analytics script on the live site (disclosed on the Privacy page)
    const allowed = h => h === OWN_HOST || h === API_HOST || h === 'static.cloudflareinsights.com' || h === 'cloudflareinsights.com';
    check('only this site, the Bible API and Cloudflare analytics are contacted', [...w.hosts, ...fw.hosts].every(allowed), [...new Set([...w.hosts, ...fw.hosts])].join(', '));
    check('no errors or CSP violations', w.errors.length === 0, w.errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // =====================================================================
  section(WEBKIT ? 'Performance (skipped: throttling needs Chrome)' : 'Performance (4x slower CPU, ~1.6 Mbps / 150 ms network)');
  if (!WEBKIT) {
    // a share link made beforehand, opened by a first-time visitor on a slow phone
    const maker = await (await browser.newContext()).newPage();
    const mid = await makeStudy(maker, BASE, 'Perf', 'Eccl 4:9-10; Prov 27:17; Acts 2:42; Heb 10:24-25');
    const shareUrl = await maker.evaluate(i => location.href.split('#')[0] + '#share=' + encodeShare(db.lists.find(l => l.id === i)), mid);
    await maker.context().close();

    const ctx = await browser.newContext({ ...PHONE });
    await ctx.addInitScript(() => {
      window.__longest = 0;
      try { new PerformanceObserver(l => l.getEntries().forEach(e => { window.__longest = Math.max(window.__longest, e.duration); })).observe({ type: 'longtask', buffered: true }); } catch (e) {}
    });
    const p = await ctx.newPage();
    const cdp = await throttle(p, ctx);
    const sizes = new Map();
    cdp.on('Network.loadingFinished', e => sizes.set(e.requestId, e.encodedDataLength));
    const urls = new Map();
    cdp.on('Network.requestWillBeSent', e => urls.set(e.requestId, e.request.url));

    let t = Date.now();
    await p.goto(shareUrl);
    await until(p, () => !!document.querySelector('.page-title'));
    const sharedMs = Date.now() - t;
    check(`share link → study on screen ≤ ${BUDGET.sharedMs} ms`, sharedMs <= BUDGET.sharedMs, `${sharedMs} ms`);

    t = Date.now();
    await p.click('.btn.primary.lg'); await hasText(p);
    const firstMs = Date.now() - t;
    check(`Start → first passage text ≤ ${BUDGET.firstPassageMs} ms`, firstMs <= BUDGET.firstPassageMs, `${firstMs} ms`);

    const shellBytes = [...sizes].filter(([id]) => { const u = new URL(urls.get(id) || BASE); return u.host === OWN_HOST && !u.pathname.startsWith('/bible/'); }).reduce((a, [, b]) => a + b, 0);
    check(`app itself ≤ ${BUDGET.shellKB} KB on a first visit`, shellBytes / 1024 <= BUDGET.shellKB, `${(shellBytes / 1024).toFixed(0)} KB`);

    // every passage was pre-loaded when the study opened, so Next is instant
    await until(p, () => Object.keys(textCache).length >= 4);
    // timed inside the page, from the tap to the next frame painted with the new text
    // (Playwright's own click and polling would add hundreds of ms on a throttled CPU)
    const nexts = [];
    for (const want of ['iron', 'apostles', 'spur']) {
      nexts.push(await p.evaluate(w => new Promise(done => {
        const t0 = performance.now();
        const mo = new MutationObserver(() => {
          if (!(document.getElementById('scripture')?.innerText || '').includes(w)) return;
          mo.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => done(Math.round(performance.now() - t0))));
        });
        mo.observe(document.getElementById('app'), { childList: true, subtree: true, characterData: true });
        document.querySelector('.dock .next').click();
      }), want));
    }
    check(`Next on a pre-loaded study ≤ ${BUDGET.nextMs} ms (tap to painted)`, Math.max(...nexts) <= BUDGET.nextMs, nexts.map(n => `${n} ms`).join(', '));

    // reading from the saved Bible: the testament is parsed once; it must not freeze the page
    await until(p, () => savedStatus('bsb'), null, 60000);
    await p.evaluate(() => { window.__longest = 0; chapterCache.clear(); savedParts.clear(); });
    t = Date.now();
    await p.evaluate(() => getChapter('bsb', 'GEN', 1));
    const coldOt = Date.now() - t;
    await p.waitForTimeout(300);
    const longest = await p.evaluate(() => window.__longest);
    check(`first read from the saved Old Testament blocks the page ≤ ${BUDGET.longTaskMs} ms`, longest <= BUDGET.longTaskMs, `longest task ${longest.toFixed(0)} ms, chapter ready in ${coldOt} ms`);
    t = Date.now(); await p.evaluate(() => getChapter('bsb', 'EXO', 20)); const warmOt = Date.now() - t;
    check('later chapters from the saved copy are instant (≤ 50 ms)', warmOt <= 50, `${warmOt} ms`);

    // localStorage growth
    const kb = await p.evaluate(async () => {
      const books = ['GEN', 'EXO', 'PSA', 'PRO', 'ISA', 'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', 'HEB'];
      for (let i = 0; i < 60; i++) await getPassage({ b: books[i % 12], c1: 1 + Math.floor(i / 12), c2: 1 + Math.floor(i / 12), v1: 1, v2: 10 }, 'bsb');
      return (localStorage.getItem('bst:text2') || '').length / 1024;
    });
    check(`60 opened passages use ≤ ${BUDGET.textCacheKB} KB of localStorage`, kb <= BUDGET.textCacheKB, `${kb.toFixed(0)} KB`);
    await ctx.close();

    // download size of each saved translation, as Cloudflare would send it (brotli)
    const dir = join(ROOT, 'public/bible');
    for (const t of ['bsb', 'web', 'kjv']) {
      const kbT = ['ot', 'nt'].reduce((a, part) => a + brotliCompressSync(readFileSync(join(dir, `${t}-${part}.json`))).length, 0) / 1024;
      check(`${t.toUpperCase()} whole-Bible download ≤ ${BUDGET.savedBibleKB} KB`, kbT <= BUDGET.savedBibleKB, `${kbT.toFixed(0)} KB`);
    }
    check('public/bible holds only the testament files', readdirSync(dir).every(f => /^[a-z]+-(ot|nt)\.json$/.test(f)), readdirSync(dir).length + ' files');
  }

  // =====================================================================
  section('Usability');
  {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
    const p = await ctx.newPage();
    const id = await makeStudy(p, BASE, 'Usability', 'Prov 27:17; Matt 5:3-10', ['Roy', 'Noemi']);
    const shareUrl = await p.evaluate(i => location.href.split('#')[0] + '#share=' + encodeShare(db.lists.find(l => l.id === i)), id);
    const state = await p.evaluate(() => JSON.stringify({ ...localStorage }));
    const screens = { home: '', editor: `#/list/${id}`, reading: `#/present/${id}/0`, settings: '#/settings', legal: '#/legal' };

    // no sideways scrolling, from a small phone to a laptop
    for (const width of [320, 390, 768, 1280]) {
      const v = await browser.newContext({ viewport: { width, height: 800 } });
      const vp = await v.newPage();
      await vp.goto(BASE); await vp.evaluate(s => Object.entries(JSON.parse(s)).forEach(([k, val]) => localStorage.setItem(k, val)), state);
      const wide = [];
      for (const [name, hash] of Object.entries({ ...screens, shared: shareUrl.slice(shareUrl.indexOf('#')) })) {
        await vp.goto(BASE + hash); await vp.reload(); await vp.waitForTimeout(400);
        if (await vp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) wide.push(name);
      }
      check(`no sideways scrolling at ${width}px`, wide.length === 0, wide.join(', '));
      await v.close();
    }

    // tap targets on the screens used during a study
    const small = [];
    const targets = { [`#/present/${id}/0`]: ['.dock .prev', '.dock .open', '.dock .next', '.stage-top a:not(.seg)', '.stage-top button'], [`#/list/${id}`]: ['[data-act=add]', '[data-act=share]', 'a.btn.primary'], '': ['[data-act=new]'] };
    for (const [hash, sels] of Object.entries(targets)) {
      await p.goto(BASE + hash); await p.waitForTimeout(400);
      for (const sel of sels) for (const el of await p.$$(sel)) {
        const box = await el.boundingBox();
        if (box && (box.height < 44 || box.width < 44)) small.push(`${sel} ${box.width.toFixed(0)}×${box.height.toFixed(0)}`);
      }
    }
    check('study controls are at least 44×44 px', small.length === 0, small.join('; '));

    // readable text and contrast, both themes
    for (const scheme of ['dark', 'light']) {
      const c = await browser.newContext({ ...PHONE, colorScheme: scheme });
      const cp = await c.newPage();
      await cp.goto(BASE); await cp.evaluate(s => Object.entries(JSON.parse(s)).forEach(([k, val]) => localStorage.setItem(k, val)), state);
      await cp.evaluate(() => { const d = JSON.parse(localStorage.getItem('bst:v1')); d.settings.inline = 'web'; localStorage.setItem('bst:v1', JSON.stringify(d)); });
      await cp.goto(`${BASE}#/present/${id}/1`); await cp.reload(); await hasText(cp); await cp.waitForTimeout(800);
      const s = await cp.evaluate(() => {
        const css = el => getComputedStyle(el);
        const bg = css(document.body).backgroundColor;
        const scr = document.getElementById('scripture'), wj = scr.querySelector('.wj'), sup = scr.querySelector('sup');
        return { bg, text: css(scr).color, size: parseFloat(css(scr).fontSize), wj: wj && css(wj).color, sup: css(sup).color };
      });
      check(`${scheme}: scripture text is large (≥ 18 px)`, s.size >= 18, `${s.size} px`);
      check(`${scheme}: scripture text contrast ≥ 7:1`, contrast(s.text, s.bg) >= 7, contrast(s.text, s.bg).toFixed(1) + ':1');
      check(`${scheme}: words of Jesus contrast ≥ 4.5:1`, s.wj && contrast(s.wj, s.bg) >= 4.5, s.wj ? contrast(s.wj, s.bg).toFixed(1) + ':1' : 'no red text found');
      check(`${scheme}: verse numbers contrast ≥ 4.5:1`, contrast(s.sup, s.bg) >= 4.5, contrast(s.sup, s.bg).toFixed(1) + ':1');
      await c.close();
    }

    // every control has a name a screen reader can read out
    const unnamed = [];
    for (const hash of Object.values(screens)) {
      await p.goto(BASE + hash); await p.waitForTimeout(400);
      unnamed.push(...await p.evaluate(() => [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea')]
        .filter(el => el.offsetParent !== null || getComputedStyle(el).position === 'fixed')
        .filter(el => !(el.getAttribute('aria-label') || el.textContent.trim() || el.getAttribute('title') || el.getAttribute('placeholder') || el.labels?.[0]?.textContent.trim()))
        .map(el => `${location.hash || '#/'} ${el.tagName.toLowerCase()}.${el.className}`)));
    }
    check('every button, link and field has an accessible name', unnamed.length === 0, unnamed.slice(0, 4).join('; '));

    // keyboard: add a passage with Enter, step through with the arrow keys
    await p.goto(`${BASE}#/list/${id}`);
    await p.fill('#addRefs', 'Ps 23:1'); await p.press('#addRefs', 'Enter');
    check('Enter in the passage box adds it', await until(p, i => db.lists.find(l => l.id === i).items.length === 3, id));

    // reduced motion
    const rm = await browser.newContext({ ...PHONE, reducedMotion: 'reduce' });
    const rp = await rm.newPage();
    await rp.goto(BASE); await rp.evaluate(s => Object.entries(JSON.parse(s)).forEach(([k, val]) => localStorage.setItem(k, val)), state);
    await rp.goto(`${BASE}#/present/${id}/0`); await rp.reload(); await hasText(rp);
    const anim = await rp.evaluate(() => parseFloat(getComputedStyle(document.getElementById('slide')).animationDuration) || 0);
    check('reduced motion: slides don’t animate', anim <= .01, `${anim}s`);
    await rm.close();
    await ctx.close();
  }

  // Add to Home Screen strip, as Safari on an iPhone (detected from the browser, no ?install= preview)
  {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const ip = await browser.newContext({ ...PHONE, userAgent: IPHONE, acceptDownloads: true });
    const p = await ip.newPage();
    const w = watch(p);
    await p.goto(BASE);
    check('iPhone: no install strip before the first study', !(await p.$('.install')));
    await makeStudy(p, BASE, 'Install', 'John 1:1');
    await p.goto(`${BASE}#/`);
    check('iPhone: strip warns once there’s a study', await until(p, () => /saved only on this phone/.test(document.querySelector('.install')?.innerText || '')));
    await p.click('.install [data-act=installHow]');
    check('iPhone: Add shows backup, Share → Add to Home Screen, then Import', await until(p, () => {
      const s = document.getElementById('installSheet');
      return s.open && /Save a backup/.test(s.innerText) && /Share/.test(s.innerText) && /Add to Home Screen/.test(s.innerText) && /Import/.test(s.innerText);
    }));
    check('iPhone: the sheet is modal and has the focus', await p.evaluate(() => document.getElementById('installSheet').contains(document.activeElement)));
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#installSheet [data-act=installBackup]')]);
    check('iPhone: Save backup downloads it and the sheet stays open', !!dl && await p.evaluate(() => document.getElementById('installSheet').open));
    await p.keyboard.press('Escape');
    check('iPhone: Escape closes the sheet', await until(p, () => !document.getElementById('installSheet').open));
    await p.click('.install [data-act=installLater]');
    await p.reload();
    check('iPhone: ✕ hides it, also after reload', await until(p, () => !!document.querySelector('.hero')) && !(await p.$('.install')));
    await p.evaluate(() => { db.settings.installLater = Date.now() - 8 * 864e5; save(); }); await p.reload();
    check('iPhone: it comes back after 7 days', await until(p, () => !!document.querySelector('.install')));
    check('iPhone strip: no errors', w.errors.length === 0, w.errors.join(' | '));
    await ip.close();

    // the installed app on iPhone starts empty: it offers to import the backup
    const home = await browser.newContext({ ...PHONE, userAgent: IPHONE });
    await home.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    const h = await home.newPage();
    await h.goto(BASE);
    check('installed iPhone app, no studies: offers Import', await until(h, () => /Moved from Safari/.test(document.querySelector('.install')?.innerText || '')) && !!(await h.$('#importFile')));
    await home.close();

    // iPadOS Safari says it's a Mac; the touch screen gives it away
    const ipad = await browser.newContext({ viewport: { width: 820, height: 1180 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' });
    await ipad.addInitScript(() => { Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }); Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 }); });
    const ia = await ipad.newPage();
    await makeStudy(ia, BASE, 'iPad', 'John 1:1'); await ia.goto(`${BASE}#/`);
    check('iPad (desktop-style Safari): gets the iPhone/iPad steps', await until(ia, () => /saved only on this phone/.test(document.querySelector('.install')?.innerText || '')));
    await ipad.close();

    // Android: after installing from the tab, the strip doesn't come back with manual steps
    const and = await browser.newContext({ ...PHONE, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
    const a = await and.newPage();
    await makeStudy(a, BASE, 'Android', 'John 1:1'); await a.goto(`${BASE}#/`);
    const shown = await until(a, () => /Opens like an app/.test(document.querySelector('.install')?.innerText || ''));
    await a.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    check('Android: strip offered, then gone once installed', shown && await until(a, () => !document.querySelector('.install')));
    await and.close();
  }
} finally {
  await browser.close();
  server?.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
