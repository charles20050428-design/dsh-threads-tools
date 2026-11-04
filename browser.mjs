/**
 * browser.mjs — Threads 網頁的自動化層
 *
 * 這裡沒有任何私人資料：你的帳號由環境變數 THREADS_ME 提供（不含 @）。
 * 登入狀態沿用瀏覽器 profile（第一次開啟視窗時手動登入一次即可）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PW_CANDIDATES = [
  'playwright-core',
  path.join(process.env.DSH_PROFILE_DIR || path.join(process.env.USERPROFILE || '.', '.dsh', 'profiles', 'desktop'), 'node_modules', 'playwright-core'),
  path.join(process.env.USERPROFILE || '.', '.dsh', 'profiles', 'desktop', 'node_modules', 'playwright-core'),
  path.join(process.env.USERPROFILE || '.', '.dsh', 'profiles', 'desktop', 'node_modules', '@playwright', 'mcp', 'node_modules', 'playwright-core'),
];
let pw;
for (const cand of PW_CANDIDATES) {
  try { pw = require(cand); break; } catch (e) { if (e?.code !== 'MODULE_NOT_FOUND') throw e; }
}
if (!pw) throw new Error('找不到 playwright-core：請確認 DSH profile 已安裝 playwright');
const { chromium } = pw;

const HOME = 'https://www.threads.com';

/** 你的 Threads 帳號（不含 @）。設定環境變數 THREADS_ME=你的帳號。 */
export const ME = (process.env.THREADS_ME || '').trim().replace(/^@/, '');

/** 這則留言／貼文是不是我自己發的。沒設定 THREADS_ME 時一律回 false（退化成只看 UI 標記）。 */
export const isMe = (user) => !!ME && user === ME;

const PROFILE_DIR = process.env.THREADS_PROFILE_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'threads-browser', 'profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** 從 block 全文剝掉「用戶名 時間 [· 作者]」前綴與 UI 噪聲，留下留言正文。 */
export function stripPrefix(raw, user) {
  let t = clean(raw);
  if (user && t.startsWith(user)) t = t.slice(user.length).trim();
  t = t.replace(/^(\d+\s*(秒|分鐘|小時|天|週|個月)|\d{1,2}\/\d{1,2}|\d+\s*(s|m|h|d))\s*(·\s*作者)?\s*/i, '');
  t = t.replace(/\s*翻譯\s*/g, ' ').replace(/\s*查看動態\s*/g, ' ').replace(/\s*熱門\s*/g, ' ');
  t = t.replace(/\s+\d+\s*\/\s*\d+\s+/g, ' ');
  t = t.replace(/\s+回覆[^……]{0,40}……/g, ' ');
  t = t.replace(/\s+\d+$/, '');
  return t.trim();
}

/** 帖子頁統一走「最近」排序，回覆時才找得到新留言（熱門排序會把新留言埋掉）。 */
export function recentUrl(postUrl) {
  const base = String(postUrl).split('?')[0];
  return base + '?sort_order=recent&filter_type=all';
}

