// Vercel serverless -- Delta Key Auto-Fetcher v2
// Runtime: Node.js 18+
// Selalu balikin JSON, gak pernah HTML crash.

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT = 55000;

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }
  return browserPromise;
}

function tryMatchKey(text) {
  if (!text) return null;
  const patterns = [
    /"key"\s*:\s*"([A-Za-z0-9_\-]{6,64})"/i,
    /"license"\s*:\s*"([A-Za-z0-9_\-]{6,64})"/i,
    /\bkey[=:]\s*([A-Za-z0-9_\-]{6,64})/i,
    /\b([A-Z0-9]{8,}-[A-Z0-9]{4,})\b/,
    /\b([A-F0-9]{20,64})\b/,
  ];
  for (const r of patterns) {
    const m = text.match(r);
    if (m) {
      const k = m[1] || m[0];
      if (!/^(true|false|null|undefined|function|return|window|document|script)$/i.test(k)) return k;
    }
  }
  return null;
}

async function fetchKey(targetUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const logs = [];
  const log = (m) => { logs.push(m); console.log('[knt]', m); };

  let capturedKey = null;

  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!/json|text|javascript/i.test(ct)) return;
      if (res.status() >= 400) return;
      const body = await res.text().catch(() => null);
      if (!body || body.length > 2000000) return;
      const k = tryMatchKey(body);
      if (k && !capturedKey) {
        capturedKey = k;
        log(`captured @ ${res.url().slice(0, 80)}`);
      }
    } catch {}
  });

  page.on('pageerror', (e) => log('pageerror: ' + e.message.slice(0, 80)));

  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  log(`goto ${targetUrl.slice(0, 80)}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  try { await page.waitForNetworkIdle({ idleTime: 2000, timeout: 12000 }); } catch {}

  const clickPatterns = ['continue', 'get key', 'get link', 'verify', 'next',
    'lanjut', 'dapatkan', 'klaim', 'claim', 'unlock', 'open', 'start', 'step'];

  const start = Date.now();
  let stable = 0;

  while (Date.now() - start < TIMEOUT && !capturedKey) {
    try {
      const domKey = await page.evaluate(() => {
        const t = document.body.innerText;
        const m = t.match(/"key"\s*:\s*"([^"]+)"/i)
               || t.match(/\b([A-Z0-9]{8,}-[A-Z0-9]{4,})\b/);
        return m ? (m[1] || m[0]) : null;
      });
      if (domKey) { capturedKey = domKey; log('captured @ DOM'); break; }
    } catch {}

    let clicked = 0;
    try {
      const buttons = await page.$$('button, a, [role="button"], .btn, [onclick]');
      for (const btn of buttons) {
        try {
          const info = await btn.evaluate((el) => ({
            txt: (el.innerText || el.textContent || '').trim().toLowerCase(),
            vis: el.offsetParent !== null && el.offsetWidth > 0,
            dis: el.disabled || el.getAttribute('aria-disabled') === 'true',
          }));
          if (!info.vis || info.dis || !info.txt || info.txt.length > 60) continue;
          for (const p of clickPatterns) {
            if (info.txt.includes(p)) {
              await btn.click({ delay: 50 }).catch(() => {});
              clicked++;
              log(`click "${info.txt.slice(0, 40)}"`);
              await new Promise(r => setTimeout(r, 900));
              break;
            }
          }
        } catch {}
      }
    } catch {}

    if (clicked === 0) stable++; else stable = 0;
    if (stable > 6) {
      await new Promise(r => setTimeout(r, 4000));
      if (stable > 10) break;
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  if (!capturedKey) {
    try {
      const txt = await page.evaluate(() => document.body.innerText);
      capturedKey = tryMatchKey(txt);
    } catch {}
  }

  const finalUrl = page.url();
  await page.close().catch(() => {});
  return { key: capturedKey, logs, finalUrl };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};

    const url = body.url;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'no url' });

    const r = await fetchKey(url);
    if (r.key) return res.status(200).json({ key: r.key, source: r.finalUrl, logs: r.logs });
    return res.status(404).json({ error: 'key not found', finalUrl: r.finalUrl, logs: r.logs });

  } catch (e) {
    return res.status(500).json({
      error: 'crash: ' + e.message,
      stack: String(e.stack || '').split('\n').slice(0, 3).join(' | '),
    });
  }
};
