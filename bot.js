require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────
const http        = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const cron        = require('node-cron');
const cf          = require('./cloudflare');
const db          = require('./database');
const { validateSubdomain, validateDnsValue, stripUrl, statusEmoji, formatSubdomainCard } = require('./helpers');
const { detectLang, LANGS } = require('./i18n');
const { storeTgFile, getFileDownloadUrl } = require('./storage');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const DOMAIN   = process.env.DOMAIN || 'yourdomain.com';

if (!TOKEN)    { console.error('❌ BOT_TOKEN missing in .env'); process.exit(1); }
if (!ADMIN_ID) { console.error('❌ ADMIN_ID missing in .env');  process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// HTTP SERVER — Render Web Service ke liye zaroori
// ─────────────────────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SubDomain Bot is running!');
}).listen(process.env.PORT || 3000, () => {
  console.log('✅ HTTP server started');
});

// ─────────────────────────────────────────────────────────────────────────────
// BOT — polling:false se start, DB ready hone ke baad polling shuru hogi
// ─────────────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: false });

// ─────────────────────────────────────────────────────────────────────────────
// SESSION STORE — in-memory, sirf conversation flow ke liye
// ─────────────────────────────────────────────────────────────────────────────
const sessions = {};
const getSession   = (id) => sessions[String(id)] || {};
const setSession   = (id, d) => { sessions[String(id)] = d; };
const clearSession = (id) => { delete sessions[String(id)]; };

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const isAdmin = (id) => String(id) === ADMIN_ID;

async function isBanned(id) {
  const u = await db.getUser(id);
  return u?.banned === true;
}

async function ensureUser(from) {
  await db.upsertUser(from.id, {
    username:  from.username       || '',
    firstName: from.first_name     || '',
    lastName:  from.last_name      || '',
    tgLang:    from.language_code  || 'en',
  });
}

async function send(chatId, text, extra = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
  } catch (e) {
    console.error('sendMessage error:', e.message);
  }
}

async function sendAdmin(text, extra = {}) {
  return send(ADMIN_ID, text, extra);
}

async function getLang(userId) {
  const l = await db.getUserLang(userId);
  if (!l || l === 'auto') {
    const u = await db.getUser(userId);
    return detectLang(u?.tgLang) || 'en';
  }
  return l;
}

async function mainMenu(userId) {
  const hi = (await getLang(userId)) === 'hi';
  const btns = [
    [{ text: hi ? '🌐 Subdomain Maango' : '🌐 Request Subdomain', callback_data: 'req_start' },
     { text: hi ? '📋 Mere Subdomains'  : '📋 My Subdomains',     callback_data: 'my_subs'   }],
    [{ text: '📖 DNS Guide', callback_data: 'dns_guide' },
     { text: '🔍 Check DNS', callback_data: 'check_dns' }],
    [{ text: '🌐 Language',  callback_data: 'lang_menu' },
     { text: '👤 Profile',   callback_data: 'profile'   }],
    [{ text: '❓ Help',      callback_data: 'help'      }],
  ];
  if (isAdmin(userId)) {
    btns.push([
      { text: '⚙️ Admin Panel', callback_data: 'admin_panel'    },
      { text: '📢 Broadcast',   callback_data: 'broadcast_start' },
    ]);
  }
  return { reply_markup: { inline_keyboard: btns } };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  try {
    await ensureUser(msg.from);
    if (!isAdmin(msg.from.id) && await isBanned(msg.from.id))
      return send(msg.chat.id, '🚫 Aapko ban kar diya gaya hai.');
    if (!isAdmin(msg.from.id) && await db.getSetting('maintenanceMode'))
      return send(msg.chat.id, '🔧 Bot maintenance mode mein hai. Baad mein aana.');
    const welcome = await db.getSetting('welcomeMsg') || '🌐 Free subdomain lo!';
    const menu    = await mainMenu(msg.from.id);
    await send(msg.chat.id,
      `⬡ *SubDomain Bot — ${DOMAIN}*\n\nNamaste *${msg.from.first_name}*! 👋\n\n${welcome}`,
      menu
    );
  } catch (e) { console.error('/start:', e.message); }
});

bot.onText(/\/help/, async (msg) => {
  try { await ensureUser(msg.from); await showHelp(msg.chat.id, msg.from.id); }
  catch (e) { console.error('/help:', e.message); }
});

bot.onText(/\/request/, async (msg) => {
  try {
    await ensureUser(msg.from);
    if (!isAdmin(msg.from.id) && await isBanned(msg.from.id)) return;
    await startRequest(msg.chat.id, msg.from.id);
  } catch (e) { console.error('/request:', e.message); }
});

bot.onText(/\/mysubdomains/, async (msg) => {
  try { await ensureUser(msg.from); await showMySubdomains(msg.chat.id, msg.from.id); }
  catch (e) { console.error('/mysubdomains:', e.message); }
});

bot.onText(/\/language/, async (msg) => {
  try { await ensureUser(msg.from); await showLangMenu(msg.chat.id); }
  catch (e) { console.error(e.message); }
});

bot.onText(/\/cancel/, async (msg) => {
  try {
    clearSession(msg.from.id);
    const menu = await mainMenu(msg.from.id);
    await send(msg.chat.id, '✅ Cancel ho gaya.', menu);
  } catch (e) { console.error(e.message); }
});

bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  try { await showAdminStats(msg.chat.id); }
  catch (e) { console.error(e.message); }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  try { await doBroadcast(msg.chat.id, match[1]); }
  catch (e) { console.error(e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CALLBACK QUERIES
// ─────────────────────────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const userId = from.id;
  try {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await ensureUser(from);
    if (!isAdmin(userId) && await isBanned(userId))
      return send(chatId, '🚫 Banned.');

    // Navigation
    if (data === 'main_menu')  { const m = await mainMenu(userId); return send(chatId, '🏠 Main Menu:', m); }
    if (data === 'help')       return showHelp(chatId, userId);
    if (data === 'profile')    return showProfile(chatId, userId);
    if (data === 'my_subs')    return showMySubdomains(chatId, userId);
    if (data === 'dns_guide')  return showDnsGuide(chatId, userId);
    if (data === 'check_dns')  return startDnsCheck(chatId, userId);
    if (data === 'lang_menu')  return showLangMenu(chatId);

    if (data.startsWith('set_lang_')) {
      const l = data.replace('set_lang_', '');
      await db.upsertUser(userId, { lang: l });
      const m = await mainMenu(userId);
      return send(chatId, `✅ Language: *${l === 'auto' ? 'Auto' : LANGS[l] || l}*`, m);
    }

    // Request flow
    if (data === 'req_start')   return startRequest(chatId, userId);
    if (data === 'req_confirm') return confirmRequest(chatId, userId);
    if (data === 'req_cancel')  {
      clearSession(userId);
      const m = await mainMenu(userId);
      return send(chatId, '❌ Cancel ho gayi.', m);
    }
    if (data.startsWith('dns_preset_'))
      return handleDnsPreset(chatId, userId, data.replace('dns_preset_', ''));

    // My subdomains
    if (data.startsWith('sub_detail_'))
      return showSubDetail(chatId, userId, data.replace('sub_detail_', ''));
    if (data.startsWith('sub_dns_'))
      return startDnsUpdate(chatId, userId, data.replace('sub_dns_', ''));
    if (data.startsWith('sub_upload_'))
      return startFileUpload(chatId, userId, data.replace('sub_upload_', ''));
    if (data.startsWith('sub_delete_confirm_'))
      return doDeleteSub(chatId, userId, data.replace('sub_delete_confirm_', ''));
    if (data.startsWith('sub_delete_'))
      return confirmDeleteSub(chatId, userId, data.replace('sub_delete_', ''));
    if (data.startsWith('dns_upd_preset_'))
      return applyDnsUpdatePreset(chatId, userId, data.replace('dns_upd_preset_', ''));

    // Admin only below
    if (!isAdmin(userId)) return;

    if (data === 'admin_panel')         return showAdminPanel(chatId);
    if (data === 'admin_pending')       return showPendingRequests(chatId);
    if (data === 'admin_active')        return showAdminSubdomains(chatId, 'active');
    if (data === 'admin_all')           return showAdminSubdomains(chatId, 'all');
    if (data === 'admin_users')         return showAdminUsers(chatId);
    if (data === 'admin_settings')      return showAdminSettings(chatId);
    if (data === 'admin_stats')         return showAdminStats(chatId);
    if (data === 'toggle_approval')     return toggleApproval(chatId);
    if (data === 'toggle_maintenance')  return toggleMaintenance(chatId);
    if (data === 'toggle_bcast_prefix') return toggleBroadcastPrefix(chatId);
    if (data === 'set_welcome')         return startSetWelcome(chatId, userId);
    if (data === 'set_maxsubs')         return startSetMaxSubs(chatId, userId);
    if (data === 'broadcast_start')     return startBroadcast(chatId, userId);

    if (data.startsWith('approve_'))   return adminApprove(chatId, data.replace('approve_', ''));
    if (data.startsWith('reject_'))    return adminReject(chatId, userId, data.replace('reject_', ''));
    if (data.startsWith('suspend_'))   return adminSuspend(chatId, data.replace('suspend_', ''));
    if (data.startsWith('unsuspend_')) return adminUnsuspend(chatId, data.replace('unsuspend_', ''));
    if (data.startsWith('admin_del_')) return adminDeleteSub(chatId, data.replace('admin_del_', ''));
    if (data.startsWith('ban_'))       return adminBanUser(chatId, data.replace('ban_', ''));
    if (data.startsWith('unban_'))     return adminUnbanUser(chatId, data.replace('unban_', ''));

  } catch (e) {
    console.error('callback_query error [' + data + ']:', e.message);
    send(chatId, `❌ Error: ${e.message}`).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLER — conversation state machine
// ─────────────────────────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.from) return;
  const userId  = msg.from.id;
  const chatId  = msg.chat.id;
  const session = getSession(userId);

  try {
    // File upload
    if (msg.document && session.step === 'file_upload') {
      clearSession(userId);
      const sub = await db.getSubdomainById(session.data.subId);
      if (!sub || sub.userId !== String(userId)) return;
      await send(chatId, '⏳ File upload ho rahi hai...');
      const result = await storeTgFile(bot, msg, session.data.subId, sub.subdomain, DOMAIN);
      if (result.error === 'wrong_type') return send(chatId, '❌ Sirf .html ya .zip files allowed hain.');
      if (result.error === 'too_big')    return send(chatId, `❌ File bahut badi! Max 5MB. Aapki: ${result.mb}MB`);
      if (result.error)                  return send(chatId, `❌ Upload error: ${result.error}`);
      const menu = await mainMenu(userId);
      return send(chatId,
        `✅ *File Upload Ho Gayi!*\n📁 \`${result.record.fileName}\`\n🌐 \`https://${sub.fullDomain}\`\n\n📥 [Download](${getFileDownloadUrl(result.record)})`,
        { ...menu, disable_web_page_preview: true }
      );
    }

    // Ignore commands and non-text
    if (!msg.text || msg.text.startsWith('/')) return;
    const text = msg.text.trim();

    // No active session
    if (!session.step) return;

    console.log(`MSG | user:${userId} step:${session.step} text:${text.slice(0,30)}`);

    // ── STEP: subdomain name ─────────────────────────────────────────────────
    if (session.step === 'req_name') {
      const name = text.toLowerCase().trim();
      const err  = validateSubdomain(name);
      if (err) return send(chatId, `❌ ${err}\n\nDobara try karein ya /cancel`);
      const exists = await db.getSubdomain(name);
      if (exists) return send(chatId, `❌ \`${name}.${DOMAIN}\` already taken hai. Dusra naam try karo.`);
      setSession(userId, { step: 'req_purpose', data: { subdomain: name } });
      return send(chatId,
        `✅ \`${name}.${DOMAIN}\` available hai!\n\n📝 *Is subdomain ka kya use karoge?*\n_(Example: Portfolio website, blog, project)_\n\n/cancel se rok sakte ho.`
      );
    }

    // ── STEP: purpose ────────────────────────────────────────────────────────
    if (session.step === 'req_purpose') {
      if (text.length < 5) return send(chatId, '❌ Thoda aur detail mein batao (5+ characters).');
      setSession(userId, { step: 'req_hosting', data: { ...session.data, purpose: text } });
      return send(chatId, '📖 *Hosting Provider Chuniye:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '▲ Vercel',        callback_data: 'dns_preset_vercel'  },
           { text: '◈ Netlify',       callback_data: 'dns_preset_netlify' }],
          [{ text: '● GitHub Pages',  callback_data: 'dns_preset_github'  },
           { text: '◉ Custom VPS/IP', callback_data: 'dns_preset_vps'     }],
          [{ text: '⬡ NS Delegation', callback_data: 'dns_preset_ns'      }],
          [{ text: '✏️ Manual Entry',  callback_data: 'dns_preset_manual'  }],
          [{ text: '❌ Cancel',        callback_data: 'req_cancel'         }],
        ]},
      });
    }

    // ── STEP: manual DNS type ────────────────────────────────────────────────
    if (session.step === 'req_dns_type') {
      const type = text.toUpperCase();
      if (!['CNAME','A','NS','TXT'].includes(type))
        return send(chatId, '❌ Type must be: `CNAME`, `A`, `NS`, or `TXT`');
      setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: type } });
      const ex = { A: '`1.2.3.4`', NS: '`ns1.provider.com`' }[type] || '`target.example.com`';
      return send(chatId, `📌 ${type} value daalo:\nExample: ${ex}`);
    }

    // ── STEP: DNS value ──────────────────────────────────────────────────────
    if (session.step === 'req_dns_value') {
      let val = text;
      if (val.startsWith('http')) val = stripUrl(val);
      const err = validateDnsValue(session.data.dnsType, val);
      const hints = {
        'INVALID_A':    '❌ Valid IP daalo. Example: `1.2.3.4`',
        'INVALID_CNAME':'❌ Valid domain daalo (https:// mat likho). Example: `yoursite.netlify.app`',
        'INVALID_NS':   '❌ Valid nameserver daalo. Example: `ns1.provider.com`',
      };
      if (err && hints[err]) return send(chatId, hints[err]);
      setSession(userId, { ...session, step: 'req_confirm_wait', data: { ...session.data, dnsValue: val } });
      return showRequestConfirm(chatId, userId);
    }

    // ── STEP: DNS update value ───────────────────────────────────────────────
    if (session.step === 'dns_update_value') {
      const { subId, dnsType } = session.data;
      let val = text;
      if (val.startsWith('http')) val = stripUrl(val);
      const err = validateDnsValue(dnsType, val);
      if (err && err !== 'INVALID_CNAME_URL') return send(chatId, '❌ Invalid value. Try again.');
      clearSession(userId);
      const sub = await db.getSubdomainById(subId);
      if (!sub || sub.userId !== String(userId)) return send(chatId, '❌ Not found.');
      try {
        const rec = await cf.updateRecord(sub.cfRecordId, sub.subdomain, dnsType, val);
        await db.updateSubdomain(subId, { dnsType, dnsValue: val, cfRecordId: rec.id });
        const menu = await mainMenu(userId);
        return send(chatId, `✅ *DNS Update Ho Gaya!*\n\`${sub.fullDomain}\`\n\`${dnsType}\` → \`${val}\`\n_Propagation: 1–30 min_`, menu);
      } catch (e) {
        const menu = await mainMenu(userId);
        return send(chatId, `❌ DNS update failed: ${e.message}`, menu);
      }
    }

    // ── STEP: DNS check ──────────────────────────────────────────────────────
    if (session.step === 'dns_check') {
      clearSession(userId);
      const name = text.toLowerCase().trim();
      try {
        const records = await cf.listRecords(name);
        if (!records.length) return send(chatId, `🔍 \`${name}.${DOMAIN}\`\n\n❌ Koi DNS record nahi mila.\n_5–30 min wait karo._`);
        const list = records.map(r => `• \`${r.type}\` → \`${r.content}\``).join('\n');
        return send(chatId, `🔍 *DNS Records — ${name}.${DOMAIN}*\n\n${list}\n\n✅ Active hai!`);
      } catch (e) { return send(chatId, `❌ DNS check failed: ${e.message}`); }
    }

    // ── STEP: reject reason (admin) ──────────────────────────────────────────
    if (session.step === 'reject_reason' && isAdmin(userId)) {
      const { subId } = session.data;
      clearSession(userId);
      const sub = await db.getSubdomainById(subId);
      if (!sub) return send(chatId, '❌ Not found.');
      await db.updateSubdomain(subId, { status: 'rejected', rejectReason: text });
      await send(chatId, `❌ \`${sub.fullDomain}\` reject kar diya.\nReason: _${text}_`);
      bot.sendMessage(sub.userId, `❌ *Subdomain Request Reject Ho Gayi*\n\n\`${sub.fullDomain}\`\n\nReason: _${text}_\n\nDusra naam try karo — /request`, { parse_mode: 'Markdown' }).catch(() => {});
      return;
    }

    // ── STEP: broadcast (admin) ──────────────────────────────────────────────
    if (session.step === 'broadcast_msg' && isAdmin(userId)) {
      clearSession(userId);
      return doBroadcast(chatId, text);
    }

    // ── STEP: set welcome (admin) ────────────────────────────────────────────
    if (session.step === 'set_welcome' && isAdmin(userId)) {
      clearSession(userId);
      await db.setSetting('welcomeMsg', text);
      return send(chatId, `✅ Welcome message update ho gaya!\n\n_"${text}"_`);
    }

    // ── STEP: set max subs (admin) ───────────────────────────────────────────
    if (session.step === 'set_maxsubs' && isAdmin(userId)) {
      clearSession(userId);
      const n = parseInt(text);
      if (isNaN(n) || n < 1 || n > 50) return send(chatId, '❌ 1–50 ke beech number daalo.');
      await db.setSetting('maxPerUser', n);
      return send(chatId, `✅ Max subdomains per user: *${n}*`);
    }

  } catch (e) {
    console.error('message handler error:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function showHelp(chatId, userId) {
  const menu = await mainMenu(userId);
  await send(chatId,
    `❓ *SubDomain Bot Help*\n\n🌐 *${DOMAIN}* pe free subdomains lo\n\n` +
    `*Commands:*\n/start — Main menu\n/request — Naya subdomain maango\n/mysubdomains — Apne subdomains\n` +
    `/language — Language change karo\n/cancel — Cancel karo` +
    (isAdmin(userId) ? '\n\n👑 *Admin:*\n/stats — Statistics\n/broadcast msg — Sabko message' : ''),
    menu
  );
}

async function showProfile(chatId, userId) {
  const [user, subs, max] = await Promise.all([
    db.getUser(userId), db.getUserSubdomains(userId), db.getSetting('maxPerUser')
  ]);
  const menu = await mainMenu(userId);
  await send(chatId,
    `👤 *Profile*\n\n🆔 ID: \`${userId}\`\n` +
    `👤 ${user?.firstName || ''} ${user?.lastName || ''}\n` +
    `📛 @${user?.username || 'N/A'}\n` +
    `🌐 Language: ${LANGS[user?.lang] || 'Auto'}\n\n` +
    `🌐 *Subdomains:* ${subs.filter(s=>s.status!=='rejected').length}/${max}\n` +
    `🟢 Active: ${subs.filter(s=>s.status==='active').length}\n` +
    `🟡 Pending: ${subs.filter(s=>s.status==='pending').length}\n\n` +
    `${user?.banned ? '🚫 *BANNED*' : '✅ Active'}`,
    menu
  );
}

async function showLangMenu(chatId) {
  await send(chatId, '🌐 *Select Language / भाषा चुनें*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🇬🇧 English',       callback_data: 'set_lang_en'   }],
      [{ text: '🇮🇳 Hindi / हिंदी', callback_data: 'set_lang_hi'   }],
      [{ text: '🤖 Auto Detect',    callback_data: 'set_lang_auto' }],
    ]},
  });
}

