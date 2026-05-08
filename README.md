# automate-centredot-newsletter-creation-and-sending

Automation for preparing CentreDot monthly Mail Mint newsletters.

## Commands

- `npm run render:pdfs` converts the Greek and English PDFs in `reference-info/` into ordered page images under `generated/newsletter/`.
- `npm run inspect:mailmint` logs into WordPress and reads the Mail Mint campaign list without changing anything.
- `npm run automate` renders the PDFs, creates or reuses the current month draft campaign, uploads the PDFs/images to WordPress media, and replaces the newsletter image sequence in Mail Mint.

Local-only folders and secrets are ignored by git: `.env`, `reference-info/`, `generated/`, and `node_modules/`.
