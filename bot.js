require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const cf = require('./cloudflare');
const db = require('./database');
const { validateSubdomain, validateDnsValue, statusEmoji, formatSubdomainCard, DNS_PRESETS } = require('./helpers');

// ── Init Bot ──────────────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID);
const DOMAIN = process.env.DOMAIN || 'yourdomain.com';

if (!TOKEN) { console.error('❌ BOT_TOKEN missing in .env'); process.exit(1); }
if (!ADMIN_ID) { console.error('❌ ADMIN_ID missing in .env'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log(`✅ SubDomain Bot started! Domain: ${DOMAIN}`);

// ── State Machine (conversation tracking) ─────────────────────────────────────
const sessions = {}; // userId → { step, data }

function getSession(userId) { return sessions[String(userId)] || {}; }
function setSession(userId, data) { sessions[String(userId)] = data; }
function clearSession(userId) { delete sessions[String(userId)]; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function isAdmin(userId) { return String(userId) === ADMIN_ID; }

function ensureUser(msg) {
  db.upsertUser(msg.from.id, {
    username: msg.from.username || '',
    firstName: msg.from.first_name || '',
    lastName: msg.from.last_name || '',
  });
  return db.getUser(msg.from.id);
}

function isBanned(userId) {
  const u = db.getUser(userId);
  return u?.banned === true;
}

async function sendAdmin(text, extra = {}) {
  return bot.sendMessage(ADMIN_ID, text, { parse_mode: 'Markdown', ...extra });
}

async function reply(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
}

// ── Main Keyboard ─────────────────────────────────────────────────────────────
function mainMenu(userId) {
  const admin = isAdmin(userId);
  const buttons = [
    [{ text: '🌐 Request Subdomain', callback_data: 'req_start' }, { text: '📋 My Subdomains', callback_data: 'my_subs' }],
    [{ text: '📖 DNS Guide', callback_data: 'dns_guide' }, { text: '🔍 Check DNS', callback_data: 'check_dns' }],
    [{ text: '❓ Help', callback_data: 'help' }, { text: '👤 My Profile', callback_data: 'profile' }],
  ];
  if (admin) {
    buttons.push([
      { text: '⚙️ Admin Panel', callback_data: 'admin_panel' },
      { text: '📢 Broadcast', callback_data: 'broadcast_start' },
    ]);
  }
  return { reply_markup: { inline_keyboard: buttons } };
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMANDS
// ══════════════════════════════════════════════════════════════════════════════

// /start
bot.onText(/\/start/, async (msg) => {
  const user = ensureUser(msg);
  if (isBanned(msg.from.id)) return reply(msg.chat.id, '🚫 Aapko ban kar diya gaya hai. Admin se contact karein.');

  const maintenance = db.getSetting('maintenanceMode');
  if (maintenance && !isAdmin(msg.from.id)) return reply(msg.chat.id, '🔧 Bot abhi maintenance mode mein hai. Baad mein try karein.');

  const welcomeMsg = db.getSetting('welcomeMsg');
  await reply(msg.chat.id,
    `⬡ *SubDomain Bot — ${DOMAIN}*\n\n` +
    `Namaste *${msg.from.first_name}*! 👋\n\n` +
    `${welcomeMsg}\n\n` +
    `_Apna free subdomain abhi lo aur website host karo!_`,
    mainMenu(msg.from.id)
  );
});

// /help
bot.onText(/\/help/, (msg) => showHelp(msg.chat.id, msg.from.id));

// /request — shortcut
bot.onText(/\/request/, (msg) => {
  ensureUser(msg);
  if (isBanned(msg.from.id)) return;
  startRequest(msg.chat.id, msg.from.id);
});

// /mysubdomains
bot.onText(/\/mysubdomains/, (msg) => {
  ensureUser(msg);
  showMySubdomains(msg.chat.id, msg.from.id);
});

// /cancel
bot.onText(/\/cancel/, (msg) => {
  clearSession(msg.from.id);
  reply(msg.chat.id, '✅ Action cancel ho gayi.', mainMenu(msg.from.id));
});

// /stats (admin)
bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  showAdminStats(msg.chat.id);
});

// /broadcast (admin)
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const text = match[1];
  const users = db.getAllUsers();
  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      await bot.sendMessage(u.id, `📢 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' });
      sent++;
    } catch { failed++; }
  }
  reply(msg.chat.id, `✅ Broadcast done!\nSent: ${sent} | Failed: ${failed}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// CALLBACK QUERY HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

bot.on('callback_query', async (query) => {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const userId = from.id;

  await bot.answerCallbackQuery(query.id);

  ensureUser({ from, chat: message.chat });
  if (isBanned(userId) && !isAdmin(userId)) return reply(chatId, '🚫 Banned.');

  // ── Main Menu ──────────────────────────────────────────────────────────────
  if (data === 'main_menu') return reply(chatId, '🏠 Main Menu:', mainMenu(userId));
  if (data === 'help') return showHelp(chatId, userId);
  if (data === 'profile') return showProfile(chatId, userId);
  if (data === 'my_subs') return showMySubdomains(chatId, userId);
  if (data === 'dns_guide') return showDnsGuide(chatId);
  if (data === 'check_dns') return startDnsCheck(chatId, userId);

  // ── Request Flow ───────────────────────────────────────────────────────────
  if (data === 'req_start') return startRequest(chatId, userId);
  if (data.startsWith('dns_preset_')) return handleDnsPreset(chatId, userId, data.replace('dns_preset_', ''));
  if (data === 'req_confirm') return confirmRequest(chatId, userId);
  if (data === 'req_cancel') { clearSession(userId); return reply(chatId, '❌ Request cancel ho gayi.', mainMenu(userId)); }

  // ── My Subdomains Actions ──────────────────────────────────────────────────
  if (data.startsWith('sub_detail_')) return showSubDetail(chatId, userId, data.replace('sub_detail_', ''));
  if (data.startsWith('sub_dns_')) return startDnsUpdate(chatId, userId, data.replace('sub_dns_', ''));
  if (data.startsWith('sub_delete_')) return confirmDeleteSub(chatId, userId, data.replace('sub_delete_', ''));
  if (data.startsWith('sub_delete_confirm_')) return doDeleteSub(chatId, userId, data.replace('sub_delete_confirm_', ''));
  if (data.startsWith('dns_update_preset_')) {
    const [preset, subId] = data.replace('dns_update_preset_', '').split('|');
    return applyDnsUpdatePreset(chatId, userId, subId, preset);
  }

  // ── Admin ──────────────────────────────────────────────────────────────────
  if (data === 'admin_panel') return showAdminPanel(chatId);
  if (data === 'admin_pending') return showPendingRequests(chatId);
  if (data === 'admin_active') return showAdminSubdomains(chatId, 'active');
  if (data === 'admin_all') return showAdminSubdomains(chatId, 'all');
  if (data === 'admin_users') return showAdminUsers(chatId);
  if (data === 'admin_settings') return showAdminSettings(chatId);
  if (data === 'admin_stats') return showAdminStats(chatId);
  if (data.startsWith('approve_')) return adminApprove(chatId, data.replace('approve_', ''));
  if (data.startsWith('reject_')) return adminReject(chatId, userId, data.replace('reject_', ''));
  if (data.startsWith('suspend_')) return adminSuspend(chatId, data.replace('suspend_', ''));
  if (data.startsWith('unsuspend_')) return adminUnsuspend(chatId, data.replace('unsuspend_', ''));
  if (data.startsWith('admin_del_')) return adminDeleteSub(chatId, data.replace('admin_del_', ''));
  if (data.startsWith('ban_user_')) return adminBanUser(chatId, data.replace('ban_user_', ''));
  if (data.startsWith('unban_user_')) return adminUnbanUser(chatId, data.replace('unban_user_', ''));
  if (data === 'toggle_approval') return toggleApproval(chatId);
  if (data === 'toggle_maintenance') return toggleMaintenance(chatId);
  if (data === 'broadcast_start') return startBroadcast(chatId, userId);
  if (data === 'set_welcome') return startSetWelcome(chatId, userId);
  if (data === 'set_maxsubs') return startSetMaxSubs(chatId, userId);
});

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER — Conversation state machine
// ══════════════════════════════════════════════════════════════════════════════

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return; // commands handled above
  if (!msg.text) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const session = getSession(userId);

  if (!session.step) return; // no active conversation

  // ── Request: Step 1 — subdomain name ──────────────────────────────────────
  if (session.step === 'req_name') {
    const name = text.toLowerCase().trim();
    const err = validateSubdomain(name);
    if (err) return reply(chatId, err + '\n\nDobara try karein ya /cancel karein.');

    const existing = db.getSubdomain(name);
    if (existing) return reply(chatId, `❌ \`${name}.${DOMAIN}\` already le li gayi hai. Koi aur naam try karein.`);

    setSession(userId, { ...session, step: 'req_purpose', data: { ...session.data, subdomain: name } });
    return reply(chatId,
      `✅ \`${name}.${DOMAIN}\` available hai!\n\n` +
      `📝 Ab batao — is subdomain ka kya use karoge?\n_(Example: Portfolio website, blog, project demo, etc.)_\n\n/cancel se rok sakte ho.`
    );
  }

  // ── Request: Step 2 — purpose ──────────────────────────────────────────────
  if (session.step === 'req_purpose') {
    if (text.length < 5) return reply(chatId, '❌ Thoda detail mein batao purpose kya hai (kam se kam 5 characters).');

    setSession(userId, { ...session, step: 'req_dns_type', data: { ...session.data, purpose: text } });
    return reply(chatId,
      `📖 *DNS Setup — Hosting Provider Chuniye*\n\nApni website kahan host karoge?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '▲ Vercel', callback_data: 'dns_preset_vercel' }, { text: '◈ Netlify', callback_data: 'dns_preset_netlify' }],
            [{ text: '● GitHub Pages', callback_data: 'dns_preset_github' }, { text: '◉ Custom VPS/IP', callback_data: 'dns_preset_vps' }],
            [{ text: '⬡ NS Delegation (Full control)', callback_data: 'dns_preset_ns' }],
            [{ text: '✏️ Manual (khud fill karunga)', callback_data: 'dns_preset_manual' }],
          ],
        },
      }
    );
  }

  // ── Request: Step 3a — manual DNS type ────────────────────────────────────
  if (session.step === 'req_dns_type_manual') {
    const type = text.toUpperCase();
    const allowed = ['CNAME', 'A', 'NS', 'TXT'];
    if (!allowed.includes(type)) return reply(chatId, `❌ Sirf ${allowed.join(', ')} allowed hain.`);
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: type } });
    return reply(chatId, `📌 DNS value daalo (${type} record ke liye):\n\nExample:\n${type === 'A' ? '`1.2.3.4`' : type === 'CNAME' ? '`target.example.com`' : '`ns1.provider.com`'}`);
  }

  // ── Request: Step 3b — DNS value ──────────────────────────────────────────
  if (session.step === 'req_dns_value') {
    const err = validateDnsValue(session.data.dnsType, text);
    if (err) return reply(chatId, err);
    setSession(userId, { ...session, step: 'req_confirm_wait', data: { ...session.data, dnsValue: text } });
    return showRequestConfirm(chatId, userId);
  }

  // ── DNS Check: enter subdomain ─────────────────────────────────────────────
  if (session.step === 'dns_check') {
    clearSession(userId);
    const name = text.toLowerCase().trim();
    try {
      const records = await cf.listRecords(name);
      if (!records.length) return reply(chatId, `🔍 \`${name}.${DOMAIN}\`\n\n❌ Koi DNS record nahi mila Cloudflare pe.\n\n_DNS propagation pending ho sakta hai (wait 5–30 min)_`);
      const list = records.map(r => `• \`${r.type}\` → \`${r.content}\``).join('\n');
      reply(chatId, `🔍 *DNS Records — ${name}.${DOMAIN}*\n\n${list}\n\n✅ Records Cloudflare pe active hain!`);
    } catch (e) {
      reply(chatId, `❌ DNS check failed: ${e.message}\n\n_Cloudflare API configure nahi hai ya record exist nahi karta._`);
    }
    return;
  }

  // ── DNS Update: enter value ────────────────────────────────────────────────
  if (session.step === 'dns_update_value') {
    const { subId, dnsType } = session.data;
    const err = validateDnsValue(dnsType, text);
    if (err) return reply(chatId, err);

    clearSession(userId);
    const sub = db.getSubdomainById(subId);
    if (!sub || sub.userId !== String(userId)) return reply(chatId, '❌ Subdomain nahi mila.');

    try {
      const record = await cf.updateRecord(sub.cfRecordId, sub.subdomain, dnsType, text);
      db.updateSubdomain(subId, { dnsType, dnsValue: text, cfRecordId: record.id });
      reply(chatId, `✅ *DNS Updated Successfully!*\n\n\`${sub.subdomain}.${DOMAIN}\`\n\`${dnsType}\` → \`${text}\`\n\n🌐 Cloudflare pe record update ho gaya!\n_Propagation: 1–30 minutes_`, mainMenu(userId));
    } catch (e) {
      reply(chatId, `❌ DNS update failed: ${e.message}`, mainMenu(userId));
    }
    return;
  }

  // ── Admin: reject reason ───────────────────────────────────────────────────
  if (session.step === 'admin_reject_reason') {
    const { subId } = session.data;
    clearSession(userId);
    const sub = db.getSubdomainById(subId);
    if (!sub) return reply(chatId, '❌ Not found.');

    db.updateSubdomain(subId, { status: 'rejected', rejectReason: text });
    reply(chatId, `❌ Subdomain \`${sub.subdomain}.${DOMAIN}\` reject kar diya gaya.\nReason: _${text}_`);
    try {
      bot.sendMessage(sub.userId,
        `❌ *Subdomain Request Rejected*\n\n\`${sub.subdomain}.${DOMAIN}\`\n\nReason: _${text}_\n\nAap dusra naam try kar sakte hain — /request`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
    return;
  }

  // ── Admin: broadcast message ──────────────────────────────────────────────
  if (session.step === 'broadcast_msg') {
    if (!isAdmin(userId)) return;
    clearSession(userId);
    const users = db.getAllUsers();
    let sent = 0, failed = 0;
    await reply(chatId, `📤 Sending to ${users.length} users...`);
    for (const u of users) {
      try {
        await bot.sendMessage(u.id, `📢 *Announcement from Admin*\n\n${text}`, { parse_mode: 'Markdown' });
        sent++;
        await new Promise(r => setTimeout(r, 35)); // rate limit safe
      } catch { failed++; }
    }
    reply(chatId, `✅ Broadcast complete!\n✉️ Sent: ${sent}\n❌ Failed: ${failed}`);
    return;
  }

  // ── Admin: set welcome message ────────────────────────────────────────────
  if (session.step === 'set_welcome') {
    if (!isAdmin(userId)) return;
    clearSession(userId);
    db.setSetting('welcomeMsg', text);
    reply(chatId, `✅ Welcome message update ho gaya!\n\n_"${text}"_`);
    return;
  }

  // ── Admin: set max subdomains ─────────────────────────────────────────────
  if (session.step === 'set_maxsubs') {
    if (!isAdmin(userId)) return;
    clearSession(userId);
    const n = parseInt(text);
    if (isNaN(n) || n < 1 || n > 20) return reply(chatId, '❌ 1 se 20 ke beech number daalo.');
    db.setSetting('maxPerUser', n);
    reply(chatId, `✅ Max subdomains per user set to *${n}*`);
    return;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── Help ──────────────────────────────────────────────────────────────────────
function showHelp(chatId, userId) {
  const adminSection = isAdmin(userId) ? '\n\n👑 *Admin Commands:*\n/stats — Statistics\n/broadcast <msg> — Sabko message' : '';
  reply(chatId,
    `❓ *SubDomain Bot Help*\n\n` +
    `🌐 *${DOMAIN}* pe free subdomains do aur users ki hosting help karo.\n\n` +
    `*User Commands:*\n` +
    `/start — Main menu\n` +
    `/request — Naya subdomain request karo\n` +
    `/mysubdomains — Apne subdomains dekho\n` +
    `/cancel — Current action cancel karo\n` +
    `${adminSection}\n\n` +
    `*DNS Types:*\n` +
    `\`CNAME\` — Vercel, Netlify, GitHub Pages\n` +
    `\`A\` — Custom server/VPS\n` +
    `\`NS\` — Full DNS delegation\n\n` +
    `_Kisi bhi problem mein admin se contact karein._`,
    mainMenu(userId)
  );
}

// ── Profile ───────────────────────────────────────────────────────────────────
function showProfile(chatId, userId) {
  const user = db.getUser(userId);
  const subs = db.getUserSubdomains(userId);
  const active = subs.filter(s => s.status === 'active').length;
  const pending = subs.filter(s => s.status === 'pending').length;
  const maxPerUser = db.getSetting('maxPerUser');

  reply(chatId,
    `👤 *Your Profile*\n\n` +
    `🆔 ID: \`${userId}\`\n` +
    `👤 Name: ${user?.firstName || ''} ${user?.lastName || ''}\n` +
    `📛 Username: ${user?.username ? '@' + user.username : 'N/A'}\n` +
    `📅 Joined: ${user?.joinedAt?.split('T')[0] || 'N/A'}\n\n` +
    `🌐 *Subdomains:*\n` +
    `├ Total: ${subs.length}/${maxPerUser}\n` +
    `├ Active: 🟢 ${active}\n` +
    `└ Pending: 🟡 ${pending}\n\n` +
    `${user?.banned ? '🚫 Status: *BANNED*' : '✅ Status: Active'}`,
    mainMenu(userId)
  );
}

// ── Start Request ─────────────────────────────────────────────────────────────
function startRequest(chatId, userId) {
  const maxPerUser = db.getSetting('maxPerUser');
  const userSubs = db.getUserSubdomains(userId).filter(s => ['active', 'pending'].includes(s.status));

  if (userSubs.length >= maxPerUser) {
    return reply(chatId,
      `❌ Aapke paas already *${userSubs.length}/${maxPerUser}* subdomains hain.\n\n` +
      `Naya request karne ke liye pehle koi purana delete karo.\n\n/mysubdomains — Dekho`,
      mainMenu(userId)
    );
  }

  clearSession(userId);
  setSession(userId, { step: 'req_name', data: {} });
  reply(chatId,
    `🌐 *New Subdomain Request*\n\n` +
    `Step 1/3 — *Subdomain naam batao:*\n\n` +
    `📌 Rules:\n` +
    `• Sirf lowercase letters, numbers, hyphen (-)\n` +
    `• 3 se 30 characters\n` +
    `• Example: \`mysite\`, \`my-blog\`, \`portfolio2024\`\n\n` +
    `Aapko milega: \`yourname.${DOMAIN}\`\n\n` +
    `/cancel se rok sakte ho.`
  );
}

// ── DNS Preset Handler ────────────────────────────────────────────────────────
function handleDnsPreset(chatId, userId, preset) {
  const session = getSession(userId);

  if (preset === 'manual') {
    setSession(userId, { ...session, step: 'req_dns_type_manual' });
    return reply(chatId, '✏️ DNS record type batao:\n\n`CNAME` | `A` | `NS` | `TXT`');
  }

  const p = DNS_PRESETS[preset];
  if (!p) return;

  setSession(userId, { ...session, step: 'req_confirm_wait', data: { ...session.data, dnsType: p.type, dnsValue: p.value, hostingProvider: preset } });

  if (preset === 'vps') {
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: 'A', hostingProvider: 'vps' } });
    return reply(chatId, `◉ *Custom VPS/Server*\n\nApna server IP daalo:\nExample: \`1.2.3.4\``);
  }

  if (preset === 'netlify') {
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: 'CNAME', hostingProvider: 'netlify' } });
    return reply(chatId, `◈ *Netlify*\n\nApna Netlify site URL daalo:\nExample: \`my-site-name.netlify.app\``);
  }

  if (preset === 'github') {
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: 'CNAME', hostingProvider: 'github' } });
    return reply(chatId, `● *GitHub Pages*\n\nApna GitHub Pages URL daalo:\nExample: \`username.github.io\``);
  }

  if (preset === 'ns') {
    setSession(userId, { ...session, step: 'req_dns_value', data: { ...session.data, dnsType: 'NS', hostingProvider: 'ns' } });
    return reply(chatId, `⬡ *NS Delegation*\n\nApna primary nameserver daalo:\nExample: \`ns1.yourprovider.com\`\n\n_Note: Ek NS record add hoga — baad mein admin se zyada add karne ko bol sakte ho._`);
  }

  if (preset === 'vercel') {
    setSession(userId, { ...session, step: 'req_confirm_wait', data: { ...session.data, dnsType: 'CNAME', dnsValue: 'cname.vercel-dns.com', hostingProvider: 'vercel' } });
    return showRequestConfirm(chatId, userId);
  }
}