// ── Request ────────────────────────────────────────────────────────────────────
async function startRequest(chatId, userId) {
  const [max, userSubs] = await Promise.all([
    db.getSetting('maxPerUser'), db.getUserSubdomains(userId)
  ]);
  const active = userSubs.filter(s => ['active','pending'].includes(s.status));
  if (active.length >= max) {
    const menu = await mainMenu(userId);
    return send(chatId, `❌ Aapke paas already *${active.length}/${max}* subdomains hain.\n\nEk delete karo pehle — /mysubdomains`, menu);
  }
  clearSession(userId);
  setSession(userId, { step: 'req_name', data: {} });
  return send(chatId,
    `🌐 *Naya Subdomain Request*\n\n` +
    `*Subdomain naam batao:*\n\n` +
    `📌 Rules:\n• Sirf lowercase letters, numbers, hyphen (-)\n` +
    `• 3 se 30 characters\n• Example: \`mysite\`, \`my-blog\`, \`portfolio\`\n\n` +
    `Aapko milega: \`naam.${DOMAIN}\`\n\n` +
    `/cancel se rok sakte ho.`
  );
}

async function handleDnsPreset(chatId, userId, preset) {
  const session = getSession(userId);
  if (!session.data) return startRequest(chatId, userId);

  if (preset === 'manual') {
    setSession(userId, { ...session, step: 'req_dns_type' });
    return send(chatId, '✏️ DNS type daalo:\n`CNAME` | `A` | `NS` | `TXT`');
  }
  if (preset === 'vercel') {
    setSession(userId, { ...session, step: 'req_confirm_wait', data: { ...session.data, dnsType: 'CNAME', dnsValue: 'cname.vercel-dns.com', hosting: 'Vercel' } });
    return showRequestConfirm(chatId, userId);
  }

  const map = {
    netlify: { type:'CNAME', hosting:'Netlify',       msg:'◈ *Netlify*\n\nApna `.netlify.app` URL paste karo:\n_(Example: `amazing-site.netlify.app`)_\n\n⚠️ `https://` mat daalo.' },
    github:  { type:'CNAME', hosting:'GitHub Pages',  msg:'● *GitHub Pages*\n\nApna GitHub Pages URL paste karo:\n_(Example: `username.github.io`)_' },
    vps:     { type:'A',     hosting:'Custom VPS',    msg:'◉ *Custom VPS*\n\nApna server IP daalo:\n_(Example: `1.2.3.4`)_' },
    ns:      { type:'NS',    hosting:'NS Delegation', msg:'⬡ *NS Delegation*\n\nPrimary nameserver daalo:\n_(Example: `ns1.provider.com`)_' },
  };
  const p = map[preset];
  if (!p) return;
  setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: p.type, hosting: p.hosting } });
  return send(chatId, p.msg);
}

