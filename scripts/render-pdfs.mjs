import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pdf } from 'pdf-to-img';

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
    if (!byLanguage.has(lang)) {
      throw new Error(`Could not find a ${lang.toUpperCase()} newsletter PDF in ${referenceDir}`);
    }
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
    images.push({ lang, page, path: imagePath, fileName });
    page += 1;
  }
  return images;
}

async function main() {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const pdfs = await findNewsletterPdfs();
  const rendered = [];
  for (const newsletterPdf of pdfs) {
    rendered.push(...await renderPdf(newsletterPdf));
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    pdfs: pdfs.map((item) => ({ lang: item.lang, path: item.path, fileName: item.name })),
    images: rendered,
  };
  await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`Rendered ${rendered.length} page images to ${outputDir}`);
  for (const item of rendered) {
    console.log(`${item.lang.toUpperCase()} page ${item.page}: ${path.relative(process.cwd(), item.path)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