// ── Show Confirm ──────────────────────────────────────────────────────────────
function showRequestConfirm(chatId, userId) {
  const { data } = getSession(userId);
  reply(chatId,
    `✅ *Request Summary — Confirm karo:*\n\n` +
    `🌐 Domain: \`${data.subdomain}.${DOMAIN}\`\n` +
    `📝 Purpose: ${data.purpose}\n` +
    `🔧 DNS Type: \`${data.dnsType}\`\n` +
    `📌 DNS Value: \`${data.dnsValue}\`\n` +
    `🏠 Hosting: ${data.hostingProvider || 'custom'}\n\n` +
    `${db.getSetting('requireApproval') ? '⏳ Admin approval required hogi.' : '✅ Auto-approved!'}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm & Submit', callback_data: 'req_confirm' }, { text: '❌ Cancel', callback_data: 'req_cancel' }],
        ],
      },
    }
  );
}

// ── Confirm Request ───────────────────────────────────────────────────────────
async function confirmRequest(chatId, userId) {
  const session = getSession(userId);
  if (!session.data?.subdomain) return reply(chatId, '❌ Session expired. /request se dobara try karo.');

  const { data } = session;
  clearSession(userId);

  const requireApproval = db.getSetting('requireApproval');
  const maxPerUser = db.getSetting('maxPerUser');
  const existing = db.getSubdomain(data.subdomain);
  if (existing) return reply(chatId, `❌ \`${data.subdomain}.${DOMAIN}\` already le li gayi. Koi aur naam try karo.`);

  const userSubs = db.getUserSubdomains(userId).filter(s => ['active', 'pending'].includes(s.status));
  if (userSubs.length >= maxPerUser) return reply(chatId, `❌ Max ${maxPerUser} subdomains limit reach ho gayi.`);

  const subId = uuidv4();
  let cfRecordId = null;
  let status = requireApproval ? 'pending' : 'active';

  if (!requireApproval && data.dnsType && data.dnsValue) {
    try {
      const record = await cf.addRecord(data.subdomain, data.dnsType, data.dnsValue);
      cfRecordId = record.id;
    } catch (e) {
      console.error('CF error:', e.message);
    }
  }

  db.addSubdomain({
    id: subId,
    userId: String(userId),
    userName: db.getUser(userId)?.firstName || '',
    userUsername: db.getUser(userId)?.username || '',
    subdomain: data.subdomain,
    fullDomain: `${data.subdomain}.${DOMAIN}`,
    purpose: data.purpose,
    dnsType: data.dnsType,
    dnsValue: data.dnsValue,
    hostingProvider: data.hostingProvider || 'custom',
    status,
    cfRecordId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  if (!requireApproval) {
    reply(chatId,
      `🎉 *Subdomain Active Ho Gayi!*\n\n` +
      `\`${data.subdomain}.${DOMAIN}\`\n\n` +
      `✅ DNS record Cloudflare pe add ho gaya!\n` +
      `⏱ Propagation: 1–30 minutes\n\n` +
      `🔍 Check: whatsmydns.net pe verify karo`,
      mainMenu(userId)
    );
  } else {
    reply(chatId,
      `✅ *Request Submit Ho Gayi!*\n\n` +
      `\`${data.subdomain}.${DOMAIN}\`\n\n` +
      `⏳ Admin review karega aur approve karega.\n` +
      `Approve hone pe aapko notification aayega.`,
      mainMenu(userId)
    );

    // Notify admin
    sendAdmin(
      `🔔 *New Subdomain Request!*\n\n` +
      `👤 User: ${db.getUser(userId)?.firstName} (@${db.getUser(userId)?.username || 'N/A'})\n` +
      `🆔 UserID: \`${userId}\`\n` +
      `🌐 Domain: \`${data.subdomain}.${DOMAIN}\`\n` +
      `📝 Purpose: ${data.purpose}\n` +
      `🔧 DNS: \`${data.dnsType}\` → \`${data.dnsValue}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve_${subId}` },
            { text: '❌ Reject', callback_data: `reject_${subId}` },
          ]],
        },
      }
    );
  }
}

