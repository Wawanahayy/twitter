// x-actions-puppeteer.mjs — v4.4
// - Support: like/unlike, retweet/unretweet, bookmark/unbookmark, follow/unfollow, reply, quote, post
// - Quote / Retweet pakai tweet yang sama dengan tweetUrl
// - Idempotent: kalau sudah like/retweet/bookmark/follow → skip
// - Anti-detect basic: random viewport, mouse move, scroll, typing manusiawi
// - Leave-site popup auto-accept
// - Multi-account: cookie bisa diganti per akun via ensurePptrCookie()
// - closeBrowser() untuk tutup browser tiap ganti akun

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

// DEFAULT dari .env (single account), bisa dioverride per akun via ensurePptrCookie()
const ENV_X_COOKIE   = process.env.X_COOKIE || "";
const PPTR_HEADLESS  = String(process.env.PPTR_HEADLESS || "1") === "1";
const PPTR_PROXY     = process.env.PPTR_PROXY || "";
const PPTR_UA        = process.env.PPTR_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LOG_LEVEL = (process.env.LOG_LEVEL || "debug").toLowerCase();
const isDebug   = LOG_LEVEL.includes("debug");

function log(...a)    { console.log("[pptr]", ...a); }
function debug(...a)  { if (isDebug) console.log("[pptr][debug]", ...a); }
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ------------------- Random helpers (anti-detect) ------------------- */

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanMouseMove(page, x, y) {
  try {
    const viewport = page.viewport() || { width: 1280, height: 720 };
    let cx = randInt(0, viewport.width);
    let cy = randInt(0, viewport.height);
    const steps = randInt(8, 20);

    for (let i = 0; i < steps; i++) {
      cx += (x - cx) / (steps - i) + randInt(-3, 3);
      cy += (y - cy) / (steps - i) + randInt(-3, 3);
      await page.mouse.move(cx, cy);
      await wait(randInt(5, 25));
    }
  } catch {
    // kalau gagal, biarin aja, nanti klik langsung
  }
}

async function humanScrollRandom(page) {
  const times = randInt(1, 3);
  for (let i = 0; i < times; i++) {
    const delta = randInt(200, 700);
    await page.mouse.wheel({ deltaY: delta });
    await wait(randInt(300, 900));
  }
}

/* ------------------- Cookie Parser (Dual-Domain) ------------------- */

function parseCookies(raw) {
  return raw
    .split(";")
    .map(v => v.trim())
    .map(v => {
      const idx = v.indexOf("=");
      if (idx < 1) return null;
      const name  = v.slice(0, idx).trim();
      const value = v.slice(idx + 1).trim().replace(/^"|"$/g, "");

      return [
        { name, value, domain: ".x.com", path: "/", secure: true },
        { name, value, domain: ".twitter.com", path: "/", secure: true }
      ];
    })
    .filter(Boolean)
    .flat();
}

/* -------------------------- Browser Manager -------------------------- */

let browser         = null;
let page            = null;
let CURRENT_COOKIE  = ENV_X_COOKIE; // akan dioverride per akun lewat ensurePptrCookie()

function buildArgs() {
  const args = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-setuid-sandbox",
    "--disable-infobars",
    "--disable-notifications",
  ];
  if (PPTR_PROXY) args.push(`--proxy-server=${PPTR_PROXY}`);
  return args;
}

// tutup browser dan reset state
export async function closeBrowser() {
  if (!browser) return;
  try {
    await browser.close();
    debug("Browser closed");
  } catch (e) {
    log("closeBrowser error:", e?.message || e);
  } finally {
    browser = null;
    page    = null;
  }
}

// Bisa dipanggil dari luar untuk ganti cookie per akun (multi account)
export async function ensurePptrCookie(rawCookie) {
  const next = String(rawCookie || "").trim();
  if (!next) {
    debug("ensurePptrCookie: empty cookie, keep CURRENT_COOKIE as is");
    return;
  }
  if (next === CURRENT_COOKIE) {
    return; // sama → nggak perlu update
  }

  CURRENT_COOKIE = next;
  debug("ensurePptrCookie: update cookie for Puppeteer");

  if (page) {
    try {
      const cookies = parseCookies(CURRENT_COOKIE);
      await page.setCookie(...cookies);
      debug("ensurePptrCookie: cookies applied to existing page");
    } catch (e) {
      log("ensurePptrCookie: setCookie error:", e?.message || e);
    }
  }
}

