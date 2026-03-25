const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 5000;

// Middleware
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// ─── Proxy endpoint ──────────────────────────────────────────────────────────
app.all('/api/proxy', async (req, res) => {
  try {
    const url = req.query.url || req.body.url;
    console.log(url, "here url");

    if (!url) return res.status(400).json({ error: 'URL is required' });

    try { new URL(url); } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    console.log(`[${req.method}] Fetching:`, url);

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      maxRedirects: 5,
      timeout: 30000,
      validateStatus: (status) => status < 500
    });

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html')) return res.send(response.data);

    let html = response.data;
    const baseUrl = new URL(url).origin;
    html = html.replace('<head>', `<head><base href="${baseUrl}/">`);

    const selectorTool = `
      <style>
        #scraper-highlight {
          position: absolute;
          background: rgba(66, 153, 225, 0.2);
          border: 2px solid #3182ce;
          pointer-events: none;
          z-index: 10000;
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
          z-index: 10001;
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
          z-index: 10002;
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
        <p>Hover over elements to highlight<br>Click to select and record action</p>
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
            if (event.data.type === 'SET_SELECT_MODE') {
              isSelectMode = event.data.value;
              if (instructions) instructions.classList.toggle('active', isSelectMode);
              if (!isSelectMode) {
                highlightBox.style.display = 'none';
                tooltip.style.display = 'none';
              }
            }
          });

          function getSelector(el) {
            if (!el) return '';
            if (el.id) return '#' + CSS.escape(el.id);
            let path = [];
            let current = el;
            while (current && current !== document.body) {
              let selector = current.tagName.toLowerCase();
              if (current.className && typeof current.className === 'string') {
                const classes = current.className.split(/\\s+/).filter(c => c && c.trim());
                if (classes.length > 0) selector += '.' + CSS.escape(classes[0]);
              }
              const parent = current.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children);
                const index = siblings.indexOf(current) + 1;
                if (siblings.length > 1) selector += ':nth-child(' + index + ')';
              }
              path.unshift(selector);
              current = current.parentElement;
            }
            return path.join(' > ');
          }

          document.addEventListener('mouseover', (e) => {
            if (!isSelectMode) return;
            const target = e.target;
            if (target === highlightBox || target === tooltip || target === instructions) return;
            const rect = target.getBoundingClientRect();
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
            highlightBox.style.display = 'block';
            highlightBox.style.top    = (rect.top  + scrollTop)  + 'px';
            highlightBox.style.left   = (rect.left + scrollLeft) + 'px';
            highlightBox.style.width  = rect.width  + 'px';
            highlightBox.style.height = rect.height + 'px';
            tooltip.style.display = 'block';
            tooltip.style.top  = (rect.top  + scrollTop  - 25) + 'px';
            tooltip.style.left = (rect.left + scrollLeft)       + 'px';
            tooltip.textContent = '<' + target.tagName.toLowerCase() + '>';
          });

          document.addEventListener('click', (e) => {
            if (!isSelectMode) return;
            e.preventDefault();
            e.stopPropagation();
            const target = e.target;
            const attributes = {};
            if (target.attributes) {
              Array.from(target.attributes).forEach(attr => {
                attributes[attr.name] = attr.value;
              });
            }
            const elementInfo = {
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
            window.parent.postMessage({ type: 'ELEMENT_SELECTED', data: elementInfo }, '*');
            const originalOutline = target.style.outline;
            target.style.outline = '2px solid #48bb78';
            setTimeout(() => { target.style.outline = originalOutline; }, 200);
          }, true);

          document.addEventListener('submit', (e) => {
            if (isSelectMode) { e.preventDefault(); e.stopPropagation(); }
          }, true);

          document.addEventListener('click', (e) => {
            if (isSelectMode && e.target.tagName === 'A') e.preventDefault();
          }, true);

          window.parent.postMessage({ type: 'IFRAME_READY' }, '*');
          console.log('Selector tool injected successfully');
        })();
      </script>
    `;

    if (html.includes('</body>')) {
      html = html.replace('</body>', selectorTool + '</body>');
    } else {
      html = html + selectorTool;
    }

    res.send(html);

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).send(`
      <!DOCTYPE html><html><head>
        <style>
          body { font-family: sans-serif; background:#f7fafc; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }
          .box { background:white; border-radius:12px; padding:32px; box-shadow:0 10px 25px rgba(0,0,0,0.1); max-width:500px; text-align:center; }
          h2 { color:#e53e3e; } p { color:#4a5568; }
          .err { background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:12px; margin:20px 0; font-family:monospace; font-size:14px; color:#991b1b; text-align:left; word-break:break-word; }
          button { background:#3182ce; color:white; border:none; padding:12px 24px; border-radius:8px; font-size:16px; cursor:pointer; }
        </style>
      </head><body>
        <div class="box">
          <div style="font-size:48px">😵</div>
          <h2>Failed to Load Website</h2>
          <div class="err">${error.message}</div>
          <button onclick="window.parent.postMessage({type:'CLOSE_ERROR'},'*')">Close</button>
        </div>
      </body></html>
    `);
  }
});