// ── My Subdomains ─────────────────────────────────────────────────────────────
function showMySubdomains(chatId, userId) {
  const subs = db.getUserSubdomains(userId);
  if (!subs.length) {
    return reply(chatId,
      `🌐 *My Subdomains*\n\nAapke paas abhi koi subdomain nahi hai.\n\nNaya request karo! 👇`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🌐 Request Subdomain', callback_data: 'req_start' }]] },
      }
    );
  }

  const buttons = subs.map(s => ([{
    text: `${statusEmoji(s.status)} ${s.subdomain}.${DOMAIN}`,
    callback_data: `sub_detail_${s.id}`,
  }]));
  buttons.push([{ text: '🏠 Main Menu', callback_data: 'main_menu' }]);

  reply(chatId,
    `🌐 *My Subdomains* (${subs.length})\n\nEk select karo details ke liye:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

// ── Subdomain Detail ──────────────────────────────────────────────────────────
function showSubDetail(chatId, userId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return reply(chatId, '❌ Not found.');

  const buttons = [];
  if (sub.status === 'active') {
    buttons.push([
      { text: '⚙️ Update DNS', callback_data: `sub_dns_${subId}` },
      { text: '🔗 Open Site', url: `https://${sub.fullDomain}` },
    ]);
  }
  buttons.push([{ text: '🗑️ Delete', callback_data: `sub_delete_${subId}` }, { text: '◀ Back', callback_data: 'my_subs' }]);

  reply(chatId, formatSubdomainCard(sub), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  });
}