export async function getPage() {
  if (page) return page;

  log("Launching Puppeteer…");

  browser = await puppeteer.launch({
    headless: PPTR_HEADLESS,
    args: buildArgs(),
    ignoreDefaultArgs: ["--enable-automation"]
  });

  page = (await browser.pages())[0];
  await page.setUserAgent(PPTR_UA);

  // viewport random dikit
  try {
    await page.setViewport({
      width:  randInt(1100, 1400),
      height: randInt(700, 900),
    });
  } catch {}

  // handle popup "Leave site?"
  page.on("dialog", async dialog => {
    console.log("[pptr] Dialog detected:", dialog.message());
    try { await dialog.accept(); } catch {}
  });

  if (CURRENT_COOKIE) {
    try {
      await page.setCookie(...parseCookies(CURRENT_COOKIE));
      debug("Cookies set for x.com + twitter.com (initial)");
    } catch (e) {
      log("Cookie error:", e);
    }
  }

  try {
    await page.goto("https://x.com", { waitUntil: "networkidle2", timeout: 60000 });
  } catch {
    try {
      await page.goto("https://x.com", { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch {}
  }

  await wait(1500);
  return page;
}

/* ----------------------------- HELPERS ----------------------------- */

function normalizeTweetUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

async function gotoTweet(rawUrl) {
  const p   = await getPage();
  const url = normalizeTweetUrl(rawUrl);
  debug("Goto:", url);

  try {
    await p.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  } catch {
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  await wait(randInt(500, 1500));
  await humanScrollRandom(p);
}

// umum: cek apakah ada salah satu selector yang muncul
async function elementExists(selectors, timeout = 4000) {
  const p = await getPage();
  const start = Date.now();

  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      const el = await p.$(sel);
      if (el) return true;
    }
    await wait(200);
  }
  return false;
}

// klik element yang benar2 keliatan (boundingBox non-zero) + human mouse
async function clickVisible(selectors, timeout = 6000) {
  const p = await getPage();
  const start = Date.now();

  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      const els = await p.$$(sel);
      for (const el of els) {
        const box = await el.boundingBox();
        if (!box || box.width === 0 || box.height === 0) continue;

        const jitterX = Math.min(5, box.width / 4);
        const jitterY = Math.min(5, box.height / 4);
        const cx = box.x + box.width  / 2 + randInt(-jitterX, jitterX);
        const cy = box.y + box.height / 2 + randInt(-jitterY, jitterY);

        await humanMouseMove(p, cx, cy);
        await wait(randInt(40, 160));
        await p.mouse.down();
        await wait(randInt(30, 120));
        await p.mouse.up();

        debug("Clicked visible (human):", sel, "box=", box);
        return true;
      }
    }
    await wait(200);
  }

  debug("clickVisible FAIL for", selectors);
  return false;
}

// klik tombol Balas/Posting di DALAM dialog reply/quote
async function clickDialogPostButton() {
  const selectors = [
    'div[role="dialog"] [data-testid="tweetButtonInline"]',
    'div[role="dialog"] [data-testid="tweetButton"]',
    'div[role="dialog"] button[data-testid="tweetButtonInline"]',
    'div[role="dialog"] button[data-testid="tweetButton"]',
    'div[role="dialog"] div[role="button"][data-testid="tweetButton"]',
  ];

  const ok = await clickVisible(selectors, 6000);
  if (ok) {
    await wait(2500);
    return true;
  }
  return false;
}

// tombol Posting/Balas/Reply (dipakai semua: post/reply/quote)
async function clickPostButton() {
  if (await clickDialogPostButton()) return true;

  const ok = await clickVisible([
    'button[data-testid="tweetButtonInline"]',
    'button[data-testid="tweetButton"]',
    'div[role="button"][data-testid="tweetButtonInline"]',
    'div[role="button"][data-testid="tweetButton"]',
  ], 5000);

  if (ok) await wait(2500);
  return ok;
}

async function typeHuman(selector, text) {
  const p = await getPage();

  try {
    await p.waitForSelector(selector, { timeout: 8000 });
  } catch (e) {
    debug("Textbox wait FAIL:", selector, e.message);
    return false;
  }

  const el = await p.$(selector);
  if (!el) return false;

  // fokus dulu
  try { await el.click(); } catch {}
  await wait(randInt(200, 600));

  for (const c of text) {
    const delay = randInt(30, 160);
    await el.type(c, { delay });

    // kadang typo + backspace
    if (Math.random() < 0.06) {
      await wait(randInt(100, 300));
      await p.keyboard.press("Backspace");
      await wait(randInt(80, 200));
      await el.type(c, { delay: randInt(40, 120) });
    }

    // pause random lebih panjang
    if (Math.random() < 0.04) {
      await wait(randInt(300, 900));
    }
  }

  return true;
}

