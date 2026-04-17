'use strict';

/**
 * btc-watcher.js — Bitcoin Testnet Deposit Watcher
 *
 * Derives a real Bitcoin testnet (Segwit) address from the agent's private key
 * and polls the mempool.space testnet API to detect incoming BTC deposits.
 *
 * When a deposit is confirmed (or seen in mempool), it emits a 'deposit' event
 * that the agent/server can use to trigger the staking flow.
 */

const EventEmitter = require('events');
const crypto       = require('crypto');
const axios        = require('axios');

// ─── Bitcoin libs ────────────────────────────────────────────────────────────
const ecc     = require('tiny-secp256k1');
const bitcoin = require('bitcoinjs-lib');
bitcoin.initEccLib(ecc);
const { ECPairFactory } = require('ecpair');
const ECPair = ECPairFactory(ecc);

// ─── Config ──────────────────────────────────────────────────────────────────
const TESTNET           = bitcoin.networks.testnet;
const MEMPOOL_API       = 'https://mempool.space/testnet/api';
const POLL_INTERVAL_MS  = 15_000; // check every 15 seconds
const MIN_CONFIRMATIONS = 0;      // 0 = trigger on mempool detection

class BtcWatcher extends EventEmitter {
  /**
   * @param {string} privateKeyHex — hex private key (with or without 0x prefix).
   *   A 32-byte key is derived from this via SHA-256 to ensure valid range.
   */
  constructor(privateKeyHex) {
    super();

    // Derive a valid 32-byte private key for Bitcoin testnet
    const raw     = privateKeyHex.replace(/^0x/, '');
    const keyBuf  = crypto.createHash('sha256').update(`btc-testnet-${raw}`).digest();
    this._keyPair = ECPair.fromPrivateKey(keyBuf, { network: TESTNET });

    // p2wpkh (native segwit — bc1q / tb1q)
    const payment   = bitcoin.payments.p2wpkh({
      pubkey:  Buffer.from(this._keyPair.publicKey),
      network: TESTNET,
    });
    this.address    = payment.address;
    this._seenTxids = new Set();
    this._timer     = null;
    this._lastBalance = 0;
  }

  /** Start polling for deposits. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    // Immediate first check
    this._poll();
    return this;
  }

  /** Stop polling. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Get the WIF private key (for export/debugging). */
  get wif() {
    return this._keyPair.toWIF();
  }

  /** Get public key hex. */
  get publicKey() {
    return Buffer.from(this._keyPair.publicKey).toString('hex');
  }

  // ─── Internal polling ──────────────────────────────────────────────────────

  async _poll() {
    try {
      // Fetch both confirmed and mempool (unconfirmed) txs
      const [confirmedRes, mempoolRes] = await Promise.all([
        axios.get(`${MEMPOOL_API}/address/${this.address}/txs`, { timeout: 10_000 }),
        axios.get(`${MEMPOOL_API}/address/${this.address}/txs/mempool`, { timeout: 10_000 }),
      ]);

      const allTxs = [...(mempoolRes.data || []), ...(confirmedRes.data || [])];

      for (const tx of allTxs) {
        if (this._seenTxids.has(tx.txid)) continue;

        // Find outputs that pay to our address
        const incoming = (tx.vout || []).filter(
          v => v.scriptpubkey_address === this.address
        );
        if (incoming.length === 0) continue;

        const totalSats = incoming.reduce((sum, v) => sum + v.value, 0);
        if (totalSats <= 0) continue;

        // Mark as seen
        this._seenTxids.add(tx.txid);

        const confirmed = tx.status && tx.status.confirmed;
        const confs     = confirmed ? (tx.status.block_height ? 'confirmed' : 1) : 0;

        this.emit('deposit', {
          txid:          tx.txid,
          amountSats:    totalSats,
          amountBTC:     totalSats / 1e8,
          confirmed:     !!confirmed,
          confirmations: confs,
          blockHeight:   tx.status?.block_height || null,
          timestamp:     new Date().toISOString(),
        });
      }
    } catch (err) {
      // Silently handle API errors — network hiccups are expected
      if (err.code !== 'ECONNABORTED') {
        this.emit('error', err);
      }
    }
  }
}

module.exports = { BtcWatcher };
