require('dotenv').config();
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');

// ── HTTP Server — Render Web Service ke liye REQUIRED ─────────────────────────
// Render Web Service ko ek open port chahiye hota hai, warna crash karta hai.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot: 'SubDomain Bot v3',
    domain: process.env.DOMAIN || 'yourdomain.com',
    uptime: Math.floor(process.uptime()) + 's',
    time: new Date().toISOString(),
  }));
}).listen(PORT, () => console.log(`✅ HTTP server running on port ${PORT}`));
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const cf = require('./cloudflare');
const db = require('./database');
const { validateSubdomain, validateDnsValue, stripUrl, statusEmoji, formatSubdomainCard, DNS_PRESETS } = require('./helpers');
const { t, detectLang, LANGS } = require('./i18n');
const { storeTgFile, getFileDownloadUrl, MAX_MB } = require('./storage');

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID);
const DOMAIN   = process.env.DOMAIN || 'yourdomain.com';

if (!TOKEN)    { console.error('❌ BOT_TOKEN missing'); process.exit(1); }
if (!ADMIN_ID) { console.error('❌ ADMIN_ID missing');  process.exit(1); }

// ── FIX: Use polling=true, this is a background worker on Render ──────────────
const bot = new TelegramBot(TOKEN, { polling: true });
console.log(`✅ SubDomain Bot v3 started | Domain: ${DOMAIN}`);

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = {};
const getSession  = (id) => sessions[String(id)] || {};
const setSession  = (id, d) => { sessions[String(id)] = d; };
const clearSession = (id) => { delete sessions[String(id)]; };

// ── Utils ─────────────────────────────────────────────────────────────────────
const isAdmin  = (id) => String(id) === ADMIN_ID;
const isBanned = (id) => db.getUser(id)?.banned === true;

function ensureUser(msg) {
  db.upsertUser(msg.from.id, {
    username:  msg.from.username  || '',
    firstName: msg.from.first_name || '',
    lastName:  msg.from.last_name  || '',
    tgLang:    msg.from.language_code || 'en',
  });
}

async function reply(chatId, text, extra = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
  } catch (e) {
    console.error('Send error:', e.message);
  }
}

async function sendAdmin(text, extra = {}) {
  return reply(ADMIN_ID, text, extra);
}

function lang(userId) {
  const l = db.getUserLang(userId);
  if (l === 'auto') {
    const u = db.getUser(userId);
    return detectLang(u?.tgLang);
  }
  return l;
}

// ── Main Keyboard ─────────────────────────────────────────────────────────────
function mainMenu(userId) {
  const hi = lang(userId) === 'hi';
  const buttons = [
    [{ text: hi ? '🌐 Subdomain Maango' : '🌐 Request Subdomain', callback_data: 'req_start' },
     { text: hi ? '📋 Mere Subdomains' : '📋 My Subdomains',     callback_data: 'my_subs'   }],
    [{ text: hi ? '📖 DNS Guide'        : '📖 DNS Guide',         callback_data: 'dns_guide' },
     { text: hi ? '🔍 DNS Check'        : '🔍 Check DNS',         callback_data: 'check_dns' }],
    [{ text: hi ? '🌐 Language'         : '🌐 Language',          callback_data: 'lang_menu' },
     { text: hi ? '👤 Profile'          : '👤 Profile',           callback_data: 'profile'   }],
    [{ text: hi ? '❓ Help'             : '❓ Help',              callback_data: 'help'      }],
  ];
  if (isAdmin(userId)) {
    buttons.push([
      { text: '⚙️ Admin Panel', callback_data: 'admin_panel' },
      { text: '📢 Broadcast',   callback_data: 'broadcast_start' },
    ]);
  }
  return { reply_markup: { inline_keyboard: buttons } };
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMANDS
// ══════════════════════════════════════════════════════════════════════════════

bot.onText(/\/start/, async (msg) => {
  ensureUser(msg);
  if (isBanned(msg.from.id) && !isAdmin(msg.from.id)) return reply(msg.chat.id, t(msg.from.id, 'banned'));
  if (db.getSetting('maintenanceMode') && !isAdmin(msg.from.id)) return reply(msg.chat.id, t(msg.from.id, 'maintenance'));
  await reply(msg.chat.id, t(msg.from.id, 'welcome', msg.from.first_name, DOMAIN, db.getSetting('welcomeMsg')), mainMenu(msg.from.id));
});

bot.onText(/\/help/,         (msg) => { ensureUser(msg); showHelp(msg.chat.id, msg.from.id); });
bot.onText(/\/request/,      (msg) => { ensureUser(msg); if (!isBanned(msg.from.id)) startRequest(msg.chat.id, msg.from.id); });
bot.onText(/\/mysubdomains/, (msg) => { ensureUser(msg); showMySubdomains(msg.chat.id, msg.from.id); });
bot.onText(/\/language/,     (msg) => { ensureUser(msg); showLangMenu(msg.chat.id, msg.from.id); });
bot.onText(/\/cancel/,       (msg) => { clearSession(msg.from.id); reply(msg.chat.id, lang(msg.from.id) === 'hi' ? '✅ Action cancel ho gayi.' : '✅ Action cancelled.', mainMenu(msg.from.id)); });
bot.onText(/\/stats/,        (msg) => { if (isAdmin(msg.from.id)) showAdminStats(msg.chat.id); });
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  doBroadcast(msg.chat.id, match[1]);
});

