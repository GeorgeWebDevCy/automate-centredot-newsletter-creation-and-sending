import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pdf } from 'pdf-to-img';
import { getWpNonce, openWordPressSession, wpFetch } from './wp-session.mjs';

const referenceDir = path.resolve('reference-info');
const outputDir = path.resolve('generated/newsletter');

function languageForFile(fileName) {
  const upper = fileName.toUpperCase();
  if (upper.includes('_GR') || upper.includes('GREEK') || upper.includes('ΕΛ')) return 'gr';
  if (upper.includes('_ENG') || upper.includes('ENGLISH')) return 'eng';
  return null;
}

async function findNewsletterPdfs() {
  const entries = await fs.readdir(referenceDir, { withFileTypes: true });
  const pdfs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
    .map((entry) => ({
      name: entry.name,
      path: path.join(referenceDir, entry.name),
      lang: languageForFile(entry.name),
    }))
    .filter((entry) => entry.lang);

  const byLanguage = new Map(pdfs.map((entry) => [entry.lang, entry]));
  for (const lang of ['gr', 'eng']) {
    if (!byLanguage.has(lang)) throw new Error(`Missing ${lang.toUpperCase()} newsletter PDF`);
  }
  return [byLanguage.get('gr'), byLanguage.get('eng')];
}

async function renderPdf({ path: pdfPath, lang }) {
  const doc = await pdf(pdfPath, { scale: 3 });
  const images = [];
  let page = 1;
  for await (const image of doc) {
    const fileName = `${lang}-${String(page).padStart(2, '0')}.png`;
    const imagePath = path.join(outputDir, fileName);
    await fs.writeFile(imagePath, image);
    images.push({ lang, page, path: imagePath, fileName, mimeType: 'image/png' });
    page += 1;
  }
  return images;
}

async function renderNewsletter() {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const pdfs = await findNewsletterPdfs();
  const images = [];
  for (const item of pdfs) images.push(...await renderPdf(item));
  return { pdfs, images };
}