// ── DNS Update ────────────────────────────────────────────────────────────────
function startDnsUpdate(chatId, userId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return reply(chatId, '❌ Not found.');

  reply(chatId,
    `⚙️ *DNS Update — ${sub.subdomain}.${DOMAIN}*\n\nHosting provider chuniye:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '▲ Vercel', callback_data: `dns_update_preset_vercel|${subId}` }, { text: '◈ Netlify', callback_data: `dns_update_preset_netlify|${subId}` }],
          [{ text: '● GitHub Pages', callback_data: `dns_update_preset_github|${subId}` }, { text: '◉ VPS', callback_data: `dns_update_preset_vps|${subId}` }],
          [{ text: '⬡ NS Delegation', callback_data: `dns_update_preset_ns|${subId}` }],
          [{ text: '✏️ Manual', callback_data: `dns_update_preset_manual|${subId}` }],
        ],
      },
    }
  );
}

async function applyDnsUpdatePreset(chatId, userId, subId, preset) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return reply(chatId, '❌ Not found.');

  const needsValue = ['netlify', 'github', 'vps', 'ns', 'manual'];
  if (needsValue.includes(preset)) {
    const p = DNS_PRESETS[preset] || { type: 'CNAME' };
    const type = preset === 'vps' ? 'A' : preset === 'ns' ? 'NS' : 'CNAME';
    setSession(userId, { step: 'dns_update_value', data: { subId, dnsType: type } });
    return reply(chatId,
      `✏️ ${type} record value daalo:\n\n` +
      (type === 'A' ? 'Example: `1.2.3.4`' : type === 'NS' ? 'Example: `ns1.provider.com`' : 'Example: `target.example.com`')
    );
  }

  if (preset === 'vercel') {
    try {
      const record = await cf.updateRecord(sub.cfRecordId, sub.subdomain, 'CNAME', 'cname.vercel-dns.com');
      db.updateSubdomain(subId, { dnsType: 'CNAME', dnsValue: 'cname.vercel-dns.com', cfRecordId: record.id });
      reply(chatId, `✅ DNS updated!\n\`CNAME\` → \`cname.vercel-dns.com\`\n\n_Cloudflare pe update ho gaya!_`, mainMenu(userId));
    } catch (e) {
      reply(chatId, `❌ Failed: ${e.message}`);
    }
  }
}

