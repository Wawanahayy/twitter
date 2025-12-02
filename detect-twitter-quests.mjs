#!/usr/bin/env node
// detect-twitter-quests.mjs — Puppeteer + cookie dari .env → deteksi tugas X/Twitter
//
// Cara pakai:
//   node detect-twitter-quests.mjs "https://quests.yom.net/loyalty"
//   node detect-twitter-quests.mjs halaman.html
//
// ENV:
//   SCAN_COOKIE="foo=bar; baz=qux; ..."  (copy dari DevTools → Request Headers → Cookie)
//   PPTR_HEADLESS=0   → kalau mau lihat browsernya (opsional)
//   PPTR_UA=...       → custom User-Agent (opsional)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ====== ENV COOKIE ======
const COOKIE =
  process.env.SCAN_COOKIE ||
  process.env.COOKIES_SCAN ||
  process.env.COOKIE_SCAN ||
  '';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node detect-twitter-quests.mjs <url|html-file> [more-url-or-file...]');
  console.error('Set SCAN_COOKIE di .env kalau perlu login.');
  process.exit(1);
}

function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

const DEFAULT_UA =
  process.env.PPTR_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36';

// ====== PUPPETEER LOADER UNTUK URL ======
async function loadHtmlFromUrlWithPuppeteer(urlStr) {
  const headless =
    String(process.env.PPTR_HEADLESS ?? '1').trim() === '0' ? false : true;

  const browser = await puppeteer.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_UA);

    // Kalau ada SCAN_COOKIE → set sebagai header & cookie page
    if (COOKIE && COOKIE.trim() !== '') {
      // Header Cookie untuk request pertama
      await page.setExtraHTTPHeaders({
        Cookie: COOKIE,
      });

      // Set cookie ke jar browser (supaya request JS berikutnya juga login)
      const cookiePairs = COOKIE.split(';')
        .map(s => s.trim())
        .filter(Boolean);

      const cookieObjs = cookiePairs
        .map(pair => {
          const eqIdx = pair.indexOf('=');
          if (eqIdx === -1) return null;
          const name = pair.slice(0, eqIdx).trim();
          const value = pair.slice(eqIdx + 1);
          if (!name) return null;
          return {
            name,
            value,
            url: urlStr,  // PENTING: pakai url, bukan domain/path manual
          };
        })
        .filter(Boolean);

      if (cookieObjs.length) {
        try {
          await page.setCookie(...cookieObjs);
        } catch (e) {
          console.error(
            '[warn] page.setCookie failed, lanjut pakai header Cookie saja:',
            e?.message || e
          );
        }
      }
    }

    await page.goto(urlStr, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // kasih waktu React render
    await sleep(3000);

    // Optional: tunggu sampai link X muncul (kalau ada)
    try {
      await page.waitForSelector('a[href*="x.com/"], a[href*="twitter.com/"]', {
        timeout: 10000,
      });
    } catch {
      // nggak apa-apa
    }

    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

// ====== LOADER GENERIK (URL → Puppeteer, file → fs) ======
async function loadHtml(src) {
  if (isUrl(src)) {
    return loadHtmlFromUrlWithPuppeteer(src);
  } else {
    const filePath = path.isAbsolute(src) ? src : path.join(__dirname, src);
    return fs.readFileSync(filePath, 'utf8');
  }
}

// ====== DETEKSI ACTION DARI TEKS ======
function extractActionsFromText(text) {
  const actions = new Set();

  if (/\bfollow\b/i.test(text)) actions.add('follow');
  if (/(^|\s)(like|❤️)(\s|$)/i.test(text)) actions.add('like');
  if (/\b(comment|reply|repl[y|i])\b/i.test(text)) actions.add('comment');
  if (/\b(repost|retweet|rt)\b/i.test(text)) actions.add('repost');
  if (/\b(quote|qt|quote tweet)\b/i.test(text)) actions.add('quote');
  if (/\bpost\b/i.test(text) && !/\brepost\b/i.test(text)) actions.add('post');
  if (/\bengage|engagement\b/i.test(text)) actions.add('engage');

  return [...actions];
}

// ====== HELPER: CARI URL X/TWITTER DI DALAM STRING ======
function findTwitterUrlInString(str) {
  if (!str) return null;
  const m = str.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

// Dari href (yang mungkin redirect/encoded), coba ambil URL Twitter final
function extractTwitterHref(href) {
  if (!href) return null;

  const direct = findTwitterUrlInString(href);
  if (direct) return direct;

  try {
    const decoded = decodeURIComponent(href);
    const fromDecoded = findTwitterUrlInString(decoded);
    if (fromDecoded) return fromDecoded;
  } catch {
    // ignore
  }

  try {
    const url = new URL(href, 'https://dummy.local');
    for (const [, value] of url.searchParams.entries()) {
      const inParam = findTwitterUrlInString(value);
      if (inParam) return inParam;

      try {
        const decoded = decodeURIComponent(value);
        const inDecoded = findTwitterUrlInString(decoded);
        if (inDecoded) return inDecoded;
      } catch {
        // ignore
      }
    }
  } catch {
    // not a full URL
  }

  return null;
}

// Klasifikasi: post vs account
function classifyTwitterLink(href) {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./i, '');
    if (!/(x\.com|twitter\.com)$/i.test(host)) return null;

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[1].toLowerCase() === 'status') {
      return {
        type: 'post',
        screenName: parts[0],
        statusId: parts[2],
      };
    }
    if (parts.length >= 1) {
      return {
        type: 'account',
        screenName: parts[0],
      };
    }
    return { type: 'unknown' };
  } catch {
    return null;
  }
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ====== SCAN HTML → TASKS ======
function scanHtmlForTwitterTasks(html, src) {
  const $ = cheerio.load(html);
  const tasks = [];

  $('a[href]').each((i, el) => {
    const rawHref = $(el).attr('href');
    const twitterHref = extractTwitterHref(rawHref);
    if (!twitterHref) return;

    const meta = classifyTwitterLink(twitterHref);
    if (!meta) return;

    const container =
      $(el).closest('div,li,section,article') || $(el).parent();

    let beforeText = '';
    let afterText  = '';

    if (container && container.length) {
      const prevSiblings = container.prevAll().slice(0, 3).get().reverse();
      const nextSiblings = container.nextAll().slice(0, 2).get();

      beforeText = prevSiblings.map(node => $(node).text()).join(' ');
      afterText  = nextSiblings.map(node => $(node).text()).join(' ');
    }

    const containerText = container.text();

    let contextText = `${beforeText} ${containerText} ${afterText}`
      .replace(/\s+/g, ' ')
      .trim();

    if (contextText.length > 500) {
      contextText = contextText.slice(0, 497) + '...';
    }

    const actions = extractActionsFromText(contextText);

    tasks.push({
      twitterUrl: twitterHref,
      rawHref,
      kind: meta.type,          // 'post' | 'account' | 'unknown'
      screenName: meta.screenName || null,
      statusId: meta.statusId || null,
      actions,                  // ['like','comment','repost','follow','quote','post','engage']
      context: contextText,
      source: src,
    });
  });

  return uniqBy(tasks, t => `${t.twitterUrl}|${t.actions.sort().join(',')}`);
}

// ====== MAIN ======
async function scanTarget(target) {
  try {
    const html  = await loadHtml(target);
    const tasks = scanHtmlForTwitterTasks(html, target);
    return {
      target,
      count: tasks.length,
      tasks,
    };
  } catch (err) {
    return {
      target,
      error: err?.message || String(err),
      tasks: [],
    };
  }
}

(async () => {
  const results = [];
  for (const t of args) {
    // eslint-disable-next-line no-await-in-loop
    const res = await scanTarget(t);
    results.push(res);
  }

  console.log(JSON.stringify(results, null, 2));
})();
