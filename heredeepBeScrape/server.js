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
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Proxy endpoint - Handle both GET and POST
app.all('/api/proxy', async (req, res) => {
  try {
    // Get URL from query string (GET) or body (POST)
    // const url = req.method === 'GET' ? req.query.url : req.body.url;
    const url =  req.query.url ||  req.body.url;
    console.log(url,"here url")
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`[${req.method}] Fetching:`, url);

    // Validate URL
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Fetch the website with better error handling
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
      validateStatus: function (status) {
        return status < 500; // Accept all status codes below 500
      }
    });

    // Check if response is HTML
    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html')) {
      // If not HTML, return as is
      return res.send(response.data);
    }

    // Inject our selector tool script into the HTML
    let html = response.data;
    
    // Add base tag to handle relative URLs
    const baseUrl = new URL(url).origin;
    html = html.replace('<head>', `<head><base href="${baseUrl}/">`);
    
    // Inject our selector tool CSS and JS
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
        .scraper-instructions.active {
          display: block;
        }
        .scraper-instructions h4 {
          margin: 0 0 8px 0;
          color: #2d3748;
          font-size: 14px;
        }
        .scraper-instructions p {
          margin: 0;
          color: #4a5568;
          font-size: 12px;
        }
      </style>
      <div class="scraper-instructions" id="scraper-instructions">
        <h4>🔍 Select Mode Active</h4>
        <p>Hover over elements to highlight<br>Click to select and record action</p>
      </div>
      <script>
        (function() {
          // Create highlight elements
          const highlightBox = document.createElement('div');
          highlightBox.id = 'scraper-highlight';
          document.body.appendChild(highlightBox);
          
          const tooltip = document.createElement('div');
          tooltip.id = 'scraper-tooltip';
          document.body.appendChild(tooltip);
          
          const instructions = document.getElementById('scraper-instructions');
          
          let isSelectMode = false;
          
          // Listen for select mode changes from parent
          window.addEventListener('message', (event) => {
            if (event.data.type === 'SET_SELECT_MODE') {
              isSelectMode = event.data.value;
              if (instructions) {
                instructions.classList.toggle('active', isSelectMode);
              }
              if (!isSelectMode) {
                highlightBox.style.display = 'none';
                tooltip.style.display = 'none';
              }
            }
          });
          
          // Generate CSS selector
          function getSelector(el) {
            if (!el) return '';
            
            if (el.id) return '#' + CSS.escape(el.id);
            
            let path = [];
            let current = el;
            
            while (current && current !== document.body) {
              let selector = current.tagName.toLowerCase();
              
              if (current.className && typeof current.className === 'string') {
                const classes = current.className.split(/\\s+/).filter(c => c && c.trim());
                if (classes.length > 0) {
                  selector += '.' + CSS.escape(classes[0]);
                }
              }
              
              // Add :nth-child for uniqueness
              const parent = current.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children);
                const index = siblings.indexOf(current) + 1;
                if (siblings.length > 1) {
                  selector += ':nth-child(' + index + ')';
                }
              }
              
              path.unshift(selector);
              current = current.parentElement;
            }
            
            return path.join(' > ');
          }
          
          // Handle mouseover for highlighting
          document.addEventListener('mouseover', (e) => {
            if (!isSelectMode) return;
            
            const target = e.target;
            if (target === highlightBox || target === tooltip || target === instructions) return;
            
            const rect = target.getBoundingClientRect();
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
            
            highlightBox.style.display = 'block';
            highlightBox.style.top = (rect.top + scrollTop) + 'px';
            highlightBox.style.left = (rect.left + scrollLeft) + 'px';
            highlightBox.style.width = rect.width + 'px';
            highlightBox.style.height = rect.height + 'px';
            
            // Show tooltip with tag name
            tooltip.style.display = 'block';
            tooltip.style.top = (rect.top + scrollTop - 25) + 'px';
            tooltip.style.left = (rect.left + scrollLeft) + 'px';
            tooltip.textContent = '<' + target.tagName.toLowerCase() + '>';
          });
          
          // Handle click for selection
          document.addEventListener('click', (e) => {
            if (!isSelectMode) return;
            
            e.preventDefault();
            e.stopPropagation();
            
            const target = e.target;
            
            // Get element info
            const elementInfo = {
              tag: target.tagName.toLowerCase(),
              id: target.id || undefined,
              classes: Array.from(target.classList || []),
              name: target.getAttribute('name'),
              type: target.getAttribute('type'),
              text: target.innerText?.slice(0, 100),
              value: target.value,
              href: target.href,
              placeholder: target.getAttribute('placeholder'),
              selector: getSelector(target)
            };
            
            // Get all attributes
            const attributes = {};
            if (target.attributes) {
              Array.from(target.attributes).forEach(attr => {
                attributes[attr.name] = attr.value;
              });
            }
            elementInfo.attributes = attributes;
            
            // Send to parent
            window.parent.postMessage({
              type: 'ELEMENT_SELECTED',
              data: elementInfo
            }, '*');
            
            // Flash the element to indicate selection
            const originalOutline = target.style.outline;
            target.style.outline = '2px solid #48bb78';
            setTimeout(() => {
              target.style.outline = originalOutline;
            }, 200);
          }, true);
          
          // Prevent form submissions in select mode
          document.addEventListener('submit', (e) => {
            if (isSelectMode) {
              e.preventDefault();
              e.stopPropagation();
              console.log('Form submission prevented in select mode');
            }
          }, true);
          
          // Prevent link clicks in select mode
          document.addEventListener('click', (e) => {
            if (isSelectMode && e.target.tagName === 'A') {
              e.preventDefault();
              console.log('Link click prevented in select mode');
            }
          }, true);
          
          // Notify parent that we're ready
          window.parent.postMessage({ type: 'IFRAME_READY' }, '*');
          console.log('Selector tool injected successfully');
        })();
      </script>
    `;
    
    // Inject the script right before </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', selectorTool + '</body>');
    } else {
      html = html + selectorTool;
    }
    
    res.send(html);
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    
    // Send a user-friendly error page
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f7fafc;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
          }
          .error-container {
            background: white;
            border-radius: 12px;
            padding: 32px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            max-width: 500px;
            text-align: center;
          }
          .error-icon {
            font-size: 48px;
            margin-bottom: 16px;
          }
          h2 {
            color: #e53e3e;
            margin: 0 0 16px 0;
          }
          p {
            color: #4a5568;
            margin: 8px 0;
            line-height: 1.6;
          }
          .error-details {
            background: #fef2f2;
            border: 1px solid #fecaca;
            border-radius: 8px;
            padding: 12px;
            margin: 20px 0;
            font-family: monospace;
            font-size: 14px;
            color: #991b1b;
            text-align: left;
            word-break: break-word;
          }
          button {
            background: #3182ce;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            transition: background 0.2s;
          }
          button:hover {
            background: #2c5282;
          }
        </style>
      </head>
      <body>
        <div class="error-container">
          <div class="error-icon">😵</div>
          <h2>Failed to Load Website</h2>
          <p>We couldn't load the requested website.</p>
          <div class="error-details">
            ${error.message}
          </div>
          <p style="font-size: 14px; color: #718096;">This might be due to:</p>
          <ul style="text-align: left; color: #4a5568; font-size: 14px;">
            <li>The website blocking automated access</li>
            <li>Network connectivity issues</li>
            <li>The website requiring authentication</li>
          </ul>
          <button onclick="window.parent.postMessage({ type: 'CLOSE_ERROR' }, '*')">
            Close
          </button>
        </div>
      </body>
      </html>
    `);
  }
});