// ══════════════════════════════════════════════════════════════════════════════
// CALLBACK QUERIES
// ══════════════════════════════════════════════════════════════════════════════

bot.on('callback_query', async (query) => {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const userId = from.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  ensureUser({ from, chat: message.chat });
  if (isBanned(userId) && !isAdmin(userId)) return reply(chatId, t(userId, 'banned'));

  // Navigation
  if (data === 'main_menu')  return reply(chatId, '🏠', mainMenu(userId));
  if (data === 'help')       return showHelp(chatId, userId);
  if (data === 'profile')    return showProfile(chatId, userId);
  if (data === 'my_subs')    return showMySubdomains(chatId, userId);
  if (data === 'dns_guide')  return showDnsGuide(chatId, userId);
  if (data === 'check_dns')  return startDnsCheck(chatId, userId);
  if (data === 'lang_menu')  return showLangMenu(chatId, userId);
  if (data.startsWith('set_lang_')) return setLang(chatId, userId, data.replace('set_lang_', ''));

  // Request flow
  if (data === 'req_start')  return startRequest(chatId, userId);
  if (data === 'req_confirm') return confirmRequest(chatId, userId);
  if (data === 'req_cancel')  { clearSession(userId); return reply(chatId, '❌', mainMenu(userId)); }
  if (data.startsWith('dns_preset_'))        return handleDnsPreset(chatId, userId, data.replace('dns_preset_', ''));

  // My subdomains
  if (data.startsWith('sub_detail_'))        return showSubDetail(chatId, userId, data.replace('sub_detail_', ''));
  if (data.startsWith('sub_dns_'))           return startDnsUpdate(chatId, userId, data.replace('sub_dns_', ''));
  if (data.startsWith('sub_upload_'))        return startFileUpload(chatId, userId, data.replace('sub_upload_', ''));
  if (data.startsWith('sub_delete_confirm_')) return doDeleteSub(chatId, userId, data.replace('sub_delete_confirm_', ''));
  if (data.startsWith('sub_delete_'))        return confirmDeleteSub(chatId, userId, data.replace('sub_delete_', ''));
  if (data.startsWith('dns_upd_preset_'))    return applyDnsUpdatePreset(chatId, userId, data.replace('dns_upd_preset_', ''));

  // Admin
  if (data === 'admin_panel')       return showAdminPanel(chatId);
  if (data === 'admin_pending')     return showPendingRequests(chatId);
  if (data === 'admin_active')      return showAdminSubdomains(chatId, 'active');
  if (data === 'admin_all')         return showAdminSubdomains(chatId, 'all');
  if (data === 'admin_users')       return showAdminUsers(chatId);
  if (data === 'admin_settings')    return showAdminSettings(chatId);
  if (data === 'admin_stats')       return showAdminStats(chatId);
  if (data === 'toggle_approval')   return toggleApproval(chatId);
  if (data === 'toggle_maintenance') return toggleMaintenance(chatId);
  if (data === 'toggle_broadcast_prefix') return toggleBroadcastPrefix(chatId, userId);
  if (data === 'set_welcome')       return startSetWelcome(chatId, userId);
  if (data === 'set_maxsubs')       return startSetMaxSubs(chatId, userId);
  if (data === 'broadcast_start')   return startBroadcast(chatId, userId);
  if (data.startsWith('approve_'))  return adminApprove(chatId, data.replace('approve_', ''));
  if (data.startsWith('reject_'))   return adminReject(chatId, userId, data.replace('reject_', ''));
  if (data.startsWith('suspend_'))  return adminSuspend(chatId, data.replace('suspend_', ''));
  if (data.startsWith('unsuspend_')) return adminUnsuspend(chatId, data.replace('unsuspend_', ''));
  if (data.startsWith('admin_del_')) return adminDeleteSub(chatId, data.replace('admin_del_', ''));
  if (data.startsWith('ban_'))      return adminBanUser(chatId, data.replace('ban_', ''));
  if (data.startsWith('unban_'))    return adminUnbanUser(chatId, data.replace('unban_', ''));
});

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER — state machine + file uploads
// ══════════════════════════════════════════════════════════════════════════════

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = getSession(userId);

  // ── File Upload ────────────────────────────────────────────────────────────
  if (msg.document && session.step === 'file_upload') {
    const { subId } = session.data;
    const sub = db.getSubdomainById(subId);
    if (!sub || sub.userId !== String(userId)) return;
    clearSession(userId);

    await reply(chatId, lang(userId) === 'hi' ? '⏳ File upload ho rahi hai...' : '⏳ Uploading file...');

    const result = await storeTgFile(bot, msg, subId, sub.subdomain, DOMAIN);
    if (result.error === 'wrong_type') return reply(chatId, t(userId, 'file_wrong_type'));
    if (result.error === 'too_big')    return reply(chatId, t(userId, 'file_toobig', result.mb));
    if (result.error)                  return reply(chatId, `❌ Error: ${result.error}`);

    const { record } = result;
    const dlUrl = getFileDownloadUrl(record);

    await reply(chatId,
      t(userId, 'file_uploaded', record.fileName, sub.fullDomain) +
      `\n\n📥 [Download File](${dlUrl})\n\n` +
      (lang(userId) === 'hi'
        ? `_Note: File Telegram pe store hai. Isko Netlify/Vercel pe manually upload karo website ke liye._`
        : `_Note: File stored on Telegram. Upload it to Netlify/Vercel/GitHub Pages to deploy your website._`),
      { ...mainMenu(userId), disable_web_page_preview: true }
    );

    // Notify admin of upload
    sendAdmin(`📁 *File Uploaded*\n\n👤 ${sub.userName} | \`${sub.fullDomain}\`\n📄 ${record.fileName} (${(record.fileSize/1024/1024).toFixed(2)}MB)`);
    return;
  }

  if (!msg.text || msg.text.startsWith('/')) return;
  const text = msg.text.trim();
  if (!session.step) return;

  // ── Request flow ───────────────────────────────────────────────────────────
  if (session.step === 'req_name') {
    const name = text.toLowerCase().trim();
    const err = validateSubdomain(name);
    if (err) return reply(chatId, `❌ ${lang(userId) === 'hi' ? 'Galat naam' : 'Invalid name'}: ${err.replace('INVALID: ','')}`);
    if (db.getSubdomain(name)) return reply(chatId, `❌ \`${name}.${DOMAIN}\` ${lang(userId) === 'hi' ? 'already le li gayi.' : 'already taken.'}`);
    setSession(userId, { ...session, step: 'req_purpose', data: { ...session.data, subdomain: name } });
    return reply(chatId, t(userId, 'ask_purpose', name, DOMAIN));
  }

  if (session.step === 'req_purpose') {
    if (text.length < 5) return reply(chatId, lang(userId) === 'hi' ? '❌ Thoda detail mein batao (5+ characters).' : '❌ Please describe more (5+ chars).');
    setSession(userId, { ...session, step: 'req_dns_type', data: { ...session.data, purpose: text } });
    return reply(chatId, t(userId, 'ask_hosting'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '▲ Vercel',        callback_data: 'dns_preset_vercel'  }, { text: '◈ Netlify',      callback_data: 'dns_preset_netlify' }],
        [{ text: '● GitHub Pages',  callback_data: 'dns_preset_github'  }, { text: '◉ Custom VPS',   callback_data: 'dns_preset_vps'     }],
        [{ text: '⬡ NS Delegation', callback_data: 'dns_preset_ns'      }],
        [{ text: '✏️ Manual',        callback_data: 'dns_preset_manual'  }],
      ]},
    });
  }

  if (session.step === 'req_dns_type_manual') {
    const type = text.toUpperCase();
    if (!['CNAME','A','NS','TXT'].includes(type)) return reply(chatId, '❌ Type must be: CNAME, A, NS, or TXT');
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: type } });
    return reply(chatId, `📌 Enter ${type} value:\n\n${type === 'A' ? 'Example: `1.2.3.4`' : 'Example: `target.example.com`'}`);
  }

  if (session.step === 'req_dns_value') {
    let val = text;
    // Auto-fix: strip https:// if user pastes full URL
    if (val.startsWith('http')) val = stripUrl(val);

    const err = validateDnsValue(session.data.dnsType, val);
    if (err === 'INVALID_A')         return reply(chatId, `❌ Enter a valid IP address.\nExample: \`1.2.3.4\``);
    if (err === 'INVALID_CNAME')     return reply(chatId, `❌ Enter a valid domain.\nExample: \`yoursite.netlify.app\``);
    if (err === 'INVALID_CNAME_URL') val = stripUrl(val); // strip and retry
    if (err === 'INVALID_NS')        return reply(chatId, `❌ Enter a valid nameserver domain.`);

    setSession(userId, { ...session, step: 'req_confirm_wait', data: { ...session.data, dnsValue: val } });
    return showRequestConfirm(chatId, userId);
  }

  // ── DNS update value ───────────────────────────────────────────────────────
  if (session.step === 'dns_update_value') {
    const { subId, dnsType } = session.data;
    let val = text;
    if (val.startsWith('http')) val = stripUrl(val);

    const err = validateDnsValue(dnsType, val);
    if (err && err !== 'INVALID_CNAME_URL') return reply(chatId, `❌ Invalid value. Try again.`);

    clearSession(userId);
    const sub = db.getSubdomainById(subId);
    if (!sub || sub.userId !== String(userId)) return reply(chatId, '❌ Not found.');

    try {
      const record = await cf.updateRecord(sub.cfRecordId, sub.subdomain, dnsType, val);
      db.updateSubdomain(subId, { dnsType, dnsValue: val, cfRecordId: record.id });
      reply(chatId, t(userId, 'dns_updated', sub.fullDomain, dnsType, val), mainMenu(userId));
    } catch (e) {
      reply(chatId, `❌ DNS update failed: ${e.message}`, mainMenu(userId));
    }
    return;
  }

  // ── DNS Check ──────────────────────────────────────────────────────────────
  if (session.step === 'dns_check') {
    clearSession(userId);
    const name = text.toLowerCase().trim();
    try {
      const records = await cf.listRecords(name);
      if (!records.length) return reply(chatId, `🔍 \`${name}.${DOMAIN}\`\n\n❌ No DNS records on Cloudflare.\n_Wait 5–30 min for propagation._`);
      const list = records.map(r => `• \`${r.type}\` → \`${r.content}\``).join('\n');
      reply(chatId, `🔍 *DNS Records — ${name}.${DOMAIN}*\n\n${list}\n\n✅ Active on Cloudflare!`);
    } catch (e) {
      reply(chatId, `❌ DNS check failed: ${e.message}`);
    }
    return;
  }

  // ── Admin flows ────────────────────────────────────────────────────────────
  if (session.step === 'admin_reject_reason' && isAdmin(userId)) {
    const { subId } = session.data;
    clearSession(userId);
    const sub = db.getSubdomainById(subId);
    if (!sub) return reply(chatId, '❌ Not found.');
    db.updateSubdomain(subId, { status: 'rejected', rejectReason: text });
    reply(chatId, `❌ \`${sub.fullDomain}\` rejected.\nReason: _${text}_`);
    try { bot.sendMessage(sub.userId, t(sub.userId, 'req_rejected', sub, text), { parse_mode: 'Markdown' }); } catch {}
    return;
  }

  if (session.step === 'broadcast_msg' && isAdmin(userId)) {
    clearSession(userId);
    doBroadcast(chatId, text);
    return;
  }

  if (session.step === 'set_welcome' && isAdmin(userId)) {
    clearSession(userId);
    db.setSetting('welcomeMsg', text);
    reply(chatId, `✅ Welcome message updated!\n\n_"${text}"_`);
    return;
  }

  if (session.step === 'set_maxsubs' && isAdmin(userId)) {
    clearSession(userId);
    const n = parseInt(text);
    if (isNaN(n) || n < 1 || n > 50) return reply(chatId, '❌ Enter number 1–50.');
    db.setSetting('maxPerUser', n);
    reply(chatId, `✅ Max subdomains per user set to *${n}*`);
    return;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

function showHelp(chatId, userId) {
  reply(chatId, t(userId, 'help', DOMAIN, isAdmin(userId)), mainMenu(userId));
}

function showProfile(chatId, userId) {
  const user = db.getUser(userId);
  const subs = db.getUserSubdomains(userId);
  const maxPerUser = db.getSetting('maxPerUser');
  const hi = lang(userId) === 'hi';
  reply(chatId,
    `👤 *${hi ? 'Meri Profile' : 'My Profile'}*\n\n` +
    `🆔 ID: \`${userId}\`\n` +
    `👤 ${user?.firstName || ''} ${user?.lastName || ''}\n` +
    `📛 @${user?.username || 'N/A'}\n` +
    `🌐 ${hi ? 'Language' : 'Language'}: ${LANGS[lang(userId)] || 'Auto'}\n\n` +
    `🌐 *Subdomains:* ${subs.filter(s => s.status !== 'rejected').length}/${maxPerUser}\n` +
    `🟢 Active: ${subs.filter(s => s.status === 'active').length}\n` +
    `🟡 Pending: ${subs.filter(s => s.status === 'pending').length}\n\n` +
    `${user?.banned ? '🚫 *BANNED*' : '✅ Active'}`,
    mainMenu(userId)
  );
}

// ── Language ──────────────────────────────────────────────────────────────────
function showLangMenu(chatId, userId) {
  reply(chatId,
    '🌐 *Select Language / भाषा चुनें*',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '🇬🇧 English', callback_data: 'set_lang_en' }, { text: '🇮🇳 Hindi / हिंदी', callback_data: 'set_lang_hi' }],
      [{ text: '🤖 Auto Detect', callback_data: 'set_lang_auto' }],
    ]}}
  );
}

