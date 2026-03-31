// ── Translations ──────────────────────────────────────────────────────────────
const T = {
  en: {
    welcome: (name, domain, msg) => `⬡ *SubDomain Bot — ${domain}*\n\nHello *${name}*! 👋\n\n${msg}\n\n_Get your free subdomain now!_`,
    start_req: (domain) => `🌐 *New Subdomain Request*\n\nStep 1/3 — *Enter subdomain name:*\n\n📌 Rules:\n• Only lowercase letters, numbers, hyphens\n• 3 to 30 characters\n• Example: \`mysite\`, \`my-blog\`\n\nYou'll get: \`yourname.${domain}\`\n\n/cancel to stop.`,
    ask_purpose: (name, domain) => `✅ \`${name}.${domain}\` is available!\n\n📝 What will you use this subdomain for?\n_(Example: Portfolio, blog, project demo)_`,
    ask_hosting: `📖 *Choose Your Hosting Provider:*`,
    req_confirm: (d) => `✅ *Request Summary — Confirm:*\n\n🌐 Domain: \`${d.subdomain}.${d.domain}\`\n📝 Purpose: ${d.purpose}\n🔧 DNS: \`${d.dnsType}\` → \`${d.dnsValue}\`\n🏠 Hosting: ${d.hosting}`,
    req_submitted: (full) => `✅ *Request Submitted!*\n\n\`${full}\`\n\n⏳ Admin will review and approve.\nYou'll get a notification when approved.`,
    req_approved: (sub) => `🎉 *Subdomain Approved!*\n\n\`${sub.fullDomain}\`\n\n✅ DNS record added to Cloudflare!\n🔒 HTTPS is automatically active via Cloudflare.\n⏱ Propagation: 1–30 minutes\n\n🔍 Check: whatsmydns.net\n\n/mysubdomains — Update DNS settings`,
    req_rejected: (sub, reason) => `❌ *Subdomain Request Rejected*\n\n\`${sub.fullDomain}\`\n\nReason: _${reason}_\n\nYou can try a different name — /request`,
    dns_updated: (full, type, val) => `✅ *DNS Updated!*\n\n\`${full}\`\n\`${type}\` → \`${val}\`\n\n🌐 Cloudflare updated!\n_Propagation: 1–30 min_`,
    suspended: (full) => `⚠️ Your subdomain \`${full}\` has been suspended. Contact admin.`,
    banned: `🚫 You have been banned. Contact admin.`,
    maintenance: `🔧 Bot is under maintenance. Please try later.`,
    max_limit: (n) => `❌ You already have *${n}/${n}* subdomains.\n\nDelete one to request new — /mysubdomains`,
    no_subs: `🌐 *My Subdomains*\n\nYou have no subdomains yet.\n\nRequest one! 👇`,
    help: (domain, isAdmin) => `❓ *SubDomain Bot Help*\n\n🌐 Get free subdomains on *${domain}*\n\n*Commands:*\n/start — Main menu\n/request — New subdomain\n/mysubdomains — Your subdomains\n/language — Change language\n/cancel — Cancel action\n${isAdmin ? '\n👑 *Admin:*\n/stats — Statistics\n/broadcast <msg> — Message all users' : ''}`,
    lang_set: (l) => `✅ Language set to *${l}*`,
    file_ask: `📁 *Upload Site Files*\n\nSend your HTML/ZIP file (max 5MB).\nThis will be deployed to your subdomain.\n\n_Only .html, .zip files accepted_`,
    file_toobig: (mb) => `❌ File too big! Max allowed: *5MB*\nYour file: ${mb}MB`,
    file_wrong_type: `❌ Only .html or .zip files accepted.`,
    file_uploaded: (name, full) => `✅ *File Deployed!*\n\n📁 File: \`${name}\`\n🌐 Site: \`https://${full}\`\n\n_Your site is live! (may take 1-2 min)_`,
    broadcast_prefix_on: `📢 Broadcast prefix is now ON`,
    broadcast_prefix_off: `📢 Broadcast prefix is now OFF`,
  },
  hi: {
    welcome: (name, domain, msg) => `⬡ *SubDomain Bot — ${domain}*\n\nNamaste *${name}*! 👋\n\n${msg}\n\n_Abhi apna free subdomain lo!_`,
    start_req: (domain) => `🌐 *Naya Subdomain Request*\n\nStep 1/3 — *Subdomain naam batao:*\n\n📌 Rules:\n• Sirf lowercase letters, numbers, hyphen (-)\n• 3 se 30 characters\n• Example: \`mysite\`, \`my-blog\`\n\nAapko milega: \`yourname.${domain}\`\n\n/cancel se rok sakte ho.`,
    ask_purpose: (name, domain) => `✅ \`${name}.${domain}\` available hai!\n\n📝 Is subdomain ka kya use karoge?\n_(Example: Portfolio, blog, project demo)_`,
    ask_hosting: `📖 *Hosting Provider Chuniye:*`,
    req_confirm: (d) => `✅ *Request Summary — Confirm karo:*\n\n🌐 Domain: \`${d.subdomain}.${d.domain}\`\n📝 Purpose: ${d.purpose}\n🔧 DNS: \`${d.dnsType}\` → \`${d.dnsValue}\`\n🏠 Hosting: ${d.hosting}`,
    req_submitted: (full) => `✅ *Request Submit Ho Gayi!*\n\n\`${full}\`\n\n⏳ Admin review karega aur approve karega.\nApprove hone pe notification aayega.`,
    req_approved: (sub) => `🎉 *Subdomain Approve Ho Gayi!*\n\n\`${sub.fullDomain}\`\n\n✅ Cloudflare pe DNS record add ho gaya!\n🔒 HTTPS automatic active hai Cloudflare se.\n⏱ Propagation: 1–30 minutes\n\n🔍 Check: whatsmydns.net\n\n/mysubdomains — DNS settings update karo`,
    req_rejected: (sub, reason) => `❌ *Subdomain Request Reject Ho Gayi*\n\n\`${sub.fullDomain}\`\n\nReason: _${reason}_\n\nDusra naam try kar sakte ho — /request`,
    dns_updated: (full, type, val) => `✅ *DNS Update Ho Gaya!*\n\n\`${full}\`\n\`${type}\` → \`${val}\`\n\n🌐 Cloudflare pe update ho gaya!\n_Propagation: 1–30 min_`,
    suspended: (full) => `⚠️ Aapki subdomain \`${full}\` suspend ho gayi hai. Admin se contact karein.`,
    banned: `🚫 Aapko ban kar diya gaya hai. Admin se contact karein.`,
    maintenance: `🔧 Bot maintenance mode mein hai. Baad mein try karein.`,
    max_limit: (n) => `❌ Aapke paas already *${n}/${n}* subdomains hain.\n\nNaya request karne ke liye pehle ek delete karo — /mysubdomains`,
    no_subs: `🌐 *Mere Subdomains*\n\nAapke paas abhi koi subdomain nahi hai.\n\nNaya request karo! 👇`,
    help: (domain, isAdmin) => `❓ *SubDomain Bot Help*\n\n🌐 *${domain}* pe free subdomains lo\n\n*Commands:*\n/start — Main menu\n/request — Naya subdomain\n/mysubdomains — Apne subdomains\n/language — Language change karo\n/cancel — Cancel karo\n${isAdmin ? '\n👑 *Admin:*\n/stats — Statistics\n/broadcast <msg> — Sabko message' : ''}`,
    lang_set: (l) => `✅ Language set ho gayi: *${l}*`,
    file_ask: `📁 *Site Files Upload Karo*\n\nApna HTML/ZIP file bhejo (max 5MB).\nYeh aapke subdomain pe deploy ho jayega.\n\n_Sirf .html, .zip files allowed hain_`,
    file_toobig: (mb) => `❌ File bahut badi hai! Max: *5MB*\nAapki file: ${mb}MB`,
    file_wrong_type: `❌ Sirf .html ya .zip files allowed hain.`,
    file_uploaded: (name, full) => `✅ *File Deploy Ho Gayi!*\n\n📁 File: \`${name}\`\n🌐 Site: \`https://${full}\`\n\n_Aapki site live hai! (1-2 min lag sakta hai)_`,
    broadcast_prefix_on: `📢 Broadcast prefix ON ho gaya`,
    broadcast_prefix_off: `📢 Broadcast prefix OFF ho gaya`,
  },
};

// Auto-detect from Telegram language_code
function detectLang(langCode) {
  if (!langCode) return 'en';
  if (langCode.startsWith('hi')) return 'hi';
  return 'en';
}

function t(userId, key, ...args) {
  const { getUserLang, getUser } = require('./database');
  let lang = getUserLang(userId);
  if (lang === 'auto') {
    const u = getUser(userId);
    lang = detectLang(u?.tgLang) || 'en';
  }
  const strings = T[lang] || T['en'];
  const fn = strings[key];
  if (!fn) return T['en'][key]?.(...args) || key;
  return typeof fn === 'function' ? fn(...args) : fn;
}

module.exports = { t, detectLang, LANGS: { en: '🇬🇧 English', hi: '🇮🇳 Hindi' } };
