'use strict';

/**
 * policy.js — OWF Policy Engine
 *
 * Enforces agent-level spending rules before every transaction is signed.
 * Plugs into the wallet's standard:signTransaction feature as the `policy` argument.
 *
 * Rules:
 *  1. Recipient address must be on the allowlist.
 *  2. USDC spend per transaction must not exceed MAX_SPEND_USD ($15).
 *  3. Daily cumulative spend must not exceed DAILY_LIMIT_USD.
 */

const { ethers }            = require('ethers');
const config                = require('./config');
const logger                = require('./logger');

const USDC_DECIMALS         = 6;
const DAILY_LIMIT_USD       = 50; // hard ceiling across all topups in 24 h

// ─── Spend ledger (in-memory; replace with Redis/DB for production) ───────────
const _spendLog = [];  // [{ timestamp: Date, amountUSD: number }]

function _dailySpend() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return _spendLog
    .filter(e => e.timestamp.getTime() > cutoff)
    .reduce((sum, e) => sum + e.amountUSD, 0);
}

// ─── PolicyEngine class ───────────────────────────────────────────────────────
class PolicyEngine {
  /**
   * @param {Object} opts
   * @param {number}  opts.maxSpendUSD       - per-tx USD ceiling (default from config)
   * @param {Set}     opts.allowedRecipients  - allowlisted `to` addresses
   */
  constructor(opts = {}) {
    this.maxSpendUSD       = opts.maxSpendUSD        || config.MAX_SPEND_USD;
    this.allowedRecipients = opts.allowedRecipients  || config.ALLOWED_RECIPIENTS;
  }

  /**
   * enforce() — called synchronously inside wallet.signTransaction().
   * Throws a descriptive PolicyViolation error on any breach.
   *
   * @param {ethers.TransactionRequest} tx
   * @param {number}                    amountUSD — the USD equivalent of the tx value
   */
  enforce(tx, amountUSD = 0) {
    const to = tx.to ? ethers.getAddress(tx.to) : null;

    // Rule 1 — allowlist
    if (to && !this._isAllowed(to)) {
      throw new PolicyViolation(`Recipient ${to} is not on the agent allowlist.`);
    }

    // Rule 2 — per-transaction ceiling
    if (amountUSD > this.maxSpendUSD) {
      throw new PolicyViolation(
        `Transaction amount $${amountUSD.toFixed(2)} exceeds per-tx limit $${this.maxSpendUSD}.`
      );
    }

    // Rule 3 — rolling 24 h cap
    const daily = _dailySpend();
    if (daily + amountUSD > DAILY_LIMIT_USD) {
      throw new PolicyViolation(
        `Daily spend cap exceeded. Used $${daily.toFixed(2)} + $${amountUSD.toFixed(2)} > $${DAILY_LIMIT_USD}.`
      );
    }

    logger.debug('Policy check passed', { to, amountUSD: amountUSD.toFixed(4) });
  }

  /** Record a confirmed spend so the daily ledger stays accurate. */
  recordSpend(amountUSD) {
    _spendLog.push({ timestamp: new Date(), amountUSD });
    logger.info('Spend recorded', {
      amountUSD:  amountUSD.toFixed(4),
      dailyTotal: _dailySpend().toFixed(4),
    });
  }

  /** Add a recipient to the runtime allowlist (e.g., after fetching VTpass address). */
  addAllowedRecipient(address) {
    this.allowedRecipients.add(ethers.getAddress(address));
    logger.info('Allowlist updated', { address });
  }

  _isAllowed(address) {
    // Normalise both sides to checksummed form before comparison
    for (const allowed of this.allowedRecipients) {
      try {
        if (ethers.getAddress(allowed) === address) return true;
      } catch {
        // skip malformed entries
      }
    }
    return false;
  }
}

class PolicyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

module.exports = { PolicyEngine, PolicyViolation };
