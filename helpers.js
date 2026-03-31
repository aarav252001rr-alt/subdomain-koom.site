const { getSetting } = require('./database');

function validateSubdomain(name) {
  if (!name) return 'INVALID: Subdomain name required.';
  name = name.toLowerCase().trim();
  if (name.length < 3) return 'INVALID: Min 3 characters.';
  if (name.length > 30) return 'INVALID: Max 30 characters.';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z0-9]{3}$/.test(name))
    return 'INVALID: Only lowercase letters, numbers, hyphens. No leading/trailing hyphens.';
  if (/--/.test(name)) return 'INVALID: Double hyphen not allowed.';
  const banned = getSetting('bannedWords') || [];
  if (banned.includes(name)) return `INVALID: "${name}" is reserved.`;
  return null;
}

// ── Improved DNS validation — catches wrong Netlify URLs etc. ─────────────────
function validateDnsValue(type, value) {
  value = (value || '').trim();
  if (!value) return 'INVALID: DNS value cannot be empty.';

  if (type === 'A') {
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return 'INVALID_A';
    if (value.split('.').map(Number).some(p => p > 255)) return 'INVALID_A';
  }

  if (type === 'CNAME') {
    // Must be a valid domain, not a full URL
    if (value.startsWith('http://') || value.startsWith('https://'))
      return 'INVALID_CNAME_URL'; // special code — we strip it
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value))
      return 'INVALID_CNAME';
    // Netlify URL must end with .netlify.app
    // GitHub must end with .github.io  — warn but allow
  }

  if (type === 'NS') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)) return 'INVALID_NS';
  }

  return null;
}

// Strip https:// or http:// if user pastes full URL
function stripUrl(value) {
  return value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}

function statusEmoji(s) {
  return { active: '🟢', pending: '🟡', suspended: '🔴', rejected: '❌' }[s] || '⚪';
}

function formatSubdomainCard(s, lang = 'en') {
  const domain = getSetting('domain');
  const labels = lang === 'hi'
    ? { status: 'Status', dns: 'DNS', cf: 'CF Record', purpose: 'Makasad', created: 'Banaya' }
    : { status: 'Status', dns: 'DNS', cf: 'CF Record', purpose: 'Purpose', created: 'Created' };
  return [
    `${statusEmoji(s.status)} *${s.subdomain}.${domain}*`,
    `├ ${labels.status}: \`${s.status.toUpperCase()}\``,
    `├ ${labels.dns}: \`${s.dnsType || 'Not set'}\` → \`${s.dnsValue || '—'}\``,
    `├ ${labels.cf}: \`${s.cfRecordId ? '✅ Linked' : '❌ Not set'}\``,
    `├ 🔒 HTTPS: \`${s.cfRecordId ? '✅ Active (Cloudflare)' : '⏳ After DNS set'}\``,
    `├ ${labels.purpose}: ${s.purpose || '—'}`,
    `└ ${labels.created}: ${s.createdAt?.split('T')[0] || '—'}`,
  ].join('\n');
}

const DNS_PRESETS = {
  vercel:  { label: '▲ Vercel',        type: 'CNAME', value: 'cname.vercel-dns.com',  note: 'Also add domain in Vercel → Settings → Domains' },
  netlify: { label: '◈ Netlify',       type: 'CNAME', value: '',                       note: 'Paste your .netlify.app URL (without https://)' },
  github:  { label: '● GitHub Pages',  type: 'CNAME', value: '',                       note: 'Paste your username.github.io URL' },
  vps:     { label: '◉ Custom VPS',    type: 'A',     value: '',                       note: 'Enter your server IP address' },
  ns:      { label: '⬡ NS Delegation', type: 'NS',    value: '',                       note: 'Enter your nameserver (ns1.provider.com)' },
};

module.exports = { validateSubdomain, validateDnsValue, stripUrl, statusEmoji, formatSubdomainCard, DNS_PRESETS };