// ── Delete Subdomain ──────────────────────────────────────────────────────────
function confirmDeleteSub(chatId, userId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return reply(chatId, '❌ Not found.');

  reply(chatId,
    `⚠️ *Delete Subdomain?*\n\n\`${sub.fullDomain}\`\n\nCloudflare DNS record bhi remove ho jayega.\n\n*Yeh undo nahi ho sakta!*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🗑️ Haan, Delete Karo', callback_data: `sub_delete_confirm_${subId}` },
          { text: '❌ Cancel', callback_data: `sub_detail_${subId}` },
        ]],
      },
    }
  );
}

async function doDeleteSub(chatId, userId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub || sub.userId !== String(userId)) return reply(chatId, '❌ Not found.');

  if (sub.cfRecordId) {
    try { await cf.deleteRecord(sub.cfRecordId); } catch {}
  }

  db.deleteSubdomain(subId);
  reply(chatId, `✅ \`${sub.fullDomain}\` delete ho gayi!\n\nCloudflare DNS record bhi remove ho gaya.`, mainMenu(userId));
}

// ── DNS Guide ─────────────────────────────────────────────────────────────────
function showDnsGuide(chatId) {
  reply(chatId,
    `📖 *DNS Setup Guide*\n\n` +
    `Apna subdomain approve hone ke baad, DNS setup karo:\n\n` +

    `*▲ Vercel:*\n` +
    `\`CNAME\` → \`cname.vercel-dns.com\`\n` +
    `_(Vercel → Settings → Domains mein bhi add karo)_\n\n` +

    `*◈ Netlify:*\n` +
    `\`CNAME\` → \`yoursite.netlify.app\`\n\n` +

    `*● GitHub Pages:*\n` +
    `\`CNAME\` → \`username.github.io\`\n` +
    `_(Repo mein CNAME file bhi banana hoga)_\n\n` +

    `*◉ Custom VPS / cPanel:*\n` +
    `\`A\` → \`your.server.ip\`\n\n` +

    `*⬡ NS Delegation (Full control):*\n` +
    `\`NS\` → \`ns1.yourprovider.com\`\n` +
    `\`NS\` → \`ns2.yourprovider.com\`\n` +
    `_(Poora subdomain DNS aapke control mein)_\n\n` +

    `⏱ *Propagation:* 5 min – 48 hours\n` +
    `🔍 *Check:* whatsmydns.net\n` +
    `🔒 *SSL:* Cloudflare free SSL automatic`
  );
}

