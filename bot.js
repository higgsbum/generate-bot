const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const textOption = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const option = (name, fallback) => {
  const value = textOption(name, null);
  return value === null ? fallback : Number(value);
};

const DEBUG = flag('debug');
const PROFILE = textOption('profile', null);
const PROFILE_SLUG = PROFILE ? PROFILE.replace(/[^\w-]/g, '_') : null;

const pad = (n) => String(n).padStart(2, '0');
const fileStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

const LOG_DIR = path.join(__dirname, 'logs');
// One file per run with every attempt, plus runs.log with a one-line summary of each finished run.
const RUN_LOG = path.join(LOG_DIR, `${fileStamp()}${PROFILE_SLUG ? `_${PROFILE_SLUG}` : ''}.log`);
const HISTORY_LOG = path.join(LOG_DIR, 'runs.log');

const CONFIG = {
  url: 'https://higgsfield.ai/ai/video?model=genjutsu',
  // Each --profile gets its own Chrome login folder so several copies can run side by side.
  profileDir: path.join(__dirname, PROFILE_SLUG ? `browser-profile-${PROFILE_SLUG}` : 'browser-profile'),
  // 'complete' = retry until a video finishes rendering successfully.
  // 'submit'   = stop as soon as Higgsfield accepts the generation request.
  waitFor: flag('submit-only') ? 'submit' : 'complete',
  maxAttempts: option('max', Infinity),
  retryDelayMs: option('delay', 5) * 1000,
  submitWindowMs: 20_000,
  completeTimeoutMs: option('timeout', 30) * 60_000,
  failureText:
    /generation failed|failed to generate|couldn'?t generate|something went wrong|an error occurred|unexpected error|please try again|try again later|too many requests|high demand|servers? (is |are )?busy|queue is full|limit (has been |was )?reached|reached the limit|protected content|credits refunded|\bfailed\b/i,
  // Shown on a history card when Higgsfield rejects a finished generation.
  refundText: /credits refunded|protected content detected/i,
  // Shown on a history card while a generation is still running.
  busyText: /^(generating|in queue|queued|in progress|processing)\s*(\.{0,3}|…)$/i,
  stopText: /not enough credits|insufficient credits|out of credits|upgrade your plan|please (log|sign) in/i,
};

const API_GATEWAY = 'https://fnf-api-gw.higgsfield.ai';
// The request the Generate button sends, e.g. POST /fnf/jobs/v2/hf_mult_motion_control.
const GENERATE_PATH = /\/jobs\/v\d+\/[^/]+$/;
// Higgsfield reports blocked jobs with statuses like "ip_detected" or "nsfw".
const FAILED_STATUS = /fail|error|nsfw|detected|cancel|reject|timeout|timed_out|refund|moderat|block|banned|violation/;
const ACTIVE_STATUS = /^(queued|pending|waiting|submitted|starting|in_progress|processing|running|generating)$/;
const DONE_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'finished']);
// Active jobs are re-polled every few seconds; one not mentioned for this long is assumed gone.
const JOB_STALE_MS = 3 * 60_000;
const MAX_CANCEL_TRIES = 3;
const IGNORED_URLS = /sentry|amplitude|mixpanel|segment|posthog|analytics|telemetry|clarity|hotjar|intercom|datadog|stripe|assets\.higgsfield|\/_clerk\/|\/api\/i\/i\//i;

const isFailedStatus = (s) => FAILED_STATUS.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT_NAME = PROFILE ? `Higgsfield bot (${PROFILE})` : 'Higgsfield bot';
const tag = PROFILE ? ` [${PROFILE}]` : '';

function appendTo(file, line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
  } catch {}
}

const log = (...m) => {
  const text = m.join(' ');
  console.log(`[${new Date().toLocaleTimeString()}]${tag}`, text);
  appendTo(RUN_LOG, `[${new Date().toLocaleString()}]${tag} ${text}`);
};
// Debug lines are network noise, so they only go to the terminal.
const debug = (...m) => DEBUG && console.log(`[${new Date().toLocaleTimeString()}]${tag} [debug]`, ...m);

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const triesText = (n) => `${n} ${n === 1 ? 'try' : 'tries'}`;