function setLang(chatId, userId, l) {
  db.upsertUser(userId, { lang: l });
  reply(chatId, t(userId, 'lang_set', l === 'auto' ? 'Auto' : LANGS[l]), mainMenu(userId));
}

// ── Request Flow ──────────────────────────────────────────────────────────────
function startRequest(chatId, userId) {
  const max = db.getSetting('maxPerUser');
  const userSubs = db.getUserSubdomains(userId).filter(s => ['active','pending'].includes(s.status));
  if (userSubs.length >= max) return reply(chatId, t(userId, 'max_limit', max), mainMenu(userId));

  clearSession(userId);
  setSession(userId, { step: 'req_name', data: {} });
  reply(chatId, t(userId, 'start_req', DOMAIN));
}

function handleDnsPreset(chatId, userId, preset) {
  const session = getSession(userId);

  if (preset === 'manual') {
    setSession(userId, { ...session, step: 'req_dns_type_manual' });
    return reply(chatId, '✏️ Enter DNS type:\n\n`CNAME` | `A` | `NS` | `TXT`');
  }

  if (preset === 'vercel') {
    setSession(userId, { ...session, step: 'req_confirm_wait', data: { ...session.data, dnsType: 'CNAME', dnsValue: 'cname.vercel-dns.com', hosting: 'Vercel' } });
    return showRequestConfirm(chatId, userId);
  }

  // Netlify — need their .netlify.app URL
  if (preset === 'netlify') {
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: 'CNAME', hosting: 'Netlify' } });
    return reply(chatId,
      `◈ *Netlify Setup*\n\n` +
      `Netlify Dashboard → apni site → Site Settings → Domain Management → "yoursite.netlify.app" copy karo\n\n` +
      `📌 Woh \`.netlify.app\` URL paste karo:\n_(Example: \`amazing-site-123.netlify.app\`)_\n\n` +
      `⚠️ Sirf domain daalo, \`https://\` nahi.`
    );
  }

  if (preset === 'github') {
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: 'CNAME', hosting: 'GitHub Pages' } });
    return reply(chatId,
      `● *GitHub Pages Setup*\n\n` +
      `Apna GitHub Pages URL daalo:\n_(Example: \`username.github.io\`)_\n\n` +
      `⚠️ Sirf domain daalo, \`https://\` nahi.`
    );
  }

  if (preset === 'vps') {
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: 'A', hosting: 'Custom VPS' } });
    return reply(chatId, `◉ *Custom VPS/Server*\n\nApna server ka public IP daalo:\n_(Example: \`1.2.3.4\`)_`);
  }

  if (preset === 'ns') {
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: 'NS', hosting: 'NS Delegation' } });
    return reply(chatId, `⬡ *NS Delegation*\n\nApna primary nameserver daalo:\n_(Example: \`ns1.yourprovider.com\`)_`);
  }
}

