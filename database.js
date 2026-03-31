const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);

// Default schema
db.defaults({
  subdomains: [],
  users: [],
  banned: [],
  announcements: [],
  settings: {
    domain: process.env.DOMAIN || 'yourdomain.com',
    maxPerUser: parseInt(process.env.MAX_SUBDOMAINS_PER_USER || '3'),
    requireApproval: process.env.REQUIRE_APPROVAL !== 'false',
    bannedWords: ['www', 'mail', 'ftp', 'admin', 'api', 'cpanel', 'webmail', 'smtp', 'pop', 'ns1', 'ns2'],
    allowedDnsTypes: ['CNAME', 'A', 'NS', 'TXT'],
    welcomeMsg: 'Welcome! Use /request to get a subdomain.',
    maintenanceMode: false,
  },
}).write();

// ── User helpers ──────────────────────────────────────────────────────────────
function getUser(userId) {
  return db.get('users').find({ id: String(userId) }).value();
}

function upsertUser(userId, data) {
  const existing = getUser(userId);
  if (existing) {
    db.get('users').find({ id: String(userId) }).assign(data).write();
  } else {
    db.get('users').push({
      id: String(userId),
      joinedAt: new Date().toISOString(),
      banned: false,
      requestCount: 0,
      ...data,
    }).write();
  }
  return getUser(userId);
}

function getAllUsers() {
  return db.get('users').value();
}

// ── Subdomain helpers ─────────────────────────────────────────────────────────
function getSubdomain(subdomain) {
  return db.get('subdomains').find({ subdomain }).value();
}

function getSubdomainById(id) {
  return db.get('subdomains').find({ id }).value();
}

function getUserSubdomains(userId) {
  return db.get('subdomains').filter({ userId: String(userId) }).value();
}

function getAllSubdomains(filter = {}) {
  let q = db.get('subdomains');
  if (filter.status) q = q.filter({ status: filter.status });
  return q.value();
}

function addSubdomain(data) {
  db.get('subdomains').push(data).write();
}

function updateSubdomain(id, data) {
  db.get('subdomains').find({ id }).assign({ ...data, updatedAt: new Date().toISOString() }).write();
}

function deleteSubdomain(id) {
  db.get('subdomains').remove({ id }).write();
}

// ── Settings helpers ──────────────────────────────────────────────────────────
function getSetting(key) {
  return db.get(`settings.${key}`).value();
}

function setSetting(key, value) {
  db.get('settings').assign({ [key]: value }).write();
}

function getSettings() {
  return db.get('settings').value();
}

module.exports = {
  db,
  getUser, upsertUser, getAllUsers,
  getSubdomain, getSubdomainById, getUserSubdomains, getAllSubdomains,
  addSubdomain, updateSubdomain, deleteSubdomain,
  getSetting, setSetting, getSettings,
};
