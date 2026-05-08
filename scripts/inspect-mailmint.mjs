import { openWordPressSession, wpFetch } from './wp-session.mjs';

async function main() {
  const { browser, page, config, nonce } = await openWordPressSession();
  try {
    await page.goto(`${config.adminUrl}admin.php?page=mrm-admin#/campaigns/regular`, {
      waitUntil: 'networkidle',
    });

    const result = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaigns/`);
    console.log(JSON.stringify({
      loggedInAsAdmin: !page.url().includes('wp-login.php'),
      nonceFound: Boolean(nonce || await page.evaluate(() => globalThis.wpApiSettings?.nonce)),
      campaignsStatus: result.status,
      campaignsPreview: Array.isArray(result.body?.data)
        ? result.body.data.slice(0, 5)
        : result.body,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