// Prints the end-of-run summary and records it in runs.log.
function recordRun(state, outcome, detail) {
  const tries = state.tries ?? 0;
  const duration = state.startedAt ? formatDuration(Date.now() - state.startedAt) : '0s';
  const summary = `${outcome} after ${triesText(tries)} in ${duration}${detail ? ` (${detail})` : ''}`;
  log(summary);
  const started = state.startedAt ? new Date(state.startedAt).toLocaleString() : 'not started';
  appendTo(HISTORY_LOG, `${started} | ${PROFILE ?? 'default'} | ${outcome} | ${triesText(tries)} | ${duration}${detail ? ` | ${detail}` : ''}`);
  return summary;
}

function notify(title, message) {
  execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`], () => {});
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, () => { rl.close(); resolve(); }));
}

// Runs inside the page. Must be self-contained because Playwright serializes it.
function installWatcher(cfg) {
  if (window.__genBot) return;
  const failRe = new RegExp(cfg.fail, 'i');
  const refundRe = new RegExp(cfg.refund, 'i');
  const busyRe = new RegExp(cfg.busy, 'i');
  const stopRe = new RegExp(cfg.stop, 'i');
  const TOAST = '[role="alert"],[role="status"],[aria-live],[data-sonner-toast],[class*="toast" i],[class*="notification" i],[class*="snackbar" i]';
  const events = [];

  const check = (el) => {
    if (!el || el.nodeType !== 1) return;
    const text = (el.innerText || el.textContent || '').trim();
    if (!text || text.length > 300) return;
    if (stopRe.test(text)) events.push({ kind: 'stop', text, at: Date.now() });
    else if (failRe.test(text) && el.closest(TOAST)) events.push({ kind: 'fail', text, at: Date.now() });
  };

  const start = () => {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') check(m.target.parentElement);
        for (const n of m.addedNodes) check(n.nodeType === 1 ? n : n.parentElement);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);

  window.__genBot = {
    events: (since) => events.filter((e) => e.at >= since),
    scan: () => {
      const counts = { failures: 0, refunds: 0, busy: 0 };
      if (!document.body) return counts;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode.nodeValue.trim();
        const el = walker.currentNode.parentElement;
        if (!t || t.length >= 120 || !el || el.closest(TOAST)) continue;
        if (failRe.test(t)) counts.failures++;
        if (refundRe.test(t)) counts.refunds++;
        if (busyRe.test(t) && el.getClientRects().length) counts.busy++;
      }
      return counts;
    },
  };
}

const watcherConfig = {
  fail: CONFIG.failureText.source,
  refund: CONFIG.refundText.source,
  busy: CONFIG.busyText.source,
  stop: CONFIG.stopText.source,
};

async function pageEvents(page, since) {
  try {
    await page.evaluate(installWatcher, watcherConfig);
    return await page.evaluate((s) => window.__genBot.events(s), since);
  } catch {
    return [];
  }
}

async function scanPage(page) {
  try {
    await page.evaluate(installWatcher, watcherConfig);
    return await page.evaluate(() => window.__genBot.scan());
  } catch {
    return { failures: 0, refunds: 0, busy: 0 };
  }
}

// Page text is only used to judge an attempt when its job could not be tracked over the network.
async function newFailureOnPage(page, attempt, baseline) {
  if (attempt.ids.size) return null;
  const now = await scanPage(page);
  if (now.refunds > baseline.refunds) return 'Protected content detected / credits refunded';
  if (now.failures > baseline.failures) return 'a new "failed" item appeared on the page';
  return null;
}

// Job ids come from the top level of the generate response and from job-like collections,
// so nested input media (which can also carry a status) is not mistaken for the result.
function collectJobIds(node, ids, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return;
  if (Array.isArray(node)) return node.forEach((n) => collectJobIds(n, ids, depth + 1));
  if (node.id != null) ids.add(String(node.id));
  for (const [key, value] of Object.entries(node)) {
    if (/^(data|jobs?|job_?sets?|jobSets?|generations?|tasks?|items)$/i.test(key)) collectJobIds(value, ids, depth + 1);
  }
}

function recordJobs(node, state) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => recordJobs(n, state));
  if (typeof node.status === 'string' && node.id != null && !('jobs' in node)) {
    const status = node.status.toLowerCase();
    if (ACTIVE_STATUS.test(status) || DONE_STATUSES.has(status) || isFailedStatus(status)) {
      const id = String(node.id);
      const job = state.jobs.get(id);
      if (!job) {
        state.jobs.set(id, { id, status, firstSeen: Date.now(), lastSeen: Date.now() });
        debug(`job ${id} -> ${status}`);
      } else {
        if (job.status !== status) debug(`job ${id} -> ${status}`);
        job.status = status;
        job.lastSeen = Date.now();
      }
    }
  }
  for (const value of Object.values(node)) recordJobs(value, state);
}

// Only this copy's own jobs count, so other copies running on the same account are left alone.
const activeJobs = (state) =>
  [...state.jobs.values()].filter(
    (j) => state.botJobs.has(j.id) && ACTIVE_STATUS.test(j.status) && Date.now() - j.lastSeen < JOB_STALE_MS,
  );

// "Generating" badges on the page cover the whole account, so they are only used
// when this copy's last click could not be tied to a job.
const pageBusy = async (page, state) => state.untracked && (await scanPage(page)).busy > 0;

const attemptStatuses = (state, attempt) =>
  [...attempt.ids].map((id) => state.jobs.get(id)?.status).filter(Boolean);

const botJobSucceeded = (state) => [...state.botJobs].some((id) => DONE_STATUSES.has(state.jobs.get(id)?.status));

function errorMessage(body, status) {
  const msg = body && (body.detail || body.message || body.error || body.msg);
  return `HTTP ${status}${msg ? `: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` : ''}`;
}

function watchNetwork(page, state) {
  const isApi = (req) => {
    const url = req.url();
    return /^https:\/\/([^/]+\.)?higgsfield\.ai\//.test(url) && !IGNORED_URLS.test(url) && ['fetch', 'xhr'].includes(req.resourceType());
  };

  page.on('request', (req) => {
    if (!req.url().startsWith(API_GATEWAY)) return;
    const headers = req.headers();
    if (!headers.authorization) return;
    state.apiHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => k === 'authorization' || k.startsWith('x-')));
  });

  page.on('response', async (res) => {
    const req = res.request();
    if (!isApi(req)) return;

    const status = res.status();
    const isJson = (res.headers()['content-type'] || '').includes('json');
    const body = isJson ? await res.json().catch(() => null) : null;
    debug(`${req.method()} ${status} ${req.url()}`);

    const { pathname } = new URL(req.url());
    if (body && pathname.includes('/jobs')) recordJobs(body, state);

    const attempt = state.attempt;
    const isGenerate = req.method() === 'POST' && GENERATE_PATH.test(pathname);
    if (!attempt || !isGenerate || Date.now() - attempt.clickedAt > CONFIG.submitWindowMs) return;

    if (status === 401 || status === 402) attempt.stop = errorMessage(body, status);
    else if (status >= 400) attempt.failure = errorMessage(body, status);
    else if (status < 300) {
      attempt.acceptedAt ??= Date.now();
      collectJobIds(body, attempt.ids);
      attempt.ids.forEach((id) => state.botJobs.add(id));
      debug(`tracking job ids: ${[...attempt.ids].join(', ') || '(none found)'}`);
    }
  });

  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      try { recordJobs(JSON.parse(payload), state); } catch {}
    });
  });
}

async function cancelJob(page, state, id) {
  try {
    const res = await page.request.put(`${API_GATEWAY}/fnf/jobs/${id}/cancel`, {
      headers: { ...state.apiHeaders, origin: 'https://higgsfield.ai', referer: 'https://higgsfield.ai/' },
    });
    return { ok: res.ok(), detail: `HTTP ${res.status()}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

// Final safety net: if two generations are ever running at once, cancel all but the oldest.
async function enforceSingleGeneration(page, state) {
  const active = activeJobs(state).sort((a, b) => a.firstSeen - b.firstSeen);
  for (const job of active.slice(1)) {
    const tries = state.cancelTries.get(job.id) ?? { count: 0, last: 0 };
    if (tries.count >= MAX_CANCEL_TRIES || Date.now() - tries.last < 5000) continue;
    tries.count++;
    tries.last = Date.now();
    state.cancelTries.set(job.id, tries);

    log(`  OVERRIDE: ${active.length} generations running at once. Cancelling the newer one (${job.id})...`);
    const result = await cancelJob(page, state, job.id);
    if (result.ok) {
      log('  Cancelled the extra generation.');
    } else if (tries.count < MAX_CANCEL_TRIES) {
      log(`  Cancel failed (${result.detail}); trying again shortly.`);
    } else {
      log(`  Could not cancel the extra generation (${result.detail}). Cancel it by hand in History.`);
      notify(BOT_NAME, 'Two generations are running and the extra one could not be cancelled.');
    }
  }
}

function startWatchdog(page, state) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await enforceSingleGeneration(page, state); } finally { running = false; }
  }, 2000);
}