// ── DNS Check ─────────────────────────────────────────────────────────────────
function startDnsCheck(chatId, userId) {
  setSession(userId, { step: 'dns_check' });
  reply(chatId, `🔍 *DNS Check*\n\nSubdomain ka naam daalo check karne ke liye:\n(sirf subdomain, domain nahi)\n\nExample: agar \`mysite.${DOMAIN}\` check karna hai to sirf \`mysite\` likho`);
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

function showAdminPanel(chatId) {
  const stats = getStats();
  reply(chatId,
    `⚙️ *Admin Panel*\n\n` +
    `🌐 Domain: \`${DOMAIN}\`\n` +
    `📊 Total: ${stats.total} | 🟢 Active: ${stats.active} | 🟡 Pending: ${stats.pending}\n` +
    `👥 Users: ${stats.users} | ⚙️ Approval: ${db.getSetting('requireApproval') ? 'ON' : 'OFF'}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `🟡 Pending (${stats.pending})`, callback_data: 'admin_pending' }, { text: '🟢 Active', callback_data: 'admin_active' }],
          [{ text: '📋 All Subdomains', callback_data: 'admin_all' }, { text: '👥 Users', callback_data: 'admin_users' }],
          [{ text: '📊 Stats', callback_data: 'admin_stats' }, { text: '⚙️ Settings', callback_data: 'admin_settings' }],
          [{ text: '📢 Broadcast', callback_data: 'broadcast_start' }, { text: '🏠 Menu', callback_data: 'main_menu' }],
        ],
      },
    }
  );
}

function getStats() {
  const subs = db.getAllSubdomains();
  return {
    total: subs.length,
    active: subs.filter(s => s.status === 'active').length,
    pending: subs.filter(s => s.status === 'pending').length,
    suspended: subs.filter(s => s.status === 'suspended').length,
    users: db.getAllUsers().length,
  };
}

function showAdminStats(chatId) {
  const s = getStats();
  const users = db.getAllUsers();
  const banned = users.filter(u => u.banned).length;

  reply(chatId,
    `📊 *Bot Statistics*\n\n` +
    `🌐 *Subdomains:*\n` +
    `├ Total: ${s.total}\n` +
    `├ 🟢 Active: ${s.active}\n` +
    `├ 🟡 Pending: ${s.pending}\n` +
    `└ 🔴 Suspended: ${s.suspended}\n\n` +
    `👥 *Users:*\n` +
    `├ Total: ${s.users}\n` +
    `└ Banned: ${banned}\n\n` +
    `⚙️ *Settings:*\n` +
    `├ Domain: \`${DOMAIN}\`\n` +
    `├ Max/user: ${db.getSetting('maxPerUser')}\n` +
    `├ Approval: ${db.getSetting('requireApproval') ? '✅ Required' : '❌ Auto-approve'}\n` +
    `└ Maintenance: ${db.getSetting('maintenanceMode') ? '🔧 ON' : '✅ OFF'}`
  );
}

function showPendingRequests(chatId) {
  const pending = db.getAllSubdomains({ status: 'pending' });
  if (!pending.length) return reply(chatId, '✅ Koi pending request nahi!', { reply_markup: { inline_keyboard: [[{ text: '◀ Admin Panel', callback_data: 'admin_panel' }]] } });

  for (const s of pending.slice(0, 8)) {
    bot.sendMessage(chatId,
      `🟡 *Pending Request*\n\n` +
      `🌐 \`${s.fullDomain}\`\n` +
      `👤 ${s.userName} (@${s.userUsername || 'N/A'}) | ID: \`${s.userId}\`\n` +
      `📝 Purpose: ${s.purpose}\n` +
      `🔧 DNS: \`${s.dnsType}\` → \`${s.dnsValue}\`\n` +
      `📅 ${s.createdAt?.split('T')[0]}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve_${s.id}` },
            { text: '❌ Reject', callback_data: `reject_${s.id}` },
            { text: '🚫 Ban User', callback_data: `ban_user_${s.userId}` },
          ]],
        },
      }
    );
  }
}