// klik menu item berdasar teks (buat Kutipan/Quote)
async function clickMenuItemByText(pattern, timeout = 5000) {
  const p  = await getPage();
  const rx = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");

  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await p.waitForSelector('[role^="menuitem"],div[role="button"],button[role="button"]', { timeout: 1000 });
    } catch {
      await wait(150);
      continue;
    }

    const items = await p.$$('[role^="menuitem"],div[role="button"],button[role="button"]');
    debug("menu candidates =", items.length);

    for (const el of items) {
      const text = (await p.evaluate(e => e.innerText || "", el)).trim();
      if (!text) continue;
      if (!rx.test(text)) continue;

      const box = await el.boundingBox();
      if (!box || box.width === 0 || box.height === 0) continue;

      await el.click();
      debug("Clicked menuitem:", text, "box=", box);
      await wait(400);
      return true;
    }

    await wait(150);
  }

  debug("clickMenuItemByText FAIL for", pattern.toString());
  return false;
}

/* ---- status helpers ---- */

async function isLiked() {
  return await elementExists([
    'button[data-testid="unlike"]',
    'div[role="button"][data-testid="unlike"]',
  ], 4000);
}

async function isRetweeted() {
  return await elementExists([
    'button[data-testid="unretweet"]',
    'div[role="button"][data-testid="unretweet"]',
  ], 4000);
}

async function isBookmarked() {
  return await elementExists([
    'button[data-testid="unbookmark"]',
    'div[role="button"][data-testid="unbookmark"]',
  ], 4000);
}

// FOLLOW status: testid klasik + text "Following/Mengikuti"
async function isFollowing() {
  const hasUnfollow = await elementExists([
    'button[data-testid="unfollow"]',
    'div[role="button"][data-testid="unfollow"]',
  ], 4000);

  if (hasUnfollow) return true;

  const p = await getPage();
  const byText = await p.evaluate(() => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    }

    const LABELS = [/^following$/i, /^mengikuti$/i];

    const nodes = Array.from(
      document.querySelectorAll('button, div[role="button"]')
    );

    for (const el of nodes) {
      if (!visible(el)) continue;
      const txt = (el.innerText || '').trim();
      if (!txt) continue;
      for (const rx of LABELS) {
        if (rx.test(txt)) return true;
      }
    }
    return false;
  });

  return byText;
}

/**
 * Klik tombol retweet yang "nempel" dengan tweetUrl
 */
async function clickRetweetNearUrl(rawUrl, timeout = 8000) {
  const p = await getPage();

  let pathPart = "";
  try {
    const u = new URL(normalizeTweetUrl(rawUrl));
    pathPart = u.pathname;
  } catch {
    debug("Invalid URL for clickRetweetNearUrl:", rawUrl);
    return false;
  }

  debug("clickRetweetNearUrl pathPart=", pathPart);

  const start = Date.now();

  while (Date.now() - start < timeout) {
    const ok = await p.evaluate((pathPart) => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/status/"]'));
      if (!anchors.length) return false;

      let targetAnchor = null;
      let bestScore = Infinity;

      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        if (!href.includes("/status/")) continue;

        const score = Math.abs(href.length - pathPart.length) +
                      (href.endsWith(pathPart) ? 0 : 10);

        if (score < bestScore) {
          bestScore = score;
          targetAnchor = a;
        }
      }

      if (!targetAnchor) return false;

      const rectA = targetAnchor.getBoundingClientRect();
      const targetY = rectA.top + rectA.height / 2;

      const buttons = Array.from(
        document.querySelectorAll(
          'button[data-testid="retweet"],div[role="button"][data-testid="retweet"],' +
          'button[data-testid="unretweet"],div[role="button"][data-testid="unretweet"]'
        )
      );

      if (!buttons.length) return false;

      let bestBtn = null;
      let bestDiff = Infinity;

      for (const b of buttons) {
        const r = b.getBoundingClientRect();
        const y = r.top + r.height / 2;
        const diff = Math.abs(y - targetY);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestBtn = b;
        }
      }

      if (!bestBtn) return false;
      bestBtn.click();
      return true;
    }, pathPart);

    if (ok) {
      debug("Clicked retweet/unretweet near tweetUrl");
      return true;
    }

    await wait(250);
  }

  debug("clickRetweetNearUrl FAIL");
  return false;
}