// Waits until nothing is generating. Returns true if one of the bot's earlier jobs succeeded meanwhile.
async function waitUntilIdle(page, state) {
  let lastLog = 0;
  for (;;) {
    if (botJobSucceeded(state)) return true;
    const active = activeJobs(state);
    const busy = await pageBusy(page, state);
    if (!active.length && !busy) return false;

    if (Date.now() - lastLog > 60_000) {
      const what = active.length ? active.map((j) => `${j.id} ${j.status}`).join(', ') : '"Generating" shown on the page';
      log(`  Waiting for the running generation to finish before clicking Generate (${what})`);
      lastLog = Date.now();
    }
    await sleep(2000);
  }
}

async function findGenerateButton(page) {
  const candidates = [
    page.locator('button[type="submit"]').filter({ hasText: /generate/i }),
    page.getByRole('button', { name: /^\s*generate/i }),
  ];
  for (const loc of candidates) {
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const btn = loc.nth(i);
      if (await btn.isVisible().catch(() => false)) return btn;
    }
  }
  return null;
}

// Returns 'clicked', 'busy' (a generation started while waiting for the button) or 'missing'.
async function clickGenerate(page, state) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const btn = await findGenerateButton(page);
    if (btn && (await btn.isEnabled().catch(() => false))) {
      if (activeJobs(state).length || (await pageBusy(page, state))) return 'busy';
      await btn.click();
      return 'clicked';
    }
    await sleep(1000);
  }
  return 'missing';
}

