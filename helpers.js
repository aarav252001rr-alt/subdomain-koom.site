// ── Banned words hardcoded — DB async call nahi chahiye yahan ────────────────
const BANNED_WORDS = ['www','mail','ftp','admin','api','cpanel','webmail','smtp','pop','ns1','ns2','root','host','blog','shop','store','app','dev','test','staging'];

function validateSubdomain(name) {
  if (!name) return 'Subdomain name required.';
  name = name.toLowerCase().trim();
  if (name.length < 3)  return 'Kam se kam 3 characters chahiye.';
  if (name.length > 30) return 'Zyada se zyada 30 characters ho sakte hain.';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z0-9]{1,2}$/.test(name))
    return 'Sirf lowercase letters (a-z), numbers (0-9) aur hyphen (-) allowed hain.';
  if (/--/.test(name)) return 'Double hyphen (--) allowed nahi.';
  if (BANNED_WORDS.includes(name)) return `"${name}" reserved word hai — dusra naam chuniye.`;
  return null; // valid
}

function validateDnsValue(type, value) {
  value = (value || '').trim();
  if (!value) return 'INVALID_EMPTY';

  if (type === 'A') {
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return 'INVALID_A';
    if (value.split('.').map(Number).some(p => p > 255)) return 'INVALID_A';
  }

  if (type === 'CNAME') {
    if (value.startsWith('http://') || value.startsWith('https://')) return 'INVALID_CNAME_URL';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)) return 'INVALID_CNAME';
  }

  if (type === 'NS') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)) return 'INVALID_NS';
  }

  return null;
}

function stripUrl(value) {
  return (value || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}

function statusEmoji(s) {
  return { active:'🟢', pending:'🟡', suspended:'🔴', rejected:'❌' }[s] || '⚪';
}

function formatSubdomainCard(s, domain) {
  return [
    `${statusEmoji(s.status)} *${s.subdomain}.${domain}*`,
    `├ Status: \`${s.status.toUpperCase()}\``,
    `├ DNS: \`${s.dnsType || 'Not set'}\` → \`${s.dnsValue || '—'}\``,
    `├ 🔒 HTTPS: \`${s.cfRecordId ? '✅ Active' : '⏳ DNS set karo'}\``,
    `├ Purpose: ${s.purpose || '—'}`,
    `└ Created: ${s.createdAt?.split('T')[0] || '—'}`,
  ].join('\n');
}

module.exports = { validateSubdomain, validateDnsValue, stripUrl, statusEmoji, formatSubdomainCard };