/* ----------------------------- ACTIONS ----------------------------- */

export async function doLike(url) {
  log("Like:", url);
  await gotoTweet(url);

  if (await isLiked()) {
    debug("Already liked → skip like");
    return true;
  }

  return await clickVisible([
    'button[data-testid="like"]',
    'div[role="button"][data-testid="like"]',
  ]);
}

export async function doUnlike(url) {
  log("Unlike:", url);
  await gotoTweet(url);

  if (!(await isLiked())) {
    debug("Not liked → skip unlike");
    return true;
  }

  return await clickVisible([
    'button[data-testid="unlike"]',
    'div[role="button"][data-testid="unlike"]',
  ]);
}

export async function doRetweet(url) {
  log("Retweet:", url);
  await gotoTweet(url);

  if (await isRetweeted()) {
    debug("Already retweeted → skip retweet");
    return true;
  }

  if (!await clickRetweetNearUrl(url)) {
    if (!await clickVisible([
      'button[data-testid="retweet"]',
      'div[role="button"][data-testid="retweet"]',
    ])) return false;
  }

  await wait(350);

  const p = await getPage();
  try {
    await p.waitForSelector('[role^="menuitem"]', { timeout: 5000 });
    const items = await p.$$('[role^="menuitem"]');
    if (items[0]) {
      const box = await items[0].boundingBox();
      await items[0].click();
      debug("Chose menuitem #0 → retweet, box=", box);
      return true;
    }
  } catch (e) {
    debug("Retweet menu fail:", e.message);
  }

  return false;
}

export async function doUnretweet(url) {
  log("Unretweet:", url);
  await gotoTweet(url);

  if (!(await isRetweeted())) {
    debug("Not retweeted → skip unretweet");
    return true;
  }

  if (!await clickRetweetNearUrl(url)) {
    if (!await clickVisible([
      'button[data-testid="unretweet"]',
      'div[role="button"][data-testid="unretweet"]',
    ])) return false;
  }

  await wait(350);

  const p = await getPage();
  try {
    await p.waitForSelector('[role^="menuitem"]', { timeout: 2000 });
    const items = await p.$$('[role^="menuitem"]');
    if (items[0]) {
      const box = await items[0].boundingBox();
      await items[0].click();
      debug("Chose menuitem #0 → unretweet, box=", box);
    }
  } catch {
    // kalau nggak ada menu, berarti klik tombol langsung unretweet → ignore
  }

  return true;
}

/* --- QUOTE / KUTIPAN --- */

export async function doQuote(url, text) {
  log("Quote:", url, text);
  await gotoTweet(url);

  if (!await clickRetweetNearUrl(url)) {
    if (!await clickVisible([
      'button[data-testid="retweet"]',
      'div[role="button"][data-testid="retweet"]',
      'button[data-testid="unretweet"]',
      'div[role="button"][data-testid="unretweet"]',
    ])) return false;
  }

  await wait(350);

  if (!await clickMenuItemByText(/Kutipan|Kutip|Quote/i, 5000)) {
    return false;
  }

  await wait(500);

  const textbox = 'div[role="textbox"][data-testid="tweetTextarea_0"]';
  if (!await typeHuman(textbox, text)) return false;

  return await clickPostButton();
}

/* --- REPLY / BALAS --- */

export async function doReply(url, text) {
  log("Reply:", url, text);
  await gotoTweet(url);

  if (!await clickVisible([
    'button[data-testid="reply"]',
    'div[role="button"][data-testid="reply"]',
  ])) return false;

  await wait(400);

  const textbox = 'div[role="textbox"][data-testid="tweetTextarea_0"]';
  if (!await typeHuman(textbox, text)) return false;

  return await clickPostButton();
}

/* --- POST (compose/post) --- */

export async function doPost(text) {
  const p = await getPage();
  log("Post:", text);

  try {
    await p.goto("https://x.com/compose/post", { waitUntil: "networkidle2" });
  } catch {
    await p.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded" });
  }

  await wait(600);

  const textbox = 'div[role="textbox"][data-testid="tweetTextarea_0"]';
  if (!await typeHuman(textbox, text)) return false;

  return await clickPostButton();
}

/* --- BOOKMARK / UNBOOKMARK --- */

export async function doBookmark(url) {
  log("Bookmark:", url);
  await gotoTweet(url);

  if (await isBookmarked()) {
    debug("Already bookmarked → skip bookmark");
    return true;
  }

  return await clickVisible([
    'button[data-testid="bookmark"]',
    'div[role="button"][data-testid="bookmark"]',
  ]);
}

