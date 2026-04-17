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
const { StarknetService }        = require('./services/starknet');
const { BridgeService }          = require('./services/bridge');
const { ArcNanopaymentService }  = require('./services/arc');

const ERC20_ABI = require('./abis/ERC20.json');

const USDC_DECIMALS = 6;

class UtilityGuardian {
  constructor() {
    this.policy    = new PolicyEngine();
    this.aave      = new AaveManager(this.policy);
    this.meter     = new MeterTwin();
    this.vtpass    = new VTpassClient();
    this.starknet  = new StarknetService();
    this.bridge    = new BridgeService();
    this.arc       = new ArcNanopaymentService(this.policy, vault);
    this._busy     = false; // mutex — prevent concurrent top-up runs
    this._yieldTimer = null;
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

    // 4. Initialise Starknet Frictionless Inflow
    try {
      await this.starknet.init();
      // Add bridge contract to policy allowlist
      this.policy.addAllowedRecipient(config.BRIDGE_BASE_RECEIVER);
      logger.info('Frictionless Inflow online', {
        starknetAddress: this.starknet.address,
        yieldMode:       this.starknet.yieldMode,
        network:         'Starknet Sepolia',
      });
    } catch (err) {
      logger.warn('Starknet init skipped', { reason: err.message });
    }

    // 5. Start Circle Arc nanopayment streaming
    try {
      this.arc.start((accumulated) => this._handleArcThreshold(accumulated));
      this.policy.addAllowedRecipient(config.ARC_RELAY_ADDRESS);
      logger.info('Circle Arc streaming started', {
        network:   'Base Sepolia',
        tickCost:  `$${config.ARC_TICK_COST}`,
        threshold: `$${config.ARC_ACCUMULATOR_THRESHOLD}`,
        protocol:  'x402 + EIP-3009',
      });
    } catch (err) {
      logger.warn('Arc init skipped', { reason: err.message });
    }

    // 6. Start the meter twin → listen for low-power events
    this.meter.on('low', (evt) => this._handleLowMeter(evt));
    this.meter.start();

    // 7. Heartbeat
    setInterval(() => this._heartbeat(), config.TICK_INTERVAL_MS);

    // 8. Starknet yield generation check (every 12-24 hours)
    this._yieldTimer = setInterval(
      () => this._generationCheck(),
      config.STARKNET_YIELD_CHECK_MS
    );
    // Run an initial check after a short delay
    setTimeout(() => this._generationCheck(), 30_000);

    logger.info('=== Utility Guardian running ===', {
      meter:     config.METER_NUMBER,
      trigger:   `< ${config.TRIGGER_THRESHOLD} units`,
      topupNGN:  config.TOPUP_AMOUNT_NGN,
      starknet:  this.starknet.address ? 'ACTIVE' : 'DISABLED',
      yieldMode: this.starknet.yieldMode || 'N/A',
      arc:       `streaming $${config.ARC_TICK_COST}/tick → $${config.ARC_ACCUMULATOR_THRESHOLD} threshold`,
    });
  }

  // ─── Arc threshold handler ─────────────────────────────────────────────────

  /**
   * Called by the Arc accumulator when streamed USDC hits the threshold.
   * Logs the event; can optionally trigger a direct VTpass purchase.
   * In the primary flow, the main Aave→VTpass path handles top-ups;
   * Arc top-ups serve as the nano-billing (streaming utilities) pathway.
   */
  async _handleArcThreshold(accumulatedUSD) {
    logger.info('Arc threshold reached — utility payment cycle', {
      accumulated:  `$${accumulatedUSD.toFixed(4)}`,
      arcStatus:    this.arc.getStatus(),
    });
    // Optionally execute a direct top-up here (bypassing Aave withdrawal)
    // for pure Arc-streamed electricity purchases:
    // await this._executeTopUp({ source: 'arc', amountUSD: accumulatedUSD });
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

  // ─── Starknet Generation Check ──────────────────────────────────────────────

  /**
   * _generationCheck() — Periodic yield harvest from Starknet Frictionless Inflow.
   *
   * Stability mode: check nUSDC yield accrued → withdraw → bridge to Base
   * Growth mode:    check STRK rewards → harvest → swap to USDC → bridge to Base
   */
  async _generationCheck() {
    if (!this.starknet.address) return;

    try {
      logger.info('--- GENERATION CHECK ---');

      // 1. Check yield status
      const status = await this.starknet.getYieldStatus();
      logger.info('Starknet yield status', {
        mode:          status.yieldMode,
        usdcDeposited: status.usdcDeposited.toFixed(4),
        strkPending:   status.strkPending.toFixed(4),
        stabilityYield: status.stabilityYield.toFixed(4),
      });

      // 2. Check harvest thresholds based on mode
      const harvestable = status.yieldMode === 'stability'
        ? status.stabilityYield
        : status.strkPending;

      const threshold = status.yieldMode === 'stability'
        ? config.STARKNET_STRK_MIN_HARVEST  // reuse threshold for both modes
        : config.STARKNET_STRK_MIN_HARVEST;

      if (harvestable < threshold) {
        logger.debug('Yield below harvest threshold', {
          pending:   harvestable.toFixed(4),
          threshold,
          mode:      status.yieldMode,
        });
        return;
      }

      // 3. Harvest & swap to USDC
      const harvest = await this.starknet.harvestAndSwap();
      if (!harvest) return;

      logger.info('Harvest complete', {
        usdcReceived: harvest.usdcReceived.toFixed(4),
        source:       harvest.source,
        gasMode:      harvest.gasMode,
      });

      // 4. Check bridge economics
      const bridgeCheck = this.bridge.shouldBridge(harvest.usdcReceived);
      if (!bridgeCheck.viable) {
        logger.info('Bridge deferred -- not yet economical', {
          reason: bridgeCheck.reason,
        });
        return;
      }

      // 5. Bridge to Base vault
      const bridgeReceipt = await this.bridge.bridge(
        harvest.usdcReceived,
        vault.address
      );

      // 6. Verify as authorized funding
      const funding = this.policy.isAuthorizedFunding(config.BRIDGE_BASE_RECEIVER);
      logger.info('Bridge initiated -- Authorized Funding', {
        txHash:     bridgeReceipt.txHash,
        netAmount:  bridgeReceipt.netAmount.toFixed(4),
        eta:        bridgeReceipt.estimatedArrival,
        authorized: funding.authorized,
      });

      logger.info('--- GENERATION CHECK COMPLETE ---');
    } catch (err) {
      logger.error('Generation check failed', { error: err.message });
    }
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
    this.arc.stop();
    if (this._yieldTimer) clearInterval(this._yieldTimer);
    logger.info('Utility Guardian stopped.');
  }
}

module.exports = UtilityGuardian;
