const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 5000;

app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ─── In-memory session store ──────────────────────────────────────────────────
const sessions = {};

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// ─── Strip meta tags that break the site's own JS ────────────────────────────
function stripBlockingMetaTags(html) {
  return html
    .replace(/<meta[^>]+http-equiv\s*=\s*['"]?content-security-policy['"]?[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*['"]?x-frame-options['"]?[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*['"]?referrer-policy['"]?[^>]*>/gi, '');
}

// ─── Selector tool injected into every proxied page ───────────────────────────
function getSelectorToolHtml(baseUrl) {
  return `
    <style>
      #scraper-highlight {
        position: absolute;
        background: rgba(66, 153, 225, 0.2);
        border: 2px solid #3182ce;
        pointer-events: none;
        z-index: 2147483640;
        display: none;
        transition: all 0.1s ease;
      }
      #scraper-tooltip {
        position: fixed;
        background: #3182ce;
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        z-index: 2147483641;
        pointer-events: none;
        display: none;
      }
      .scraper-instructions {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: white;
        border: 1px solid #3182ce;
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        z-index: 2147483642;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        max-width: 300px;
        display: none;
      }
      .scraper-instructions.active { display: block; }
      .scraper-instructions h4 { margin: 0 0 8px 0; color: #2d3748; font-size: 14px; }
      .scraper-instructions p  { margin: 0; color: #4a5568; font-size: 12px; }
    </style>
    <div class="scraper-instructions" id="scraper-instructions">
      <h4>🔍 Select Mode Active</h4>
      <p>Hover to highlight · Click to select<br>Dropdowns &amp; menus open normally</p>
    </div>
    <script>
      (function() {
        const highlightBox = document.createElement('div');
        highlightBox.id = 'scraper-highlight';
        document.body.appendChild(highlightBox);

        const tooltip = document.createElement('div');
        tooltip.id = 'scraper-tooltip';
        document.body.appendChild(tooltip);

        const instructions = document.getElementById('scraper-instructions');
        let isSelectMode = false;

        window.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'SET_SELECT_MODE') {
            isSelectMode = event.data.value;
            if (instructions) instructions.classList.toggle('active', isSelectMode);
            if (!isSelectMode) {
              highlightBox.style.display = 'none';
              tooltip.style.display = 'none';
            }
          }
        });

        // ── Selector builder ──────────────────────────────────────────────
        function getSelector(el) {
          if (!el || el === document.documentElement) return '';
          if (el.id) return '#' + CSS.escape(el.id);
          let path = [], current = el;
          while (current && current !== document.body && current !== document.documentElement) {
            let sel = current.tagName.toLowerCase();
            if (current.className && typeof current.className === 'string') {
              const classes = current.className.trim().split(/\\s+/).filter(Boolean);
              if (classes.length) sel += '.' + CSS.escape(classes[0]);
            }
            const parent = current.parentElement;
            if (parent) {
              const idx = Array.from(parent.children).indexOf(current) + 1;
              if (parent.children.length > 1) sel += ':nth-child(' + idx + ')';
            }
            path.unshift(sel);
            current = current.parentElement;
          }
          return path.join(' > ');
        }

        function buildElementInfo(target) {
          const attributes = {};
          if (target.attributes) {
            Array.from(target.attributes).forEach(a => { attributes[a.name] = a.value; });
          }
          return {
            tag:         target.tagName.toLowerCase(),
            id:          target.id || undefined,
            classes:     Array.from(target.classList || []),
            name:        target.getAttribute('name'),
            type:        target.getAttribute('type'),
            text:        target.innerText?.slice(0, 100),
            value:       target.value,
            href:        target.href,
            placeholder: target.getAttribute('placeholder'),
            selector:    getSelector(target),
            attributes
          };
        }

        function flashElement(target) {
          const orig = target.style.outline;
          target.style.outline = '2px solid #48bb78';
          setTimeout(() => { target.style.outline = orig; }, 300);
        }

        // ── Hover highlight ───────────────────────────────────────────────
        document.addEventListener('mouseover', (e) => {
          if (!isSelectMode) return;
          const target = e.target;
          if (target === highlightBox || target === tooltip) return;
          const rect = target.getBoundingClientRect();
          const sTop  = window.pageYOffset  || document.documentElement.scrollTop;
          const sLeft = window.pageXOffset || document.documentElement.scrollLeft;
          highlightBox.style.cssText += ';display:block;top:' + (rect.top + sTop) + 'px;left:' + (rect.left + sLeft) + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px';
          tooltip.style.display = 'block';
          tooltip.style.top  = Math.max(0, rect.top - 25) + 'px';
          tooltip.style.left = rect.left + 'px';
          tooltip.textContent = '<' + target.tagName.toLowerCase() + '>';
        }, true);

        // ── MOUSEDOWN — bubble phase (false) ─────────────────────────────
        // KEY FIX: Using bubble (false) instead of capture (true) means the
        // element's OWN handlers fire first → dropdown opens → THEN we record.
        // Capture phase was interrupting dropdown event flow in React/Bootstrap/MUI.
        document.addEventListener('mousedown', (e) => {
          if (!isSelectMode) return;
          const target = e.target;
          if (target === highlightBox || target === tooltip || target === instructions) return;
          window.parent.postMessage({ type: 'ELEMENT_SELECTED', data: buildElementInfo(target) }, '*');
          flashElement(target);
          // NO preventDefault, NO stopPropagation — everything fires normally
        }, false); // ← false = bubble phase

        // ── CLICK — only block real page navigations ──────────────────────
        // KEY FIX: Check the RAW href attribute (not the resolved node.href).
        // node.href resolves "#" to "http://localhost:5000/...#" which was
        // incorrectly triggering our block and calling stopPropagation(),
        // preventing the dropdown's own click handler from ever firing.
        document.addEventListener('click', (e) => {
          if (!isSelectMode) return;
          let node = e.target;
          while (node && node !== document.body) {
            if (node.tagName === 'A') {
              const rawHref = node.getAttribute('href'); // raw value, NOT resolved
              // Safe: no href, empty, hash (#section), javascript:
              const isSafeToggle = !rawHref ||
                                   rawHref === '' ||
                                   rawHref.startsWith('#') ||
                                   rawHref.startsWith('javascript:');
              if (!isSafeToggle) {
                // Real navigation to another page — block it
                e.preventDefault();
                // We REMOVED e.stopPropagation() so that custom JS UI frameworks 
                // still receive the click event and can open their dropdowns normally
              }
              // Hash/javascript links: let through so dropdown/toggle works
              return;
            }
            node = node.parentElement;
          }
        }, true);

        // ── SUBMIT — block so iframe doesn't navigate away ────────────────
        document.addEventListener('submit', (e) => {
          if (isSelectMode) { e.preventDefault(); e.stopPropagation(); }
        }, true);

        // ── SELECT change — re-send with chosen value ─────────────────────
        document.addEventListener('change', (e) => {
          if (!isSelectMode) return;
          if (e.target.tagName.toUpperCase() === 'SELECT') {
            window.parent.postMessage({ type: 'ELEMENT_SELECTED', data: buildElementInfo(e.target) }, '*');
          }
        }, false); // bubble — native select opens first, we read the value after

        window.parent.postMessage({ type: 'IFRAME_READY' }, '*');
      })();
    </script>
  `;
}