async function showHistory(page) {
  const tab = page.locator('button.q-tabs-tab', { hasText: /^\s*History\s*$/ }).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click().catch(() => {});
    await sleep(2000);
  }
}

// Returns { result: 'accepted' | 'unclear' } or { result: 'failed' | 'stop', reason }.
async function waitForSubmit(page, state, attempt, baseline) {
  while (Date.now() - attempt.clickedAt < CONFIG.submitWindowMs) {
    if (attempt.stop) return { result: 'stop', reason: attempt.stop };
    if (attempt.failure) return { result: 'failed', reason: attempt.failure };

    for (const e of await pageEvents(page, attempt.clickedAt)) {
      if (e.kind === 'stop') return { result: 'stop', reason: e.text };
      if (e.kind === 'fail' && !attempt.acceptedAt) return { result: 'failed', reason: e.text };
    }
    const failedJob = attemptStatuses(state, attempt).find(isFailedStatus);
    if (failedJob) return { result: 'failed', reason: `job status "${failedJob}"` };
    const pageFailure = await newFailureOnPage(page, attempt, baseline);
    if (pageFailure) return { result: 'failed', reason: pageFailure };
    if (attempt.acceptedAt && Date.now() - attempt.acceptedAt > 4000) return { result: 'accepted' };
    await sleep(500);
  }
  return { result: attempt.acceptedAt ? 'accepted' : 'unclear' };
}

// Returns { result: 'done' | 'failed' | 'stop' | 'timeout', reason }.
async function waitForCompletion(page, state, attempt, baseline) {
  const deadline = Date.now() + CONFIG.completeTimeoutMs;
  let lastLog = Date.now();
  while (Date.now() < deadline) {
    const statuses = attemptStatuses(state, attempt);
    if (statuses.some((s) => DONE_STATUSES.has(s)) || botJobSucceeded(state)) return { result: 'done' };
    const failedJob = statuses.find(isFailedStatus);
    if (failedJob) return { result: 'failed', reason: `job status "${failedJob}"` };

    for (const e of await pageEvents(page, attempt.clickedAt)) {
      if (e.kind === 'stop') return { result: 'stop', reason: e.text };
      if (e.kind === 'fail' && !attempt.ids.size) return { result: 'failed', reason: e.text };
    }
    const pageFailure = await newFailureOnPage(page, attempt, baseline);
    if (pageFailure) return { result: 'failed', reason: pageFailure };

    if (Date.now() - lastLog > 60_000) {
      log(`  still rendering... (${statuses.join(', ') || 'no status yet'})`);
      lastLog = Date.now();
    }
    await sleep(1500);
  }
  return { result: 'timeout' };
}

