const mongoose = require('mongoose');

let isConnected = false;

// ── Connect — bot shuru hone se pehle yeh complete hona chahiye ────────────────
async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGO_URI .env mein missing hai!');
    process.exit(1);
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 15000,
    });
    isConnected = true;
    console.log('✅ MongoDB Atlas connected! Data permanent rahega.');
  } catch (e) {
    console.error('❌ MongoDB connect failed:', e.message);
    console.error('👉 Fix: MongoDB Atlas → Network Access → Add 0.0.0.0/0');
    process.exit(1); // bot start hi mat karo agar DB nahi mila
  }
}

// ── Schemas ────────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  id:        { type: String, required: true, unique: true },
  username:  { type: String, default: '' },
  firstName: { type: String, default: '' },
  lastName:  { type: String, default: '' },
  tgLang:    { type: String, default: 'en' },
  lang:      { type: String, default: 'auto' },
  banned:    { type: Boolean, default: false },
  joinedAt:  { type: String, default: () => new Date().toISOString() },
});

const subdomainSchema = new mongoose.Schema({
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
});

const fileSchema = new mongoose.Schema({
  id: String, subdomainId: String, subdomain: String,
  fileName: String, fileId: String, filePath: String,
  fileSize: Number, ext: String, deployUrl: String,
  uploadedAt: { type: String, default: () => new Date().toISOString() },
});

const settingsSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
});

const User      = mongoose.model('User',      userSchema);
const Subdomain = mongoose.model('Subdomain', subdomainSchema);
const FileRec   = mongoose.model('FileRec',   fileSchema);
const Settings  = mongoose.model('Settings',  settingsSchema);

// ── Default settings ────────────────────────────────────────────────────────────
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
    await Settings.findOneAndUpdate(
      { key },
      { $setOnInsert: { key, value } },
      { upsert: true, new: false }
    );
  }
}

// ── User helpers ───────────────────────────────────────────────────────────────
const getUser     = (id) => User.findOne({ id: String(id) }).lean();
const getAllUsers  = ()   => User.find().lean();
const getUserLang = async (id) => { const u = await getUser(id); return u?.lang || 'auto'; };
const upsertUser  = (id, data) => User.findOneAndUpdate(
  { id: String(id) },
  { $set: { id: String(id), ...data } },
  { upsert: true, new: true }
).lean();

// ── Subdomain helpers ──────────────────────────────────────────────────────────
const getSubdomain      = (sub)    => Subdomain.findOne({ subdomain: sub }).lean();
const getSubdomainById  = (id)     => Subdomain.findOne({ id }).lean();
const getUserSubdomains = (userId) => Subdomain.find({ userId: String(userId) }).lean();
const getAllSubdomains   = (filter = {}) => {
  const q = {};
  if (filter.status) q.status = filter.status;
  return Subdomain.find(q).sort({ createdAt: -1 }).lean();
};
const addSubdomain    = (data) => new Subdomain(data).save();
const updateSubdomain = (id, data) => Subdomain.findOneAndUpdate(
  { id }, { $set: { ...data, updatedAt: new Date().toISOString() } }, { new: true }
);
const deleteSubdomain = (id) => Subdomain.deleteOne({ id });

// ── File helpers ───────────────────────────────────────────────────────────────
const addFileRecord = (data)  => new FileRec(data).save();
const getSubFiles   = (subId, subdomain) => {
  if (subdomain) return FileRec.find({ subdomain }).lean();
  return FileRec.find({ subdomainId: subId }).lean();
};
const deleteSubFiles= (subId) => FileRec.deleteMany({ subdomainId: subId });

// ── Settings helpers ───────────────────────────────────────────────────────────
const getSetting  = async (key) => { const d = await Settings.findOne({ key }).lean(); return d?.value ?? DEFAULTS[key]; };
const setSetting  = (key, value) => Settings.findOneAndUpdate({ key }, { key, value }, { upsert: true, new: true });
const getSettings = async () => {
  const all = await Settings.find().lean();
  return Object.fromEntries(all.map(s => [s.key, s.value]));
};

module.exports = {
  connectDB, initSettings,
  getUser, upsertUser, getAllUsers, getUserLang,
  getSubdomain, getSubdomainById, getUserSubdomains, getAllSubdomains,
  addSubdomain, updateSubdomain, deleteSubdomain,
  addFileRecord, getSubFiles, deleteSubFiles,
  getSetting, setSetting, getSettings,
};
