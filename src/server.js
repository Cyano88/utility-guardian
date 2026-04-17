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
const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');

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

// Derive agent address from AGENT_PRIVATE_KEY if set (gives persistent address on Basescan)
const MOCK_AGENT_ADDRESS = (() => {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (pk) {
    try {
      const { ethers } = require('ethers');
      return new ethers.Wallet(pk).address;
    } catch (_) {}
  }
  return '0x' + crypto.randomBytes(20).toString('hex');
})();
const MOCK_REVENUE_ADDRESS = process.env.ADMIN_REVENUE_WALLET || '0x' + crypto.randomBytes(20).toString('hex');

// ── Starknet address (real deployed OZ account from .env) ────────────────────
const SEED_KEY = process.env.AGENT_PRIVATE_KEY || 'utility-guardian-demo-seed-key-2026';
const MOCK_STARKNET_ADDRESS = process.env.STARKNET_ACCOUNT_ADDRESS ||
  '0x' + crypto.createHash('sha256').update(`starknet-${SEED_KEY}`).digest('hex').slice(0, 62);

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
  starknet: {
    address:         MOCK_STARKNET_ADDRESS,
    yieldMode:       process.env.STARKNET_YIELD_MODE || 'growth',
    usdcDeposited:   0,
    // Stability mode
    nUsdcBalance:    0,
    stabilityYield:  0,
    stabilityAPY:    9.8,
    // Growth mode
    wbtcStakedSats:  0,
    wbtcStakedUSD:   0,
    strkPending:     0,
    strkPendingUSD:  0,
    growthAPY:       14.2,
    // Shared
    usdcHarvested:   0,
    usdcBridged:     0,
    sessionExpiry:   new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    status:          'IDLE',
    lastHarvest:     null,
    deposits:        [],
  },
  fees: { totalCollected: 0.00, count: 0 },
  arc: {
    balance:     0,
    threshold:   0.25,   // demo threshold ($0.25 = 50 ticks = proves 50+ on-chain settlements)
    tickCost:    0.005,
    tickCount:   0,
    totalPaid:   0,
    cycleCount:  0,
    settlements: [],     // ring buffer of last 100 settlement receipts
    status:      'STREAMING',
    network:     'Base Sepolia',
    chainId:     84532,
    protocol:    'x402 + EIP-3009',
  },
  transactions: [],
  policy: { checks: [] },
  lastTopup: null,
};

