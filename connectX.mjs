#!/usr/bin/env node
// bindX.mjs — Bind Twitter/X via cookie (auth_token + ct0), PKCE, Puppeteer ONLY.
//
// Flow:
//   1) Resolve AUTHORIZE_URL:
//        - Kalau AUTHORIZE_URL env ke-set, pakai itu langsung
//        - Kalau tidak, call AUTH_API_URL (Next.js data) pakai AUTH_API_COOKIE → cari /i/oauth2/authorize
//   2) Buka authorizeUrl pakai Puppeteer, klik tombol “Authorize/Allow/Izinkan/Approve”, tunggu redirect.
//
// ENV penting:
//   X_COOKIE           = auth_token=...; ct0=...; (copy dari browser X)
//   AUTHORIZE_URL      = (opsional) langsung X /i/oauth2/authorize
//   AUTH_API_URL       = (opsional) endpoint Next.js yang balikin authorizeUrl (body atau Location)
//   AUTH_API_COOKIE    = cookie untuk AUTH_API_URL (next-auth.session-token, dsb)
//   REDIRECT_HOST      = snag-render.com (default, host callback yang ditunggu)
//   USER_AGENT         = UA browser (default: Chrome 120)
//   PPTR_HEADLESS      = 1 (default) → headless; 0 → kelihatan
//   HTTP_PROXY / HTTPS_PROXY / ALL_PROXY (opsional) → pakai proxy

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

