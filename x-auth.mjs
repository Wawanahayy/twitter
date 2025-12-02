// x-auth.mjs — Cookie-based X session helper (standalone)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

/* ===================== Low-level utils ===================== */
function hasAuthToken(cookieStr = '') { return /(?:^|;\s*)auth_token=/.test(cookieStr); }

function ensureLangCookie(cookieStr = '') {
  if (!cookieStr) return cookieStr;
  // kalau sudah ada lang= apapun, biarin saja (termasuk lang=id)
  if (/(?:^|;\s*)lang=/.test(cookieStr)) return cookieStr;
  return cookieStr.replace(/\s*;?\s*$/, '') + '; lang=en';
}

function parseCookiePairs(str = '') {
  const out = {};
  for (const part of String(str).split(/[;\n]+/)) {
    const seg = part.trim();
    if (!seg) continue;
    const i = seg.indexOf('=');
    if (i < 1) continue;
    const k = seg.slice(0, i).trim().toLowerCase();
    let v = seg.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function pickCt0Loose(cookieStr = '') {
  const m = parseCookiePairs(cookieStr);
  return m['ct0'] || m['c t0'] || m['cto'] || '';
}

function makeRawAxios() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
  let httpAgent, httpsAgent;
  if (proxy) {
    const isSocks = /^socks/i.test(proxy);
    const agent = isSocks ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy);
    httpAgent = agent;
    httpsAgent = agent;
  } else {
    httpAgent = new http.Agent({ keepAlive: true });
    httpsAgent = new https.Agent({ keepAlive: true });
  }
  return axios.create({
    httpAgent,
    httpsAgent,
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400,
  });
}

async function extractBearerFromHtml(rawAxios, html) {
  const urls = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g)).map(m => m[1]);
  const pri = urls.filter(u => /abs\.twimg\.com\/responsive-web\/client-web\//.test(u));
  for (const u of pri.slice(0, 24)) {
    try {
      const js = await rawAxios.get(u, { responseType: 'text' }).then(r => String(r.data || ''));
      const m = js.match(/Bearer\s+([A-Za-z0-9%\-\._]+)/);
      if (m) return m[1];
    } catch {
      // ignore
    }
  }
  return null;
}

