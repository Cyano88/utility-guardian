# Utility Guardian ⚡

**OpenWallet Foundation Hackathon — Autonomous Utility Management Agent**

An autonomous Node.js agent that monitors a Nigerian AEDC prepaid electricity meter, earns yield on idle USDC via Aave V3 on Base, auto-tops-up power when units run low, charges a 1% service fee, and notifies the user by email — all enforced by an OWF-compliant Policy Engine.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Utility Guardian                      │
│                                                         │
│  ┌──────────────┐   low event   ┌───────────────────┐  │
│  │ Meter Twin   │──────────────▶│   Agent Orchestr. │  │
│  │ (5 min tick) │               │   (agent.js)      │  │
│  └──────────────┘               └─────────┬─────────┘  │
│                                           │             │
│         ┌──────────────────────────┬──────┘             │
│         ▼                          ▼                    │
│  ┌─────────────┐          ┌──────────────────┐          │
│  │ OWF Wallet  │          │  Policy Engine   │          │
│  │ Vault       │◀─sign────│  (allowlist +    │          │
│  │ (wallet.js) │          │   spend limits)  │          │
│  └──────┬──────┘          └──────────────────┘          │
│         │                                               │
│   ┌─────┴──────┐   ┌────────────┐   ┌───────────────┐  │
│   │ Aave V3    │   │  VTpass    │   │  Nodemailer   │  │
│   │ withdraw() │   │  /pay      │   │  (email)      │  │
│   └────────────┘   └────────────┘   └───────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Setup

### 1. Install dependencies

```bash
cd utility-guardian
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

Required variables:

| Variable | Description |
|---|---|
| `AGENT_PRIVATE_KEY` | Base wallet private key (hex) |
| `VTPASS_API_KEY` | VTpass API key |
| `VTPASS_SECRET_KEY` | VTpass secret key |
| `VTPASS_PUBLIC_KEY` | VTpass public key |
| `ADMIN_REVENUE_WALLET` | Address to receive 1% service fee |
| `SMTP_USER` | Gmail / SMTP username |
| `SMTP_PASS` | Gmail app password |
| `NOTIFY_TO` | Customer email address |

### 3. Run

```bash
# Production
node src/index.js

# Development (auto-restart on file change)
node --watch src/index.js
```

---

## How It Works

### OWF Wallet Standard

`wallet.js` implements the [Wallet Standard](https://github.com/wallet-standard/wallet-standard) interfaces:

- **`standard:connect`** — opens the encrypted in-memory vault
- **`standard:signTransaction`** — signs a tx only after the Policy Engine approves it
- **`standard:signMessage`** — EIP-191 message signing

The private key is AES-256-CBC encrypted in memory immediately after startup. The raw key is never held in a plain variable beyond the initial init.

### Policy Engine

Every transaction is validated against:

1. **Allowlist** — `to` address must be in the pre-approved set (Aave pool, revenue wallet, VTpass merchant)
2. **Per-tx ceiling** — max $15 USD per transaction
3. **Rolling 24 h cap** — max $50 USD in any 24-hour window

A `PolicyViolation` is thrown before `signTransaction` is called, so funds never move.

### Aave V3 Yield

| Event | Action |
|---|---|
| Agent startup | `supply()` all idle wallet USDC → Aave |
| Low meter trigger | `withdraw()` exact amount needed back to wallet |

The agent holds aUSDC (interest-bearing) between top-ups, continuously earning yield on the full reserve.

### Top-Up Flow

```
Low alert (< 3.0 units)
    │
    ├─ Verify meter (VTpass merchant-verify)
    ├─ Policy check (allowlist + spend limits)
    ├─ Aave withdraw(topupUSD + vtpassFee)
    ├─ Transfer 1% fee → ADMIN_REVENUE_WALLET (Base USDC)
    ├─ VTpass /pay → 20-digit token
    ├─ Credit meter twin
    └─ Email notification (token + tx hash + fee breakdown)
```

### Fee Breakdown Example (₦5,000 top-up)

| Item | Amount |
|---|---|
| Electricity (₦5,000 ÷ 1,600) | $3.1250 USDC |
| VTpass processing (5%) | $0.1563 USDC |
| Guardian service fee (1%) | $0.0313 USDC |
| **Total withdrawn from Aave** | **$3.2813 USDC** |

---

## Simulated Demo Behaviour

| Parameter | Value |
|---|---|
| Starting units | 5.0 |
| Consumption | −0.5 units / 5 min |
| Trigger threshold | < 3.0 units |
| Time to first trigger | ~20 minutes |

Adjust `TICK_INTERVAL_MS` in `.env` or `config.js` for faster demos.

---

## Contract Addresses (Base Mainnet)

| Contract | Address |
|---|---|
| Aave V3 Pool | `0xA238Dd80C259a72e81d7e4674A9801593f98d1c5` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| aBasUSDC | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` |

---

## Security Notes

- **Never commit `.env`** — add it to `.gitignore`
- Use a **dedicated agent wallet** with only the USDC reserve; no other assets
- For production: replace the in-memory vault with a **hardware wallet** or **cloud KMS** (AWS KMS, GCP Cloud HSM) — the OWF wallet standard interface is the same
- VTpass sandbox URL: `https://sandbox.vtpass.com/api` (set in `VTPASS_BASE_URL`)
