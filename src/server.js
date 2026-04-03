'use strict';

/**
 * server.js — Utility Guardian: Live Demo Server
 *
 * Runs a fully self-contained simulation with mocked VTpass + Aave.
 * Streams real-time events to the dashboard via Server-Sent Events.
 *
 * npm run demo → http://localhost:3000
 */

require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const PORT   = process.env.PORT || 3000;
const clients = new Set();

// ── SSE broadcast ─────────────────────────────────────────────────────────────
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(payload); } catch (_) {} });
}

// ── Shared demo state ─────────────────────────────────────────────────────────
const TOPUP_NGN    = parseFloat(process.env.TOPUP_AMOUNT_NGN) || 5000;
const NGN_USD_RATE = parseFloat(process.env.NGN_USD_RATE)     || 1600;

const MOCK_AGENT_ADDRESS   = '0x' + crypto.randomBytes(20).toString('hex');
const MOCK_REVENUE_ADDRESS = process.env.ADMIN_REVENUE_WALLET || '0x' + crypto.randomBytes(20).toString('hex');

const state = {
  agent: {
    address:  MOCK_AGENT_ADDRESS,
    revenue:  MOCK_REVENUE_ADDRESS,
    status:   'INITIALIZING',
    network:  'Base Mainnet · Chain ID 8453',
    standard: 'OWF Wallet Standard v1.0.0',
  },
  meter: {
    number:    process.env.METER_NUMBER || 'O159006781284',
    units:     5.0,
    maxUnits:  10.0,
    threshold: 3.0,
    isLow:     false,
    topupCount: 0,
    lastTopup: null,
  },
  aave: {
    supplied:       50.00,
    walletBalance:  0.00,
    yieldEarned:    0.00,
    apy:            8.24,
  },
  fees: { totalCollected: 0.00, count: 0 },
  transactions: [],
  policy: { checks: [] },
  lastTopup: null,
};