async function showRequestConfirm(chatId, userId) {
  const { data } = getSession(userId);
  if (!data?.subdomain) return startRequest(chatId, userId);
  const approval = await db.getSetting('requireApproval');
  await send(chatId,
    `✅ *Confirm karo:*\n\n🌐 Domain: \`${data.subdomain}.${DOMAIN}\`\n📝 Purpose: ${data.purpose}\n🔧 DNS: \`${data.dnsType}\` → \`${data.dnsValue}\`\n🏠 Hosting: ${data.hosting||'custom'}\n\n${approval?'⏳ Admin approval required.':'✅ Auto-approved!'}`,
    { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[
      { text:'✅ Confirm & Submit', callback_data:'req_confirm' },
      { text:'❌ Cancel',           callback_data:'req_cancel'  },
    ]]}}
  );
}

async function confirmRequest(chatId, userId) {
  const session = getSession(userId);
  const { data } = session;
  if (!data?.subdomain) return startRequest(chatId, userId);
  clearSession(userId);

  const [max, approval, exists, userSubs] = await Promise.all([
    db.getSetting('maxPerUser'), db.getSetting('requireApproval'),
    db.getSubdomain(data.subdomain), db.getUserSubdomains(userId),
  ]);

  if (exists) return send(chatId, `❌ \`${data.subdomain}.${DOMAIN}\` already taken. Dusra naam try karo.`);
  if (userSubs.filter(s=>['active','pending'].includes(s.status)).length >= max) {
    const menu = await mainMenu(userId);
    return send(chatId, `❌ Max ${max} subdomains limit ho gayi.`, menu);
  }

  const subId = uuidv4();
  let cfRecordId = null;
  const status = approval ? 'pending' : 'active';

  if (!approval && data.dnsType && data.dnsValue) {
    try { const r = await cf.addRecord(data.subdomain, data.dnsType, data.dnsValue); cfRecordId = r.id; }
    catch (e) { console.error('CF error:', e.message); }
  }

  const user = await db.getUser(userId);
  await db.addSubdomain({
    id: subId, userId: String(userId),
    userName: user?.firstName||'', userUsername: user?.username||'',
    subdomain: data.subdomain, fullDomain: `${data.subdomain}.${DOMAIN}`,
    purpose: data.purpose, dnsType: data.dnsType, dnsValue: data.dnsValue,
    hosting: data.hosting||'custom', status, cfRecordId,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  const menu = await mainMenu(userId);
  if (!approval) {
    await send(chatId, `🎉 *Subdomain Active Ho Gayi!*\n\n\`${data.subdomain}.${DOMAIN}\`\n\n✅ Cloudflare pe DNS add ho gaya!\n🔒 HTTPS automatic active hai.\n⏱ Propagation: 1–30 min`, menu);
  } else {
    await send(chatId, `✅ *Request Submit Ho Gayi!*\n\n\`${data.subdomain}.${DOMAIN}\`\n\n⏳ Admin approve karega, notification aayega.`, menu);
    await sendAdmin(
      `🔔 *New Subdomain Request*\n\n👤 ${user?.firstName} (@${user?.username||'N/A'}) | \`${userId}\`\n🌐 \`${data.subdomain}.${DOMAIN}\`\n📝 ${data.purpose}\n🔧 ${data.dnsType} → ${data.dnsValue}\n🏠 ${data.hosting||'custom'}`,
      { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[
        { text:'✅ Approve', callback_data:`approve_${subId}` },
        { text:'❌ Reject',  callback_data:`reject_${subId}`  },
      ]]}}
    );
  }
}

