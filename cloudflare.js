const axios = require('axios');

const CF_BASE = `https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}/dns_records`;
const DOMAIN = process.env.DOMAIN;

const cf = axios.create({
  baseURL: CF_BASE,
  headers: {
    Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

function isMock() {
  return !process.env.CF_API_TOKEN || !process.env.CF_ZONE_ID ||
    process.env.CF_API_TOKEN === 'your_cloudflare_api_token';
}

async function addRecord(subdomain, type, value, priority = null) {
  if (isMock()) {
    console.log(`[CF MOCK] ADD ${type} ${subdomain}.${DOMAIN} → ${value}`);
    return { id: `mock_${Date.now()}`, name: `${subdomain}.${DOMAIN}`, type, content: value };
  }

  const body = {
    type: type.toUpperCase(),
    name: `${subdomain}.${DOMAIN}`,
    content: value,
    ttl: 3600,
    proxied: false,
  };
  if (type === 'MX' && priority) body.priority = priority;
  if (type === 'NS') body.proxied = false;

  const res = await cf.post('', body);
  if (!res.data.success) throw new Error(res.data.errors?.[0]?.message || 'Cloudflare error');
  return res.data.result;
}

async function deleteRecord(recordId) {
  if (isMock() || !recordId || recordId.startsWith('mock_')) {
    console.log(`[CF MOCK] DELETE ${recordId}`);
    return true;
  }
  const res = await cf.delete(`/${recordId}`);
  if (!res.data.success) throw new Error(res.data.errors?.[0]?.message || 'Delete failed');
  return true;
}

async function listRecords(subdomain) {
  if (isMock()) return [];
  const res = await cf.get('', { params: { name: `${subdomain}.${DOMAIN}`, per_page: 10 } });
  if (!res.data.success) throw new Error('List failed');
  return res.data.result;
}

async function updateRecord(recordId, subdomain, type, value) {
  try { await deleteRecord(recordId); } catch {}
  return addRecord(subdomain, type, value);
}

module.exports = { addRecord, deleteRecord, listRecords, updateRecord, isMock };