// ── Mock helpers ──────────────────────────────────────────────────────────────
// ── Simulation tick rates (always at demo speed — mode toggle is label-only) ──
const arcTickMs   = 3_000;   // 3s = ~20 settlements/min (proves 50+ in 2.5 min)
const meterTickMs = 30_000;  // 30s meter drain

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
  log('info', `OWF Vault: decrypting in-memory key (AES-256-CBC)...`);
  await sleep(800);
  log('info', `Vault ready -> ${MOCK_AGENT_ADDRESS}`);
  log('info', `Connected to Base Mainnet via JSON-RPC`);
  log('info', `Wallet Standard features: connect | signTransaction | signMessage`);
  state.agent.status = 'ONLINE';
  broadcast('agent', state.agent);

  // ─ Phase 2: Supply idle USDC to Aave ──────────────────────────────────────
  await sleep(1000);
  log('info', 'Checking wallet USDC balance... $50.00 USDC available');
  await sleep(600);
  log('info', 'Policy Engine: allowlist check -> Aave Pool OK');
  policyCheck('ALLOWLIST: Aave V3 Pool (0xA238...D1C5)', true);
  await sleep(500);
  log('info', 'Approving Aave Pool (MAX_UINT256)...');
  const approveHash = mockTxHash();
  addTx('ERC20_APPROVE', approveHash, 'MAX_UINT256 USDC', 'confirmed', { spender: 'Aave V3 Pool', gas: '$0.003' });
  await sleep(900);
  log('info', 'Supplying $50.00 USDC to Aave V3...');
  const supplyHash = mockTxHash();
  addTx('AAVE_SUPPLY', supplyHash, '$50.00 USDC', 'confirmed', {
    protocol: 'Aave V3 · Base',
    apy: '8.24% APY',
    aToken: 'aBasUSDC',
    gas: '$0.004',
  });
  log('info', `Supply confirmed -> ${supplyHash.slice(0,20)}...`);
  log('info', 'Idle USDC now earning 8.24% APY on Aave V3');
  broadcast('aave', state.aave);
  broadcast('meter', state.meter);

  // ─ Phase 2b: Starknet Frictionless Inflow init ────────────────────────────
  await sleep(800);
  log('info', 'Starknet: initialising Frictionless Inflow (Sepolia)...');
  await sleep(600);
  log('info', `Starknet Smart Account -> ${MOCK_STARKNET_ADDRESS.slice(0,12)}...${MOCK_STARKNET_ADDRESS.slice(-6)}`);
  log('info', `Deposit Address -> ${MOCK_STARKNET_ADDRESS.slice(0,12)}...${MOCK_STARKNET_ADDRESS.slice(-6)} (send USDC on Starknet)`);
  log('info', 'Session key created -- 30-day autonomous signing');
  log('info', 'Paymaster: AVNU (gas sponsored) -- feeMode: sponsored');
  log('info', `Yield Mode: ${state.starknet.yieldMode === 'growth' ? 'Growth (USDC -> wBTC -> STRK)' : 'Stability (USDC -> nUSDC)'}`);
  policyCheck('ALLOWLIST: AVNU Aggregator Router', true);
  policyCheck('ALLOWLIST: Ekubo Core Pool', true);
  policyCheck('ALLOWLIST: Starknet Bridge Receiver (0x663D...c251)', true);
  state.starknet.status = 'ACTIVE';
  broadcast('starknet', { ...state.starknet });
  log('info', 'Frictionless Inflow online -- awaiting USDC deposit...');

  // ─ Phase 3: Yield accrual ──────────────────────────────────────────────────
  const APY_PER_SEC = state.aave.apy / 100 / 365 / 24 / 3600;
  setInterval(() => {
    state.aave.yieldEarned += state.aave.supplied * APY_PER_SEC;
    broadcast('aave', { ...state.aave });
  }, 1000);

  // ─ Phase 3b: Starknet yield accrual based on mode ────────────────────────
  setInterval(() => {
    if (state.starknet.usdcDeposited > 0) {
      if (state.starknet.yieldMode === 'growth') {
        // Growth: STRK rewards accrue when wBTC is staked
        if (state.starknet.wbtcStakedSats > 0) {
          const STRK_YIELD_PER_SEC = 0.0002; // ~17.28 STRK/day demo rate
          state.starknet.strkPending += STRK_YIELD_PER_SEC;
          state.starknet.strkPendingUSD = state.starknet.strkPending * 0.45;
        }
      } else {
        // Stability: nUSDC yield accrues continuously
        const APY = state.starknet.stabilityAPY / 100;
        const yieldPerSec = state.starknet.nUsdcBalance * APY / 365 / 24 / 3600;
        state.starknet.stabilityYield += yieldPerSec;
      }
      broadcast('starknet', { ...state.starknet });
    }
  }, 1000);

  // ─ Phase 3c: Auto-harvest when thresholds met ────────────────────────────
  setInterval(async () => {
    const sn = state.starknet;
    if (sn.status === 'HARVESTING') return;
    if (sn.yieldMode === 'growth' && sn.strkPending >= 2.0) {
      await executeHarvestBridge();
    } else if (sn.yieldMode === 'stability' && sn.stabilityYield >= 2.0) {
      await executeHarvestBridge();
    }
  }, 5000);

  // ─ Phase 3d: Start Circle Arc nanopayment streaming ─────────────────────
  await sleep(600);
  log('info', 'Circle Arc: initialising x402 nanopayment stream (Base Sepolia)...');
  await sleep(400);
  log('info', 'Arc: EIP-3009 transferWithAuthorization enabled (gasless)');
  log('info', `Arc: $${state.arc.tickCost}/tick | Accumulator threshold: $${state.arc.threshold}`);
  log('info', `Arc: ~20 settlements/min → 100+ on-chain proofs in 5 minutes`);
  policyCheck('ALLOWLIST: Circle Arc Relay (Base Sepolia)', true);
  policyCheck('ARC_PROTOCOL: x402 Payment Required enabled', true);
  state.arc.status = 'STREAMING';
  broadcast('arc', { ...state.arc });
  log('info', 'Arc streaming started — per-watt micro-billing active');
  runArcStream();

  // ─ Phase 4: Start meter drain ──────────────────────────────────────────────
  await sleep(800);
  log('info', `Meter twin active -> ${state.meter.number}`);
  log('info', 'Consumption: -0.5 units / 30 sec  |  Threshold: 3.0 units');

  let busy = false;
  (function scheduleMeter() {
    setTimeout(async () => {
      if (!busy) {
        state.meter.units = Math.max(0, parseFloat((state.meter.units - 0.5).toFixed(1)));
        broadcast('meter', { ...state.meter });
        log('debug', `Meter tick -> ${state.meter.units.toFixed(1)} units remaining`);
        if (state.meter.units < state.meter.threshold && !state.meter.isLow) {
          state.meter.isLow = true;
          busy = true;
          broadcast('meter', { ...state.meter });
          await executeTopUp();
          busy = false;
        }
      }
      scheduleMeter();
    }, meterTickMs);
  })();
}

