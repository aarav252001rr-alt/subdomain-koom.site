# ⬡ Telegram SubDomain Bot v3

## 🔧 Render Deploy Fix — "No open ports detected" Error

**Galti yeh thi:** Bot ko "Web Service" ke taur pe deploy kiya tha.  
**Fix yeh hai:** Bot ko **"Background Worker"** ke taur pe deploy karo.

---

## ✅ Render pe Sahi Tarike se Deploy Karo

1. render.com → Dashboard → **"New +"** → **"Background Worker"** ← (Web Service NAHI!)
2. GitHub repo connect karo
3. Settings:
   ```
   Name:          subdomain-bot
   Runtime:       Node
   Build Command: npm install
   Start Command: node bot.js
   Plan:          FREE ✅
   ```
4. Environment Variables:
   ```
   BOT_TOKEN              = BotFather ka token
   ADMIN_ID               = Aapka Telegram User ID
   DOMAIN                 = yourdomain.com
   CF_API_TOKEN           = Cloudflare API token
   CF_ZONE_ID             = Cloudflare Zone ID
   MAX_SUBDOMAINS_PER_USER = 3
   REQUIRE_APPROVAL       = true
   ```
5. Deploy! ✅

> Background Worker ko port ki zaroorat nahi hoti — isliye "No open ports" error nahi aayega.

---

## 🔒 HTTPS Fix

Cloudflare pe domain hone se **automatic free HTTPS** milta hai.  
User ko `https://subdomain.yourdomain.com` milega — koi extra config nahi chahiye.

---

## 🌐 Netlify Subdomain Error Fix

**Galti:** User ne `https://site.netlify.app` paste kiya tha.  
**Fix:** Bot ab automatically `https://` strip kar leta hai.  
Aur validation better hai — wrong URLs pe clear error message aata hai.

---

## 📢 Broadcast Prefix

Admin Panel → Settings → "Broadcast Prefix ON/OFF"  
- **ON:** Har broadcast message pe "📢 Admin Announcement" heading aati hai  
- **OFF:** Sirf aapka message jata hai, koi heading nahi

---

## 📁 File Upload (5MB Limit)

- Active subdomain pe `📁 Upload File` button aata hai
- `.html` ya `.zip` files accept hoti hain
- 5MB se badi file reject ho jati hai
- File Telegram ke CDN pe store hoti hai (free, no extra storage needed)
- User ko download link milta hai

---

## 🌐 Multiple Languages

- `/language` — Language change karo
- 🇬🇧 English | 🇮🇳 Hindi | 🤖 Auto-detect
- Auto-detect Telegram language se language set karta hai

---

## 📁 Files

```
tgbot-v2/
├── bot.js        ← Main bot
├── cloudflare.js ← Auto DNS
├── database.js   ← JSON DB
├── helpers.js    ← Validation
├── i18n.js       ← Hindi/English translations
├── storage.js    ← File upload handler
├── package.json
└── .env.example
```