function showAdminSubdomains(chatId, filter) {
  const subs = filter === 'all' ? db.getAllSubdomains() : db.getAllSubdomains({ status: filter });
  if (!subs.length) return reply(chatId, `📋 Koi subdomain nahi (${filter}).`);

  const list = subs.slice(0, 15).map(s =>
    `${statusEmoji(s.status)} \`${s.subdomain}\` — ${s.userName} (@${s.userUsername || 'N/A'})`
  ).join('\n');

  reply(chatId, `📋 *Subdomains (${filter}) — ${subs.length} total*\n\n${list}${subs.length > 15 ? '\n\n_...aur bhi hain_' : ''}`);
}

function showAdminUsers(chatId) {
  const users = db.getAllUsers();
  if (!users.length) return reply(chatId, '👥 Koi user nahi.');

  const list = users.slice(0, 20).map(u => {
    const subs = db.getUserSubdomains(u.id).length;
    return `${u.banned ? '🚫' : '✅'} ${u.firstName} (@${u.username || 'N/A'}) — ${subs} subs`;
  }).join('\n');

  reply(chatId, `👥 *Users (${users.length})*\n\n${list}`);
}

function showAdminSettings(chatId) {
  reply(chatId,
    `⚙️ *Bot Settings*\n\n` +
    `🌐 Domain: \`${DOMAIN}\`\n` +
    `📊 Max/user: ${db.getSetting('maxPerUser')}\n` +
    `✅ Approval: ${db.getSetting('requireApproval') ? 'Required' : 'Auto'}\n` +
    `🔧 Maintenance: ${db.getSetting('maintenanceMode') ? 'ON' : 'OFF'}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `${db.getSetting('requireApproval') ? '✅' : '❌'} Toggle Approval`, callback_data: 'toggle_approval' }],
          [{ text: `${db.getSetting('maintenanceMode') ? '🔧' : '✅'} Toggle Maintenance`, callback_data: 'toggle_maintenance' }],
          [{ text: '📝 Set Welcome Message', callback_data: 'set_welcome' }],
          [{ text: '🔢 Set Max Subdomains/User', callback_data: 'set_maxsubs' }],
          [{ text: '◀ Back', callback_data: 'admin_panel' }],
        ],
      },
    }
  );
}

// ── Approve ───────────────────────────────────────────────────────────────────
async function adminApprove(chatId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');
  if (sub.status === 'active') return reply(chatId, '✅ Already active hai!');

  let cfRecordId = sub.cfRecordId;
  try {
    if (sub.dnsType && sub.dnsValue) {
      const record = await cf.addRecord(sub.subdomain, sub.dnsType, sub.dnsValue);
      cfRecordId = record.id;
    }
  } catch (e) {
    console.error('CF approve error:', e.message);
  }

  db.updateSubdomain(subId, { status: 'active', cfRecordId });
  reply(chatId, `✅ *Approved!*\n\`${sub.fullDomain}\`\n\nCloudflare DNS record ${cfRecordId ? 'add ho gaya ✅' : 'add nahi ho paya ⚠️ (CF config check karo)'}`);

  try {
    bot.sendMessage(sub.userId,
      `🎉 *Subdomain Approved!*\n\n` +
      `\`${sub.fullDomain}\`\n\n` +
      `✅ Aapka subdomain active ho gaya!\n\n` +
      `*DNS Setup:*\n\`${sub.dnsType}\` → \`${sub.dnsValue}\`\n\n` +
      `⏱ Propagation: 1–30 minutes\n` +
      `🔍 Check: whatsmydns.net pe verify karo\n\n` +
      `/mysubdomains — DNS update karo`,
      { parse_mode: 'Markdown' }
    );
  } catch {}
}

