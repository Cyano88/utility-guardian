'use strict';

require('dotenv').config();

// ─── Validation helper ───────────────────────────────────────────────────────
function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

// ─── Chain ───────────────────────────────────────────────────────────────────
const CHAIN_ID = 8453; // Base Mainnet

// ─── Aave V3 on Base ─────────────────────────────────────────────────────────
const AAVE_POOL_ADDRESS     = '0xA238Dd80C259a72e81d7E4674A9801593f98D1C5';
const USDC_ADDRESS          = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AUSDC_ADDRESS         = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB'; // aBasUSDC

// ─── Policy constraints ───────────────────────────────────────────────────────
const MAX_SPEND_USD         = 15;    // max per transaction in USD
const AGENT_FEE_BPS         = 100;   // 1% service fee (100 basis points)
const VTPASS_PROCESSING_PCT = 0.05;  // 5% VTpass processing overhead

// ─── Meter digital twin ───────────────────────────────────────────────────────
const METER_NUMBER          = process.env.METER_NUMBER || 'O159006781284';
const INITIAL_METER_UNITS   = 5.0;
const UNITS_DROP_PER_TICK   = 0.5;
const TICK_INTERVAL_MS      = 5 * 60 * 1000; // 5 minutes
const TRIGGER_THRESHOLD     = 3.0;
const TOPUP_TARGET_UNITS    = 10.0;  // restore to this level

// ─── Finance ──────────────────────────────────────────────────────────────────
const TOPUP_AMOUNT_NGN      = Number(process.env.TOPUP_AMOUNT_NGN)  || 5000;
const NGN_USD_RATE          = Number(process.env.NGN_USD_RATE)       || 1600;

// ─── VTpass ──────────────────────────────────────────────────────────────────
const VTPASS_BASE_URL       = process.env.VTPASS_BASE_URL || 'https://vtpass.com/api';

// ─── Wallet allowlist (Policy Engine) ────────────────────────────────────────
// Only these addresses may receive funds from this agent.
const ALLOWED_RECIPIENTS   = new Set([
  '0x0000000000000000000000000000000000000000', // placeholder — set real VTpass merchant addr
  AAVE_POOL_ADDRESS,
  process.env.ADMIN_REVENUE_WALLET || '',
].filter(Boolean));

module.exports = {
  // Chain
  CHAIN_ID,
  BASE_RPC_URL: process.env.BASE_RPC_URL || 'https://mainnet.base.org',

  // Wallet
  AGENT_PRIVATE_KEY: process.env.AGENT_PRIVATE_KEY,
  VAULT_ENCRYPTION_KEY: process.env.VAULT_ENCRYPTION_KEY,
  ADMIN_REVENUE_WALLET: process.env.ADMIN_REVENUE_WALLET,

  // Aave
  AAVE_POOL_ADDRESS,
  USDC_ADDRESS,
  AUSDC_ADDRESS,

  // Policy
  MAX_SPEND_USD,
  AGENT_FEE_BPS,
  VTPASS_PROCESSING_PCT,
  ALLOWED_RECIPIENTS,

  // Meter
  METER_NUMBER,
  INITIAL_METER_UNITS,
  UNITS_DROP_PER_TICK,
  TICK_INTERVAL_MS,
  TRIGGER_THRESHOLD,
  TOPUP_TARGET_UNITS,

  // Finance
  TOPUP_AMOUNT_NGN,
  NGN_USD_RATE,

  // VTpass
  VTPASS_BASE_URL,
  VTPASS_API_KEY:     process.env.VTPASS_API_KEY,
  VTPASS_SECRET_KEY:  process.env.VTPASS_SECRET_KEY,
  VTPASS_PUBLIC_KEY:  process.env.VTPASS_PUBLIC_KEY,

  // Email
  SMTP_HOST:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  SMTP_PORT:   Number(process.env.SMTP_PORT) || 587,
  SMTP_USER:   process.env.SMTP_USER,
  SMTP_PASS:   process.env.SMTP_PASS,
  NOTIFY_TO:   process.env.NOTIFY_TO,
};
