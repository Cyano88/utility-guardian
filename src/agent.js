'use strict';

/**
 * agent.js — The Utility Guardian Orchestrator
 *
 * Full autonomous lifecycle:
 *
 *  1. Initialise OWF vault & Policy Engine
 *  2. Supply idle USDC → Aave V3 (yield-earning)
 *  3. Start the AEDC meter digital twin (simulated consumption)
 *  4. On LOW event:
 *       a. Calculate exact cost (NGN → USD) + VTpass fee + 1% agent fee
 *       b. Policy Engine validates spend against limits + allowlist
 *       c. Aave withdraw() exactly the required USDC
 *       d. Send 1% fee to ADMIN_REVENUE_WALLET (on-chain USDC transfer)
 *       e. Call VTpass /pay → obtain 20-digit token
 *       f. Credit the meter twin
 *       g. Send email notification
 *  5. Log a periodic status heartbeat every 5 minutes
 */

const { ethers }                 = require('ethers');
const config                     = require('./config');
const logger                     = require('./logger');
const vault                      = require('./wallet');
const { PolicyEngine }           = require('./policy');
const AaveManager                = require('./aave');
const MeterTwin                  = require('./meter');
const { VTpassClient, VTpassError } = require('./vtpass');
const { sendTopupConfirmation }  = require('./notify');

const ERC20_ABI = require('./abis/ERC20.json');

const USDC_DECIMALS = 6;

class UtilityGuardian {
  constructor() {
    this.policy  = new PolicyEngine();
    this.aave    = new AaveManager(this.policy);
    this.meter   = new MeterTwin();
    this.vtpass  = new VTpassClient();
    this._busy   = false; // mutex — prevent concurrent top-up runs
  }

  // ─── Startup ───────────────────────────────────────────────────────────────

  async start() {
    logger.info('=== Utility Guardian starting ===');

    // 1. Boot the OWF wallet vault
    await vault.init();
    logger.info('OWF vault ready', { address: vault.address });

    // Add known contract addresses to the policy allowlist at runtime
    this.policy.addAllowedRecipient(config.AAVE_POOL_ADDRESS);
    if (config.ADMIN_REVENUE_WALLET) {
      this.policy.addAllowedRecipient(config.ADMIN_REVENUE_WALLET);
    }

    // 2. Move idle USDC into Aave to start earning yield
    try {
      await this.aave.supplyAll();
    } catch (err) {
      logger.warn('Initial Aave supply skipped', { reason: err.message });
    }

    // 3. Log initial position
    const position = await this.aave.getPosition().catch(() => null);
    if (position) logger.info('Initial position', position);

    // 4. Start the meter twin → listen for low-power events
    this.meter.on('low', (evt) => this._handleLowMeter(evt));
    this.meter.start();

    // 5. Heartbeat
    setInterval(() => this._heartbeat(), config.TICK_INTERVAL_MS);

    logger.info('=== Utility Guardian running ===', {
      meter:    config.METER_NUMBER,
      trigger:  `< ${config.TRIGGER_THRESHOLD} units`,
      topupNGN: config.TOPUP_AMOUNT_NGN,
    });
  }

  // ─── Core top-up flow ──────────────────────────────────────────────────────

  async _handleLowMeter(evt) {
    if (this._busy) {
      logger.warn('Top-up already in progress — skipping duplicate trigger.');
      return;
    }
    this._busy = true;

    try {
      logger.info('--- TOP-UP INITIATED ---', evt);
      await this._executeTopUp();
    } catch (err) {
      logger.error('Top-up failed', { error: err.message, stack: err.stack });
    } finally {
      this._busy = false;
    }
  }