// ── My Subdomains ──────────────────────────────────────────────────────────────
async function showMySubdomains(chatId, userId) {
  const subs = await db.getUserSubdomains(userId);
  if (!subs.length) {
    return send(chatId, '🌐 *Mere Subdomains*\n\nAbhi koi subdomain nahi hai.\n\nNaya request karo! 👇', {
      parse_mode:'Markdown',
      reply_markup:{ inline_keyboard:[[{ text:'🌐 Request Subdomain', callback_data:'req_start' }]] }
    });
  }
  const btns = subs.map(s=>[{ text:`${statusEmoji(s.status)} ${s.subdomain}.${DOMAIN}`, callback_data:`sub_detail_${s.id}` }]);
  btns.push([{ text:'🏠 Main Menu', callback_data:'main_menu' }]);
  await send(chatId, `🌐 *Mere Subdomains* (${subs.length})`, { parse_mode:'Markdown', reply_markup:{ inline_keyboard:btns } });
}

async function showSubDetail(chatId, userId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return send(chatId, '❌ Not found.');
  const btns = [];
  if (sub.status === 'active') {
    btns.push([{ text:'⚙️ Update DNS', callback_data:`sub_dns_${subId}` }, { text:'📁 Upload File', callback_data:`sub_upload_${subId}` }]);
    btns.push([{ text:'🔗 Site Open Karo', url:`https://${sub.fullDomain}` }]);
  }
  btns.push([{ text:'🗑️ Delete', callback_data:`sub_delete_${subId}` }, { text:'◀ Back', callback_data:'my_subs' }]);
  await send(chatId, formatSubdomainCard(sub), { parse_mode:'Markdown', reply_markup:{ inline_keyboard:btns } });
}

