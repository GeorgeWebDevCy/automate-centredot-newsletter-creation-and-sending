import 'dotenv/config';
import { chromium } from 'playwright';

const requiredEnv = ['ADMIN_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'];

export function getConfig() {
  for (const key of requiredEnv) {
    if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
  }
  const adminUrl = process.env.ADMIN_URL;
  const siteUrl = new URL(adminUrl).origin;
  return {
    adminUrl,
    siteUrl,
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    headless: process.env.HEADLESS !== 'false',
  };
}

export async function openWordPressSession() {
  const config = getConfig();
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(config.adminUrl, { waitUntil: 'domcontentloaded' });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.waitForTimeout(3000);
    }
  }
  if (page.url().includes('wp-login.php')) {
    await page.fill('#user_login', config.username);
    await page.fill('#user_pass', config.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('#wp-submit'),
    ]);
  }

  if (page.url().includes('wp-login.php')) {
    throw new Error('WordPress login did not complete. Check the credentials in .env.');
  }

  const nonce = await page.evaluate(() => {
    const candidates = [
      globalThis.wpApiSettings?.nonce,
      globalThis.mrm_admin_data?.nonce,
      globalThis.MRM_Vars?.nonce,
      globalThis.MintMail?.nonce,
      globalThis.mailMintAdmin?.nonce,
    ];
    return candidates.find(Boolean) || '';
  });

  return { browser, context, page, config, nonce };
}

export async function getWpNonce(page) {
  return page.evaluate(() => {
    const candidates = [
      globalThis.wpApiSettings?.nonce,
      globalThis.mrm_admin_data?.nonce,
      globalThis.MRM_Vars?.nonce,
      globalThis.MintMail?.nonce,
      globalThis.mailMintAdmin?.nonce,
    ];
    return candidates.find(Boolean) || '';
  });
}

export async function wpFetch(page, endpoint, options = {}) {
  return page.evaluate(async ({ endpoint, options }) => {
    const response = await fetch(endpoint, {
      credentials: 'same-origin',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(globalThis.wpApiSettings?.nonce ? { 'X-WP-Nonce': globalThis.wpApiSettings.nonce } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  }, { endpoint, options });
}