function showRequestConfirm(chatId, userId) {
  const { data } = getSession(userId);
  const approval = db.getSetting('requireApproval');
  reply(chatId,
    t(userId, 'req_confirm', { subdomain: data.subdomain, domain: DOMAIN, purpose: data.purpose, dnsType: data.dnsType, dnsValue: data.dnsValue, hosting: data.hosting || 'custom' }) +
    `\n\n${approval ? '⏳ Admin approval required.' : '✅ Will be auto-approved!'}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
      { text: '✅ Confirm', callback_data: 'req_confirm' },
      { text: '❌ Cancel', callback_data: 'req_cancel'  },
    ]]}}
  );
}

async function confirmRequest(chatId, userId) {
  const session = getSession(userId);
  if (!session.data?.subdomain) return reply(chatId, '❌ Session expired. /request again.');
  const { data } = session;
  clearSession(userId);

  const max = db.getSetting('maxPerUser');
  const approval = db.getSetting('requireApproval');
  if (db.getSubdomain(data.subdomain)) return reply(chatId, `❌ \`${data.subdomain}.${DOMAIN}\` already taken.`);
  if (db.getUserSubdomains(userId).filter(s => ['active','pending'].includes(s.status)).length >= max) return reply(chatId, t(userId, 'max_limit', max));

  const subId = uuidv4();
  let cfRecordId = null;
  let status = approval ? 'pending' : 'active';

  if (!approval && data.dnsType && data.dnsValue) {
    try {
      const rec = await cf.addRecord(data.subdomain, data.dnsType, data.dnsValue);
      cfRecordId = rec.id;
    } catch (e) { console.error('CF error:', e.message); }
  }

  const user = db.getUser(userId);
  db.addSubdomain({
    id: subId, userId: String(userId),
    userName: user?.firstName || '', userUsername: user?.username || '',
    subdomain: data.subdomain, fullDomain: `${data.subdomain}.${DOMAIN}`,
    purpose: data.purpose, dnsType: data.dnsType, dnsValue: data.dnsValue,
    hosting: data.hosting || 'custom', status, cfRecordId,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  if (!approval) {
    reply(chatId, t(userId, 'req_approved', { fullDomain: `${data.subdomain}.${DOMAIN}` }), mainMenu(userId));
  } else {
    reply(chatId, t(userId, 'req_submitted', `${data.subdomain}.${DOMAIN}`), mainMenu(userId));
    sendAdmin(
      `🔔 *New Subdomain Request*\n\n` +
      `👤 ${user?.firstName} (@${user?.username || 'N/A'}) | \`${userId}\`\n` +
      `🌐 \`${data.subdomain}.${DOMAIN}\`\n` +
      `📝 ${data.purpose}\n` +
      `🔧 ${data.dnsType} → ${data.dnsValue}\n` +
      `🏠 ${data.hosting}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve_${subId}` },
        { text: '❌ Reject',  callback_data: `reject_${subId}`  },
      ]]}}
    );
  }
}