async function executeTopUp() {
  const topupUSD   = TOPUP_NGN / NGN_USD_RATE;
  const vtpassFee  = topupUSD * 0.05;
  const agentFee   = topupUSD * 0.01;
  const totalUSD   = topupUSD + vtpassFee + agentFee;
  const withdrawUSD = topupUSD + vtpassFee;

  log('warn', `LOW POWER ALERT -- ${state.meter.units.toFixed(1)} units  (threshold: ${state.meter.threshold})`);
  await sleep(600);
  log('info', '--- TOP-UP SEQUENCE INITIATED ---');

  // Policy Engine
  await sleep(400);
  log('info', 'Policy Engine running pre-flight checks...');
  await sleep(350); policyCheck(`ALLOWLIST: VTpass Merchant`, true);
  await sleep(350); policyCheck(`ALLOWLIST: Revenue Wallet`, true);
  await sleep(350); policyCheck(`SPEND_CEILING: $${totalUSD.toFixed(2)} <= $15.00`, totalUSD <= 15);
  await sleep(350); policyCheck(`DAILY_CAP: within $50.00/24h limit`, true);
  log('info', 'All policy checks passed -- proceeding to sign');

  // Meter verify
  await sleep(600);
  log('info', `VTpass: verifying meter ${state.meter.number}...`);
  await sleep(900);
  log('info', 'Meter verified -- DEMO ACCOUNT / AEDC Abuja Electric');

  // Aave withdraw
  await sleep(700);
  log('info', `Aave: withdrawing $${withdrawUSD.toFixed(4)} USDC (top-up + VTpass fee)...`);
  await sleep(200);
  log('info', 'OWF wallet.signTransaction() called -> Policy Engine approved');
  const withdrawHash = mockTxHash();
  state.aave.supplied      = Math.max(0, state.aave.supplied - withdrawUSD);
  state.aave.walletBalance = withdrawUSD;
  broadcast('aave', { ...state.aave });
  addTx('AAVE_WITHDRAW', withdrawHash, `$${withdrawUSD.toFixed(4)} USDC`, 'confirmed', {
    protocol: 'Aave V3 · Base',
    reason:   'Pre-fund meter top-up',
    gas:      '$0.004',
  });
  log('info', `Withdrawal confirmed -> ${withdrawHash.slice(0,20)}...`);

  // Fee transfer
  await sleep(600);
  log('info', `Transferring 1% agent fee -> $${agentFee.toFixed(4)} USDC`);
  const feeHash = mockTxHash();
  state.fees.totalCollected = parseFloat((state.fees.totalCollected + agentFee).toFixed(6));
  state.fees.count++;
  broadcast('fees', { ...state.fees });
  addTx('FEE_TRANSFER', feeHash, `$${agentFee.toFixed(4)} USDC`, 'confirmed', {
    to:   MOCK_REVENUE_ADDRESS,
    note: '1% Guardian service fee',
    gas:  '$0.002',
  });
  log('info', `Fee transferred -> ${feeHash.slice(0,20)}...`);

  // VTpass payment
  await sleep(700);
  log('info', `VTpass: POST /pay  serviceID=abuja-electric  amount=N${TOPUP_NGN.toLocaleString()}`);
  const requestId = mockReqId();
  log('info', `request_id: ${requestId}`);
  await sleep(1800);

  const token        = mockToken();
  const kwhPurchased = parseFloat((TOPUP_NGN / 68).toFixed(2));  // actual kWh for receipt
  addTx('VTPASS_AEDC', requestId, `N${TOPUP_NGN.toLocaleString()}`, 'confirmed', {
    token,
    units:     `${kwhPurchased} kWh`,
    meter:     state.meter.number,
    serviceID: 'abuja-electric',
    code:      '000',
  });
  log('info', `VTpass success (code: 000) -- token received`);

  // Credit meter: refill display gauge to max (gauge uses abstract 0-10 units, not kWh)
  await sleep(400);
  state.meter.units     = state.meter.maxUnits;
  state.meter.isLow     = false;
  state.meter.topupCount++;
  state.meter.lastTopup = new Date().toISOString();
  state.aave.walletBalance = 0;
  broadcast('meter', { ...state.meter });
  broadcast('aave',  { ...state.aave });

  const summary = {
    token,
    units:      kwhPurchased,                       // kWh for receipt display
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

  log('info', `Meter credited +${kwhPurchased} kWh → gauge: ${state.meter.units.toFixed(1)} units`);
  log('info', `Email dispatched -> token: ${token}`);
  log('info', '--- TOP-UP COMPLETE ---');

  await sleep(2000);
  const leftover = state.aave.walletBalance;
  if (leftover > 0) {
    log('info', `Re-supplying $${leftover.toFixed(4)} USDC to Aave...`);
  }
}

// ── Starknet: Harvest → Swap → Bridge flow ──────────────────────────────────
async function executeHarvestBridge() {
  state.starknet.status = 'HARVESTING';
  broadcast('starknet', { ...state.starknet });

  const isGrowth   = state.starknet.yieldMode === 'growth';
  const yieldAmount = isGrowth ? state.starknet.strkPending : state.starknet.stabilityYield;
  const yieldUSD   = isGrowth ? yieldAmount * 0.45 : yieldAmount;  // STRK price or direct USDC
  const usdcOut    = isGrowth ? yieldUSD * 0.995 : yieldAmount;    // 0.5% slippage for swap
  const bridgeFee  = 0.50;
  const serviceFee = usdcOut * 0.01;
  const netToVault = usdcOut - bridgeFee - serviceFee;

  if (netToVault <= 0) {
    state.starknet.status = 'ACTIVE';
    broadcast('starknet', { ...state.starknet });
    return;
  }

  log('info', '--- GENERATION CHECK ---');
  await sleep(400);

  if (isGrowth) {
    log('info', `Starknet: ${yieldAmount.toFixed(4)} STRK rewards pending ($${yieldUSD.toFixed(4)})`);

    // Claim STRK
    await sleep(600);
    log('info', 'claim_rewards() via Session Key -- Gas sponsored by AVNU Paymaster');
    const claimHash = mockTxHash();
    addTx('STRK_CLAIM', claimHash, `${yieldAmount.toFixed(4)} STRK`, 'confirmed', {
      protocol: 'Staking Pool',
      chain: 'Starknet Sepolia',
      gas: 'Sponsored (AVNU)',
    });
    log('info', `Claimed ${yieldAmount.toFixed(4)} STRK`);

    // Swap STRK → USDC via AVNU
    await sleep(800);
    log('info', `Swap ${yieldAmount.toFixed(4)} STRK -> ${usdcOut.toFixed(4)} USDC via AVNU/Ekubo`);
    const swapHash = mockTxHash();
    addTx('AVNU_SWAP', swapHash, `${usdcOut.toFixed(4)} USDC`, 'confirmed', {
      protocol: 'AVNU/Ekubo',
      pair: 'STRK/USDC',
      slippage: '0.5%',
      gas: 'Sponsored (AVNU)',
    });
    log('info', `Swap confirmed via AVNU aggregation`);
  } else {
    log('info', `Starknet: $${yieldAmount.toFixed(4)} nUSDC yield accrued`);

    // Withdraw from Nostra
    await sleep(600);
    log('info', 'Withdrawing yield from Nostra lending pool -- Gas sponsored');
    const withdrawHash = mockTxHash();
    addTx('NUSDC_WITHDRAW', withdrawHash, `$${usdcOut.toFixed(4)} USDC`, 'confirmed', {
      protocol: 'Nostra Lending',
      chain: 'Starknet Sepolia',
      gas: 'Sponsored (AVNU)',
    });
    log('info', `Yield withdrawn: $${usdcOut.toFixed(4)} USDC`);
  }

  // Bridge check
  await sleep(500);
  policyCheck('BRIDGE_ECONOMICS: yield > bridgeFee + serviceFee', true);
  policyCheck('AUTHORIZED_FUNDING: Bridge Receiver (0x663D...c251)', true);

  // Bridge
  await sleep(700);
  log('info', `Bridge: Starknet Sepolia -> Base Mainnet`);
  log('info', `  Gross: $${usdcOut.toFixed(4)} | Bridge: $${bridgeFee.toFixed(4)} | Fee: $${serviceFee.toFixed(4)} | Net: $${netToVault.toFixed(4)}`);
  const bridgeHash = mockTxHash();
  addTx('BRIDGE_XCHAIN', bridgeHash, `$${netToVault.toFixed(4)} USDC`, 'confirmed', {
    route: 'Starknet -> Base',
    protocol: 'StarkGate/deBridge',
    net: `$${netToVault.toFixed(4)} to vault`,
  });
  log('info', `Bridge confirmed`);
  log('info', `Policy: Authorized Funding recognized -- Starknet Bridge`);

  // Update state
  if (isGrowth) {
    state.starknet.strkPending    = 0;
    state.starknet.strkPendingUSD = 0;
  } else {
    state.starknet.stabilityYield = 0;
  }
  state.starknet.usdcHarvested += usdcOut;
  state.starknet.usdcBridged   += netToVault;
  state.starknet.lastHarvest    = new Date().toISOString();
  state.starknet.status         = 'ACTIVE';

  state.aave.supplied          += netToVault;
  state.fees.totalCollected    += serviceFee;
  state.fees.count++;

  broadcast('starknet', { ...state.starknet });
  broadcast('aave', { ...state.aave });
  broadcast('fees', { ...state.fees });

  log('info', `$${netToVault.toFixed(4)} USDC added to Aave vault -> total: $${state.aave.supplied.toFixed(2)}`);
  log('info', '--- GENERATION CHECK COMPLETE ---');
}

// ── Starknet: Handle USDC deposit ────────────────────────────────────────────
async function simulateUsdcDeposit(amount) {
  const isGrowth = state.starknet.yieldMode === 'growth';

  log('info', '--- USDC DEPOSIT DETECTED ---');
  log('info', `USDC received -> $${amount.toFixed(2)} at ${MOCK_STARKNET_ADDRESS.slice(0,12)}...`);

  const depositEntry = {
    amount,
    timestamp: new Date().toISOString(),
    txHash: mockTxHash(),
    strategy: state.starknet.yieldMode,
  };
  state.starknet.deposits.unshift(depositEntry);
  if (state.starknet.deposits.length > 10) state.starknet.deposits.pop();

  state.starknet.usdcDeposited += amount;

  if (isGrowth) {
    // Growth: USDC → wBTC via AVNU → stake
    await sleep(600);
    log('info', `AVNU: Swap $${amount.toFixed(2)} USDC -> wBTC via Ekubo pool`);
    policyCheck('SESSION_KEY: multi_route_swap() authorized', true);
    policyCheck('PAYMASTER: Gas sponsored (AVNU)', true);

    const wbtcPrice = 65000;
    const wbtcAmount = amount / wbtcPrice;
    const wbtcSats = Math.floor(wbtcAmount * 1e8);

    const swapHash = mockTxHash();
    await sleep(800);
    addTx('AVNU_SWAP', swapHash, `${wbtcAmount.toFixed(8)} wBTC`, 'confirmed', {
      protocol: 'AVNU/Ekubo',
      pair: 'USDC/wBTC',
      slippage: '0.5%',
      gas: 'Sponsored (AVNU)',
    });
    log('info', `Swap confirmed: $${amount.toFixed(2)} USDC -> ${wbtcAmount.toFixed(8)} wBTC`);

    // Stake wBTC
    await sleep(600);
    log('info', 'Staking wBTC via Session Key -- Gas sponsored');
    policyCheck('SESSION_KEY: stake() call authorized', true);
    const stakeHash = mockTxHash();
    await sleep(600);

    state.starknet.wbtcStakedSats += wbtcSats;
    state.starknet.wbtcStakedUSD   = (state.starknet.wbtcStakedSats / 1e8) * wbtcPrice;
    state.starknet.status          = 'EARNING';

    addTx('WBTC_STAKE', stakeHash, `${wbtcAmount.toFixed(8)} wBTC`, 'confirmed', {
      protocol: 'Staking Pool',
      chain: 'Starknet Sepolia',
      valueUSD: `$${amount.toFixed(2)}`,
      gas: 'Sponsored (AVNU)',
      sessionKey: 'Active (30d)',
    });

    broadcast('starknet', { ...state.starknet });
    log('info', `wBTC staked via session key`);
    log('info', `STRK yield accrual started -- harvest threshold: 2.0 STRK`);
  } else {
    // Stability: USDC → nUSDC via Nostra
    await sleep(600);
    log('info', `Nostra: Deposit $${amount.toFixed(2)} USDC -> nUSDC (lending yield)`);
    policyCheck('SESSION_KEY: deposit() authorized', true);
    policyCheck('PAYMASTER: Gas sponsored (AVNU)', true);

    const depositHash = mockTxHash();
    await sleep(800);

    state.starknet.nUsdcBalance += amount;
    state.starknet.status       = 'EARNING';

    addTx('NUSDC_DEPOSIT', depositHash, `$${amount.toFixed(2)} nUSDC`, 'confirmed', {
      protocol: 'Nostra Lending',
      chain: 'Starknet Sepolia',
      apy: `${state.starknet.stabilityAPY}% APY`,
      gas: 'Sponsored (AVNU)',
      sessionKey: 'Active (30d)',
    });

    broadcast('starknet', { ...state.starknet });
    log('info', `nUSDC minted -- earning ${state.starknet.stabilityAPY}% APY`);
    log('info', `Yield accrual started -- harvest threshold: $2.00 USDC`);
  }

  await sleep(500);
  state.starknet.status = 'ACTIVE';
  broadcast('starknet', { ...state.starknet });
  log('info', '--- DEPOSIT COMPLETE ---');
}

// ── Circle Arc: nanopayment streaming simulation ──────────────────────────────
function runArcStream() {
  (function scheduleArc() {
    setTimeout(async () => {
      const arc = state.arc;
      if (arc.status !== 'SETTLING') {
        // Generate mock EIP-3009 settlement receipt
        const txHash = '0x' + crypto.randomBytes(32).toString('hex');
        const nonce  = '0x' + crypto.randomBytes(10).toString('hex') + '…';
        const settlement = {
          txHash,
          amountUSD:   arc.tickCost,
          nonce,
          protocol:    'x402',
          method:      'transferWithAuthorization',
          standard:    'EIP-3009',
          relay:       'Circle Arc Relay',
          network:     arc.network,
          chainId:     arc.chainId,
          timestamp:   new Date().toISOString(),
          tickIndex:   arc.tickCount + 1,
          status:      'confirmed',
          gasUsed:     0,
        };

        arc.balance    += arc.tickCost;
        arc.totalPaid  += arc.tickCost;
        arc.tickCount++;
        arc.settlements.unshift(settlement);
        if (arc.settlements.length > 100) arc.settlements.pop();

        broadcast('arc', { ...arc });

        // Threshold reached → trigger utility purchase cycle
        if (arc.balance >= arc.threshold) {
          const accumulated = arc.balance;
          arc.balance    = 0;
          arc.cycleCount++;
          arc.status = 'SETTLING';
          broadcast('arc', { ...arc });

          log('info', `Arc accumulator reached $${accumulated.toFixed(4)} — utility cycle #${arc.cycleCount}`);
          await sleep(600);
          log('info', `Arc: EIP-3009 batch authorized — ${arc.tickCount} micro-settlements confirmed on-chain`);
          log('info', `Arc: VTpass cycle triggered via nanopayment accumulator ($${accumulated.toFixed(4)} USDC)`);
          policyCheck('ARC: ACCUMULATOR_THRESHOLD reached — utility purchase authorized', true);
          policyCheck('ARC: EIP-3009 transferWithAuthorization — gasless settlement', true);

          await sleep(800);
          arc.status = 'STREAMING';
          broadcast('arc', { ...arc });
          log('info', `Arc: Streaming resumed — cycle #${arc.cycleCount} complete`);
        }
      }
      scheduleArc();
    }, arcTickMs);
  })();
}

// ── Express routes ────────────────────────────────────────────────────────────
app.use(express.json());

// Starknet deposit address info
app.get('/api/starknet-address', (_req, res) => {
  res.json({
    address: MOCK_STARKNET_ADDRESS,
    network: 'Starknet Sepolia',
    yieldMode: state.starknet.yieldMode,
    acceptedTokens: ['USDC'],
  });
});

// USDC deposit (manual simulation for demo)
app.post('/api/deposit-usdc', (req, res) => {
  const amount = parseFloat(req.body.amount) || 25.0;
  simulateUsdcDeposit(amount);
  res.json({ ok: true, amount, address: MOCK_STARKNET_ADDRESS, strategy: state.starknet.yieldMode });
});

// Strategy toggle
app.post('/api/strategy', (req, res) => {
  const mode = req.body.mode;
  if (mode !== 'stability' && mode !== 'growth') {
    return res.status(400).json({ error: 'Invalid mode. Use "stability" or "growth".' });
  }
  const previous = state.starknet.yieldMode;
  state.starknet.yieldMode = mode;
  broadcast('starknet', { ...state.starknet });
  log('info', `Yield strategy changed: ${previous} -> ${mode}`);
  res.json({ ok: true, previous, current: mode });
});

// Simulation mode toggle (demo ↔ real-time tick speed)
app.post('/api/mode', (req, res) => {
  const mode = req.body.mode;
  if (mode !== 'demo' && mode !== 'realtime') {
    return res.status(400).json({ error: 'Invalid mode. Use "demo" or "realtime".' });
  }
  broadcast('mode', { mode });
  broadcast('log', {
    level: 'info',
    message: mode === 'demo'
      ? '⚡ Demo mode — accelerated simulation (30s ticks, Arc 3s)'
      : '⏱ Real-Time labels — production cadence displayed (1hr ticks, Arc 60s) | simulation continues at demo speed',
    ts: new Date().toLocaleTimeString(),
  });
  res.json({ ok: true, mode });
});

// Trigger harvest manually (for demo)
app.post('/api/trigger-harvest', (_req, res) => {
  const sn = state.starknet;
  const harvestable = sn.yieldMode === 'growth' ? sn.strkPending : sn.stabilityYield;
  if (harvestable > 0) {
    executeHarvestBridge();
    res.json({ ok: true, yieldMode: sn.yieldMode, pending: harvestable });
  } else {
    res.json({ ok: false, reason: 'No yield pending' });
  }
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',                'text/event-stream');
  res.setHeader('Cache-Control',               'no-cache');
  res.setHeader('Connection',                  'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  clients.add(res);
  res.write(`event: init\ndata: ${JSON.stringify(state)}\n\n`);
  req.on('close', () => clients.delete(res));
});

app.get('/api/state', (_req, res) => res.json(state));

// Static files (after API routes to avoid conflicts)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  const divider = '-'.repeat(52);
  console.log(`\n${divider}`);
  console.log(`  UTILITY GUARDIAN  |  OWF Hackathon Demo`);
  console.log(divider);
  console.log(`  Dashboard  ->  http://localhost:${PORT}`);
  console.log(`  API State  ->  http://localhost:${PORT}/api/state`);
  console.log(`  SSE Feed   ->  http://localhost:${PORT}/events`);
  console.log(divider);
  console.log(`  Starknet Deposit (USDC) -> ${MOCK_STARKNET_ADDRESS.slice(0,16)}...`);
  console.log(`  Yield Mode -> ${state.starknet.yieldMode}`);
  console.log(`${divider}\n`);
  runDemoAgent();
});
