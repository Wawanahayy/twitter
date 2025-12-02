#!/usr/bin/env node
// x-tasks.mjs — runner multi-account + auto task builder dari .env
//
// - Multi-account: ACCOUNT / ACCOUNTS_FILE (1 baris = 1 X_COOKIE)
// - Task source:
//     * Kalau X_TASKS_FILE ada → dipakai (manual JSON array of actions)
//     * Kalau X_TASKS_FILE nggak ada → auto-build dari:
//          TARGET (url / .txt / .json)
//          COMMENT / POST / QUOTE (file .txt)
//          FOLLOW / UNFOLLOW (url / .txt / .json)
//          + flag DO_* (like/retweet/bookmark/follow/un*)
// - Full Puppeteer only (XActions → x-actions-puppeteer.mjs)
// - Tiap akun pakai browser baru (closeBrowser per akun)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureXSession } from './x-auth.mjs';
import { XActions } from './x-actions.mjs';
import { closeBrowser as pptrCloseBrowser } from './x-actions-puppeteer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const isDebug   = LOG_LEVEL.includes('debug');

function logf(tag) {
  return {
    info:  (...a) => console.log(`[info]  [${tag}]`, ...a),
    warn:  (...a) => console.warn(`[warn]  [${tag}]`, ...a),
    error: (...a) => console.error(`[error] [${tag}]`, ...a),
    debug: (...a) => { if (isDebug) console.log(`[debug] [${tag}]`, ...a); },
  };
}

const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || '1'));

const BASE_SLEEP_MS  = Number(process.env.SLEEP_AFTER_ACTION_MS || 15000);
const JITTER_MS      = Number(process.env.SLEEP_JITTER_MS || 5000);
const MAX_ACTIONS    = Number(process.env.MAX_ACTIONS_PER_RUN || 0);

const COOLDOWN_EVERY = Number(process.env.COOLDOWN_EVERY || 0);
const COOLDOWN_MS    = Number(process.env.COOLDOWN_MS || 60000);

const STOP_ON_RATE_LIMIT = !/^(0|false|no)$/i.test(String(process.env.STOP_ON_RATE_LIMIT || '1'));

const TASK_FILE     = process.env.X_TASKS_FILE || '';
const TARGET_ENV    = process.env.TARGET || '';
const FOLLOW_ENV    = process.env.FOLLOW || '';
const UNFOLLOW_ENV  = process.env.UNFOLLOW || '';
const COMMENT_FILE  = process.env.COMMENT || process.env.COMMENT_FILE;
const POST_FILE     = process.env.POST || process.env.POST_FILE;
const QUOTE_FILE    = process.env.QUOTE || process.env.QUOTE_FILE;
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || process.env.ACCOUNT;

// Flag DO_* (default 0 = off)
const DO_LIKE        = /^(1|true|yes)$/i.test(String(process.env.DO_LIKE || '0'));
const DO_UNLIKE      = /^(1|true|yes)$/i.test(String(process.env.DO_UNLIKE || '0'));
const DO_RETWEET     = /^(1|true|yes)$/i.test(String(process.env.DO_RETWEET || '0'));
const DO_UNRETWEET   = /^(1|true|yes)$/i.test(String(process.env.DO_UNRETWEET || '0'));
const DO_BOOKMARK    = /^(1|true|yes)$/i.test(String(process.env.DO_BOOKMARK || '0'));
const DO_UNBOOKMARK  = /^(1|true|yes)$/i.test(String(process.env.DO_UNBOOKMARK || '0'));
const DO_FOLLOW      = /^(1|true|yes)$/i.test(String(process.env.DO_FOLLOW || '0'));
const DO_UNFOLLOW    = /^(1|true|yes)$/i.test(String(process.env.DO_UNFOLLOW || '0'));

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function sleepRandom(baseMs, jitterMs) {
  const base   = Math.max(0, Number(baseMs) || 0);
  const jitter = Math.max(0, Number(jitterMs) || 0);
  const extra  = jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0;
  const total  = base + extra;
  return sleep(total);
}