export async function doUnbookmark(url) {
  log("Unbookmark:", url);
  await gotoTweet(url);

  if (!(await isBookmarked())) {
    debug("Not bookmarked → skip unbookmark");
    return true;
  }

  return await clickVisible([
    'button[data-testid="unbookmark"]',
    'div[role="button"][data-testid="unbookmark"]',
  ]);
}

/* --- FOLLOW / UNFOLLOW --- */

export async function doFollow(url) {
  log("Follow:", url);
  const p = await getPage();

  try {
    await p.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  } catch {
    try {
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch {}
  }

  await wait(1000);

  if (await isFollowing()) {
    debug("Already following → skip follow");
    return true;
  }

  // 1) Coba selector klasik data-testid="follow"
  const okClassic = await clickVisible([
    'button[data-testid="follow"]',
    'div[role="button"][data-testid="follow"]',
  ], 5000);

  if (okClassic) {
    await wait(1500);
    return true;
  }

  // 2) Fallback: cari tombol berdasar text "Follow" / "Ikuti"
  const okText = await p.evaluate(() => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    }

    const LABELS = [/^follow$/i, /^ikuti$/i];

    const nodes = Array.from(
      document.querySelectorAll('button, div[role="button"]')
    );

    for (const el of nodes) {
      if (!visible(el)) continue;
      const txt = (el.innerText || '').trim();
      if (!txt) continue;
      for (const rx of LABELS) {
        if (rx.test(txt)) {
          el.click();
          return true;
        }
      }
    }
    return false;
  });

  if (okText) {
    debug("doFollow: clicked button by text");
    await wait(1500);
    return true;
  }

  debug("doFollow: follow button not found");
  return false;
}

export async function doUnfollow(url) {
  log("Unfollow:", url);
  const p = await getPage();

  try {
    await p.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  } catch {
    try {
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch {}
  }

  await wait(800);

  if (!(await isFollowing())) {
    debug("Not following → skip unfollow");
    return true;
  }

  // 1) Coba tombol unfollow klasik
  let clicked = await clickVisible([
    'button[data-testid="unfollow"]',
    'div[role="button"][data-testid="unfollow"]',
  ], 5000);

  // 2) Fallback: klik tombol dengan text "Following" / "Mengikuti"
  if (!clicked) {
    clicked = await p.evaluate(() => {
      function visible(el) {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        );
      }

      const LABELS = [/^following$/i, /^mengikuti$/i];

      const nodes = Array.from(
        document.querySelectorAll('button, div[role="button"]')
      );

      for (const el of nodes) {
        if (!visible(el)) continue;
        const txt = (el.innerText || '').trim();
        if (!txt) continue;
        for (const rx of LABELS) {
          if (rx.test(txt)) {
            el.click();
            return true;
          }
        }
      }
      return false;
    });

    if (clicked) {
      debug("doUnfollow: clicked button by text");
    }
  }

  if (!clicked) {
    debug("doUnfollow: unfollow button not found");
    return false;
  }

  // 3) Konfirmasi popup
  const okConfirm = await clickVisible([
    'button[data-testid="confirmationSheetConfirm"]',
    'div[role="button"][data-testid="confirmationSheetConfirm"]',
  ], 5000);

  if (okConfirm) {
    await wait(1500);
    return true;
  }

  // Kadang nggak ada popup → click single button udah cukup
  debug("doUnfollow: no confirm popup, assume success");
  return true;
}

/* --------------------------- WRAPPER --------------------------- */

export class XActionsPuppeteer {
  async do(action) {
    const t    = (action?.type || "").toLowerCase();
    const url  = action.tweetUrl || action.screenUrl;
    const text = action.text || action.content || action.postText;

    if (t === "like")        return doLike(url);
    if (t === "unlike")      return doUnlike(url);
    if (t === "retweet")     return doRetweet(url);
    if (t === "unretweet")   return doUnretweet(url);
    if (t === "reply")       return doReply(url, text);
    if (t === "post")        return doPost(text);
    if (t === "quote")       return doQuote(url, text);
    if (t === "bookmark")    return doBookmark(url);
    if (t === "unbookmark")  return doUnbookmark(url);
    if (t === "follow")      return doFollow(url);
    if (t === "unfollow")    return doUnfollow(url);

    log("Unknown action:", t);
    return false;
  }
}
