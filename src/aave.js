'use strict';

/**
 * aave.js — Aave V3 Yield Manager (Base Mainnet)
 *
 * Lifecycle:
 *   startup  → supplyAll()     — deposit idle USDC wallet balance into Aave
 *   topup    → withdraw(amt)   — pull exactly what's needed back to the wallet
 *
 * Pool:  0xA238Dd80C259a72e81d7E4674A9801593f98D1C5
 * USDC:  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  (6 decimals)
 * aUSDC: 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB  (tracks yield)
 */

const { ethers }    = require('ethers');
const config        = require('./config');
const logger        = require('./logger');
const vault         = require('./wallet');
const { PolicyEngine } = require('./policy');

const POOL_ABI  = require('./abis/AavePool.json');
const ERC20_ABI = require('./abis/ERC20.json');

const USDC_DECIMALS = 6;
const MAX_UINT256   = ethers.MaxUint256;

class AaveManager {
  constructor(policy) {
    this.policy = policy || new PolicyEngine();
    this._pool  = null;
    this._usdc  = null;
    this._ausdc = null;
  }

  // ─── Internal: lazy contract initialisation ────────────────────────────────
  _getContracts() {
    if (!this._pool) {
      const signer  = vault.signer;
      this._pool    = new ethers.Contract(config.AAVE_POOL_ADDRESS, POOL_ABI,  signer);
      this._usdc    = new ethers.Contract(config.USDC_ADDRESS,      ERC20_ABI, signer);
      this._ausdc   = new ethers.Contract(config.AUSDC_ADDRESS,     ERC20_ABI, signer);
    }
    return { pool: this._pool, usdc: this._usdc, ausdc: this._ausdc };
  }

  // ─── Public helpers ────────────────────────────────────────────────────────

  /** Return the agent's current aUSDC balance (principal + accrued yield) in USD. */
  async getAaveBalance() {
    const { ausdc } = this._getContracts();
    const raw = await ausdc.balanceOf(vault.address);
    return Number(ethers.formatUnits(raw, USDC_DECIMALS));
  }

  /** Return raw wallet USDC balance in USD. */
  async getWalletUsdcBalance() {
    const { usdc } = this._getContracts();
    const raw = await usdc.balanceOf(vault.address);
    return Number(ethers.formatUnits(raw, USDC_DECIMALS));
  }

  /**
   * supplyAll() — deposit every idle USDC in the wallet into Aave.
   * Called once on agent startup.
   */
  async supplyAll() {
    const { pool, usdc } = this._getContracts();
    const rawBalance = await usdc.balanceOf(vault.address);

    if (rawBalance === 0n) {
      logger.info('Aave supply skipped — wallet USDC balance is zero.');
      return null;
    }

    const amountUSD = Number(ethers.formatUnits(rawBalance, USDC_DECIMALS));
    logger.info('Supplying idle USDC to Aave', { amountUSD: amountUSD.toFixed(4) });

    // 1. Approve the Pool to spend USDC (use MAX_UINT256 once — saves future gas)
    logger.debug('Approving USDC spend to Aave Pool…');
    const approveTx = await usdc.approve(config.AAVE_POOL_ADDRESS, MAX_UINT256);
    await approveTx.wait(1);
    logger.debug('Approval confirmed', { txHash: approveTx.hash });

    // 2. Supply — policy check (internal transfer to Aave, no USD leaving the ecosystem)
    this.policy.enforce({ to: config.AAVE_POOL_ADDRESS }, amountUSD);

    const supplyTx = await pool.supply(
      config.USDC_ADDRESS,
      rawBalance,
      vault.address,
      0 // referralCode
    );
    const receipt = await supplyTx.wait(1);
    logger.info('USDC supplied to Aave', {
      txHash:    receipt.hash,
      amountUSD: amountUSD.toFixed(4),
    });

    this.policy.recordSpend(0); // supply is not a spend — record $0
    return receipt;
  }

  /**
   * withdraw(amountUSD) — pull a specific USD amount from Aave back to the wallet.
   * Called right before a meter top-up so funds are available for VTpass.
   *
   * @param {number} amountUSD  - the amount to withdraw (must pass policy check)
   * @returns {ethers.TransactionReceipt}
   */
  async withdraw(amountUSD) {
    if (amountUSD <= 0) throw new Error('Withdraw amount must be positive.');

    // Policy guard — withdrawal funds the topup, so it counts as spend
    this.policy.enforce({ to: config.AAVE_POOL_ADDRESS }, amountUSD);

    const { pool } = this._getContracts();
    const rawAmount = ethers.parseUnits(amountUSD.toFixed(6), USDC_DECIMALS);

    const aaveBalance = await this.getAaveBalance();
    if (aaveBalance < amountUSD) {
      throw new Error(
        `Insufficient Aave balance. Required: $${amountUSD.toFixed(4)}, Available: $${aaveBalance.toFixed(4)}`
      );
    }

    logger.info('Withdrawing from Aave', { amountUSD: amountUSD.toFixed(4) });

    const tx = await pool.withdraw(
      config.USDC_ADDRESS,
      rawAmount,
      vault.address
    );
    const receipt = await tx.wait(1);

    logger.info('Aave withdrawal confirmed', {
      txHash:    receipt.hash,
      amountUSD: amountUSD.toFixed(4),
    });

    this.policy.recordSpend(amountUSD);
    return receipt;
  }

  /** Snapshot of the agent's full financial position. */
  async getPosition() {
    const { pool } = this._getContracts();
    const [walletUsdc, aaveUsdc, accountData] = await Promise.all([
      this.getWalletUsdcBalance(),
      this.getAaveBalance(),
      pool.getUserAccountData(vault.address),
    ]);
    return {
      walletUSDC:        walletUsdc,
      aaveUSDC:          aaveUsdc,
      totalUSDC:         walletUsdc + aaveUsdc,
      healthFactor:      ethers.formatUnits(accountData.healthFactor, 18),
      totalCollateral:   ethers.formatUnits(accountData.totalCollateralBase, 8), // USD, 8 dec
    };
  }
}

module.exports = AaveManager;