// ─── Safe click: races click against navigation so context is never destroyed ──
async function safeClick(page, selector) {
  try {
    // CRITICAL: waitForNavigation MUST be started BEFORE the click.
    // If we await click() first and navigation fires during it, the context is
    // already destroyed by the time we call waitForNavigation → the bug.
    // Promise.all starts both simultaneously so we never miss the navigation event.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => {}),
      page.click(selector),
    ]);
  } catch (err) {
    if (err.message && err.message.includes('Execution context was destroyed')) {
      // Navigation already happened mid-click — just wait for the new page to settle
      console.log('  [safeClick] context destroyed mid-click — waiting for navigation to settle');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    } else {
      throw err;
    }
  }
  // Final settle: ensure DOM is fully ready after any navigation
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
}

// ─── Replay steps on Puppeteer page ──────────────────────────────────────────
async function replaySteps(page, steps) {
  for (let i = 0; i < steps.length; i++) {
    const { action, selector, value, waitMs } = steps[i];
    console.log(`  step [${i + 1}] ${action}  selector=${selector}  value=${value}`);
    try {
      switch (action) {
        case 'click':
          await page.waitForSelector(selector, { timeout: 10000 });
          await safeClick(page, selector);
          break;
        case 'type':
          await page.waitForSelector(selector, { timeout: 10000 });
          await page.click(selector, { clickCount: 3 });
          await page.type(selector, value || '', { delay: 40 });
          break;
        case 'select':
          await page.waitForSelector(selector, { timeout: 10000 });
          await page.select(selector, value || '');
          break;
        case 'scroll':
          if (selector) {
            await page.waitForSelector(selector, { timeout: 10000 });
            await page.$eval(selector, el => el.scrollIntoView());
          } else {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          }
          break;
        case 'wait':
          if (selector) {
            await page.waitForSelector(selector, { timeout: 15000 });
          } else {
            await delay(Number(waitMs) || 1000);
          }
          break;
        case 'wait_timeout':
          await delay(Number(value) || 1000);
          break;
        case 'hover':
          await page.waitForSelector(selector, { timeout: 10000 });
          await page.hover(selector);
          break;
        case 'press':
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => {}),
            page.keyboard.press(value || 'Enter'),
          ]);
          await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
          break;
        default:
          console.warn(`  unknown action: ${action} — skipping`);
      }
      await delay(300);
    } catch (stepErr) {
      console.error(`  step [${i + 1}] failed: ${stepErr.message}`);
    }
  }
}

