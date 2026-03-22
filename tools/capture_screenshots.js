const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');

const baseUrl = 'http://localhost:3000';
const assetsDir = path.resolve('C:\\Users\\Administrator\\OneDrive\\CanvasClashShots');

async function drawSample(page) {
  await page.mouse.move(320, 360);
  await page.mouse.down();
  await page.mouse.move(620, 360);
  await page.mouse.up();

  await page.mouse.move(380, 460);
  await page.mouse.down();
  await page.mouse.move(520, 560);
  await page.mouse.up();
}

function waitForServer(url, retries = 40, delayMs = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const tryOnce = () => {
      attempts += 1;
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (attempts >= retries) {
          reject(new Error('Server not ready'));
          return;
        }
        setTimeout(tryOnce, delayMs);
      });
    };

    tryOnce();
  });
}

async function main() {
  fs.mkdirSync(assetsDir, { recursive: true });

  const serverProcess = spawn('node', ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'ignore'
  });

  try {
    await waitForServer(baseUrl);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });

  const host = await context.newPage();
  await host.goto(baseUrl, { waitUntil: 'networkidle' });
  await host.fill('#name-input', 'Host');
  await host.fill('#room-title-input', 'Sketch Lab');
  await host.fill('#room-tags-input', 'manga, neon, portraits');
  await host.fill('#room-password-input', 'clash');
  await host.click('#create-btn');
  await host.waitForSelector('#room-code');

  const roomCode = (await host.textContent('#room-code'))?.trim() || '';

  const lobby = await context.newPage();
  await lobby.goto(baseUrl, { waitUntil: 'networkidle' });
  await lobby.waitForTimeout(1200);
  await lobby.waitForSelector('.server-item', { timeout: 5000 });
  await lobby.screenshot({ path: path.join(assetsDir, 'lobby.png'), fullPage: true });

  const solo = await context.newPage();
  await solo.goto(baseUrl, { waitUntil: 'networkidle' });
  await solo.click('#solo-btn');
  await solo.waitForTimeout(300);
  await drawSample(solo);
  await solo.waitForTimeout(200);
  await solo.screenshot({ path: path.join(assetsDir, 'canvas.png'), fullPage: true });

  const join = await context.newPage();
  await join.goto(baseUrl, { waitUntil: 'networkidle' });
  await join.fill('#name-input', 'Nova');
  await join.fill('#room-input', roomCode);
  await join.fill('#room-password-input', 'clash');
  await join.click('#join-btn');
  await join.waitForSelector('#chat-text');

  await join.fill('#chat-text', 'Hey team!');
  await join.keyboard.press('Enter');

  await host.waitForSelector('#chat-text');
  await host.fill('#chat-text', 'Welcome to Canvas Clash!');
  await host.keyboard.press('Enter');

  await join.waitForTimeout(300);
  await drawSample(join);
  await host.waitForTimeout(600);

  await host.screenshot({ path: path.join(assetsDir, 'multiplayer.png'), fullPage: true });

  await host.screenshot({ path: path.join(assetsDir, 'demo_1.png'), fullPage: true });
  await drawSample(host);
  await host.waitForTimeout(200);
  await host.screenshot({ path: path.join(assetsDir, 'demo_2.png'), fullPage: true });

  await browser.close();
  } finally {
    serverProcess.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
