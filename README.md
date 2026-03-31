# ⬡ Telegram SubDomain Bot

> Advanced Telegram bot — Users ko free subdomains do with Cloudflare Auto-DNS  
> **100% Free Deploy on Render.com**

---

## 🤖 Bot Features

| Feature | Details |
|---|---|
| 🌐 Subdomain Request | Multi-step conversation flow |
| ✅ Admin Approve/Reject | Reject reason bhi bhejta hai user ko |
| 🔧 Auto Cloudflare DNS | Approve hote hi DNS automatically add |
| ⚙️ DNS Update | User khud DNS change kar sakta hai |
| 📖 DNS Guide | Vercel/Netlify/GitHub/VPS/NS guide |
| 🔍 DNS Check | Cloudflare pe records verify karo |
| 🚫 Ban/Unban | Abusive users ko ban karo |
| 📢 Broadcast | Sab users ko message bhejo |
| 📊 Daily Stats | Har din admin ko stats aata hai |
| 🔧 Maintenance Mode | Bot temporarily off karo |
| ⚙️ Live Settings | Max subdomains, approval toggle, welcome msg |

---

## ✅ STEP 1 — BotFather se Bot Banao

1. Telegram open karo → search `@BotFather`
2. Send `/newbot`
3. Bot ka naam daalo (e.g. `MyDomain SubBot`)
4. Username daalo (e.g. `mydomainsubbot` — `bot` se end hona chahiye)
5. Token copy karo:
   ```
   1234567890:ABCDEFghijklmnopqrstuvwxyz
   ```

---

## ✅ STEP 2 — Apna Telegram User ID Pata Karo

1. Telegram mein search karo `@userinfobot`
2. `/start` bhejo
3. Aapka **User ID** copy karo (number hoga, e.g. `123456789`)
   - Yeh ADMIN_ID hai

---

## ✅ STEP 3 — Cloudflare Setup (Auto-DNS ke liye)

> Bina Cloudflare ke bot kaam karega, bas DNS manually add karna padega

### Domain Cloudflare pe Move Karo:
1. **cloudflare.com** → Free account
2. Add Site → `yourdomain.com`
3. Free plan select karo
4. Cloudflare 2 nameservers dega
5. **Hotinger** mein DNS → Nameservers change karo → Cloudflare ke daalo

### API Token Banao:
1. Cloudflare → My Profile → **API Tokens**
2. Create Token → **"Edit zone DNS"** template
3. Zone: apna domain select karo
4. Token copy karo

### Zone ID:
1. Cloudflare Dashboard → apna domain click karo
2. Right sidebar mein **Zone ID** copy karo

---

## ✅ STEP 4 — GitHub pe Upload Karo

```bash
cd telegram-subdomain-bot
git init
git add .
git commit -m "Telegram SubDomain Bot"
git remote add origin https://github.com/YOURUSERNAME/telegram-bot.git
git push -u origin main
```

---

## ✅ STEP 5 — Render pe FREE Deploy Karo

1. **render.com** → Free account banao (GitHub se login karo)

2. Dashboard → **"New +"** → **"Web Service"**

3. GitHub connect karo → apna repo select karo

4. Settings fill karo:
   ```
   Name:          telegram-subdomain-bot
   Runtime:       Node
   Build Command: npm install
   Start Command: node bot.js
   Plan:          FREE ✅
   ```

5. **"Environment Variables"** section mein add karo:

   | Key | Value |
   |-----|-------|
   | `BOT_TOKEN` | BotFather ka token |
   | `ADMIN_ID` | Aapka Telegram User ID |
   | `DOMAIN` | yourdomain.com |
   | `CF_API_TOKEN` | Cloudflare API token |
   | `CF_ZONE_ID` | Cloudflare Zone ID |
   | `MAX_SUBDOMAINS_PER_USER` | 3 |
   | `REQUIRE_APPROVAL` | true |

6. **"Create Web Service"** click karo

7. Deploy ho jayega! (2-3 minute)

8. Telegram mein apne bot ko `/start` bhejo ✅

---

## ✅ STEP 6 — Render Free mein Bot Ko Alive Rakho

> Render free plan 15 min inactivity pe sleep ho jata hai

### UptimeRobot (FREE):
1. **uptimerobot.com** → Free account
2. **"New Monitor"** → Type: `HTTP(s)`
3. URL: `https://your-bot-name.onrender.com/` 
   _(Render dashboard se URL copy karo)_
4. Interval: **14 minutes**
5. Save → Done! ✅

Bot ab 24/7 alive rahega FREE mein!

---

## 📱 Bot Commands

```
/start          — Bot start karo
/request        — Naya subdomain maango
/mysubdomains   — Apne subdomains dekho
/cancel         — Current action cancel karo
/help           — Help dekho
/stats          — Admin: statistics (sirf admin)
/broadcast msg  — Admin: sab ko message bhejo
```

---

## 🔄 User Journey

```
User: /start
Bot:  Main menu dikhata hai

User: "Request Subdomain"  
Bot:  Subdomain naam maangta hai

User: "mysite"
Bot:  Purpose maangta hai

User: "Portfolio website"
Bot:  Hosting provider chunne deta hai (Vercel/Netlify/etc.)

User: "Vercel" select karta hai
Bot:  Summary dikhata hai + Confirm button

User: Confirm karta hai
Bot:  Admin ko notification bhejta hai

Admin: Approve karta hai
Bot:  Cloudflare pe DNS add karta hai + User ko notification
      "🎉 Subdomain Active Ho Gayi!"
```

---

## 📁 Files

```
telegram-subdomain-bot/
├── bot.js          ← Main bot (sab kuch yahan)
├── cloudflare.js   ← Auto DNS API
├── database.js     ← JSON DB (lowdb)
├── helpers.js      ← Validation & formatting
├── package.json    ← Dependencies
├── .env.example    ← Copy → .env for local testing
└── README.md       ← Yeh file
```

---

## 🧪 Local Testing

```bash
# 1. Dependencies install karo
npm install

# 2. .env file banao
cp .env.example .env
# .env mein apni values daalo

# 3. Run karo
node bot.js
```