// ── My Subdomains ─────────────────────────────────────────────────────────────
function showMySubdomains(chatId, userId) {
  const subs = db.getUserSubdomains(userId);
  if (!subs.length) return reply(chatId, t(userId, 'no_subs'), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🌐 Request', callback_data: 'req_start' }]] }});

  const hi = lang(userId) === 'hi';
  const buttons = subs.map(s => ([{ text: `${statusEmoji(s.status)} ${s.subdomain}.${DOMAIN}`, callback_data: `sub_detail_${s.id}` }]));
  buttons.push([{ text: '🏠 Menu', callback_data: 'main_menu' }]);
  reply(chatId, `🌐 *${hi ? 'Mere Subdomains' : 'My Subdomains'}* (${subs.length})`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

function showSubDetail(chatId, userId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return reply(chatId, '❌ Not found.');
  const hi = lang(userId) === 'hi';
  const buttons = [];
  if (sub.status === 'active') {
    buttons.push([
      { text: '⚙️ Update DNS', callback_data: `sub_dns_${subId}` },
      { text: '📁 Upload File', callback_data: `sub_upload_${subId}` },
    ]);
    buttons.push([{ text: '🔗 Open Site', url: `https://${sub.fullDomain}` }]);
  }
  buttons.push([
    { text: '🗑️ Delete', callback_data: `sub_delete_${subId}` },
    { text: '◀ Back', callback_data: 'my_subs' },
  ]);
  reply(chatId, formatSubdomainCard(sub, lang(userId)), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

// ── File Upload ───────────────────────────────────────────────────────────────
function startFileUpload(chatId, userId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return reply(chatId, '❌ Not found.');
  if (sub.status !== 'active') return reply(chatId, '❌ Subdomain must be active to upload files.');
  setSession(userId, { step: 'file_upload', data: { subId } });
  reply(chatId, t(userId, 'file_ask') + `\n\n🌐 Subdomain: \`${sub.fullDomain}\`\n\n/cancel to stop.`);
}

// ── DNS Update ────────────────────────────────────────────────────────────────
function startDnsUpdate(chatId, userId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return;
  reply(chatId, `⚙️ *DNS Update — ${sub.subdomain}.${DOMAIN}*\n\nChoose hosting:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '▲ Vercel', callback_data: `dns_upd_preset_vercel|${subId}` }, { text: '◈ Netlify', callback_data: `dns_upd_preset_netlify|${subId}` }],
      [{ text: '● GitHub', callback_data: `dns_upd_preset_github|${subId}` }, { text: '◉ VPS',    callback_data: `dns_upd_preset_vps|${subId}` }],
      [{ text: '⬡ NS', callback_data: `dns_upd_preset_ns|${subId}` }, { text: '✏️ Manual', callback_data: `dns_upd_preset_manual|${subId}` }],
    ]},
  });
}

async function applyDnsUpdatePreset(chatId, userId, rawData) {
  const [preset, subId] = rawData.split('|');
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return;

  if (preset === 'vercel') {
    try {
      const rec = await cf.updateRecord(sub.cfRecordId, sub.subdomain, 'CNAME', 'cname.vercel-dns.com');
      db.updateSubdomain(subId, { dnsType: 'CNAME', dnsValue: 'cname.vercel-dns.com', cfRecordId: rec.id });
      return reply(chatId, t(userId, 'dns_updated', sub.fullDomain, 'CNAME', 'cname.vercel-dns.com'), mainMenu(userId));
    } catch (e) { return reply(chatId, `❌ ${e.message}`); }
  }

  // Others need value input
  const typeMap = { netlify: 'CNAME', github: 'CNAME', vps: 'A', ns: 'NS', manual: 'CNAME' };
  const promptMap = {
    netlify: `◈ *Netlify*\n\nPaste your \`.netlify.app\` URL:\n_(Without https://)_`,
    github:  `● *GitHub Pages*\n\nPaste your GitHub Pages URL:\n_(Example: \`username.github.io\`)_`,
    vps:     `◉ *VPS*\n\nEnter your server IP:`,
    ns:      `⬡ *NS*\n\nEnter nameserver:`,
    manual:  `✏️ Enter DNS value:`,
  };

  setSession(userId, { step: 'dns_update_value', data: { subId, dnsType: typeMap[preset] || 'CNAME' } });
  reply(chatId, promptMap[preset] || 'Enter DNS value:');
}

function confirmDeleteSub(chatId, userId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return;
  const hi = lang(userId) === 'hi';
  reply(chatId,
    `⚠️ *${hi ? 'Delete Karo?' : 'Delete?'}*\n\n\`${sub.fullDomain}\`\n\n${hi ? 'Cloudflare DNS bhi remove ho jayega.' : 'Cloudflare DNS record will also be removed.'}\n\n*${hi ? 'Yeh undo nahi ho sakta!' : 'This cannot be undone!'}*`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
      { text: hi ? '🗑️ Haan Delete' : '🗑️ Yes Delete', callback_data: `sub_delete_confirm_${subId}` },
      { text: '❌ Cancel', callback_data: `sub_detail_${subId}` },
    ]]}}
  );
}

async function doDeleteSub(chatId, userId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return;
  if (sub.cfRecordId) { try { await cf.deleteRecord(sub.cfRecordId); } catch {} }
  db.deleteSubdomain(subId);
  db.deleteSubFiles(subId);
  const hi = lang(userId) === 'hi';
  reply(chatId, `✅ \`${sub.fullDomain}\` ${hi ? 'delete ho gayi!' : 'deleted!'}\n${hi ? 'Cloudflare DNS record bhi remove ho gaya.' : 'Cloudflare DNS removed.'}`, mainMenu(userId));
}

// ── DNS Guide ─────────────────────────────────────────────────────────────────
function showDnsGuide(chatId, userId) {
  const hi = lang(userId) === 'hi';
  reply(chatId,
    `📖 *DNS Setup Guide*\n\n` +
    `*▲ Vercel:*\n\`CNAME\` → \`cname.vercel-dns.com\`\n_(${hi ? 'Vercel → Settings → Domains mein bhi add karo' : 'Also add in Vercel → Settings → Domains'})_\n\n` +
    `*◈ Netlify:*\n\`CNAME\` → \`yoursite.netlify.app\`\n_(${hi ? 'Netlify site URL — https:// mat daalo' : 'Your .netlify.app URL — without https://'})_\n\n` +
    `*● GitHub Pages:*\n\`CNAME\` → \`username.github.io\`\n\n` +
    `*◉ Custom VPS:*\n\`A\` → \`your.server.ip\`\n\n` +
    `*⬡ NS Delegation:*\n\`NS\` → \`ns1.yourprovider.com\`\n\n` +
    `🔒 *HTTPS:* ${hi ? 'Cloudflare se automatic free HTTPS milta hai!' : 'Free HTTPS automatic via Cloudflare!'}\n` +
    `⏱ *Propagation:* 1–30 min\n` +
    `🔍 *Check:* whatsmydns.net`
  );
}

function startDnsCheck(chatId, userId) {
  setSession(userId, { step: 'dns_check' });
  const hi = lang(userId) === 'hi';
  reply(chatId, hi ? `🔍 Subdomain naam daalo check karne ke liye:\n_(Sirf naam, domain nahi)_\n\nExample: \`mysite\`` : `🔍 Enter subdomain name to check:\n_(Just the name, not full domain)_\n\nExample: \`mysite\``);
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

function showAdminPanel(chatId) {
  const s = getStats();
  reply(chatId,
    `⚙️ *Admin Panel*\n\n🌐 \`${DOMAIN}\`\n📊 Total: ${s.total} | 🟢 ${s.active} | 🟡 ${s.pending} | 👥 ${s.users}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: `🟡 Pending (${s.pending})`, callback_data: 'admin_pending' }, { text: '🟢 Active', callback_data: 'admin_active' }],
      [{ text: '📋 All Subdomains', callback_data: 'admin_all' }, { text: '👥 Users', callback_data: 'admin_users' }],
      [{ text: '📊 Stats', callback_data: 'admin_stats' }, { text: '⚙️ Settings', callback_data: 'admin_settings' }],
      [{ text: '📢 Broadcast', callback_data: 'broadcast_start' }, { text: '🏠 Menu', callback_data: 'main_menu' }],
    ]}}
  );
}

function getStats() {
  const subs = db.getAllSubdomains();
  return { total: subs.length, active: subs.filter(s => s.status === 'active').length, pending: subs.filter(s => s.status === 'pending').length, suspended: subs.filter(s => s.status === 'suspended').length, users: db.getAllUsers().length };
}

function showAdminStats(chatId) {
  const s = getStats();
  const banned = db.getAllUsers().filter(u => u.banned).length;
  reply(chatId,
    `📊 *Bot Statistics*\n\n🌐 Subdomains:\n├ Total: ${s.total}\n├ 🟢 Active: ${s.active}\n├ 🟡 Pending: ${s.pending}\n└ 🔴 Suspended: ${s.suspended}\n\n👥 Users: ${s.users} (${banned} banned)\n\n⚙️ Settings:\n├ Domain: \`${DOMAIN}\`\n├ Max/user: ${db.getSetting('maxPerUser')}\n├ Approval: ${db.getSetting('requireApproval') ? '✅' : '❌'}\n└ Maintenance: ${db.getSetting('maintenanceMode') ? '🔧 ON' : '✅ OFF'}`
  );
}

function showPendingRequests(chatId) {
  const pending = db.getAllSubdomains({ status: 'pending' });
  if (!pending.length) return reply(chatId, '✅ No pending requests!');
  for (const s of pending.slice(0, 8)) {
    bot.sendMessage(chatId,
      `🟡 *Pending*\n\n🌐 \`${s.fullDomain}\`\n👤 ${s.userName} (@${s.userUsername || 'N/A'})\n📝 ${s.purpose}\n🔧 ${s.dnsType} → ${s.dnsValue}\n🏠 ${s.hosting || 'custom'}\n📅 ${s.createdAt?.split('T')[0]}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve_${s.id}` },
        { text: '❌ Reject',  callback_data: `reject_${s.id}`  },
        { text: '🚫 Ban',     callback_data: `ban_${s.userId}` },
      ]]}}
    );
  }
}