function mimeTypeFor(filePath) {
  if (filePath.toLowerCase().endsWith('.pdf')) return 'application/pdf';
  if (filePath.toLowerCase().endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

async function cookieHeader(context, siteUrl) {
  const cookies = await context.cookies(siteUrl);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function uploadMedia({ context, page, config }, filePath, fileName = path.basename(filePath)) {
  const nonce = await getWpNonce(page);
  const buffer = await fs.readFile(filePath);
  const response = await fetch(`${config.siteUrl}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      Cookie: await cookieHeader(context, config.siteUrl),
      'X-WP-Nonce': nonce,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Type': mimeTypeFor(filePath),
    },
    body: buffer,
  });

  const body = await response.json().catch(async () => ({ message: await response.text() }));
  if (!response.ok) {
    throw new Error(`Media upload failed for ${fileName}: ${response.status} ${JSON.stringify(body)}`);
  }
  return {
    id: body.id,
    url: body.source_url,
    fileName,
    mediaType: body.media_type,
  };
}

function findImageContainer(content) {
  let best = null;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    const children = Array.isArray(node.children) ? node.children : [];
    const newsletterImages = children.filter((child) => {
      const attrs = child?.attributes || {};
      return child?.type === 'advanced_image' && /NEWSLETTER_CENTREDOT/i.test(`${attrs.src || ''} ${attrs.href || ''}`);
    });
    if (newsletterImages.length > (best?.count || 0)) best = { node, count: newsletterImages.length };
    children.forEach(walk);
  }
  walk(content);
  if (!best) throw new Error('Could not find the existing newsletter image block in the builder JSON.');
  return best.node;
}

function imageNode(src, href) {
  return {
    type: 'advanced_image',
    data: { value: {} },
    attributes: {
      align: 'center',
      height: 'auto',
      padding: '0px 0px 35px 0px',
      src,
      alt: 'Default Image',
      href,
    },
    children: [],
  };
}

function updateBuilderJson(jsonData, uploaded) {
  const nextJson = structuredClone(jsonData);
  const container = findImageContainer(nextJson.content);
  const imageChildren = [
    ...uploaded.images.filter((item) => item.lang === 'gr').map((item) => imageNode(item.url, uploaded.pdfs.gr.url)),
    ...uploaded.images.filter((item) => item.lang === 'eng').map((item) => imageNode(item.url, uploaded.pdfs.eng.url)),
  ];

  const firstNewsletterIndex = container.children.findIndex((child) => {
    const attrs = child?.attributes || {};
    return child?.type === 'advanced_image' && /NEWSLETTER_CENTREDOT/i.test(`${attrs.src || ''} ${attrs.href || ''}`);
  });
  const withoutNewsletterImages = container.children.filter((child) => {
    const attrs = child?.attributes || {};
    return !(child?.type === 'advanced_image' && /NEWSLETTER_CENTREDOT/i.test(`${attrs.src || ''} ${attrs.href || ''}`));
  });

  const insertAt = firstNewsletterIndex >= 0 ? firstNewsletterIndex : 0;
  withoutNewsletterImages.splice(insertAt, 0, ...imageChildren);
  container.children = withoutNewsletterImages;
  return nextJson;
}

function renderImageHtml({ src, href }) {
  return `                            <tr>
                              <td align="center" style="font-size:0px;padding:0px 0px 35px 0px;word-break:break-word;">
                                <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;border-spacing:0px;">
                                  <tbody>
                                    <tr>
                                      <td style="width:552px;">
                                        <a href="${href}" target="_blank">
                                          <img alt="Default Image" src="${src}" style="border:0;display:block;outline:none;text-decoration:none;height:auto;width:100%;font-size:13px;" width="552" height="auto" />
                                        </a>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </td>
                            </tr>`;
}

function updateEmailBody(html, uploaded) {
  const blocks = [
    ...uploaded.images.filter((item) => item.lang === 'gr').map((item) => renderImageHtml({ src: item.url, href: uploaded.pdfs.gr.url })),
    ...uploaded.images.filter((item) => item.lang === 'eng').map((item) => renderImageHtml({ src: item.url, href: uploaded.pdfs.eng.url })),
  ].join('\n');

  const newsletterBlock = /(?:\s*<tr>[\s\S]*?NEWSLETTER_CENTREDOT[\s\S]*?<\/tr>)/gi;
  const matches = [...html.matchAll(newsletterBlock)];
  if (!matches.length) throw new Error('Could not find newsletter image rows in email HTML.');

  const start = matches[0].index;
  const last = matches[matches.length - 1];
  const end = last.index + last[0].length;
  return `${html.slice(0, start)}\n${blocks}\n${html.slice(end)}`;
}

function titleForThisMonth() {
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Nicosia' });
  return `CentreDot Updates ${formatter.format(new Date())}`;
}

function createCampaignPayload(duplicateData) {
  const recipients = duplicateData?.meta?.recipients || duplicateData?.recipients || {};
  const emails = (duplicateData?.emails || []).map((email, index) => {
    const {
      id,
      campaign_id: campaignId,
      email_body: emailBody,
      email_json: emailJson,
      json_data: jsonData,
      scheduled_at: scheduledAt,
      send_time: sendTime,
      ...rest
    } = email;
    return {
      ...rest,
      email_index: String(index),
      status: 'draft',
      scheduled_at: null,
      delay: rest.delay || '0',
      delay_count: rest.delay_count || '0',
      delay_value: rest.delay_value || 'Minutes',
    };
  });

  return {
    title: process.env.CAMPAIGN_TITLE || titleForThisMonth(),
    status: 'draft',
    type: duplicateData?.type || 'regular',
    scheduled_at: '',
    recipients,
    emails,
  };
}

async function latestRegularCampaign(page, config) {
  if (process.env.SOURCE_CAMPAIGN_ID) return { id: String(process.env.SOURCE_CAMPAIGN_ID) };
  const response = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaigns/`);
  if (!response.ok) throw new Error(`Could not list campaigns: ${response.status}`);
  const campaigns = response.body?.campaigns || response.body?.data || [];
  const regular = campaigns.filter((campaign) => campaign.type === 'regular' && campaign.status !== 'draft');
  if (!regular.length) throw new Error('No regular campaigns found.');
  return regular[0];
}

async function existingDraftCampaign(page, config) {
  if (process.env.TARGET_CAMPAIGN_ID) return { id: String(process.env.TARGET_CAMPAIGN_ID) };
  const response = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaigns/`);
  if (!response.ok) throw new Error(`Could not list campaigns: ${response.status}`);
  const campaigns = response.body?.campaigns || response.body?.data || [];
  const title = process.env.CAMPAIGN_TITLE || titleForThisMonth();
  return campaigns.find((campaign) => (
    campaign.type === 'regular' &&
    campaign.status === 'draft' &&
    campaign.title === title
  ));
}

function extractDuplicatedCampaignId(body) {
  const candidates = [
    body?.campaign_id,
    body?.data?.campaign_id,
    body?.data?.id,
    body?.data?.campaign?.id,
    body?.id,
  ].filter(Boolean);
  if (!candidates.length) throw new Error(`Could not read duplicated campaign ID from response: ${JSON.stringify(body)}`);
  return String(candidates[0]);
}

async function duplicateCampaign(page, config, sourceCampaignId) {
  const duplicateSeed = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaigns/duplicate/${sourceCampaignId}`);
  if (!duplicateSeed.ok) {
    throw new Error(`Could not read duplicate seed: ${duplicateSeed.status} ${JSON.stringify(duplicateSeed.body)}`);
  }
  const duplicateData = duplicateSeed.body?.data;
  if (!duplicateData) throw new Error(`Duplicate seed had no data: ${JSON.stringify(duplicateSeed.body)}`);

  const create = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaigns/`, {
    method: 'POST',
    body: JSON.stringify(createCampaignPayload(duplicateData)),
  });
  if (!create.ok) throw new Error(`Campaign create failed: ${create.status} ${JSON.stringify(create.body)}`);

  const campaignId = extractDuplicatedCampaignId(create.body);
  if (String(campaignId) === String(sourceCampaignId)) {
    throw new Error(`Refusing to continue because duplicate returned the source campaign ID ${sourceCampaignId}.`);
  }
  return campaignId;
}

async function main() {
  console.log('Rendering PDFs...');
  const rendered = await renderNewsletter();
  console.log(`Rendered ${rendered.images.length} images.`);

  const session = await openWordPressSession();
  const { browser, page, config, context } = session;
  try {
    await page.goto(`${config.adminUrl}admin.php?page=mrm-admin#/campaigns/regular`, { waitUntil: 'networkidle' });

    const sourceCampaign = await latestRegularCampaign(page, config);
    const sourceDetails = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaigns/${sourceCampaign.id}`);
    const sourceEmailId = sourceDetails.body?.data?.emails?.[0]?.id;
    if (!sourceEmailId) throw new Error(`Could not find email ID for source campaign ${sourceCampaign.id}`);

    const existingDraft = await existingDraftCampaign(page, config);
    let campaignId = existingDraft?.id;
    if (campaignId) {
      console.log(`Reusing existing draft campaign ${campaignId}...`);
    } else {
      console.log(`Duplicating campaign ${sourceCampaign.id}...`);
      campaignId = await duplicateCampaign(page, config, sourceCampaign.id);
    }

    const duplicated = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaigns/${campaignId}`);
    const emailId = duplicated.body?.data?.emails?.[0]?.id;
    if (!emailId) throw new Error(`Could not find email ID for duplicated campaign ${campaignId}`);
    console.log(`Created duplicated campaign ${campaignId}, email ${emailId}.`);

    console.log('Uploading PDFs...');
    const uploadedPdfs = {};
    for (const item of rendered.pdfs) {
      uploadedPdfs[item.lang] = await uploadMedia(session, item.path, item.name);
      console.log(`${item.lang.toUpperCase()} PDF: ${uploadedPdfs[item.lang].url}`);
    }

    console.log('Uploading page images...');
    const uploadedImages = [];
    for (const item of rendered.images) {
      const originalPdf = rendered.pdfs.find((pdfItem) => pdfItem.lang === item.lang);
      const uploadName = originalPdf.name.replace(/\.pdf$/i, `-${String(item.page).padStart(2, '0')}.png`);
      const uploaded = await uploadMedia(session, item.path, uploadName);
      uploadedImages.push({ ...item, ...uploaded });
      console.log(`${item.lang.toUpperCase()} page ${item.page}: ${uploaded.url}`);
    }

    const uploaded = { pdfs: uploadedPdfs, images: uploadedImages };
    let builder = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaign/${campaignId}/email-builder/${emailId}`);
    if (!builder.ok) throw new Error(`Could not read duplicated builder data: ${builder.status}`);
    if (!builder.body?.email_data) {
      builder = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaign/${sourceCampaign.id}/email-builder/${sourceEmailId}`);
      if (!builder.ok || !builder.body?.email_data) {
        throw new Error(`Could not read source builder data: ${builder.status} ${JSON.stringify(builder.body)}`);
      }
    }
    const emailData = builder.body.email_data;
    const jsonData = updateBuilderJson(emailData.json_data, uploaded);
    const emailBody = updateEmailBody(emailData.email_body, uploaded);

    console.log('Saving duplicated newsletter content...');
    const save = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaign/${campaignId}/email/0/${emailId}`, {
      method: 'PUT',
      body: JSON.stringify({
        campaign_id: campaignId,
        email_id: emailId,
        email_index: 0,
        editor_type: emailData.editor_type || 'advanced-builder',
        email_body: emailBody,
        json_data: jsonData,
      }),
    });
    if (!save.ok || save.body?.success === false) {
      throw new Error(`Builder save failed: ${save.status} ${JSON.stringify(save.body)}`);
    }

    const campaign = duplicated.body.data;
    campaign.title = process.env.CAMPAIGN_TITLE || titleForThisMonth();
    campaign.status = 'draft';
    campaign.campaign_id = campaignId;
    campaign.emails = campaign.emails.map((email) => ({
      ...email,
      id: emailId,
      status: 'draft',
      scheduled_at: null,
      email_subject: process.env.EMAIL_SUBJECT || campaign.title,
    }));
    const updateCampaign = await wpFetch(page, `${config.siteUrl}/wp-json/mrm/v1/campaigns/${campaignId}`, {
      method: 'PUT',
      body: JSON.stringify(campaign),
    });
    if (!updateCampaign.ok) {
      console.warn(`Campaign metadata update skipped: ${updateCampaign.status} ${JSON.stringify(updateCampaign.body)}`);
    }

    const manifest = {
      createdAt: new Date().toISOString(),
      sourceCampaignId: sourceCampaign.id,
      campaignId,
      emailId,
      campaignTitle: campaign.title,
      pdfs: uploadedPdfs,
      images: uploadedImages.map(({ lang, page, url, id, fileName }) => ({ lang, page, url, id, fileName })),
    };
    await fs.writeFile(path.join(outputDir, 'upload-manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`Done. Campaign ${campaignId} is ready as draft: ${config.adminUrl}admin.php?page=mrm-admin#/campaigns/regular/${campaignId}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