async function startFileUpload(chatId, userId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return send(chatId, '❌ Not found.');
  if (sub.status !== 'active') return send(chatId, '❌ Subdomain active honi chahiye.');
  setSession(userId, { step:'file_upload', data:{ subId } });
  return send(chatId, `📁 *File Upload Karo*\n\n🌐 \`${sub.fullDomain}\`\n\nApna HTML ya ZIP file bhejo (max 5MB)\n\n/cancel to stop.`);
}

async function startDnsUpdate(chatId, userId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return;
  await send(chatId, `⚙️ *DNS Update — ${sub.subdomain}.${DOMAIN}*\n\nHosting chuniye:`, {
    parse_mode:'Markdown',
    reply_markup:{ inline_keyboard:[
      [{ text:'▲ Vercel', callback_data:`dns_upd_preset_vercel|${subId}` }, { text:'◈ Netlify', callback_data:`dns_upd_preset_netlify|${subId}` }],
      [{ text:'● GitHub', callback_data:`dns_upd_preset_github|${subId}` }, { text:'◉ VPS',    callback_data:`dns_upd_preset_vps|${subId}` }],
      [{ text:'⬡ NS',    callback_data:`dns_upd_preset_ns|${subId}` },     { text:'✏️ Manual', callback_data:`dns_upd_preset_manual|${subId}` }],
      [{ text:'◀ Back',  callback_data:`sub_detail_${subId}` }],
    ]},
  });
}

async function applyDnsUpdatePreset(chatId, userId, raw) {
  const [preset, subId] = raw.split('|');
  const sub = await db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return;
  if (preset === 'vercel') {
    try {
      const rec = await cf.updateRecord(sub.cfRecordId, sub.subdomain, 'CNAME', 'cname.vercel-dns.com');
      await db.updateSubdomain(subId, { dnsType:'CNAME', dnsValue:'cname.vercel-dns.com', cfRecordId:rec.id });
      const menu = await mainMenu(userId);
      return send(chatId, `✅ DNS Updated!\n\`CNAME\` → \`cname.vercel-dns.com\``, menu);
    } catch (e) { return send(chatId, `❌ ${e.message}`); }
  }
  const typeMap = { netlify:'CNAME', github:'CNAME', vps:'A', ns:'NS', manual:'CNAME' };
  const msgMap  = {
    netlify:'◈ Netlify URL daalo:\n_(Example: `mysite.netlify.app`)_',
    github: '● GitHub Pages URL daalo:\n_(Example: `username.github.io`)_',
    vps:    '◉ Server IP daalo:\n_(Example: `1.2.3.4`)_',
    ns:     '⬡ Nameserver daalo:\n_(Example: `ns1.provider.com`)_',
    manual: '✏️ DNS value daalo:',
  };
  setSession(userId, { step:'dns_update_value', data:{ subId, dnsType:typeMap[preset]||'CNAME' } });
  return send(chatId, msgMap[preset]||'Enter value:');
}

async function confirmDeleteSub(chatId, userId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return;
  await send(chatId,
    `⚠️ *Delete Karo?*\n\n\`${sub.fullDomain}\`\n\nCloudflare DNS bhi remove ho jayega.\n*Yeh undo nahi ho sakta!*`,
    { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[
      { text:'🗑️ Haan Delete Karo', callback_data:`sub_delete_confirm_${subId}` },
      { text:'❌ Cancel',            callback_data:`sub_detail_${subId}` },
    ]]}}
  );
}

async function doDeleteSub(chatId, userId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return;
  if (sub.cfRecordId) { try { await cf.deleteRecord(sub.cfRecordId); } catch {} }
  await db.deleteSubdomain(subId);
  await db.deleteSubFiles(subId);
  const menu = await mainMenu(userId);
  return send(chatId, `✅ \`${sub.fullDomain}\` delete ho gayi!\nCloudflare DNS bhi remove ho gaya.`, menu);
}

async function showDnsGuide(chatId, userId) {
  const menu = await mainMenu(userId);
  await send(chatId,
    `📖 *DNS Setup Guide*\n\n` +
    `*▲ Vercel:*\n\`CNAME\` → \`cname.vercel-dns.com\`\n_(Vercel → Settings → Domains mein bhi add karo)_\n\n` +
    `*◈ Netlify:*\n\`CNAME\` → \`yoursite.netlify.app\`\n_(https:// mat daalo)_\n\n` +
    `*● GitHub Pages:*\n\`CNAME\` → \`username.github.io\`\n\n` +
    `*◉ Custom VPS:*\n\`A\` → \`your.server.ip\`\n\n` +
    `*⬡ NS Delegation:*\n\`NS\` → \`ns1.yourprovider.com\`\n\n` +
    `🔒 HTTPS: Cloudflare se automatic free!\n⏱ Propagation: 1–30 min\n🔍 Check: whatsmydns.net`,
    menu
  );
}

async function startDnsCheck(chatId, userId) {
  setSession(userId, { step:'dns_check' });
  await send(chatId, `🔍 *DNS Check*\n\nSubdomain naam daalo:\n_(Sirf naam, domain nahi)_\n\nExample: \`mysite\`\n\n/cancel to stop.`);
}

// ── Admin ──────────────────────────────────────────────────────────────────────
async function getStats() {
  const [subs, users] = await Promise.all([db.getAllSubdomains(), db.getAllUsers()]);
  return {
    total: subs.length,
    active: subs.filter(s=>s.status==='active').length,
    pending: subs.filter(s=>s.status==='pending').length,
    suspended: subs.filter(s=>s.status==='suspended').length,
    users: users.length,
    banned: users.filter(u=>u.banned).length,
  };
}