// Login endpoint for handling form submissions
app.post('/api/login', async (req, res) => {
  try {
    const { url, email, password } = req.body;
    
    if (!url || !email || !password) {
      return res.status(400).json({ error: 'URL, email, and password are required' });
    }
    
    console.log('Processing login for:', url);
    
    // Use Puppeteer to handle the login
    const browser = await puppeteer.launch({ 
      headless: false, // Set to true in production
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1280, height: 800 });
    
    // Navigate to login page
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Wait for email field
    await page.waitForSelector('input[type="email"], input[name="email"], input[name="username"]', { timeout: 10000 });
    
    // Fill in the form
    await page.type('input[type="email"], input[name="email"], input[name="username"]', email);
    await page.type('input[type="password"]', password);
    
    // Click login button
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('button[type="submit"], input[type="submit"]')
    ]);
    
    // Get the final URL and page content
    const finalUrl = page.url();
    const title = await page.title();
    const screenshot = await page.screenshot({ encoding: 'base64' });
    
    await browser.close();
    
    res.json({ 
      success: true, 
      url: finalUrl,
      title: title,
      screenshot: screenshot,
      message: 'Login successful!'
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Backend is working!', 
    timestamp: new Date().toISOString() 
  });
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on http://localhost:${PORT}`);
  console.log(`📍 Test endpoint: http://localhost:${PORT}/api/test`);
  console.log(`📍 Proxy endpoint: http://localhost:${PORT}/api/proxy?url=YOUR_URL`);
});