function showAdminSubdomains(chatId, filter) {
  const subs = filter === 'all' ? db.getAllSubdomains() : db.getAllSubdomains({ status: filter });
  if (!subs.length) return reply(chatId, `No subdomains (${filter}).`);
  const list = subs.slice(0, 20).map(s => `${statusEmoji(s.status)} \`${s.subdomain}\` — ${s.userName}`).join('\n');
  reply(chatId, `📋 *${filter} (${subs.length})*\n\n${list}`);
}

function showAdminUsers(chatId) {
  const users = db.getAllUsers();
  if (!users.length) return reply(chatId, 'No users.');
  const list = users.slice(0, 20).map(u => `${u.banned ? '🚫' : '✅'} ${u.firstName} (@${u.username || 'N/A'}) — ${db.getUserSubdomains(u.id).length} subs`).join('\n');
  reply(chatId, `👥 *Users (${users.length})*\n\n${list}`);
}

function showAdminSettings(chatId) {
  reply(chatId,
    `⚙️ *Settings*\n\nDomain: \`${DOMAIN}\`\nMax/user: ${db.getSetting('maxPerUser')}\nApproval: ${db.getSetting('requireApproval') ? '✅ Required' : '❌ Auto'}\nMaintenance: ${db.getSetting('maintenanceMode') ? '🔧 ON' : '✅ OFF'}\nBroadcast Prefix: ${db.getSetting('broadcastPrefix') ? `"${db.getSetting('broadcastPrefix')}"` : 'OFF'}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: `${db.getSetting('requireApproval') ? '✅' : '❌'} Toggle Approval`,     callback_data: 'toggle_approval' }],
      [{ text: `${db.getSetting('maintenanceMode') ? '🔧' : '✅'} Toggle Maintenance`,  callback_data: 'toggle_maintenance' }],
      [{ text: '📢 Broadcast Prefix ON/OFF', callback_data: 'toggle_broadcast_prefix' }],
      [{ text: '📝 Set Welcome Msg', callback_data: 'set_welcome' }, { text: '🔢 Set Max Subs', callback_data: 'set_maxsubs' }],
      [{ text: '◀ Back', callback_data: 'admin_panel' }],
    ]}}
  );
}

async function adminApprove(chatId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');
  if (sub.status === 'active') return reply(chatId, '✅ Already active!');

  let cfId = null;
  try {
    if (sub.dnsType && sub.dnsValue) {
      const rec = await cf.addRecord(sub.subdomain, sub.dnsType, sub.dnsValue);
      cfId = rec.id;
    }
  } catch (e) { console.error('CF approve error:', e.message); }

  db.updateSubdomain(subId, { status: 'active', cfRecordId: cfId });
  reply(chatId, `✅ *Approved!* \`${sub.fullDomain}\`\nCloudflare DNS: ${cfId ? '✅ Added' : '⚠️ Not added (check CF config)'}`);

  try {
    bot.sendMessage(sub.userId, t(sub.userId, 'req_approved', sub), { parse_mode: 'Markdown' });
  } catch {}
}

