const mongoose = require('mongoose');

// ── Connect to MongoDB Atlas ───────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) console.error('❌ MONGO_URI missing — data will be lost on restart!');

mongoose.connect(MONGO_URI || 'mongodb://localhost/subdomainbot', {
  serverSelectionTimeoutMS: 8000,
}).then(() => console.log('✅ MongoDB connected — data is permanent!'))
  .catch(e => console.error('❌ MongoDB connection error:', e.message));

// ── Schemas ───────────────────────────────────────────────────────────────────
const User = mongoose.model('User', new mongoose.Schema({
  id:        { type: String, required: true, unique: true },
  username:  { type: String, default: '' },
  firstName: { type: String, default: '' },
  lastName:  { type: String, default: '' },
  tgLang:    { type: String, default: 'en' },
  lang:      { type: String, default: 'auto' },
  banned:    { type: Boolean, default: false },
  joinedAt:  { type: String, default: () => new Date().toISOString() },
}));

const Subdomain = mongoose.model('Subdomain', new mongoose.Schema({
  id:           { type: String, required: true, unique: true },
  userId:       { type: String, required: true, index: true },
  userName:     { type: String, default: '' },
  userUsername: { type: String, default: '' },
  subdomain:    { type: String, required: true, unique: true },
  fullDomain:   String,
  purpose:      String,
  dnsType:      String,
  dnsValue:     String,
  hosting:      String,
  status:       { type: String, default: 'pending' },
  cfRecordId:   String,
  rejectReason: String,
  createdAt:    { type: String, default: () => new Date().toISOString() },
  updatedAt:    { type: String, default: () => new Date().toISOString() },
}));

const FileRec = mongoose.model('FileRec', new mongoose.Schema({
  id: String, subdomainId: String, subdomain: String,
  fileName: String, fileId: String, filePath: String,
  fileSize: Number, ext: String, deployUrl: String,
  uploadedAt: { type: String, default: () => new Date().toISOString() },
}));

const Settings = mongoose.model('Settings', new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
}));

// ── Init default settings on first run ───────────────────────────────────────
const DEFAULTS = {
  domain:          process.env.DOMAIN || 'yourdomain.com',
  maxPerUser:      parseInt(process.env.MAX_SUBDOMAINS_PER_USER || '3'),
  requireApproval: process.env.REQUIRE_APPROVAL !== 'false',
  bannedWords:     ['www','mail','ftp','admin','api','cpanel','webmail','smtp','pop','ns1','ns2','root','host'],
  welcomeMsg:      '🌐 Free subdomain lo aur apni website host karo!',
  maintenanceMode: false,
  broadcastPrefix: '',
};

async function initSettings() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await Settings.findOneAndUpdate({ key }, { $setOnInsert: { key, value } }, { upsert: true });
  }
  console.log('✅ Settings initialized');
}
initSettings().catch(console.error);

// ── User helpers ──────────────────────────────────────────────────────────────
const getUser = (id) => User.findOne({ id: String(id) }).lean();
const upsertUser = (id, data) => User.findOneAndUpdate(
  { id: String(id) },
  { $set: { id: String(id), ...data } },
  { upsert: true, new: true }
).lean();
const getAllUsers = () => User.find().lean();
const getUserLang = async (id) => { const u = await getUser(id); return u?.lang || 'auto'; };

// ── Subdomain helpers ─────────────────────────────────────────────────────────
const getSubdomain = (sub) => Subdomain.findOne({ subdomain: sub }).lean();
const getSubdomainById = (id) => Subdomain.findOne({ id }).lean();
const getUserSubdomains = (userId) => Subdomain.find({ userId: String(userId) }).lean();
const getAllSubdomains = (filter = {}) => {
  const q = {};
  if (filter.status) q.status = filter.status;
  return Subdomain.find(q).sort({ createdAt: -1 }).lean();
};
const addSubdomain = (data) => new Subdomain(data).save();
const updateSubdomain = (id, data) => Subdomain.findOneAndUpdate(
  { id }, { $set: { ...data, updatedAt: new Date().toISOString() } }, { new: true }
);
const deleteSubdomain = (id) => Subdomain.deleteOne({ id });

// ── File helpers ──────────────────────────────────────────────────────────────
const addFileRecord = (data) => new FileRec(data).save();
const getSubFiles = (subId) => FileRec.find({ subdomainId: subId }).lean();
const deleteSubFiles = (subId) => FileRec.deleteMany({ subdomainId: subId });

// ── Settings helpers ──────────────────────────────────────────────────────────
const getSetting = async (key) => { const d = await Settings.findOne({ key }).lean(); return d?.value; };
const setSetting = (key, value) => Settings.findOneAndUpdate({ key }, { key, value }, { upsert: true, new: true });
const getSettings = async () => {
  const all = await Settings.find().lean();
  return Object.fromEntries(all.map(s => [s.key, s.value]));
};

module.exports = {
  getUser, upsertUser, getAllUsers, getUserLang,
  getSubdomain, getSubdomainById, getUserSubdomains, getAllSubdomains,
  addSubdomain, updateSubdomain, deleteSubdomain,
  addFileRecord, getSubFiles, deleteSubFiles,
  getSetting, setSetting, getSettings,
};