// ── Reject ────────────────────────────────────────────────────────────────────
function adminReject(chatId, adminUserId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');
  setSession(adminUserId, { step: 'admin_reject_reason', data: { subId } });
  reply(chatId, `❌ Reject reason batao:\n\n_${sub.fullDomain}_ ke liye rejection reason type karo:`);
}

// ── Suspend / Unsuspend ───────────────────────────────────────────────────────
async function adminSuspend(chatId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');

  if (sub.cfRecordId) {
    try { await cf.deleteRecord(sub.cfRecordId); } catch {}
  }
  db.updateSubdomain(subId, { status: 'suspended', cfRecordId: null });
  reply(chatId, `🔴 \`${sub.fullDomain}\` suspend ho gayi.\nCloudflare DNS record remove ho gaya.`);
  try { bot.sendMessage(sub.userId, `⚠️ Aapki subdomain \`${sub.fullDomain}\` suspend ho gayi hai. Admin se contact karein.`, { parse_mode: 'Markdown' }); } catch {}
}

async function adminUnsuspend(chatId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');

  let cfRecordId = null;
  try {
    if (sub.dnsType && sub.dnsValue) {
      const r = await cf.addRecord(sub.subdomain, sub.dnsType, sub.dnsValue);
      cfRecordId = r.id;
    }
  } catch {}

  db.updateSubdomain(subId, { status: 'active', cfRecordId });
  reply(chatId, `🟢 \`${sub.fullDomain}\` active ho gayi!`);
}

async function adminDeleteSub(chatId, subId) {
  const sub = db.getSubdomainById(subId);
  if (!sub) return reply(chatId, '❌ Not found.');
  if (sub.cfRecordId) { try { await cf.deleteRecord(sub.cfRecordId); } catch {} }
  db.deleteSubdomain(subId);
  reply(chatId, `✅ \`${sub.fullDomain}\` delete kar di gayi.`);
}

// ── Ban / Unban ───────────────────────────────────────────────────────────────
function adminBanUser(chatId, userId) {
  db.upsertUser(userId, { banned: true });
  reply(chatId, `🚫 User \`${userId}\` ban ho gaya.`);
  try { bot.sendMessage(userId, '🚫 Aapko ban kar diya gaya hai.'); } catch {}
}

function adminUnbanUser(chatId, userId) {
  db.upsertUser(userId, { banned: false });
  reply(chatId, `✅ User \`${userId}\` unban ho gaya.`);
}

// ── Toggle Settings ───────────────────────────────────────────────────────────
function toggleApproval(chatId) {
  const curr = db.getSetting('requireApproval');
  db.setSetting('requireApproval', !curr);
  reply(chatId, `✅ Approval requirement: *${!curr ? 'ON (manual approve)' : 'OFF (auto-approve)'}*`);
}

function toggleMaintenance(chatId) {
  const curr = db.getSetting('maintenanceMode');
  db.setSetting('maintenanceMode', !curr);
  reply(chatId, `✅ Maintenance mode: *${!curr ? 'ON' : 'OFF'}*`);
}

function startBroadcast(chatId, userId) {
  if (!isAdmin(userId)) return;
  setSession(userId, { step: 'broadcast_msg' });
  reply(chatId, `📢 *Broadcast Message*\n\nWoh message type karo jo sabko bhejna hai:\n\n/cancel se rok sakte ho.`);
}

function startSetWelcome(chatId, userId) {
  if (!isAdmin(userId)) return;
  setSession(userId, { step: 'set_welcome' });
  reply(chatId, `📝 Naya welcome message type karo:\n\n(Current: _${db.getSetting('welcomeMsg')}_)`);
}

function startSetMaxSubs(chatId, userId) {
  if (!isAdmin(userId)) return;
  setSession(userId, { step: 'set_maxsubs' });
  reply(chatId, `🔢 Max subdomains per user set karo (1-20):\n\n(Current: ${db.getSetting('maxPerUser')})`);
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
// ── Cron: Daily Stats to Admin ────────────────────────────────────────────────
cron.schedule('0 9 * * *', () => {
  const s = getStats();
  sendAdmin(`📊 *Daily Stats — ${new Date().toLocaleDateString('en-IN')}*\n\n🌐 Total Subdomains: ${s.total}\n🟢 Active: ${s.active}\n🟡 Pending: ${s.pending}\n👥 Users: ${s.users}`);
});

// ── Error handling ────────────────────────────────────────────────────────────
bot.on('polling_error', (err) => console.error('Polling error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));

console.log(`🤖 Bot is running! Send /start to @your_bot`);