function adminReject(chatId, adminId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');
  setSession(adminId, { step: 'admin_reject_reason', data: { subId } });
  reply(chatId, `❌ Enter rejection reason for \`${sub.fullDomain}\`:`);
}

async function adminSuspend(chatId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');
  if (sub.cfRecordId) { try { await cf.deleteRecord(sub.cfRecordId); } catch {} }
  db.updateSubdomain(subId, { status: 'suspended', cfRecordId: null });
  reply(chatId, `🔴 \`${sub.fullDomain}\` suspended.`);
  try { bot.sendMessage(sub.userId, t(sub.userId, 'suspended', sub.fullDomain), { parse_mode: 'Markdown' }); } catch {}
}

async function adminUnsuspend(chatId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');
  let cfId = null;
  try { if (sub.dnsType && sub.dnsValue) { const r = await cf.addRecord(sub.subdomain, sub.dnsType, sub.dnsValue); cfId = r.id; } } catch {}
  db.updateSubdomain(subId, { status: 'active', cfRecordId: cfId });
  reply(chatId, `🟢 \`${sub.fullDomain}\` unsuspended.`);
}

async function adminDeleteSub(chatId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');
  if (sub.cfRecordId) { try { await cf.deleteRecord(sub.cfRecordId); } catch {} }
  db.deleteSubdomain(subId);
  reply(chatId, `✅ \`${sub.fullDomain}\` deleted.`);
}