// ── Mock helpers ──────────────────────────────────────────────────────────────
const mockTxHash  = () => '0x' + crypto.randomBytes(32).toString('hex');
const mockReqId   = () => {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${crypto.randomBytes(4).toString('hex')}`;
};
const mockToken   = () =>
  Array.from({ length: 5 }, () =>
    Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  ).join('-');
const sleep       = ms => new Promise(r => setTimeout(r, ms));

function addTx(type, hash, amount, status = 'confirmed', meta = {}) {
  const tx = { id: Date.now(), type, hash, amount, status, timestamp: new Date().toISOString(), ...meta };
  state.transactions.unshift(tx);
  if (state.transactions.length > 30) state.transactions.pop();
  broadcast('tx', tx);
  return tx;
}

function policyCheck(rule, result) {
  const check = { rule, passed: result, timestamp: new Date().toISOString() };
  state.policy.checks.unshift(check);
  if (state.policy.checks.length > 12) state.policy.checks.pop();
  broadcast('policy', check);
}

function log(level, message) {
  broadcast('log', { level, message, ts: new Date().toLocaleTimeString() });
}

// ── Demo agent ────────────────────────────────────────────────────────────────
async function runDemoAgent() {

  // ─ Phase 1: Vault init ────────────────────────────────────────────────────
  await sleep(1200);
  log('info', `OWF Vault: decrypting in-memory key (AES-256-CBC)…`);
  await sleep(800);
  log('info', `Vault ready → ${MOCK_AGENT_ADDRESS}`);
  log('info', `Connected to Base Mainnet via JSON-RPC`);
  log('info', `Wallet Standard features: connect · signTransaction · signMessage`);
  state.agent.status = 'ONLINE';
  broadcast('agent', state.agent);

  // ─ Phase 2: Supply idle USDC to Aave ──────────────────────────────────────
  await sleep(1000);
  log('info', 'Checking wallet USDC balance… $50.00 USDC available');
  await sleep(600);
  log('info', 'Policy Engine: allowlist check → Aave Pool ✓');
  policyCheck('ALLOWLIST · Aave V3 Pool (0xA238…D1C5)', true);
  await sleep(500);
  log('info', 'Approving Aave Pool (MAX_UINT256)…');
  const approveHash = mockTxHash();
  addTx('ERC20_APPROVE', approveHash, 'MAX_UINT256 USDC', 'confirmed', { spender: 'Aave V3 Pool', gas: '$0.003' });
  await sleep(900);
  log('info', 'Supplying $50.00 USDC to Aave V3…');
  const supplyHash = mockTxHash();
  addTx('AAVE_SUPPLY', supplyHash, '$50.00 USDC', 'confirmed', {
    protocol: 'Aave V3 · Base',
    apy: '8.24% APY',
    aToken: 'aBasUSDC',
    gas: '$0.004',
  });
  log('info', `✓ Supply confirmed → ${supplyHash.slice(0,20)}…`);
  log('info', 'Idle USDC now earning 8.24% APY on Aave V3');
  broadcast('aave', state.aave);
  broadcast('meter', state.meter);

  // ─ Phase 3: Yield accrual ──────────────────────────────────────────────────
  const APY_PER_SEC = state.aave.apy / 100 / 365 / 24 / 3600;
  setInterval(() => {
    state.aave.yieldEarned += state.aave.supplied * APY_PER_SEC;
    broadcast('aave', { ...state.aave });
  }, 1000);

  // ─ Phase 4: Start meter drain ──────────────────────────────────────────────
  await sleep(800);
  log('info', `Meter twin active → ${state.meter.number}`);
  log('info', 'Consumption: −0.5 units / 30 sec  |  Threshold: 3.0 units');

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    state.meter.units = Math.max(0, parseFloat((state.meter.units - 0.5).toFixed(1)));
    broadcast('meter', { ...state.meter });
    log('debug', `Meter tick → ${state.meter.units.toFixed(1)} units remaining`);

    if (state.meter.units < state.meter.threshold && !state.meter.isLow) {
      state.meter.isLow = true;
      busy = true;
      broadcast('meter', { ...state.meter });
      await executeTopUp();
      busy = false;
    }
  }, 30_000);
}

async function executeTopUp() {
  const topupUSD   = TOPUP_NGN / NGN_USD_RATE;
  const vtpassFee  = topupUSD * 0.05;
  const agentFee   = topupUSD * 0.01;
  const totalUSD   = topupUSD + vtpassFee + agentFee;
  const withdrawUSD = topupUSD + vtpassFee;

  log('warn', `⚠ LOW POWER ALERT — ${state.meter.units.toFixed(1)} units  (threshold: ${state.meter.threshold})`);
  await sleep(600);
  log('info', '─── TOP-UP SEQUENCE INITIATED ───────────────────────────');

  // Policy Engine
  await sleep(400);
  log('info', 'Policy Engine running pre-flight checks…');
  await sleep(350); policyCheck(`ALLOWLIST · VTpass Merchant`, true);
  await sleep(350); policyCheck(`ALLOWLIST · Revenue Wallet`, true);
  await sleep(350); policyCheck(`SPEND_CEILING · $${totalUSD.toFixed(2)} ≤ $15.00`, totalUSD <= 15);
  await sleep(350); policyCheck(`DAILY_CAP · within $50.00/24h limit`, true);
  log('info', '✓ All policy checks passed — proceeding to sign');

  // Meter verify
  await sleep(600);
  log('info', `VTpass: verifying meter ${state.meter.number}…`);
  await sleep(900);
  log('info', '✓ Meter verified — Customer: DEMO ACCOUNT / AEDC Abuja Electric');

  // Aave withdraw
  await sleep(700);
  log('info', `Aave: withdrawing $${withdrawUSD.toFixed(4)} USDC (top-up + VTpass fee)…`);
  await sleep(200);
  log('info', 'OWF wallet.signTransaction() called → Policy Engine approved');
  const withdrawHash = mockTxHash();
  state.aave.supplied      = Math.max(0, state.aave.supplied - withdrawUSD);
  state.aave.walletBalance = withdrawUSD;
  broadcast('aave', { ...state.aave });
  addTx('AAVE_WITHDRAW', withdrawHash, `$${withdrawUSD.toFixed(4)} USDC`, 'confirmed', {
    protocol: 'Aave V3 · Base',
    reason:   'Pre-fund meter top-up',
    gas:      '$0.004',
  });
  log('info', `✓ Withdrawal confirmed → ${withdrawHash.slice(0,20)}…`);

  // Fee transfer
  await sleep(600);
  log('info', `Transferring 1% agent fee → $${agentFee.toFixed(4)} USDC`);
  const feeHash = mockTxHash();
  state.fees.totalCollected = parseFloat((state.fees.totalCollected + agentFee).toFixed(6));
  state.fees.count++;
  broadcast('fees', { ...state.fees });
  addTx('FEE_TRANSFER', feeHash, `$${agentFee.toFixed(4)} USDC`, 'confirmed', {
    to:   MOCK_REVENUE_ADDRESS,
    note: '1% Guardian service fee',
    gas:  '$0.002',
  });
  log('info', `✓ Fee transferred → ${feeHash.slice(0,20)}…`);

  // VTpass payment
  await sleep(700);
  log('info', `VTpass: POST /pay  serviceID=abuja-electric  amount=₦${TOPUP_NGN.toLocaleString()}`);
  const requestId = mockReqId();
  log('info', `request_id: ${requestId}`);
  await sleep(1800);  // simulated API latency

  const token     = mockToken();
  const units     = parseFloat((TOPUP_NGN / 68).toFixed(2)); // ₦68/kWh AEDC tariff
  addTx('VTPASS_AEDC', requestId, `₦${TOPUP_NGN.toLocaleString()}`, 'confirmed', {
    token,
    units:     `${units} kWh`,
    meter:     state.meter.number,
    serviceID: 'abuja-electric',
    code:      '000',
  });
  log('info', `✓ VTpass success (code: 000) — token received`);

  // Credit meter
  await sleep(400);
  state.meter.units     = parseFloat((state.meter.units + units).toFixed(1));
  state.meter.isLow     = false;
  state.meter.topupCount++;
  state.meter.lastTopup = new Date().toISOString();
  state.aave.walletBalance = 0;
  broadcast('meter', { ...state.meter });
  broadcast('aave',  { ...state.aave });

  // Emit topup summary
  const summary = {
    token,
    units,
    amountNGN:  TOPUP_NGN,
    amountUSD:  topupUSD.toFixed(4),
    vtpassFee:  vtpassFee.toFixed(4),
    agentFee:   agentFee.toFixed(4),
    totalUSD:   totalUSD.toFixed(4),
    newBalance: state.meter.units.toFixed(1),
    txHash:     withdrawHash,
  };
  state.lastTopup = summary;
  broadcast('topup', summary);

  log('info', `✓ Meter credited +${units} units → new balance: ${state.meter.units.toFixed(1)}`);
  log('info', `📧 Email dispatched → token: ${token}`);
  log('info', '─── TOP-UP COMPLETE ─────────────────────────────────────');

  // Re-supply leftover
  await sleep(2000);
  const leftover = state.aave.walletBalance;
  if (leftover > 0) {
    log('info', `Re-supplying $${leftover.toFixed(4)} USDC to Aave…`);
  }
}

// ── Express routes ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',                'text/event-stream');
  res.setHeader('Cache-Control',               'no-cache');
  res.setHeader('Connection',                  'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  clients.add(res);
  // Send full state snapshot immediately on connect / reconnect
  res.write(`event: init\ndata: ${JSON.stringify(state)}\n\n`);
  req.on('close', () => clients.delete(res));
});

app.get('/api/state', (_req, res) => res.json(state));

app.listen(PORT, () => {
  const divider = '─'.repeat(52);
  console.log(`\n${divider}`);
  console.log(`  ⚡  UTILITY GUARDIAN  |  OWF Hackathon Demo`);
  console.log(divider);
  console.log(`  Dashboard  →  http://localhost:${PORT}`);
  console.log(`  API State  →  http://localhost:${PORT}/api/state`);
  console.log(`  SSE Feed   →  http://localhost:${PORT}/events`);
  console.log(`${divider}\n`);
  runDemoAgent();
});