// ---- lazy import puppeteer
let puppeteer = null;
async function ensurePuppeteer() {
  if (puppeteer) return puppeteer;
  try {
    puppeteer = await import('puppeteer'); // npm i puppeteer
    return puppeteer;
  } catch {
    throw new Error('Puppeteer diminta tapi "puppeteer" belum diinstall (npm i puppeteer)');
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function hasAuthToken(cookie) {
  return /auth_token\s*=/.test(cookie || '');
}

let httpClient = null;

function createHttpClient() {
  const agentOpts = { keepAlive: true };
  let httpAgent = new http.Agent(agentOpts);
  let httpsAgent = new https.Agent(agentOpts);

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;

  if (proxyUrl) {
    let proxyAgent;
    if (proxyUrl.startsWith('socks')) {
      proxyAgent = new SocksProxyAgent(proxyUrl);
    } else {
      proxyAgent = new HttpsProxyAgent(proxyUrl);
    }
    httpAgent = proxyAgent;
    httpsAgent = proxyAgent;
  }

  const client = axios.create({
    timeout: 30_000,
    maxRedirects: 0,
    httpAgent,
    httpsAgent,
    validateStatus: () => true,
  });

  return client;
}


async function resolveAuthorizeUrlViaAuthApi(authApiUrl, authApiCookie, ua) {
  const res = await httpClient.get(authApiUrl, {
    headers: {
      'user-agent': ua,
      accept: '*/*',
      'x-nextjs-data': '1',
      cookie: authApiCookie,
    },
  });

  let bodyStr = '';
  if (typeof res.data === 'string') {
    bodyStr = res.data;
  } else if (res.data != null) {
    bodyStr = JSON.stringify(res.data);
  }

  let authorizeUrl = null;

  const m = bodyStr.match(/https:\/\/x\.com\/i\/oauth2\/authorize[^\s"']+/);
  if (m) authorizeUrl = m[0];
  if (!authorizeUrl && res.headers?.location) {
    authorizeUrl = res.headers.location;
  }

  if (!authorizeUrl) {
    throw new Error('Tidak bisa menemukan authorizeUrl dari AUTH_API_URL');
  }

  return authorizeUrl;
}


async function approveWithPuppeteer(authorizeUrl, cookieStr, ua, redirectHostStartsWith = 'snag-render.com') {
  const { default: P } = await ensurePuppeteer();

  console.log('[bindX] launch browser…');
  const browser = await P.launch({
    headless: String(process.env.PPTR_HEADLESS ?? '1') === '1',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-US'],
  });

  try {
    const page = await browser.newPage();
    if (ua) {
      await page.setUserAgent(ua);
    }

    // Inject cookies X (auth_token, ct0, dst)
    if (cookieStr && cookieStr.trim()) {
      const cookiePairs = cookieStr.split(';').map(s => s.trim()).filter(Boolean);

      const cookies = cookiePairs
        .map(pair => {
          const eq = pair.indexOf('=');
          if (eq <= 0) return null;
          const name = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim().replace(/^"|"$/g, '');
          if (!name || !value) return null;
          return {
            name,
            value,
            domain: '.x.com',
            path: '/',
            httpOnly: false,
            secure: true,
          };
        })
        .filter(Boolean);

      if (cookies.length) {
        await page.setCookie(...cookies);
      }
    }

    await page.goto(authorizeUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    let currentUrl = page.url();

    // Kalau sudah langsung redirect ke callback
    try {
      const hostNow = new URL(currentUrl).host;
      if (hostNow.startsWith(redirectHostStartsWith)) {
        const urlObj = new URL(currentUrl);
        const code = urlObj.searchParams.get('code') || null;
        return { callbackUrl: currentUrl, code };
      }
    } catch {
    }
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], input[type="submit"]'),
      );

      function matchText(el) {
        const t = (el.innerText || el.value || '').toLowerCase();
        return (
          t.includes('authorize') ||
          t.includes('allow') ||
          t.includes('izinkan') ||
          t.includes('approve')
        );
      }

      const btn = candidates.find(matchText);
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
      } catch {
      }
    }

    currentUrl = page.url();

    let callbackUrl = null;
    let code = null;

    try {
      const urlObj = new URL(currentUrl);
      const host = urlObj.host;
      if (!redirectHostStartsWith || host.startsWith(redirectHostStartsWith)) {
        callbackUrl = currentUrl;
        code = urlObj.searchParams.get('code') || null;
      }
    } catch {

    }

    return { callbackUrl, code };
  } finally {
    await browser.close().catch(() => {});
  }
}


async function main() {
  const AUTHORIZE_URL = process.env.AUTHORIZE_URL || '';
  const AUTH_API_URL = process.env.AUTH_API_URL || '';
  const AUTH_API_COOKIE = process.env.AUTH_API_COOKIE || '';
  const X_COOKIE = process.env.X_COOKIE || '';
  const REDIRECT_HOST = process.env.REDIRECT_HOST || 'snag-render.com';
  const USER_AGENT =
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  console.log('[bindX] start');

  if (!X_COOKIE) {
    console.error('[bindX] ERROR: X_COOKIE kosong');
    process.exitCode = 1;
    return;
  }
  if (!hasAuthToken(X_COOKIE)) {
    console.error('[bindX] ERROR: X_COOKIE tidak mengandung auth_token');
    process.exitCode = 1;
    return;
  }

  httpClient = createHttpClient();

  let authorizeUrl = AUTHORIZE_URL;

  try {
    if (!authorizeUrl) {
      if (!AUTH_API_URL || !AUTH_API_COOKIE) {
        throw new Error('AUTHORIZE_URL kosong dan AUTH_API_URL/AUTH_API_COOKIE juga kosong. Set salah satu.');
      }
      authorizeUrl = await resolveAuthorizeUrlViaAuthApi(AUTH_API_URL, AUTH_API_COOKIE, USER_AGENT);
    }

    console.log('[bindX] authorizeUrl:', authorizeUrl);

    const result = await approveWithPuppeteer(
      authorizeUrl,
      X_COOKIE,
      USER_AGENT,
      REDIRECT_HOST,
    );

    if (result.callbackUrl) {
      console.log('[bindX] DONE');
      console.log('[bindX] callbackUrl:', result.callbackUrl);
      if (result.code) {
        console.log('[bindX] code:', result.code);
      }
    } else {
      console.warn('[bindX] Selesai tanpa callbackUrl yang match host redirect');
    }
  } catch (e) {
    console.error('[bindX] ERROR:', e?.message || e);
    process.exitCode = 1;
  }
}

if (process.argv[1] === __filename) {
  main();
}
