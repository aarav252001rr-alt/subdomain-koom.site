// ── File Storage via Telegram's own CDN + metadata in DB ─────────────────────
// Strategy: Files stay on Telegram servers (free, no limit),
// we store file_id + metadata. For actual web hosting we use
// a free static host: surge.sh via their API or store on github gist.
// For MVP: we store the Telegram file_id and provide download link.

const axios = require('axios');
const { addFileRecord, getSubFiles, deleteSubFiles } = require('./database');
const { v4: uuidv4 } = require('uuid');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAX_MB = 5;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const ALLOWED_EXTS = ['.html', '.zip', '.htm'];

// Get file info from Telegram
async function getTgFile(fileId) {
  const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  if (!res.data.ok) throw new Error('Cannot get file info');
  return res.data.result; // { file_id, file_path, file_size }
}

// Download file buffer from Telegram
async function downloadTgFile(filePath) {
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// Upload HTML content to surge.sh (free static hosting)
async function deployToSurge(htmlContent, subdomain, domain) {
  // Surge.sh doesn't have official API but we can use their npm CLI.
  // For Telegram bot context, we'll store in a Pastebin-like service
  // and link to it, OR we host the file on the CF worker.
  // Best free option: telegra.ph for HTML preview OR github gist.
  // We'll use a simple approach: store file_id and give download link.
  return { hosted: false, reason: 'Use Cloudflare Pages or Netlify to deploy the file.' };
}

// Upload to file.io (temp) or return tg CDN link
async function storeTgFile(bot, fileMsg, subdomainId, subdomain, domain) {
  const doc = fileMsg.document;
  if (!doc) return { error: 'No document found.' };

  const fileName = doc.file_name || 'index.html';
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTS.includes(ext)) return { error: 'wrong_type' };

  const fileSize = doc.file_size || 0;
  if (fileSize > MAX_BYTES) return { error: 'too_big', mb: (fileSize / 1024 / 1024).toFixed(1) };

  // Get file path from Telegram
  const tgFile = await getTgFile(doc.file_id);

  // Download the actual content
  const buffer = await downloadTgFile(tgFile.file_path);

  // Try to deploy to Cloudflare Pages via API if configured
  // Otherwise just store file_id so user can download
  let deployUrl = null;
  if (ext === '.html' || ext === '.htm') {
    try {
      deployUrl = await deployToCloudflarePages(buffer, subdomain, domain, fileName);
    } catch (e) {
      console.log('CF Pages deploy failed:', e.message);
    }
  }

  // Store record
  const record = {
    id: uuidv4(),
    subdomainId,
    subdomain,
    fileName,
    fileId: doc.file_id,
    filePath: tgFile.file_path,
    fileSize,
    ext,
    deployUrl,
    uploadedAt: new Date().toISOString(),
  };

  // Remove old files for this subdomain (keep only latest)
  deleteSubFiles(subdomainId);
  addFileRecord(record);

  return { success: true, record, deployUrl };
}

// Cloudflare Pages deploy via API (if CF Pages configured)
async function deployToCloudflarePages(htmlBuffer, subdomain, domain, fileName) {
  const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
  const CF_TOKEN = process.env.CF_API_TOKEN;
  const CF_PAGES_PROJECT = process.env.CF_PAGES_PROJECT;

  if (!CF_ACCOUNT || !CF_PAGES_PROJECT) throw new Error('CF Pages not configured');

  const FormData = require('form-data');
  const form = new FormData();
  form.append('manifest', JSON.stringify({ '/index.html': fileName }));
  form.append(fileName, htmlBuffer, { filename: fileName, contentType: 'text/html' });

  const res = await axios.post(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects/${CF_PAGES_PROJECT}/deployments`,
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${CF_TOKEN}` } }
  );

  if (!res.data.success) throw new Error('CF Pages deploy failed');
  return res.data.result?.url;
}

// Get download URL for a stored file
function getFileDownloadUrl(record) {
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${record.filePath}`;
}

module.exports = { storeTgFile, getTgFile, getFileDownloadUrl, MAX_MB, ALLOWED_EXTS };
