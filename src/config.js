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

// ─── Starknet Financial Battery (Sepolia Testnet) ────────────────────────────
const STARKNET_RPC_URL          = process.env.STARKNET_RPC_URL || 'https://starknet-sepolia.public.blastapi.io';
const STARKNET_PRIVATE_KEY      = process.env.STARKNET_PRIVATE_KEY || null;
const STARKNET_ACCOUNT_ADDRESS  = process.env.STARKNET_ACCOUNT_ADDRESS || null;
const STARKNET_YIELD_CHECK_MS   = Number(process.env.STARKNET_YIELD_CHECK_MS) || 12 * 60 * 60 * 1000; // 12 hours
const STARKNET_STRK_MIN_HARVEST = Number(process.env.STARKNET_STRK_MIN_HARVEST) || 2.0; // min STRK to trigger harvest

// ─── Frictionless Inflow: AVNU/Ekubo on-chain aggregation ───────────────────
const AVNU_AGGREGATOR_ADDRESS   = '0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f'; // AVNU Router (Sepolia)
const EKUBO_POOL_ADDRESS        = '0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b'; // Ekubo Core (Sepolia)

// Yield strategy mode: 'stability' (USDC → nUSDC yield) or 'growth' (USDC → wBTC → STRK staking)
const STARKNET_YIELD_MODE       = process.env.STARKNET_YIELD_MODE || 'growth';

// Bridge contract on Base (deBridge receiver) — added to allowlist
const BRIDGE_BASE_RECEIVER      = '0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251';

// ─── Circle Arc Nanopayment (Base Sepolia) ────────────────────────────────────
const ARC_USDC_ADDRESS          = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // USDC (Base Sepolia)
const ARC_RELAY_ADDRESS         = '0x9C7a2c5b9e5d0f7B8A3F2E1D4C6B0A8F3E2D1C5'; // Circle Arc relay
const ARC_TICK_COST             = parseFloat(process.env.ARC_TICK_COST)             || 0.005; // USD per tick
const ARC_ACCUMULATOR_THRESHOLD = parseFloat(process.env.ARC_ACCUMULATOR_THRESHOLD) || 2.00;  // USD to trigger VTpass
const ARC_TICK_INTERVAL_MS      = parseInt(process.env.ARC_TICK_INTERVAL_MS)        || 6000;  // ms between ticks

// ─── Wallet allowlist (Policy Engine) ────────────────────────────────────────
// Only these addresses may receive funds from this agent.
const ALLOWED_RECIPIENTS   = new Set([
  '0x0000000000000000000000000000000000000000', // placeholder — set real VTpass merchant addr
  AAVE_POOL_ADDRESS,
  BRIDGE_BASE_RECEIVER,
  ARC_RELAY_ADDRESS,
  process.env.ADMIN_REVENUE_WALLET || '',
].filter(Boolean));

// Starknet-side allowlist (AVNU Aggregator + Ekubo for on-chain swaps)
const STARKNET_ALLOWED_CONTRACTS = new Set([
  AVNU_AGGREGATOR_ADDRESS,
  EKUBO_POOL_ADDRESS,
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

  // Starknet Financial Battery
  STARKNET_RPC_URL,
  STARKNET_PRIVATE_KEY,
  STARKNET_ACCOUNT_ADDRESS,
  STARKNET_YIELD_CHECK_MS,
  STARKNET_STRK_MIN_HARVEST,
  BRIDGE_BASE_RECEIVER,

  // Frictionless Inflow (AVNU/Ekubo)
  AVNU_AGGREGATOR_ADDRESS,
  EKUBO_POOL_ADDRESS,
  STARKNET_YIELD_MODE,
  STARKNET_ALLOWED_CONTRACTS,

  // Circle Arc Nanopayment
  ARC_USDC_ADDRESS,
  ARC_RELAY_ADDRESS,
  ARC_TICK_COST,
  ARC_ACCUMULATOR_THRESHOLD,
  ARC_TICK_INTERVAL_MS,

  // Email
  SMTP_HOST:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  SMTP_PORT:   Number(process.env.SMTP_PORT) || 587,
  SMTP_USER:   process.env.SMTP_USER,
  SMTP_PASS:   process.env.SMTP_PASS,
  NOTIFY_TO:   process.env.NOTIFY_TO,
};