// ─── Extract fields from Puppeteer page ──────────────────────────────────────
async function extractFields(page, extractionFields, attempt = 1) {
  try {
    if (extractionFields.length === 0) {
      const bodyText = await page.evaluate(() => document.body.innerText?.slice(0, 5000));
      return [{ page_text: bodyText }];
    }
    await delay(500);
    return await page.evaluate((fields) => {
      const record = {};
      fields.forEach(({ fieldName, selector, attr }) => {
        try {
          const el = document.querySelector(selector);
          if (!el) { record[fieldName] = null; return; }
          if (attr === 'href')      record[fieldName] = el.href || el.getAttribute('href');
          else if (attr === 'src')  record[fieldName] = el.src  || el.getAttribute('src');
          else if (attr)            record[fieldName] = el.getAttribute(attr);
          else                      record[fieldName] = el.innerText?.trim() || el.textContent?.trim();
        } catch { record[fieldName] = null; }
      });
      return [record];
    }, extractionFields);
  } catch (err) {
    if (err.message && err.message.includes('Execution context was destroyed') && attempt <= 3) {
      console.log(`  [extractFields] Context destroyed mid-eval — waiting to settle and retrying (Attempt ${attempt})`);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
      return extractFields(page, extractionFields, attempt + 1);
    }
    throw err;
  }
}

// ─── Build safe HTML (strip blocking tags, inject tool) ───────────────────────
function buildSafeHtml(rawHtml, pageUrl, tool) {
  let html = stripBlockingMetaTags(rawHtml);
  const baseUrl = new URL(pageUrl).origin;
  if (html.includes('<base')) {
    html = html.replace(/<base[^>]*>/i, `<base href="${baseUrl}/">`);
  } else {
    html = html.replace(/<head>/i, `<head><base href="${baseUrl}/">`);
  }
  html = html.includes('</body>') ? html.replace('</body>', tool + '</body>') : html + tool;
  return html;
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'OK' }));

