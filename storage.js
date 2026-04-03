const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { addFileRecord, deleteSubFiles, getSubFiles } = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAX_MB    = 5;
const MAX_BYTES = MAX_MB * 1024 * 1024;

// Supported file types aur unke content types
const CONTENT_TYPES = {
  '.html': 'text/html;charset=UTF-8',
  '.htm':  'text/html;charset=UTF-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain',
  '.zip':  'application/zip',
};

// ── Telegram se file info lo ───────────────────────────────────────────────────
async function getTgFileInfo(fileId) {
  const res = await axios.get(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  if (!res.data.ok) throw new Error('Telegram file info error');
  return res.data.result; // { file_path, file_size }
}

// ── ZIP ke andar se files nikalo (in-memory) ───────────────────────────────────
async function extractZipFiles(buffer) {
  const JSZip = require('jszip');
  const zip   = await JSZip.loadAsync(buffer);
  const files  = {};

  const promises = [];
  zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) return;
    if (relativePath.includes('__MACOSX') || relativePath.includes('.DS_Store')) return;

    // Top-level folder strip karo agar hai
    let cleanPath = relativePath;
    const firstSlash = relativePath.indexOf('/');
    if (firstSlash > 0 && firstSlash < relativePath.length - 1) {
      cleanPath = relativePath.slice(firstSlash + 1);
    }
    if (!cleanPath) return;

    promises.push(
      zipEntry.async('nodebuffer').then(content => {
        files[cleanPath] = content;
      })
    );
  });

  await Promise.all(promises);

  // index.html ensure karo
  if (!files['index.html'] && !files['index.htm']) {
    const htmlFile = Object.keys(files).find(f => f.endsWith('.html') || f.endsWith('.htm'));
    if (htmlFile) {
      files['index.html'] = files[htmlFile];
      delete files[htmlFile];
    }
  }

  return files;
}

// ── Telegram pe file upload karo (bot ke saath) ───────────────────────────────
async function uploadBufferToTelegram(buffer, filename, botToken, storageChatId) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', storageChatId);
  form.append('document', buffer, { filename });

  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendDocument`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity }
  );

  if (!res.data.ok) throw new Error('Telegram upload failed: ' + res.data.description);
  return res.data.result.document; // { file_id, file_path, file_size, ... }
}

// ── Main: Bot se file receive karke process karo ──────────────────────────────
async function storeTgFile(bot, fileMsg, subdomainId, subdomain, domain) {
  const doc = fileMsg.document;
  if (!doc) return { error: 'No document' };

  const fileName = doc.file_name || 'index.html';
  const ext      = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  const isZip    = ext === '.zip';
  const allowed  = ['.html', '.htm', '.css', '.js', '.zip'];

  if (!allowed.includes(ext)) return { error: 'wrong_type' };
  if ((doc.file_size || 0) > MAX_BYTES) return { error: 'too_big', mb: ((doc.file_size||0)/1024/1024).toFixed(1) };

  // Telegram se file download karo
  const tgInfo = await getTgFileInfo(doc.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${tgInfo.file_path}`;
  const res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(res.data);

  // Purani files delete karo
  await deleteSubFiles(subdomainId);

  const STORAGE_CHAT = process.env.STORAGE_CHAT_ID || process.env.ADMIN_ID;
  const uploadedFiles = [];

  if (isZip) {
    // ZIP extract karo aur har file alag alag store karo
    const files = await extractZipFiles(buffer);
    const fileList = Object.entries(files);

    if (!fileList.length) return { error: 'zip_empty' };

    for (const [filePath, fileBuffer] of fileList) {
      const fileExt = filePath.includes('.') ? '.' + filePath.split('.').pop().toLowerCase() : '';
      const ct = CONTENT_TYPES[fileExt] || 'application/octet-stream';

      // Telegram pe store karo
      const tgDoc = await uploadBufferToTelegram(fileBuffer, filePath, BOT_TOKEN, STORAGE_CHAT);

      const record = {
        id: uuidv4(), subdomainId, subdomain,
        filePath: filePath,           // web path: "index.html", "css/style.css"
        tgFileId: tgDoc.file_id,      // Telegram file_id
        tgFilePath: null,             // getFile se milega on-demand
        contentType: ct,
        fileSize: fileBuffer.length,
        isIndex: filePath === 'index.html' || filePath === 'index.htm',
        uploadedAt: new Date().toISOString(),
      };
      await addFileRecord(record);
      uploadedFiles.push(filePath);
    }
  } else {
    // Single HTML/CSS/JS file
    const ct = CONTENT_TYPES[ext] || 'text/html;charset=UTF-8';

    // Telegram pe store karo
    const tgDoc = await uploadBufferToTelegram(buffer, 'index.html', BOT_TOKEN, STORAGE_CHAT);

    const record = {
      id: uuidv4(), subdomainId, subdomain,
      filePath: 'index.html',
      tgFileId: tgDoc.file_id,
      tgFilePath: null,
      contentType: ct,
      fileSize: buffer.length,
      isIndex: true,
      uploadedAt: new Date().toISOString(),
    };
    await addFileRecord(record);
    uploadedFiles.push('index.html');
  }

  return { success: true, files: uploadedFiles };
}

// ── Worker ke liye: file serve karo ──────────────────────────────────────────
// path = requested URL path, e.g. "/" or "/about.html" or "/css/style.css"
async function getFileForWorker(subdomain, requestPath) {
  const files = await getSubFiles(null, subdomain); // subdomain se dhundho
  if (!files || !files.length) return null;

  // Path normalize karo
  let filePath = requestPath.replace(/^\//, '') || 'index.html';
  if (filePath.endsWith('/')) filePath += 'index.html';
  if (!filePath.includes('.')) filePath += '/index.html';

  // File dhundho
  let fileRecord = files.find(f => f.filePath === filePath);

  // Nahi mila toh index.html do
  if (!fileRecord) {
    fileRecord = files.find(f => f.isIndex || f.filePath === 'index.html');
  }

  if (!fileRecord) return null;

  // Telegram file path refresh karo (file_id se)
  const tgInfo = await getTgFileInfo(fileRecord.tgFileId);

  return {
    filePath:    tgInfo.file_path,     // Telegram CDN path
    contentType: fileRecord.contentType,
    fileName:    fileRecord.filePath,
  };
}

module.exports = { storeTgFile, getFileForWorker, MAX_MB, CONTENT_TYPES };