async function showAdminPanel(chatId) {
  const s = await getStats();
  await send(chatId,
    `⚙️ *Admin Panel*\n\n🌐 \`${DOMAIN}\`\n📊 Total:${s.total} 🟢:${s.active} 🟡:${s.pending} 🔴:${s.suspended}\n👥 Users:${s.users} 🚫:${s.banned}`,
    { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
      [{ text:`🟡 Pending (${s.pending})`, callback_data:'admin_pending' }, { text:'🟢 Active',       callback_data:'admin_active'   }],
      [{ text:'📋 All Subdomains',         callback_data:'admin_all'     }, { text:'👥 Users',         callback_data:'admin_users'    }],
      [{ text:'📊 Stats',                  callback_data:'admin_stats'   }, { text:'⚙️ Settings',      callback_data:'admin_settings' }],
      [{ text:'📢 Broadcast',              callback_data:'broadcast_start'}, { text:'🏠 Menu',         callback_data:'main_menu'      }],
    ]}}
  );
}

async function showAdminStats(chatId) {
  const [s, max, approval, maintenance] = await Promise.all([getStats(), db.getSetting('maxPerUser'), db.getSetting('requireApproval'), db.getSetting('maintenanceMode')]);
  await send(chatId,
    `📊 *Statistics*\n\n🌐 Total: ${s.total}\n🟢 Active: ${s.active}\n🟡 Pending: ${s.pending}\n🔴 Suspended: ${s.suspended}\n\n👥 Users: ${s.users} (🚫 ${s.banned} banned)\n\n⚙️ Max/user: ${max} | Approval: ${approval?'✅':'❌ Auto'} | Maintenance: ${maintenance?'🔧 ON':'✅ OFF'}`
  );
}

async function showPendingRequests(chatId) {
  const pending = await db.getAllSubdomains({ status:'pending' });
  if (!pending.length) return send(chatId, '✅ Koi pending request nahi!');
  for (const s of pending.slice(0,8)) {
    await bot.sendMessage(chatId,
      `🟡 *Pending*\n\n🌐 \`${s.fullDomain}\`\n👤 ${s.userName} (@${s.userUsername||'N/A'})\n📝 ${s.purpose}\n🔧 \`${s.dnsType}\` → \`${s.dnsValue}\`\n🏠 ${s.hosting||'custom'}\n📅 ${s.createdAt?.split('T')[0]}`,
      { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[
        { text:'✅ Approve', callback_data:`approve_${s.id}` },
        { text:'❌ Reject',  callback_data:`reject_${s.id}`  },
        { text:'🚫 Ban',     callback_data:`ban_${s.userId}` },
      ]]}}
    ).catch(()=>{});
  }
}

async function showAdminSubdomains(chatId, filter) {
  const subs = await (filter==='all' ? db.getAllSubdomains() : db.getAllSubdomains({status:filter}));
  if (!subs.length) return send(chatId, `📋 Koi subdomain nahi (${filter}).`);
  const list = subs.slice(0,20).map(s=>`${statusEmoji(s.status)} \`${s.subdomain}\` — ${s.userName}`).join('\n');
  await send(chatId, `📋 *${filter} (${subs.length})*\n\n${list}`);
}

async function showAdminUsers(chatId) {
  const users = await db.getAllUsers();
  if (!users.length) return send(chatId, 'Koi user nahi.');
  const list = users.slice(0,20).map(u=>`${u.banned?'🚫':'✅'} ${u.firstName} (@${u.username||'N/A'}) \`${u.id}\``).join('\n');
  await send(chatId, `👥 *Users (${users.length})*\n\n${list}`);
}

async function showAdminSettings(chatId) {
  const [max,approval,maintenance,prefix] = await Promise.all([db.getSetting('maxPerUser'),db.getSetting('requireApproval'),db.getSetting('maintenanceMode'),db.getSetting('broadcastPrefix')]);
  await send(chatId,
    `⚙️ *Settings*\n\nDomain: \`${DOMAIN}\`\nMax/user: ${max}\nApproval: ${approval?'✅ Required':'❌ Auto'}\nMaintenance: ${maintenance?'🔧 ON':'✅ OFF'}\nBroadcast Prefix: ${prefix?'✅ ON':'❌ OFF'}`,
    { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
      [{ text:`${approval?'✅':'❌'} Toggle Approval`,      callback_data:'toggle_approval'    }],
      [{ text:`${maintenance?'🔧':'✅'} Toggle Maintenance`, callback_data:'toggle_maintenance'  }],
      [{ text:'📢 Broadcast Prefix ON/OFF',                  callback_data:'toggle_bcast_prefix' }],
      [{ text:'📝 Set Welcome Msg',  callback_data:'set_welcome' }, { text:'🔢 Set Max Subs', callback_data:'set_maxsubs' }],
      [{ text:'◀ Back', callback_data:'admin_panel' }],
    ]}}
  );
}

async function adminApprove(chatId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub) return send(chatId, '❌ Not found.');
  if (sub.status==='active') return send(chatId, '✅ Already active!');
  let cfId = null;
  try { if (sub.dnsType && sub.dnsValue) { const r = await cf.addRecord(sub.subdomain, sub.dnsType, sub.dnsValue); cfId = r.id; } } catch (e) { console.error('CF approve:', e.message); }
  await db.updateSubdomain(subId, { status:'active', cfRecordId:cfId });
  await send(chatId, `✅ *Approved!* \`${sub.fullDomain}\`\nCloudflare DNS: ${cfId?'✅ Added':'⚠️ Not added (CF config check karo)'}`);
  bot.sendMessage(sub.userId,
    `🎉 *Subdomain Approve Ho Gayi!*\n\n\`${sub.fullDomain}\`\n\n✅ Cloudflare pe DNS add!\n🔒 HTTPS active!\n⏱ Propagation: 1–30 min\n\n/mysubdomains`,
    { parse_mode:'Markdown' }
  ).catch(()=>{});
}