async function discoverClientVersion(rawAxios, html) {
  const urls = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g)).map(m => m[1]);
  const pri = urls.filter(u => /abs\.twimg\.com\/responsive-web\/client-web\//.test(u));
  for (const u of pri.slice(0, 16)) {
    try {
      const js = await rawAxios.get(u, { responseType: 'text' }).then(r => String(r.data || ''));
      const m1 = js.match(/clientVersion["']?\s*:\s*["']([^"']+)["']/);
      if (m1) return m1[1];
      const m2 = js.match(/["']version["']\s*:\s*["']([^"']+)["']/);
      if (m2) return m2[1];
    } catch {
      // ignore
    }
  }
  return null;
}

/* ===================== Class: XAuth ===================== */
export class XAuth {
  constructor({ xCookie, ua } = {}) {
    assert(xCookie, 'XAuth requires xCookie');
    assert(hasAuthToken(xCookie), 'X cookie must include auth_token');
    assert(pickCt0Loose(xCookie), 'X cookie must include ct0');

    this.cookie = ensureLangCookie(xCookie);
    this.ua = ua || process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    this.raw = makeRawAxios();

    this._bearer = null;
    this._clientVersion = null;
    this._opIds = null;
  }

  async discoverBearer() {
    if (this._bearer) return this._bearer;
    const headersBase = {
      'user-agent': this.ua,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      cookie: this.cookie,
      'accept-language': 'en-US,en;q=0.9',
    };
    const HTML_CANDIDATES = [
      'https://x.com/home',
      'https://x.com/i/flow/login',
      'https://x.com/i/oauth2/authorize',
      'https://twitter.com/home',
      'https://x.com/settings',
    ];
    for (const url of HTML_CANDIDATES) {
      try {
        const r = await this.raw.get(url, { headers: headersBase });
        if (typeof r.data === 'string') {
          const bearer = await extractBearerFromHtml(this.raw, r.data);
          if (bearer) {
            this._bearer = bearer;
            this._clientVersion = this._clientVersion || (await discoverClientVersion(this.raw, r.data));
            return bearer;
          }
        }
      } catch {
        // ignore & try next
      }
    }
    throw new Error('auto-bearer: failed to discover bearer from X bundles');
  }

  buildXHeaders({ mode = 'api', referer = 'https://x.com/' } = {}) {
    const ct0 = pickCt0Loose(this.cookie);
    const xTid = crypto.randomBytes(32).toString('base64');

    const h = {
      'user-agent': this.ua,
      cookie: this.cookie,
      'x-csrf-token': ct0,
      origin: 'https://x.com',
      referer,
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="142", "Not(A:Brand";v="24", "Google Chrome";v="142"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'x-client-transaction-id': xTid,
      'sec-gpc': '1',
    };

    if (mode === 'api') {
      h.accept = 'application/json';
      h['content-type'] = 'application/json';
      h['x-twitter-client-name'] = 'web';
      if (this._clientVersion) h['x-twitter-client-version'] = this._clientVersion;
      if (this._bearer) h.authorization = `Bearer ${this._bearer}`;
      h['x-twitter-locale'] = 'en';
    } else {
      h.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
      h['upgrade-insecure-requests'] = '1';
    }
    return h;
  }

  headersForm(referer) {
    const h = this.buildXHeaders({ mode: 'api', referer });
    return { ...h, 'content-type': 'application/x-www-form-urlencoded' };
  }

  async badgeCount() {
    const headers = this.buildXHeaders({ mode: 'api', referer: 'https://x.com/home' });
    const url = 'https://x.com/i/api/2/badge_count/badge_count.json?supports_ntab_urt=1&include_xchat_count=1';
    try {
      const r = await this.raw.get(url, {
        headers: { ...headers, 'x-twitter-polling': 'true' },
        validateStatus: s => s >= 200 && s < 500,
      });
      return r.status;
    } catch {
      return 0;
    }
  }

  async verifySession() {
    if (!this._bearer) await this.discoverBearer();

    const hHtml = this.buildXHeaders({ mode: 'html', referer: 'https://x.com/home' });
    const s1 = await this.raw.get('https://x.com/settings', {
      headers: hHtml,
      validateStatus: s => s >= 200 && s < 500,
    }).then(r => r.status).catch(() => 0);
    if (s1 === 403) throw new Error('X session invalid (settings -> 403)');

    const hForm = this.headersForm('https://x.com/home');
    const rSettings = await this.raw.get('https://x.com/i/api/1.1/account/settings.json', {
      headers: hForm,
      validateStatus: s => s >= 200 && s < 500,
    }).catch(() => null);
    if (rSettings?.status === 200) return rSettings.data;

    const rVerify = await this.raw.get(
      'https://x.com/i/api/1.1/account/verify_credentials.json?skip_status=true&include_entities=false',
      {
        headers: hForm,
        validateStatus: s => s >= 200 && s < 500,
      },
    ).catch(() => null);
    if (rVerify?.status === 200) return rVerify.data;

    const bc = await this.badgeCount().catch(() => 0);
    if (bc === 200) return { ok: true, soft: true };

    throw new Error(`X session invalid (settings.html=${s1} / settings.json=${rSettings?.status || 0} / verify_credentials=${rVerify?.status || 0})`);
  }

  // === helper: ambil user yang lagi login (buat log username) ===
  async getCurrentUser() {
    const headers = this.headersForm('https://x.com/home');

    const r = await this.raw.get(
      'https://x.com/i/api/1.1/account/verify_credentials.json?skip_status=true&include_entities=false',
      {
        headers,
        validateStatus: s => s >= 200 && s < 500,
      },
    ).catch(() => null);

    if (r?.status === 200 && r.data) {
      return r.data;
    }
    throw new Error(`getCurrentUser failed (status=${r?.status || '??'})`);
  }

  // discoverOpIds (GraphQL operation IDs) — TRUE source-of-truth
  async discoverOpIds(seeds = []) {
    if (this._opIds) return this._opIds;

    const htmlUrls = [
      'https://x.com/home',
      'https://x.com/i/flow/login',
      'https://x.com/i/oauth2/authorize',
      'https://x.com/settings',
      ...seeds.filter(u => /^https?:\/\/(x|twitter)\.com\//i.test(String(u || ''))),
    ];
    const jsUrls = new Set();

    for (const u of htmlUrls) {
      try {
        const r = await this.raw.get(u, {
          headers: { 'user-agent': this.ua, accept: 'text/html', cookie: this.cookie },
          validateStatus: s => s >= 200 && s < 500,
        });
        const html = String(r.data || '');
        for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
          const src = m[1];
          if (/abs\.twimg\.com\/responsive-web\/client-web\//.test(src)) jsUrls.add(src);
        }
        if (jsUrls.size >= 16) break;
      } catch {
        // ignore
      }
    }

    const names = [
      'CreateRetweet',
      'FavoriteTweet',
      'CreateTweet',
      'UserByScreenName',
      'FollowUser',
      'UnfollowUser',
      'CreateTweetBookmark',
    ];
    const out = {};

    for (const js of Array.from(jsUrls).slice(0, 60)) {
      try {
        const txt = await this.raw.get(js, { responseType: 'text' }).then(r => String(r.data || ''));

        for (const name of names) {
          if (out[name]) continue;
          const m = txt.match(new RegExp(`\\b([a-zA-Z0-9_-]{22,})\\/${name}\\b`));
          if (m) { out[name] = m[1]; continue; }
        }

        for (const name of names) {
          if (out[name]) continue;
          const m2 = txt.match(new RegExp(`${name}"?\\s*[:\\{][^\\}]*?queryId"?:\\s*"?([a-zA-Z0-9_-]{22,})"?`));
          if (m2) { out[name] = m2[1]; continue; }
        }

        const mapMatches = [...txt.matchAll(/"([A-Za-z0-9_-]{22,})"[^}{]{0,240}?"([A-Za-z]+)"/g)];
        for (const mm of mapMatches) {
          const id = mm[1];
          const name = mm[2];
          if (names.includes(name) && !out[name]) out[name] = id;
        }

        if (Object.keys(out).length >= names.length) break;
      } catch {
        // ignore
      }
    }

    this._opIds = out;
    return out;
  }

  getOpId(name) {
    return this._opIds?.[name] || null;
  }
}

export async function ensureXSession({ xCookie, ua } = {}) {
  const xa = new XAuth({ xCookie, ua });

  await xa.discoverBearer();
  await xa.badgeCount().catch(() => {});
  await xa.verifySession();

  try {
    const me = await xa.getCurrentUser();
    const screen = me.screen_name || me.screenName || '(unknown)';
    const id = me.id_str || me.id || '?';
    console.log(`[info]  [x-auth] Logged in as @${screen} (id=${id})`);
  } catch (e) {
    const lvl = String(process.env.LOG_LEVEL || '').toLowerCase();
    if (lvl.includes('debug')) {
      console.log('[debug] [x-auth] Failed to fetch current user:', e?.message || e);
    }
  }

  return xa;
}