function adminBanUser(chatId, userId)   { db.upsertUser(userId, { banned: true  }); reply(chatId, `🚫 User \`${userId}\` banned.`);   try { bot.sendMessage(userId, t(userId, 'banned')); } catch {} }
function adminUnbanUser(chatId, userId) { db.upsertUser(userId, { banned: false }); reply(chatId, `✅ User \`${userId}\` unbanned.`); }

function toggleApproval(chatId)    { const c = db.getSetting('requireApproval'); db.setSetting('requireApproval', !c); reply(chatId, `✅ Approval: *${!c ? 'Required (manual)' : 'Auto-approve'}*`); }
function toggleMaintenance(chatId) { const c = db.getSetting('maintenanceMode'); db.setSetting('maintenanceMode', !c); reply(chatId, `✅ Maintenance: *${!c ? 'ON' : 'OFF'}*`); }
function toggleBroadcastPrefix(chatId, userId) {
  const current = db.getSetting('broadcastPrefix');
  if (current) {
    db.setSetting('broadcastPrefix', '');
    reply(chatId, t(userId, 'broadcast_prefix_off'));
  } else {
    db.setSetting('broadcastPrefix', '📢 *Admin Announcement*\n\n');
    reply(chatId, t(userId, 'broadcast_prefix_on'));
  }
}

function startBroadcast(chatId, userId) {
  if (!isAdmin(userId)) return;
  setSession(userId, { step: 'broadcast_msg' });
  reply(chatId, '📢 *Broadcast*\n\nType message to send to all users:\n\n/cancel to stop.');
}

function startSetWelcome(chatId, userId) { if (!isAdmin(userId)) return; setSession(userId, { step: 'set_welcome' }); reply(chatId, `📝 Enter new welcome message:\n\n_(Current: "${db.getSetting('welcomeMsg')}")_`); }
function startSetMaxSubs(chatId, userId) { if (!isAdmin(userId)) return; setSession(userId, { step: 'set_maxsubs' }); reply(chatId, `🔢 Enter max subdomains per user (1–50):\n_(Current: ${db.getSetting('maxPerUser')})_`); }

async function doBroadcast(chatId, text) {
  const prefix = db.getSetting('broadcastPrefix') || '';
  const users = db.getAllUsers();
  let sent = 0, failed = 0;
  await reply(chatId, `📤 Sending to ${users.length} users...`);
  for (const u of users) {
    try {
      await bot.sendMessage(u.id, prefix + text, { parse_mode: 'Markdown' });
      sent++;
      await new Promise(r => setTimeout(r, 40)); // Telegram rate limit safe
    } catch { failed++; }
  }
  reply(chatId, `✅ Broadcast complete!\n✉️ Sent: ${sent} | ❌ Failed: ${failed}`);
}

// ── Daily Stats Cron ──────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', () => {
  const s = getStats();
  sendAdmin(`📊 *Daily Report — ${new Date().toLocaleDateString('en-IN')}*\n\n🌐 Active: ${s.active} | Pending: ${s.pending}\n👥 Users: ${s.users}`);
});

// ── Error handling ─────────────────────────────────────────────────────────────
bot.on('polling_error', (e) => console.error('Polling error:', e.code, e.message));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message));

console.log('🤖 Bot ready! Send /start to your bot on Telegram.');