  async _executeTopUp() {
    // ── Step 1: Calculate amounts ─────────────────────────────────────────────
    const topupNGN       = config.TOPUP_AMOUNT_NGN;
    const topupUSD       = topupNGN / config.NGN_USD_RATE;          // e.g. 5000/1600 ≈ $3.125
    const vtpassFeeUSD   = topupUSD * config.VTPASS_PROCESSING_PCT; // 5% VTpass overhead
    const agentFeeUSD    = topupUSD * (config.AGENT_FEE_BPS / 10000); // 1% agent fee
    const totalNeededUSD = topupUSD + vtpassFeeUSD + agentFeeUSD;

    logger.info('Fee breakdown', {
      topupUSD:       topupUSD.toFixed(4),
      vtpassFeeUSD:   vtpassFeeUSD.toFixed(4),
      agentFeeUSD:    agentFeeUSD.toFixed(4),
      totalNeededUSD: totalNeededUSD.toFixed(4),
    });

    // ── Step 2: Policy guard (pre-flight) ─────────────────────────────────────
    // Validates spend ceiling and daily cap before touching any funds
    this.policy.enforce({ to: config.ADMIN_REVENUE_WALLET }, totalNeededUSD);

    // ── Step 3: Verify meter before payment ───────────────────────────────────
    let customerInfo;
    try {
      customerInfo = await this.vtpass.verifyMeter(config.METER_NUMBER);
    } catch (err) {
      logger.error('Meter verification failed — aborting top-up', { error: err.message });
      throw err;
    }

    // ── Step 4: Withdraw from Aave (topupUSD + vtpassFee) ────────────────────
    // We withdraw the electricity + VTpass cost. The agent fee stays on-chain.
    const withdrawUSD    = topupUSD + vtpassFeeUSD;
    const withdrawReceipt = await this.aave.withdraw(withdrawUSD);

    // ── Step 5: Transfer 1% agent fee to revenue wallet ───────────────────────
    let feeTxHash = null;
    if (config.ADMIN_REVENUE_WALLET && agentFeeUSD > 0) {
      feeTxHash = await this._transferFee(agentFeeUSD);
    }

    // ── Step 6: Call VTpass to purchase electricity ───────────────────────────
    let vtpassResult;
    try {
      vtpassResult = await this.vtpass.pay(
        config.METER_NUMBER,
        topupNGN,
        process.env.CUSTOMER_PHONE || '08000000000'
      );
    } catch (err) {
      // VTpass failed after Aave withdrawal — log for manual reconciliation
      logger.error('CRITICAL: Aave funds withdrawn but VTpass payment failed!', {
        withdrawUSD,
        vtpassError: err.message,
        aaveTxHash:  withdrawReceipt.hash,
      });
      throw err;
    }

    const { token, units: unitsAdded, requestId } = vtpassResult;

    // ── Step 7: Update the meter digital twin ─────────────────────────────────
    this.meter.credit(unitsAdded || this._estimateUnits(topupNGN));

    // ── Step 8: Record total spend in policy ledger ───────────────────────────
    this.policy.recordSpend(totalNeededUSD);

    // ── Step 9: Email notification ────────────────────────────────────────────
    await sendTopupConfirmation({
      token,
      txHash:            withdrawReceipt.hash,
      meterNumber:       config.METER_NUMBER,
      topupAmountNGN:    topupNGN,
      topupAmountUSD:    topupUSD,
      agentFeeUSD,
      vtpassFeeUSD,
      totalWithdrawnUSD: withdrawUSD,
      unitsAdded:        unitsAdded || this._estimateUnits(topupNGN),
      newBalance:        this.meter.currentUnits,
    });

    logger.info('--- TOP-UP COMPLETE ---', {
      token,
      aaveTxHash:  withdrawReceipt.hash,
      feeTxHash,
      unitsAdded,
      meterBalance: this.meter.currentUnits.toFixed(2),
    });

    return { token, withdrawReceipt, feeTxHash, unitsAdded };
  }

  // ─── Revenue fee transfer ──────────────────────────────────────────────────

  async _transferFee(amountUSD) {
    const rawAmount = ethers.parseUnits(amountUSD.toFixed(6), USDC_DECIMALS);
    const usdc      = new ethers.Contract(config.USDC_ADDRESS, ERC20_ABI, vault.signer);

    logger.info('Sending agent fee to revenue wallet', {
      to:        config.ADMIN_REVENUE_WALLET,
      amountUSD: amountUSD.toFixed(4),
    });

    // Build the tx so the Policy Engine can inspect it
    const txRequest = await usdc.transfer.populateTransaction(
      config.ADMIN_REVENUE_WALLET,
      rawAmount
    );

    // Sign via OWF wallet standard (policy check happens inside)
    const signedTx = await vault.signTransaction(txRequest, this.policy);

    // Broadcast
    const tx      = await vault.provider.broadcastTransaction(signedTx);
    const receipt = await tx.wait(1);

    logger.info('Fee transfer confirmed', {
      txHash:    receipt.hash,
      amountUSD: amountUSD.toFixed(4),
    });

    return receipt.hash;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Rough unit estimate when VTpass doesn't return units in response. */
  _estimateUnits(amountNGN) {
    // AEDC Band B tariff ≈ ₦68/kWh (2024). Adjust as needed.
    const AEDC_TARIFF_NGN_PER_KWH = 68;
    return amountNGN / AEDC_TARIFF_NGN_PER_KWH;
  }

  async _heartbeat() {
    try {
      const position = await this.aave.getPosition();
      logger.info('Heartbeat', {
        meter:      this.meter.status(),
        aave:       `$${position.aaveUSDC.toFixed(4)} USDC`,
        wallet:     `$${position.walletUSDC.toFixed(4)} USDC`,
        total:      `$${position.totalUSDC.toFixed(4)} USDC`,
      });
    } catch (err) {
      logger.warn('Heartbeat failed', { error: err.message });
    }
  }

  /** Graceful shutdown hook. */
  async stop() {
    this.meter.stop();
    logger.info('Utility Guardian stopped.');
  }
}

module.exports = UtilityGuardian;