function resolvePathMaybe(p) {
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p; // URL, jangan di-resolve
  return path.isAbsolute(p) ? p : path.resolve(__dirname, p);
}

function fileExistsLocal(p) {
  const full = resolvePathMaybe(p);
  if (!full) return false;
  if (/^https?:\/\//i.test(full)) return false; // URL bukan file
  return fs.existsSync(full);
}

function loadJsonFile(fullPath) {
  const raw = fs.readFileSync(fullPath, 'utf8');
  return JSON.parse(raw);
}

function loadLinesFromFile(p, desc, log) {
  const full = resolvePathMaybe(p);
  if (!full || /^https?:\/\//i.test(full)) {
    log.warn(`${desc}: "${p}" bukan path file lokal, skip loadLinesFromFile.`);
    return [];
  }
  if (!fs.existsSync(full)) {
    log.warn(`${desc} file not found: ${full}`);
    return [];
  }
  const raw = fs.readFileSync(full, 'utf8');
  return raw
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);
}

function loadTasks(log) {
  const full = resolvePathMaybe(TASK_FILE);
  if (!full || !fs.existsSync(full)) {
    log.error(`Task file not found: ${full}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(full, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log.error('Failed to parse JSON from', full, '-', e.message || e);
    process.exit(1);
  }
  if (!Array.isArray(data)) {
    log.error('X_TASKS_FILE must be an array of actions');
    process.exit(1);
  }
  return data;
}

/**
 * Helper generik untuk load list target dari env:
 *   - Kalau env = URL  → return [url]
 *   - Kalau env = .txt → 1 per baris
 *   - Kalau env = .json:
 *       * array of string
 *       * { targets: [string | {tweetUrl}] }
 */
function loadListFromEnv({ name, envVal, log }) {
  const list = [];
  if (!envVal) return list;

  const val = envVal.trim();

  if (/^https?:\/\//i.test(val)) {
    list.push(val);
    return list;
  }

  // JSON file
  if (val.toLowerCase().endsWith('.json') && fileExistsLocal(val)) {
    const full = resolvePathMaybe(val);
    try {
      const js = loadJsonFile(full);
      if (Array.isArray(js)) {
        for (const it of js) {
          if (typeof it === 'string') list.push(it);
          else if (it && typeof it === 'object') {
            if (typeof it.url === 'string') list.push(it.url);
            else if (typeof it.tweetUrl === 'string') list.push(it.tweetUrl);
            else if (typeof it.screenUrl === 'string') list.push(it.screenUrl);
          }
        }
      } else if (js && typeof js === 'object' && Array.isArray(js.targets)) {
        for (const it of js.targets) {
          if (typeof it === 'string') list.push(it);
          else if (it && typeof it === 'object') {
            if (typeof it.url === 'string') list.push(it.url);
            else if (typeof it.tweetUrl === 'string') list.push(it.tweetUrl);
            else if (typeof it.screenUrl === 'string') list.push(it.screenUrl);
          }
        }
      }
    } catch (e) {
      log.warn(`Gagal parse ${name} json:`, e?.message || e);
    }
    return list;
  }

  // TXT file
  if (fileExistsLocal(val)) {
    return loadLinesFromFile(val, name, log);
  }

  // fallback: treat as 1 URL / 1 handle string
  list.push(val);
  return list;
}

// ⬇⬇⬇ GLOBAL: simpan semua baris comment.txt (1 baris 1 address)
let GLOBAL_COMMENTS = [];

// Build tasks otomatis dari TARGET/COMMENT/POST/QUOTE + DO_* + FOLLOW/UNFOLLOW
function buildTasksFromEnv(log) {
  const tasks = [];

  // 1) Targets untuk tweet-based (like/retweet/reply/quote/bookmark)
  const targets         = loadListFromEnv({ name: 'TARGET',   envVal: TARGET_ENV,   log });
  const followTargets   = loadListFromEnv({ name: 'FOLLOW',   envVal: FOLLOW_ENV,   log });
  const unfollowTargets = loadListFromEnv({ name: 'UNFOLLOW', envVal: UNFOLLOW_ENV, log });

  // 2) Comments / posts / quotes dari txt
  const comments = COMMENT_FILE ? loadLinesFromFile(COMMENT_FILE, 'COMMENT', log) : [];
  const posts    = POST_FILE    ? loadLinesFromFile(POST_FILE, 'POST', log)       : [];
  const quotes   = QUOTE_FILE   ? loadLinesFromFile(QUOTE_FILE, 'QUOTE', log)     : [];

  // simpan ke global → dipakai per account
  GLOBAL_COMMENTS = comments;

  // 3) POST: tweet baru (tanpa target)
  if (posts.length > 0) {
    for (const text of posts) {
      tasks.push({ type: 'post', text });
    }
  }

  // 4) Per-target untuk tweetUrl (like/retweet/dll)
  if (targets.length > 0) {
    for (let i = 0; i < targets.length; i++) {
      const tweetUrl = targets[i];

      // NOTE:
      // jangan set DO_LIKE & DO_UNLIKE dua-duanya 1, nanti like+unlike
      if (DO_LIKE)       tasks.push({ type: 'like',       tweetUrl });
      if (DO_UNLIKE)     tasks.push({ type: 'unlike',     tweetUrl });

      if (DO_RETWEET)    tasks.push({ type: 'retweet',    tweetUrl });
      if (DO_UNRETWEET)  tasks.push({ type: 'unretweet',  tweetUrl });

      if (DO_BOOKMARK)   tasks.push({ type: 'bookmark',   tweetUrl });
      if (DO_UNBOOKMARK) tasks.push({ type: 'unbookmark', tweetUrl });

      // FOLLOW / UNFOLLOW dari tweetUrl → XActions akan extract handle
      if (DO_FOLLOW && !FOLLOW_ENV) {
        // Kalau FOLLOW_ENV kosong, DO_FOLLOW dari TARGET
        tasks.push({ type: 'follow',   tweetUrl });
      }
      if (DO_UNFOLLOW && !UNFOLLOW_ENV) {
        tasks.push({ type: 'unfollow', tweetUrl });
      }

      // REPLY: JANGAN SET text DI SINI
      // → text akan diisi per akun pakai GLOBAL_COMMENTS
      if (comments.length > 0) {
        tasks.push({ type: 'reply', tweetUrl });
      }

      // QUOTE: masih pakai i%quotes.length (global, sama semua akun)
      if (quotes.length > 0) {
        const text = quotes[i % quotes.length];
        tasks.push({ type: 'quote', tweetUrl, text });
      }
    }
  }

  // 5) FOLLOW / UNFOLLOW khusus dari FOLLOW/UNFOLLOW list
  if (DO_FOLLOW && followTargets.length > 0) {
    for (const url of followTargets) {
      // pakai screenUrl biar langsung ke profil
      tasks.push({ type: 'follow', screenUrl: url });
    }
  }

  if (DO_UNFOLLOW && unfollowTargets.length > 0) {
    for (const url of unfollowTargets) {
      tasks.push({ type: 'unfollow', screenUrl: url });
    }
  }

  if (tasks.length === 0) {
    log.error('Tidak ada task yang terbentuk. Set minimal salah satu: X_TASKS_FILE (file ada) atau TARGET/COMMENT/POST/QUOTE/FOLLOW/UNFOLLOW + DO_* di .env');
    process.exit(1);
  }

  log.info(`Auto-build ${tasks.length} task dari .env (TARGET/COMMENT/POST/QUOTE/FOLLOW/UNFOLLOW/DO_*).`);
  if (isDebug) {
    log.debug('Sample task[0..4]:', tasks.slice(0, 5));
  }

  return tasks;
}

// Multi-account loader
function loadAccounts(log) {
  let accounts = [];

  if (ACCOUNTS_FILE) {
    accounts = loadLinesFromFile(ACCOUNTS_FILE, 'ACCOUNT', log);
    if (accounts.length === 0) {
      log.warn('ACCOUNT/ACCOUNTS_FILE diset tapi tidak ada baris valid, fallback ke X_COOKIE.');
    }
  }

  if (accounts.length === 0) {
    const xCookie = (process.env.X_COOKIE || '').trim();
    if (!xCookie) {
      log.error('Set X_COOKIE di .env ATAU ACCOUNT/ACCOUNTS_FILE dengan 1 cookie per baris.');
      process.exit(1);
    }
    accounts = [xCookie];
  }

  return accounts;
}

function isRateLimitError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  const status = e?.response?.status || e?.status;

  if (status === 429) return true;

  if (msg.includes('rate limit')) return true;
  if (msg.includes('too many requests')) return true;

  if (msg.includes('daily limit for sending tweets')) return true;
  if (msg.includes('daily limit for sending tweets and messages')) return true;

  if (msg.includes('this request looks like it might be automated')) return true;
  if (msg.includes('protect our users from spam')) return true;
  if (msg.includes('(226)')) return true;

  return false;
}

// Jalankan 1 akun
async function runForAccount({ xCookie, ua, tasks, log, accountIndex, totalAccounts }) {
  log.info(`===== Account #${accountIndex + 1}/${totalAccounts} =====`);

  if (DRY_RUN) {
    log.info('DRY_RUN=1 → hanya simulasi, tidak kirim request ke X.');
  } else {
    log.info('DRY_RUN=0 → AKSI NYATA ke X. Pastikan interval & jumlah aman.');
  }

  log.debug(`BASE_SLEEP_MS=${BASE_SLEEP_MS} JITTER_MS=${JITTER_MS} MAX_ACTIONS=${MAX_ACTIONS}`);
  if (COOLDOWN_EVERY > 0) {
    log.debug(`COOLDOWN_EVERY=${COOLDOWN_EVERY} COOLDOWN_MS=${COOLDOWN_MS}`);
  }
  log.debug(`STOP_ON_RATE_LIMIT=${STOP_ON_RATE_LIMIT}`);

  let binder;
  try {
    binder = await ensureXSession({ xCookie, ua });
    log.info('X session ready.');
  } catch (e) {
    log.error('X session init failed untuk akun ini:', e?.message || e);
    return { stopDueToRateLimit: false };
  }

  const xAct = new XActions(binder);

  log.info(`Loaded ${tasks.length} X action(s) untuk akun ini.`);

  const effectiveTasks = (MAX_ACTIONS > 0)
    ? tasks.slice(0, MAX_ACTIONS)
    : tasks;

  if (MAX_ACTIONS > 0 && tasks.length > MAX_ACTIONS) {
    log.info(`MAX_ACTIONS_PER_RUN=${MAX_ACTIONS} → hanya menjalankan ${MAX_ACTIONS} aksi pertama per akun.`);
  }

  let idx = 0;
  let executed = 0;
  let stopDueToRateLimit = false;

  for (const baseAction of effectiveTasks) {
    idx++;
    const t = String(baseAction?.type || '').toLowerCase();
    const referer = baseAction.tweetUrl || baseAction.screenUrl || 'https://x.com/home';

    // clone per akun
    let action = { ...baseAction };

    // 📝 Inject COMMENT per akun:
    //
    // GLOBAL_COMMENTS = [addr1, addr2, ...]
    // Account #0 → GLOBAL_COMMENTS[0]
    // Account #1 → GLOBAL_COMMENTS[1]
    // dst (wrap kalau habis)
    if ((t === 'reply' || t === 'comment') &&
        GLOBAL_COMMENTS.length > 0 &&
        !action.text) {
      const cIdx = accountIndex % GLOBAL_COMMENTS.length;
      action.text = GLOBAL_COMMENTS[cIdx];
    }

    log.info(`[#${idx}] ${t || '(no-type)'}`);

    if (DRY_RUN) {
      log.info(
        '    [dry-run] would do:',
        t,
        '→',
        action.tweetUrl || action.screenUrl || action.text || '(no payload)'
      );
    } else {
      try {
        const ok = await xAct.doFromAction(action, { referer }, log);
        if (ok) {
          executed++;
          log.info('    action ok');
        } else {
          log.warn('    action incomplete (returned false)');
        }
      } catch (e) {
        log.warn('    action failed:', e?.message || e);

        if (isRateLimitError(e)) {
          if (STOP_ON_RATE_LIMIT) {
            log.warn('    Detected rate-limit / automation block. Stop runner untuk akun ini (dan global).');
            stopDueToRateLimit = true;
            break;
          } else {
            const bigCooldown = Math.max(COOLDOWN_MS, 120000);
            log.warn(`    Detected rate-limit / automation block, tetapi STOP_ON_RATE_LIMIT=0 → cooldown besar ${bigCooldown}ms sebelum lanjut…`);
            await sleep(bigCooldown);
          }
        }
      }
    }

    if (stopDueToRateLimit) break;

    if (!DRY_RUN &&
        COOLDOWN_EVERY > 0 &&
        executed > 0 &&
        executed % COOLDOWN_EVERY === 0 &&
        idx < effectiveTasks.length) {
      log.info(`    cooldown: sleeping ${COOLDOWN_MS}ms setelah ${executed} aksi...`);
      await sleep(COOLDOWN_MS);
      continue;
    }

    if (idx < effectiveTasks.length) {
      const start = Date.now();
      await sleepRandom(BASE_SLEEP_MS, JITTER_MS);
      const elapsed = Date.now() - start;
      log.debug(`    slept ${elapsed}ms sebelum aksi berikutnya...`);
    }
  }

  if (stopDueToRateLimit) {
    log.warn('Runner berhenti lebih awal untuk akun ini karena rate-limit / automation block dari X.');
  } else {
    log.info('All X actions processed untuk akun ini.');
  }

  return { stopDueToRateLimit };
}

(async () => {
  const log = logf('x-tasks');
  const ua  = process.env.USER_AGENT;

  // 1) load akun
  const accounts = loadAccounts(log);
  log.info(`Total account: ${accounts.length}`);

  // 2) load / build task (sekali saja, dipakai semua akun)
  let tasks;
  if (fileExistsLocal(TASK_FILE)) {
    log.info(`Pakai X_TASKS_FILE=${TASK_FILE} (manual).`);
    tasks = loadTasks(log);
  } else {
    tasks = buildTasksFromEnv(log);
  }

  let globalStop = false;

  // 3) loop account
  for (let i = 0; i < accounts.length; i++) {
    const xCookie = accounts[i];

    // pastikan browser lama (kalau ada) ditutup dulu → 1 akun 1 browser baru
    try {
      await pptrCloseBrowser();
    } catch (e) {
      log.debug('pptrCloseBrowser (before account) error:', e?.message || e);
    }

    const { stopDueToRateLimit } = await runForAccount({
      xCookie,
      ua,
      tasks,
      log,
      accountIndex: i,
      totalAccounts: accounts.length,
    });

    // habis 1 akun selesai, tutup lagi browser biar benar2 bersih
    try {
      await pptrCloseBrowser();
    } catch (e) {
      log.debug('pptrCloseBrowser (after account) error:', e?.message || e);
    }

    if (stopDueToRateLimit && STOP_ON_RATE_LIMIT) {
      globalStop = true;
      break;
    }
  }

  if (globalStop) {
    log.warn('Runner berhenti lebih awal karena rate-limit / automation block.');
  } else {
    log.info('All X actions processed untuk semua akun.');
  }

  process.exit(0);
})().catch(e => {
  console.error('[fatal]', e?.message || e);
  process.exit(1);
});