async function adminReject(chatId, adminId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub) return send(chatId, '❌ Not found.');
  setSession(adminId, { step:'reject_reason', data:{ subId } });
  await send(chatId, `❌ Rejection reason type karo:\n_${sub.fullDomain}_ ke liye:`);
}

async function adminSuspend(chatId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub) return send(chatId, '❌ Not found.');
  if (sub.cfRecordId) { try { await cf.deleteRecord(sub.cfRecordId); } catch {} }
  await db.updateSubdomain(subId, { status:'suspended', cfRecordId:null });
  await send(chatId, `🔴 \`${sub.fullDomain}\` suspended.`);
  bot.sendMessage(sub.userId, `⚠️ Aapki \`${sub.fullDomain}\` suspend ho gayi. Admin se contact karein.`, { parse_mode:'Markdown' }).catch(()=>{});
}

async function adminUnsuspend(chatId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub) return send(chatId, '❌ Not found.');
  let cfId = null;
  try { if (sub.dnsType && sub.dnsValue) { const r = await cf.addRecord(sub.subdomain, sub.dnsType, sub.dnsValue); cfId = r.id; } } catch {}
  await db.updateSubdomain(subId, { status:'active', cfRecordId:cfId });
  await send(chatId, `🟢 \`${sub.fullDomain}\` unsuspend ho gayi!`);
}

async function adminDeleteSub(chatId, subId) {
  const sub = await db.getSubdomainById(subId);
  if (!sub) return send(chatId, '❌ Not found.');
  if (sub.cfRecordId) { try { await cf.deleteRecord(sub.cfRecordId); } catch {} }
  await db.deleteSubdomain(subId);
  await send(chatId, `✅ \`${sub.fullDomain}\` delete ho gayi.`);
}

async function adminBanUser(chatId, userId) {
  await db.upsertUser(userId, { banned:true });
  await send(chatId, `🚫 User \`${userId}\` banned.`);
  bot.sendMessage(userId, '🚫 Aapko ban kar diya gaya hai.').catch(()=>{});
}

async function adminUnbanUser(chatId, userId) {
  await db.upsertUser(userId, { banned:false });
  await send(chatId, `✅ User \`${userId}\` unbanned.`);
}

async function toggleApproval(chatId) {
  const c = await db.getSetting('requireApproval');
  await db.setSetting('requireApproval', !c);
  await send(chatId, `✅ Approval: *${!c?'Required (manual)':'Auto-approve'}*`);
}

async function toggleMaintenance(chatId) {
  const c = await db.getSetting('maintenanceMode');
  await db.setSetting('maintenanceMode', !c);
  await send(chatId, `✅ Maintenance: *${!c?'🔧 ON':'✅ OFF'}*`);
}

async function toggleBroadcastPrefix(chatId) {
  const c = await db.getSetting('broadcastPrefix');
  if (c) { await db.setSetting('broadcastPrefix',''); await send(chatId,'📢 Broadcast prefix OFF — sirf message jayega.'); }
  else   { await db.setSetting('broadcastPrefix','📢 *Admin Announcement*\n\n'); await send(chatId,'📢 Broadcast prefix ON — heading add hogi.'); }
}

async function startBroadcast(chatId, userId) {
  setSession(userId, { step:'broadcast_msg' });
  await send(chatId, '📢 *Broadcast*\n\nSabko bhejna wala message type karo:\n\n/cancel to stop.');
}

async function doBroadcast(chatId, text) {
  const [prefix, users] = await Promise.all([db.getSetting('broadcastPrefix'), db.getAllUsers()]);
  const fullMsg = (prefix||'') + text;
  let sent=0, failed=0;
  await send(chatId, `📤 Sending to ${users.length} users...`);
  for (const u of users) {
    try { await bot.sendMessage(u.id, fullMsg, {parse_mode:'Markdown'}); sent++; await new Promise(r=>setTimeout(r,40)); }
    catch { failed++; }
  }
  await send(chatId, `✅ Broadcast done!\n✉️ Sent: ${sent} | ❌ Failed: ${failed}`);
}

async function startSetWelcome(chatId, userId) {
  const cur = await db.getSetting('welcomeMsg');
  setSession(userId, { step:'set_welcome' });
  await send(chatId, `📝 Naya welcome message type karo:\n_(Current: "${cur}")_\n\n/cancel to stop.`);
}

async function startSetMaxSubs(chatId, userId) {
  const cur = await db.getSetting('maxPerUser');
  setSession(userId, { step:'set_maxsubs' });
  await send(chatId, `🔢 Max subdomains per user (1–50):\n_(Current: ${cur})_`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY CRON
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  try {
    const s = await getStats();
    await sendAdmin(`📊 *Daily Report*\n\n🌐 Active: ${s.active} | Pending: ${s.pending}\n👥 Users: ${s.users}`);
  } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP — DB ready hone ke baad polling shuru karo
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await db.connectDB();
    await db.initSettings();
    await bot.startPolling();          // ← sirf yahan polling shuru hoti hai
    bot.on('polling_error', (e) => console.error('Polling error:', e.code, e.message));
    console.log(`✅ Bot polling started | ${DOMAIN}`);
  } catch (e) {
    console.error('❌ Startup failed:', e.message);
    process.exit(1);
  }
})();

process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message));