async function run(page, state) {
  await showHistory(page);

  let n = 0;
  while (n < CONFIG.maxAttempts) {
    if (await waitUntilIdle(page, state)) return { ok: true };

    const baseline = await scanPage(page);
    const attempt = { n: n + 1, clickedAt: Date.now(), ids: new Set() };
    state.attempt = attempt;

    const click = await clickGenerate(page, state);
    if (click === 'busy') continue;
    if (click === 'missing') return { ok: false, reason: 'Could not find an enabled Generate button for 2 minutes.' };
    n++;
    state.tries = n;
    log(`Attempt ${n}${Number.isFinite(CONFIG.maxAttempts) ? `/${CONFIG.maxAttempts}` : ''}: clicked Generate`);

    let outcome = await waitForSubmit(page, state, attempt, baseline);
    if (outcome.result === 'accepted') log('  Higgsfield accepted the generation');
    if (outcome.result === 'unclear') log('  No clear response from Higgsfield; watching the page instead');

    if (outcome.result === 'accepted' || outcome.result === 'unclear') {
      if (CONFIG.waitFor === 'submit') {
        if (outcome.result === 'accepted') return { ok: true };
        return { ok: false, reason: 'Could not confirm the generation was submitted. Run with --debug to see network traffic.' };
      }
      log('  Waiting for the video to finish...');
      outcome = await waitForCompletion(page, state, attempt, baseline);
    }
    state.untracked = attempt.ids.size === 0;

    if (outcome.result === 'done') return { ok: true };
    if (outcome.result === 'stop') return { ok: false, reason: `Stopped: ${outcome.reason}` };
    if (outcome.result === 'timeout') {
      return { ok: false, reason: `No result after ${CONFIG.completeTimeoutMs / 60_000} minutes. Not retrying to avoid duplicate generations.` };
    }

    log(`  FAILED (${outcome.reason}). Retrying in ${CONFIG.retryDelayMs / 1000}s...`);
    await sleep(CONFIG.retryDelayMs);
  }
  return { ok: false, reason: `Gave up after ${CONFIG.maxAttempts} attempts.` };
}

async function main() {
  const context = await chromium
    .launchPersistentContext(CONFIG.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    })
    .catch((err) => {
      if (/ProcessSingleton|already in use|profile.*in use/i.test(err.message)) {
        console.error(`\nAnother copy of the bot is already using "${path.basename(CONFIG.profileDir)}".`);
        console.error('Start this copy with its own profile, e.g.: npm run debug -- --profile second\n');
        process.exit(1);
      }
      throw err;
    });
  const page = context.pages()[0] ?? (await context.newPage());
  const state = {
    attempt: null,
    jobs: new Map(),
    botJobs: new Set(),
    cancelTries: new Map(),
    apiHeaders: {},
    untracked: false,
    tries: 0,
    startedAt: null,
    finished: false,
  };

  await page.addInitScript(installWatcher, watcherConfig);
  watchNetwork(page, state);
  await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded' });

  process.on('SIGINT', async () => {
    if (state.startedAt && !state.finished) recordRun(state, 'STOPPED BY YOU');
    log('Stopping bot.');
    await context.close().catch(() => {});
    process.exit(0);
  });

  console.log(`
Higgsfield Genjutsu auto-generate bot${PROFILE ? ` (profile: ${PROFILE})` : ''}
-------------------------------------
1. Log in to Higgsfield in the Chrome window (only needed the first time).
2. Set everything up: reference video, images, prompt, quality, etc.
3. Come back here and press Enter. The bot will click Generate and retry
   on failure until a generation ${CONFIG.waitFor === 'submit' ? 'is accepted' : 'finishes successfully'}.
   This copy only ever runs one generation at a time; its extras are cancelled.
   (${Number.isFinite(CONFIG.maxAttempts) ? `max ${CONFIG.maxAttempts}` : 'unlimited'} attempts, ${CONFIG.retryDelayMs / 1000}s between retries, Ctrl+C to stop)
`);
  await ask('Press Enter to start... ');

  state.startedAt = Date.now();
  log('Run started');
  startWatchdog(page, state);
  const result = await run(page, state);
  state.attempt = null;
  state.finished = true;

  if (result.ok) {
    const summary = recordRun(state, 'SUCCESS');
    notify(BOT_NAME, `Your Genjutsu generation passed! ${summary}`);
  } else {
    const summary = recordRun(state, 'STOPPED', result.reason);
    notify(BOT_NAME, summary);
  }
  log(`Log saved to ${path.relative(__dirname, RUN_LOG)} (all runs: ${path.relative(__dirname, HISTORY_LOG)})`);
  log('Browser stays open so you can check the result. Press Ctrl+C to quit.');
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