export function createThreadsController() {
  let ctxPromise = null;
  let page = null;

  async function ensure() {
    if (ctxPromise) {
      // 瀏覽器被關掉／當掉時 context 已死，快取會讓所有工具永久報 "has been closed"
      const c = await ctxPromise.catch(() => null);
      if (!c) ctxPromise = null;
    }
    if (!ctxPromise) {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      ctxPromise = chromium
        .launchPersistentContext(PROFILE_DIR, {
          channel: 'msedge',
          headless: false,
          viewport: null,
          args: ['--autoplay-policy=no-user-gesture-required'],
        })
        .then((c) => {
          c.on('close', () => { ctxPromise = null; page = null; });
          return c;
        })
        .catch((e) => { ctxPromise = null; throw e; });
    }
    const ctx = await ctxPromise;
    if (!page || page.isClosed()) page = ctx.pages()[0] ?? (await ctx.newPage());
    return ctx;
  }

  async function goto(url, waitMs = 3500) {
    await ensure();
    await page.goto(url.startsWith('http') ? url : HOME + url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(waitMs);
  }

  /** 往下滾觸發留言懶加載。 */
  async function loadMore(times = 2) {
    await ensure();
    for (let i = 0; i < times; i++) {
      await page.mouse.move(500, 500).catch(() => {});
      await page.mouse.wheel(0, 1400).catch(() => {});
      await sleep(900);
    }
  }

  async function loggedIn() {
    const ctx = await ensure();
    const cookies = await ctx.cookies();
    return cookies.some((c) => c.name === 'sessionid');
  }

  /** 讀當前頁面的留言/貼文區塊（含 usernames 與原始文字）。 */
  async function readBlocks() {
    await ensure();
    return page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('[data-pressable-container="true"]')].map((el, i) => {
        const a = el.querySelector('a[href^="/@"]:not([href*="/post/"])');
        const user = (a?.getAttribute('href') || '').replace(/^\/@/, '');
        const imgAlt = el.querySelector('img')?.getAttribute('alt') || '';
        return { i, user, raw: clean(el.innerText) };
      }).filter((b) => b.raw);
    });
  }

  async function listMyPosts(limit = 5) {
    await goto(`/@${ME}`);
    const hrefs = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/post/"]')].map((a) => a.getAttribute('href')))]);
    return hrefs.filter(Boolean).slice(0, limit);
  }

  /** 讀一個帖子頁：主貼 + 留言（最近排序），標記哪些已被我回過。 */
  async function readThread(postUrl) {
    await goto(recentUrl(postUrl));
    await loadMore(2);
    const blocks = await readBlocks();
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (isMe(b.user)) continue;
      // 最近排序（最新在最上）：我對這則留言的回覆會緊貼在它上面；也兼容升序（貼在下面）
      const prev = i > 0 && i - 1 !== 0 ? blocks[i - 1] : null;
      const next = i + 1 < blocks.length ? blocks[i + 1] : null;
      const replied = isMe(prev?.user) || isMe(next?.user);
      out.push({ i: b.i, user: b.user, text: stripPrefix(b.raw, b.user).slice(0, 300), replied });
    }
    return { postUrl, post: stripPrefix(blocks[0]?.raw ?? '', blocks[0]?.user ?? '').slice(0, 160), replies: out };
  }

  /** 找某則留言並進入它的回覆編輯器（最近排序）。 */
  async function openReply(postUrl, targetUser, targetText) {
    await goto(recentUrl(postUrl));
    const blocks = await readBlocks();
    const cand = blocks.filter((b) => b.user === targetUser && !isMe(b.user));
    if (!cand.length) throw new Error(`找不到 @${targetUser} 在這則帖子的留言`);
    let target = cand[0];
    if (targetText) {
      const hit = cand.find((b) => stripPrefix(b.raw, b.user).includes(clean(targetText).slice(0, 20)));
      if (hit) target = hit;
    }

    const block = page.locator('[data-pressable-container="true"]').nth(target.i);
    await block.locator('svg title').filter({ hasText: '回覆' }).first().locator('xpath=../..').click({ timeout: 15000 });
    await sleep(2500);
    return target;
  }

  /** 讀「動態 → 回覆」：別人回覆我的留言清單（最新在最上）。會先下滑載入更多。 */
  async function listActivityReplies(limit = 12, scrolls = 2) {
    await goto('https://www.threads.com/activity/replies/');
    await loadMore(Math.max(0, Math.min(Number(scrolls) || 0, 8)));
    const cards = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('[data-pressable-container="true"]')].map((el) => {
        const anchors = [...el.querySelectorAll('a[href^="/@"]')];
        const postA = anchors.find((a) => (a.getAttribute('href') || '').includes('/post/'));
        const userA = anchors.find((a) => a !== postA);
        const user = (userA?.getAttribute('href') || '').replace(/^\/@/, '');
        const raw = clean(el.innerText);
        const time = (raw.match(/(\d+\s*(?:秒|分鐘|小時|天|週)前|大約\s*\d+\s*(?:秒|分鐘|小時|天)前)/) || [])[0] || '';
        // 卡片底下那排「回覆」圖標：已回＝實心勾（沒有 path 子元素），未回＝空心氣泡（1 個 path）
        const replySvg = [...el.querySelectorAll('svg')].find((s) => (s.querySelector('title')?.textContent || '') === '回覆');
        const repliedIcon = replySvg ? replySvg.querySelectorAll('path').length === 0 : false;
        return { user, time, text: clean(postA?.innerText || ''), replyUrl: postA?.getAttribute('href') || '', repliedIcon };
      }).filter((c) => c.user && c.replyUrl);
    });
    const seen = new Set();
    return cards.filter((c) => { if (seen.has(c.replyUrl)) return false; seen.add(c.replyUrl); return true; }).slice(0, limit);
  }

  /** 只讀：打開某則留言頁，回傳可見文字與大張圖片的 URL（純圖留言用）。 */
  async function peek(replyUrl) {
    await goto(replyUrl);
    return page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const imgs = [...document.querySelectorAll('img')]
        .map((i) => ({ src: i.currentSrc || i.src || '', w: i.naturalWidth || i.offsetWidth || 0, h: i.naturalHeight || i.offsetHeight || 0, alt: i.alt || '' }))
        .filter((x) => x.src && x.w >= 120 && x.h >= 120 && !x.src.startsWith('data:'));
      const seen = new Set();
      const unique = imgs.filter((x) => { const k = x.src.split('?')[0]; if (seen.has(k)) return false; seen.add(k); return true; });
      return {
        url: location.href,
        body: clean(document.body.innerText).slice(0, 700),
        hasNoReply: /尚無回覆/.test(document.body.innerText || ''),
        images: unique.slice(0, 4).map((x) => ({ src: x.src, w: x.w, h: x.h, alt: x.alt })),
      };
    });
  }

  /** 回覆「動態→回覆」裡的一則：直接開對方單則頁填字送出；給了 imagePath 就貼圖。 */
  async function replyToActivity(user, text, replyUrl, imagePath) {
    let url = replyUrl;
    if (!url) {
      const list = await listActivityReplies(30);
      const hit = list.find((c) => c.user === user);
      if (!hit) throw new Error(`動態回覆裡找不到 @${user} 的留言`);
      url = hit.replyUrl;
    }
    await goto(url);
    // 開頁後再確認一次有沒有回過：有「尚無回覆」＝還沒回；已有我的回覆連結＝回過了
    const check = await page.evaluate((me) => {
      const body = document.body.innerText || '';
      const mine = !!me && !!document.querySelector('a[href^="/@' + me + '/post/"]');
      return { none: /尚無回覆/.test(body), mine };
    }, ME);
    if (!check.none && check.mine) return { ok: false, alreadyReplied: true, replyUrl: url };
    const sent = imagePath ? await composeImageAndSend(imagePath, text) : await composeAndSend(text);
    return { ...sent, replyUrl: url };
  }

  /** 貼圖＋送出：點「附加影音內容」走原生 filechooser，附上圖片後按「發佈」。 */
  async function composeImageAndSend(imagePath, text = '') {
    if (!fs.existsSync(imagePath)) throw new Error('圖片不存在：' + imagePath);
    const attach = page.getByRole('button', { name: '附加影音內容' }).first();
    await attach.waitFor({ state: 'visible', timeout: 15000 });
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      attach.click(),
    ]);
    await chooser.setFiles(imagePath);
    const publish = page.getByRole('button', { name: /^發佈$|^发布$/ }).first();
    await publish.waitFor({ state: 'visible', timeout: 20000 });
    await sleep(1200);
    if (text && text.trim()) {
      const editor = page.locator('[data-lexical-editor="true"]').first();
      await editor.focus();
      await sleep(400);
      await page.keyboard.type(text.trim(), { delay: 25 });
      await sleep(700);
    }
    await publish.click({ timeout: 15000 });

    let last = { posted: false };
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      last = await page.evaluate(() => ({
        posted: /已發佈|已发布|Posted/.test(document.body.innerText || ''),
        dialog: !!document.querySelector('[role="dialog"]'),
        editorText: (document.querySelector('[data-lexical-editor="true"]')?.innerText || '').trim().length,
      }));
      if (last.posted || (!last.dialog && last.editorText === 0)) return { ok: true, detail: last };
    }
    return { ok: false, detail: last };
  }

  /** 在目前編輯器填字並送出。回傳 { ok, detail }。 */
  async function composeAndSend(text) {
    const editor = page.locator('[data-lexical-editor="true"]').first();
    await editor.waitFor({ state: 'attached', timeout: 15000 });
    // 空白編輯器中央被 placeholder 覆蓋層擋住（click 一直 timeout）→ 退回 DOM focus
    try {
      await editor.click({ timeout: 4000 });
    } catch {
      await editor.focus();
    }
    await sleep(400);
    await page.keyboard.insertText(text);
    await sleep(1200);
    if (!(await editor.innerText()).trim()) throw new Error('輸入框沒吃到字');

    try {
      const buttons = editor.locator('xpath=ancestor::div[5]').locator('[role="button"]');
      const send = buttons.last();
      await send.waitFor({ state: 'visible', timeout: 6000 });
      const box = await send.boundingBox();
      if (!box || box.width < 8) throw new Error('送出按鈕不可見');
      await send.click({ timeout: 10000 });
    } catch {
      const publish = page.locator('[role="dialog"] [role="button"]').filter({ hasText: /^發佈$/ }).last();
      await publish.click({ timeout: 15000 });
    }

    let last = { posted: false, editorCleared: false, url: page.url() };
    for (let i = 0; i < 14; i++) {
      await sleep(500);
      last = await page.evaluate(() => {
        const ed = document.querySelector('[data-lexical-editor="true"]');
        const body = document.body.innerText || '';
        return {
          posted: /已發佈|已发布|Posted/.test(body),
          editorCleared: !ed || (ed.innerText || '').trim().length === 0,
          url: location.href,
        };
      });
      if (last.posted || last.editorCleared) return { ok: true, detail: last };
    }
    return { ok: false, detail: last };
  }

  /** 讀首頁推薦流（別人的貼文），用來學網路用語／看什麼在紅。 */
  async function feed(limit = 12, scrolls = 2) {
    await goto('https://www.threads.com/');
    await loadMore(Math.max(0, Math.min(Number(scrolls) || 0, 8)));
    const cards = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('[data-pressable-container="true"]')].map((el, i) => {
        const anchors = [...el.querySelectorAll('a[href^="/@"]')];
        const postA = anchors.find((a) => (a.getAttribute('href') || '').includes('/post/'));
        const userA = anchors.find((a) => a !== postA && !(a.getAttribute('href') || '').includes('/post/'));
        const user = (userA?.getAttribute('href') || '').replace(/^\/@/, '');
        return { i, user, postUrl: postA?.getAttribute('href') || '', raw: clean(el.innerText) };
      }).filter((c) => c.user && c.postUrl);
    });
    const seen = new Set();
    return cards
      .filter((c) => { if (seen.has(c.postUrl)) return false; seen.add(c.postUrl); return true; })
      .slice(0, limit)
      .map((c) => ({ user: c.user, postUrl: c.postUrl, text: stripPrefix(c.raw, c.user).slice(0, 400), tail: c.raw.slice(-60) }));
  }

  /** 在別人的帖子下留言：打開帖子 → 點「回覆」→ 填字（可附圖）→ 送出。 */
  async function comment(postUrl, text, imagePath) {
    if ((!text || !text.trim()) && !imagePath) throw new Error('text 和 imagePath 至少要給一個');
    if (imagePath && !fs.existsSync(imagePath)) throw new Error('圖片不存在：' + imagePath);
    await goto(postUrl);
    const replySvg = page.locator('svg title').filter({ hasText: '回覆' }).first();
    await replySvg.waitFor({ state: 'attached', timeout: 15000 });
    await replySvg.locator('xpath=../..').click();
    await sleep(2500);
    const sent = imagePath ? await composeImageAndSend(imagePath, text) : await composeAndSend(text);
    return { ...sent, postUrl };
  }

  /** 發新串文：點「新串文」→ 填字（可附圖）→ 按「發佈」。 */
  async function post(text, imagePath) {
    if ((!text || !text.trim()) && !imagePath) throw new Error('text 和 imagePath 至少要給一個');
    if (imagePath && !fs.existsSync(imagePath)) throw new Error('圖片不存在：' + imagePath);
    await goto('https://www.threads.com/');
    const newBtn = page.getByRole('button', { name: '新串文' }).first();
    await newBtn.waitFor({ state: 'visible', timeout: 15000 });
    await newBtn.click();
    await sleep(2500);

    const editor = page.locator('[data-lexical-editor="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 15000 });
    await editor.focus();
    await sleep(400);
    if (text && text.trim()) {
      await page.keyboard.type(text.trim(), { delay: 25 });
      await sleep(900);
    }

    if (imagePath) {
      const attach = page.getByRole('button', { name: '附加影音內容' }).first();
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15000 }),
        attach.click(),
      ]);
      await chooser.setFiles(imagePath);
      await sleep(1800);
    }

    const publish = page.getByRole('button', { name: /^發佈$|^发布$/ }).first();
    await publish.waitFor({ state: 'visible', timeout: 15000 });
    await publish.click();

    let last = { posted: false };
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      last = await page.evaluate(() => ({
        posted: /已發佈|已发布|Posted/.test(document.body.innerText || ''),
        dialog: !!document.querySelector('[role="dialog"]'),
        editorText: (document.querySelector('[data-lexical-editor="true"]')?.innerText || '').trim().length,
        url: location.href,
      }));
      if (last.posted || !last.dialog) return { ok: true, detail: last };
    }
    return { ok: false, detail: last };
  }

  async function reply(config) {
    const { postUrl, user, text, matchText } = config;
    if (!text || !text.trim()) throw new Error('回覆內容不能為空');
    const target = await openReply(postUrl, user, matchText);
    const sent = await composeAndSend(text.trim());
    return { ok: sent.ok, target: { user: target.user, blockIndex: target.i }, ...sent.detail };
  }

  async function status() {
    const ok = await loggedIn();
    return {
      loggedIn: ok,
      url: page && !page.isClosed() ? page.url() : null,
      me: ME || null,
      hint: ME ? undefined : '尚未設定 THREADS_ME（你的 Threads 帳號，不含 @）；設定後才能判斷哪些留言是我自己發的',
      profile: PROFILE_DIR,
    };
  }

  async function close() {
    try { if (ctxPromise) { const ctx = await ctxPromise; await ctx.close(); } } catch {}
    ctxPromise = null; page = null;
  }

  return { ensure, goto, loadMore, loggedIn, readBlocks, listMyPosts, readThread, listActivityReplies, replyToActivity, peek, feed, comment, post, reply, status, close };
}
