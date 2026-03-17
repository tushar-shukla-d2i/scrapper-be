const { chromium } = require("playwright")

let browser;

async function launchBrowser(url) {
    browser = await chromium.launch({
        headless: false,
        args: [
            "--remote-debugging-port=9222"
        ]
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(url);
    console.log("Browser launched with CDP on port 9222");

    return true;
}

module.exports = {launchBrowser};
