# Hackathon Demo & Submission Guide
## Utility Guardian ⚡ — OWF Hackathon

---

## ▶ Run the demo RIGHT NOW (60 seconds)

```bash
cd utility-guardian
npm run demo
# Open http://localhost:3000
```

**Timeline after launch:**
| Time | What happens |
|---|---|
| 0:00 | Dashboard loads, agent initializes |
| 0:02 | Vault decrypts, connects to Base Mainnet |
| 0:04 | $50 USDC supplied to Aave → tx appears |
| 0:05 | Yield counter starts ticking live |
| 0:35 | Meter drops to 4.5 → first tick |
| 1:15 | Meter hits 2.5 → LOW POWER ALERT fires |
| 1:15 | Policy Engine runs 4 checks (all green) |
| 1:20 | Aave withdrawal tx confirmed |
| 1:22 | Fee transfer tx confirmed |
| 1:25 | VTpass API called → 20-digit token returned |
| 1:26 | Meter credited, toast notification pops |
| 1:28 | Cycle resets, Aave resumes earning |

---

## 📹 Recording the Demo (for submission video)

### Recommended tool: OBS Studio (free) or Loom

**What to show on screen:**
1. Start the terminal (`npm run demo`) — show the server starting
2. Open `http://localhost:3000` in full screen
3. Walk through each panel while narrating:
   - **Top-left gauge** — "This is the AEDC digital twin for meter O159006781284"
   - **Stats row** — "Fifty dollars in Aave, earning 8.24% APY — right now, live"
   - **OWF panel** — "Every transaction passes through our Policy Engine before signing"
4. Wait for the LOW POWER alert (appears ~75 seconds in)
5. Point at the Policy Engine log as checks run
6. Point at the Transaction Feed as txs appear
7. Show the 20-digit token in the toast notification
8. End with the fee collected counter

### Narration script (60 seconds):
> "Utility Guardian is an autonomous agent that solves energy poverty in Nigeria. 
> It holds a USDC reserve, earns yield on Aave V3 while idle, and automatically 
> tops up an AEDC prepaid meter the moment power runs low — all without human 
> intervention. Every transaction is governed by an OpenWallet Foundation-compliant 
> Policy Engine that enforces an address allowlist, a $15 per-transaction ceiling, 
> and a $50 daily cap. The private key is AES-256 encrypted in memory and never 
> touches disk. When the meter drops below 3 units, the agent withdraws exactly 
> what it needs from Aave, charges a 1% service fee, purchases electricity through 
> VTpass, and emails the 20-digit token to the user. Capital is always working — 
> earning when idle, spending only what's necessary."

---

## 🌐 Make it publicly accessible (judges can click a live URL)

### Option A — ngrok (2 minutes, free)
```bash
# Terminal 1
npm run demo

# Terminal 2 (install ngrok from ngrok.com first)
ngrok http 3000
# Copy the https://xxxx.ngrok-free.app URL
```

### Option B — Railway (free tier, permanent URL)
1. Push repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Set environment variables in Railway dashboard
4. Railway gives you a `.up.railway.app` URL

### Option C — Render (free tier)
1. Push to GitHub
2. render.com → New Web Service → connect repo
3. Start command: `node src/server.js`
4. Free URL: `.onrender.com`

---

## 📦 GitHub Repo Setup (15 minutes)

```bash
cd utility-guardian
git init
git add .
git commit -m "feat: Utility Guardian — OWF Hackathon submission"
git branch -M main
git remote add origin https://github.com/YOURUSERNAME/utility-guardian.git
git push -u origin main
```

**Add a `.gitignore` first:**
```
node_modules/
.env
guardian.log
*.log
```

**Pin these topics on the repo:**
`openwalletfoundation` `web3` `defi` `aave` `base-network` `autonomous-agent` `nigeria` `energy`

---

## 🏆 What Makes This Stand Out — Talking Points

### 1. Real-World Problem
> "350 million people in sub-Saharan Africa lack reliable electricity access.
> Prepaid meters go dark at the worst times. This agent never sleeps."

### 2. OWF Policy Engine (unique differentiator)
> "Most hackathon wallets just sign. Ours enforces governance — every 
> transaction is validated against an allowlist, a spend ceiling, and a 
> rolling daily cap before the key is ever used."

### 3. Capital Efficiency
> "Zero idle capital. The reserve earns ~8% APY on Aave between top-ups.
> A $50 reserve covering ₦5,000/month top-ups effectively pays for itself
> in yield over ~18 months."

### 4. Composability
> "Base → Aave V3 → VTpass → AEDC → Email. Five systems, zero humans,
> one autonomous loop."

### 5. Production architecture
> "The mock services in the demo are drop-in replacements — swap 
> `VTPASS_BASE_URL` from sandbox to live and the exact same code runs 
> in production."

---

## 📊 Slide deck outline (if needed — 5 slides)

**Slide 1 — Problem**
- Nigerian prepaid meters go dark unexpectedly
- Manual top-up requires time, internet access, airtime
- Money sitting in a wallet earns nothing

**Slide 2 — Solution**
- Autonomous agent: monitor → earn → top-up → notify
- Architecture diagram (paste the ASCII from README)

**Slide 3 — OWF Compliance**
- Wallet Standard interface table
- Policy Engine diagram (allowlist + ceilings)
- AES-256 in-memory vault

**Slide 4 — Live Demo**
- Screenshot of the dashboard during a top-up
- Highlight: Policy checks, Aave tx, token received

**Slide 5 — Business Model & Scale**
- 1% fee per top-up (~$0.03–$0.15)
- Aave yield covers infrastructure costs
- Extensible to IKEDC, EKEDC, EEDC (all Nigerian DISCOs)
- International: Any VTpass-connected utility

---

## ✅ Submission Checklist

- [ ] `npm run demo` works and dashboard loads
- [ ] Full top-up cycle completes (watch for the toast ~75s in)
- [ ] Public URL is accessible (ngrok / Railway)
- [ ] GitHub repo is public with good README
- [ ] Demo video recorded (Loom link ready)
- [ ] Submission form filled with: repo URL + live URL + video URL
