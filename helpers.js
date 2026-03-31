const { getSetting } = require('./database');

// ── Subdomain Validation ──────────────────────────────────────────────────────
function validateSubdomain(name) {
  if (!name) return '❌ Subdomain name required hai.';
  name = name.toLowerCase().trim();
  if (name.length < 3) return '❌ Subdomain kam se kam 3 characters ka hona chahiye.';
  if (name.length > 30) return '❌ Subdomain zyada se zyada 30 characters ka ho sakta hai.';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z0-9]$/.test(name))
    return '❌ Sirf lowercase letters (a-z), numbers (0-9) aur hyphen (-) allowed hai.';
  if (/--/.test(name)) return '❌ Double hyphen (--) allowed nahi.';

  const banned = getSetting('bannedWords') || [];
  if (banned.includes(name)) return `❌ "${name}" reserved word hai — dusra naam chuniye.`;

  return null; // valid
}

// ── DNS Validation ────────────────────────────────────────────────────────────
function validateDnsValue(type, value) {
  value = value.trim();
  if (!value) return '❌ DNS value empty hai.';

  if (type === 'A') {
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(value)) return '❌ A record ke liye valid IPv4 address chahiye.\nExample: `1.2.3.4`';
    const parts = value.split('.').map(Number);
    if (parts.some(p => p > 255)) return '❌ Invalid IP address.';
  }

  if (type === 'CNAME') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value))
      return '❌ CNAME ke liye valid domain chahiye.\nExample: `cname.vercel-dns.com`';
  }

  if (type === 'NS') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value))
      return '❌ NS ke liye valid nameserver domain chahiye.\nExample: `ns1.cloudflare.com`';
  }

  return null; // valid
}

// ── Status Emoji ──────────────────────────────────────────────────────────────
function statusEmoji(status) {
  const map = { active: '🟢', pending: '🟡', suspended: '🔴', rejected: '❌' };
  return map[status] || '⚪';
}

// ── Format Subdomain Card ─────────────────────────────────────────────────────
function formatSubdomainCard(s) {
  const domain = getSetting('domain');
  return [
    `${statusEmoji(s.status)} *${s.subdomain}.${domain}*`,
    `├ Status: \`${s.status.toUpperCase()}\``,
    `├ DNS: \`${s.dnsType || 'Not set'}\` → \`${s.dnsValue || '—'}\``,
    `├ CF Record: \`${s.cfRecordId ? '✅ Linked' : '❌ Not linked'}\``,
    `├ Purpose: ${s.purpose || '—'}`,
    `└ Created: ${s.createdAt?.split('T')[0] || '—'}`,
  ].join('\n');
}

// ── DNS Hosting Presets ───────────────────────────────────────────────────────
const DNS_PRESETS = {
  vercel: { label: '▲ Vercel', type: 'CNAME', value: 'cname.vercel-dns.com', note: 'Vercel → Settings → Domains mein bhi add karo' },
  netlify: { label: '◈ Netlify', type: 'CNAME', value: 'yoursite.netlify.app', note: 'yoursite ki jagah apna Netlify site name daalo' },
  github: { label: '● GitHub Pages', type: 'CNAME', value: 'username.github.io', note: 'username ki jagah apna GitHub username daalo' },
  vps: { label: '◉ VPS/Server', type: 'A', value: '0.0.0.0', note: '0.0.0.0 ki jagah apna server IP daalo' },
  ns: { label: '⬡ NS Delegation', type: 'NS', value: 'ns1.provider.com', note: 'Aapko full DNS control milega apne subdomain pe' },
};

// ── Escape Markdown ───────────────────────────────────────────────────────────
function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

module.exports = { validateSubdomain, validateDnsValue, statusEmoji, formatSubdomainCard, DNS_PRESETS, esc };
