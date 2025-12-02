// x-actions.mjs — v3.7 (Puppeteer only)
// - GAK nembak API/GraphQL sama sekali
// - Semua aksi: like/unlike, retweet/unretweet, bookmark/unbookmark,
//   follow/unfollow, reply, quote, post → lewat Puppeteer
// - Tetap multi-account (cookie per akun lewat binder.cookie)

import assert from 'node:assert/strict';
import {
  doReply as pptrReply,
  doPost as pptrPost,
  doQuote as pptrQuote,
  doLike as pptrLike,
  doUnlike as pptrUnlike,
  doRetweet as pptrRetweet,
  doUnretweet as pptrUnretweet,
  doFollow as pptrFollow,
  doUnfollow as pptrUnfollow,
  doBookmark as pptrBookmark,
  doUnbookmark as pptrUnbookmark,
  ensurePptrCookie,
} from './x-actions-puppeteer.mjs';

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const IS_DEBUG  = LOG_LEVEL.includes('debug');

function firstNonEmpty(...vals) {
  for (const v of vals) if (v != null && String(v).trim() !== '') return v;
}

function parseTweetIdFromUrl(u) {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, '');
    if (!/(^x\.com$|^twitter\.com$|^mobile\.twitter\.com$)/i.test(host)) return undefined;

    const path = url.pathname.replace(/\/+/g, '/').toLowerCase();
    const qid = url.searchParams.get('tweet_id');
    if (path.startsWith('/intent/') && qid && /^\d+$/.test(qid)) return qid;

    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p => /^status(es)?$/i.test(p) || p.toLowerCase() === 'i');
    if (idx >= 0) {
      const candidate = parts[idx + 1]?.split('?')[0];
      if (candidate && /^\d+$/.test(candidate)) return candidate;
    }
    for (const p of parts) if (/^\d+$/.test(p)) return p;
  } catch {}
  return undefined;
}

function parseScreenFromUrl(u) {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, '');
    if (!/(^x\.com$|^twitter\.com$|^mobile\.twitter\.com$)/i.test(host)) return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    const handle = parts[0];
    if (handle && !/^(home|i|intent)$/i.test(handle)) return handle;
  } catch {}
  return undefined;
}

export class XActions {
  constructor(binder) {
    // binder = instance XAuth dari x-auth.mjs
    assert(binder, 'XActions needs binder');
    this.binder = binder;
  }

  /**
   * action:
   *   {
   *     type: "like|retweet|reply|quote|post|bookmark|follow|...",
   *     tweetUrl?: "https://x.com/.../status/123",
   *     screenUrl?: "https://x.com/username",
   *     text?: "....",
   *     content?: "...",
   *     postText?: "..."
   *   }
   */
  async doFromAction(action, { referer }, log = console) {
    const t = String(action?.type || '').toLowerCase();

    const tweetId   = firstNonEmpty(action.tweetId, parseTweetIdFromUrl(action.tweetUrl));
    const screen    = firstNonEmpty(
      action.screenName,
      parseScreenFromUrl(action.screenUrl),
      parseScreenFromUrl(action.tweetUrl),
    );
    const text      = firstNonEmpty(action.text, action.content, action.postText);
    const tweetUrl  = action.tweetUrl;
    const screenUrl = action.screenUrl || (screen ? `https://x.com/${screen}` : undefined);

    const pptrTweetUrl =
      tweetUrl || (tweetId ? `https://x.com/i/web/status/${tweetId}` : undefined);

    if (IS_DEBUG) {
      log.debug?.('[x-actions][pptr-only] doFromAction', {
        type: t,
        tweetId,
        screen,
        hasText: !!text,
        tweetUrl,
        screenUrl,
        pptrTweetUrl,
      });
    }

    // 🔑 Penting: pastikan Puppeteer pakai cookie milik akun ini
    try {
      if (this.binder?.cookie) {
        await ensurePptrCookie(this.binder.cookie);
      }
    } catch (e) {
      log.warn?.('[x-actions][pptr] ensurePptrCookie error:', e?.message || e);
    }

    // ======================= PURE PUPPETEER =======================

    try {
      if (t === 'like') {
        if (!pptrTweetUrl) throw new Error('like: no tweetUrl/tweetId');
        return await pptrLike(pptrTweetUrl);
      }

      if (t === 'unlike') {
        if (!pptrTweetUrl) throw new Error('unlike: no tweetUrl/tweetId');
        return await pptrUnlike(pptrTweetUrl);
      }

      if (t === 'retweet') {
        if (!pptrTweetUrl) throw new Error('retweet: no tweetUrl/tweetId');
        return await pptrRetweet(pptrTweetUrl);
      }

      if (t === 'unretweet') {
        if (!pptrTweetUrl) throw new Error('unretweet: no tweetUrl/tweetId');
        return await pptrUnretweet(pptrTweetUrl);
      }

      if (t === 'bookmark') {
        if (!pptrTweetUrl) throw new Error('bookmark: no tweetUrl/tweetId');
        return await pptrBookmark(pptrTweetUrl);
      }

      if (t === 'unbookmark') {
        if (!pptrTweetUrl) throw new Error('unbookmark: no tweetUrl/tweetId');
        return await pptrUnbookmark(pptrTweetUrl);
      }

      if (t === 'follow') {
        const url = screenUrl || pptrTweetUrl;
        if (!url) {
          log.warn?.('[x-actions] follow: no url resolved');
          return false;
        }
        return await pptrFollow(url);
      }

      if (t === 'unfollow') {
        const url = screenUrl || pptrTweetUrl;
        if (!url) {
          log.warn?.('[x-actions] unfollow: no url resolved');
          return false;
        }
        return await pptrUnfollow(url);
      }

      if (t === 'post') {
        return await pptrPost(text || 'Hello');
      }

      if (t === 'reply' || t === 'comment') {
        if (!pptrTweetUrl) throw new Error('reply: no tweetUrl/tweetId');
        return await pptrReply(pptrTweetUrl, text || 'Nice!');
      }

      if (t === 'quote') {
        if (!pptrTweetUrl) throw new Error('quote: no tweetUrl/tweetId');
        return await pptrQuote(pptrTweetUrl, text || '');
      }

      log.warn?.('[x-actions] Unknown action type:', t);
      return false;
    } catch (e) {
      log.warn?.('[x-actions][pptr] error:', e?.message || e);
      return false;
    }
  }
}