// ─── Proxy endpoint ────────────────────────────────────────────────────────────
app.all('/api/proxy', async (req, res) => {
  const url = req.query.url || req.body.url;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      maxRedirects: 5, timeout: 30000, validateStatus: (s) => s < 500
    });

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html')) return res.send(response.data);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');

    const tool = getSelectorToolHtml(new URL(url).origin);
    res.send(buildSafeHtml(response.data, url, tool));

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">
      <h2 style="color:#e53e3e">Failed to load</h2><p>${error.message}</p>
      <button onclick="window.parent.postMessage({type:'CLOSE_ERROR'},'*')" style="background:#3182ce;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer">Close</button>
    </body></html>`);
  }
});

// ─── GET /api/page — serve live Puppeteer page into iframe ───────────────────
app.get('/api/page', async (req, res) => {
  const session = sessions[req.query.sessionId];
  if (!session) return res.status(404).send('<html><body><h2>Session not found</h2></body></html>');
  try {
    const { page } = session;
    const currentUrl = page.url();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    const tool = getSelectorToolHtml(new URL(currentUrl).origin);
    res.send(buildSafeHtml(await page.content(), currentUrl, tool));
  } catch (err) {
    res.status(500).send(`<html><body><h2>Error: ${err.message}</h2></body></html>`);
  }
});

// ─── POST /api/run ─────────────────────────────────────────────────────────────
app.post('/api/run', async (req, res) => {
  const { url, steps = [], extractionFields = [] } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  console.log(`\n▶ /api/run  url=${url}  steps=${steps.length}`);
  try {
    const browser = await puppeteer.launch({
      headless: false,
      ignoreHTTPSErrors: true,           // bypass HTTPS/HTTP security warnings
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',            // kills ad blockers → fixes ERR_BLOCKED_BY_CLIENT
        '--disable-web-security',          // allow mixed HTTP/HTTPS content
        '--allow-running-insecure-content',// don't block HTTP on HTTPS pages
        '--ignore-certificate-errors',     // ignore SSL cert issues
        '--disable-features=IsolateOrigins,site-per-process', // iframe compat
        '--no-first-run',                  // skip first-run dialogs
        '--no-default-browser-check',
      ],
      defaultViewport: { width: 1280, height: 800 }
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000, ignoreHTTPSErrors: true });
    await replaySteps(page, steps);
    // Ensure page is fully settled after all steps (catches any trailing navigation)
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
    const results   = await extractFields(page, extractionFields);
    const sessionId = `session_${Date.now()}`;
    sessions[sessionId] = { browser, page };
    console.log(`  ✓ ${results.length} record(s). Session: ${sessionId}`);
    res.json({ success: true, results, total: results.length, sessionId, liveUrl: page.url() });
  } catch (err) {
    console.error('Run error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/continue ───────────────────────────────────────────────────────
app.post('/api/continue', async (req, res) => {
  const { sessionId, steps = [], extractionFields = [] } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  console.log(`\n▶ /api/continue  session=${sessionId}  steps=${steps.length}`);
  try {
    await replaySteps(session.page, steps);
    // Ensure page is fully settled after all steps (catches any trailing navigation)
    await session.page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
    const results = await extractFields(session.page, extractionFields);
    res.json({ success: true, results, total: results.length, liveUrl: session.page.url() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/close ──────────────────────────────────────────────────────────
app.post('/api/close', async (req, res) => {
  const session = sessions[req.body.sessionId];
  if (session) {
    await session.browser.close().catch(() => {});
    delete sessions[req.body.sessionId];
  }
  res.json({ success: true });
});

app.get('/api/test', (req, res) => res.json({ message: 'Backend working', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`✅ Server on http://localhost:${PORT}`);
  console.log(`📍 POST /api/run       – run steps, keep browser alive`);
  console.log(`📍 GET  /api/page      – dump live page into iframe`);
  console.log(`📍 POST /api/continue  – run more steps on session`);
  console.log(`📍 POST /api/close     – close browser`);
});