// ─── RUN endpoint ─────────────────────────────────────────────────────────────
app.post('/api/run', async (req, res) => {
  const { url, steps = [], extractionFields = [] } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  console.log(`\n▶ /api/run  url=${url}  steps=${steps.length}  fields=${extractionFields.length}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 800 }
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('  → navigating to', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const { action, selector, value, waitMs } = step;
      console.log(`  step [${i + 1}] ${action}  selector=${selector}  value=${value}`);

      try {
        switch (action) {
          case 'click':
            await page.waitForSelector(selector, { timeout: 10000 });
            await page.click(selector);
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
              await page.waitForTimeout(waitMs || 1000);
            }
            break;

          case 'wait_timeout':
            await page.waitForTimeout(Number(value) || 1000);
            break;

          case 'hover':
            await page.waitForSelector(selector, { timeout: 10000 });
            await page.hover(selector);
            break;

          case 'press':
            await page.keyboard.press(value || 'Enter');
            break;

          default:
            console.warn(`  unknown action: ${action} — skipping`);
        }

        await page.waitForTimeout(300);

      } catch (stepErr) {
        console.error(`  step [${i + 1}] failed: ${stepErr.message}`);
      }
    }

    let results = [];

    if (extractionFields.length > 0) {
      console.log('  → extracting', extractionFields.length, 'field(s)');
      await page.waitForTimeout(500);

      results = await page.evaluate((fields) => {
        const record = {};
        fields.forEach(({ fieldName, selector, attr }) => {
          try {
            const el = document.querySelector(selector);
            if (!el) { record[fieldName] = null; return; }
            if (attr === 'href')       record[fieldName] = el.href || el.getAttribute('href');
            else if (attr === 'src')   record[fieldName] = el.src  || el.getAttribute('src');
            else if (attr)             record[fieldName] = el.getAttribute(attr);
            else                       record[fieldName] = el.innerText?.trim() || el.textContent?.trim();
          } catch (e) {
            record[fieldName] = null;
          }
        });
        return [record];
      }, extractionFields);

    } else {
      const bodyText = await page.evaluate(() => document.body.innerText?.slice(0, 5000));
      results = [{ page_text: bodyText }];
    }

    console.log(`  ✓ extracted ${results.length} record(s)`);
    res.json({ success: true, results, total: results.length });

  } catch (err) {
    console.error('Run error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) {
      await browser.close();
      console.log('  browser closed');
    }
  }
});

// ─── Test endpoint ───────────────────────────────────────────────────────────
app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is working!', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on http://localhost:${PORT}`);
  console.log(`📍 Proxy : http://localhost:${PORT}/api/proxy?url=YOUR_URL`);
  console.log(`📍 Run   : POST http://localhost:${PORT}/api/run`);
});
