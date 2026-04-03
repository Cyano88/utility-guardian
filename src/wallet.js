'use strict';

/**
 * wallet.js — OpenWallet Foundation (OWF) Standard-compatible Local Vault
 *
 * Implements the Wallet Standard interface (https://github.com/wallet-standard/wallet-standard)
 * as adopted by the OpenWallet Foundation.  In production this would delegate to a
 * hardware-backed KMS or HSM; for the hackathon we use an in-process ethers.js signer
 * with an encrypted-in-memory private key.
 *
 * Key OWF interfaces implemented:
 *  - Wallet            (name, version, icon, chains, features, accounts)
 *  - WalletAccount     (address, publicKey, chains, features)
 *  - standard:signTransaction  feature
 *  - standard:signMessage      feature
 */

const { ethers } = require('ethers');
const crypto     = require('crypto');
const config     = require('./config');
const logger     = require('./logger');

// ─── Constants ────────────────────────────────────────────────────────────────
const WALLET_STANDARD_VERSION = '1.0.0';
const CHAIN_IDENTIFIER        = `eip155:${config.CHAIN_ID}`; // "eip155:8453"

// ─── Encrypted vault (in-memory) ─────────────────────────────────────────────
// In production: persist to OS keychain or secure enclave.
let _encryptedKey = null;
let _provider     = null;
let _signer       = null;
let _account      = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function deriveKey(encryptionKey) {
  return crypto.createHash('sha256').update(encryptionKey).digest(); // 32 bytes
}

function encryptPrivateKey(rawPrivateKey, encryptionKey) {
  const iv  = crypto.randomBytes(16);
  const key = deriveKey(encryptionKey);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(rawPrivateKey, 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), data: encrypted.toString('hex') };
}

function decryptPrivateKey(encryptedPayload, encryptionKey) {
  const iv  = Buffer.from(encryptedPayload.iv, 'hex');
  const key = deriveKey(encryptionKey);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPayload.data, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ─── OWF Wallet Standard — WalletAccount ─────────────────────────────────────
function buildAccount(address, publicKey) {
  return Object.freeze({
    address,
    publicKey: Buffer.from(publicKey.replace('0x', ''), 'hex'),
    chains:   [CHAIN_IDENTIFIER],
    features: ['standard:signTransaction', 'standard:signMessage'],
    label:    'Utility Guardian Agent Wallet',
    icon:     'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
  });
}

// ─── OWF Wallet Standard — Wallet object ─────────────────────────────────────
const GuardianWallet = Object.freeze({
  version: WALLET_STANDARD_VERSION,
  name:    'Utility Guardian Vault',
  icon:    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
  chains:  [CHAIN_IDENTIFIER],

  get accounts() {
    return _account ? [_account] : [];
  },

  features: {
    /** standard:connect — initialise the vault from the encrypted store */
    'standard:connect': {
      version: '1.0.0',
      connect: async () => {
        if (!_signer) throw new Error('Vault not initialised. Call vault.init() first.');
        return { accounts: GuardianWallet.accounts };
      },
    },

    /**
     * standard:signTransaction
     * Takes a pre-built ethers TransactionRequest and returns the signed hex string.
     * The Policy Engine is called here — before every signature — to enforce rules.
     */
    'standard:signTransaction': {
      version: '1.0.0',
      signTransaction: async (transaction, policy) => {
        if (!_signer) throw new Error('Vault locked.');
        if (policy) policy.enforce(transaction); // throws on violation
        const signed = await _signer.signTransaction(transaction);
        logger.debug('Transaction signed', { to: transaction.to });
        return signed;
      },
    },

    /** standard:signMessage — sign arbitrary bytes (EIP-191) */
    'standard:signMessage': {
      version: '1.0.0',
      signMessage: async (message) => {
        if (!_signer) throw new Error('Vault locked.');
        return _signer.signMessage(message);
      },
    },
  },
});

// ─── Public vault API ─────────────────────────────────────────────────────────
const vault = {
  /**
   * init() — encrypt the private key in memory and connect to Base.
   * Must be called once on agent startup.
   */
  async init() {
    if (!config.AGENT_PRIVATE_KEY) throw new Error('AGENT_PRIVATE_KEY not set.');
    const encKey = config.VAULT_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

    _encryptedKey = encryptPrivateKey(config.AGENT_PRIVATE_KEY, encKey);
    _provider     = new ethers.JsonRpcProvider(config.BASE_RPC_URL, config.CHAIN_ID);

    const rawKey = decryptPrivateKey(_encryptedKey, encKey);
    _signer      = new ethers.Wallet(rawKey, _provider);

    // Build the OWF-standard account descriptor
    const signingKey = new ethers.SigningKey(rawKey);
    _account = buildAccount(_signer.address, signingKey.compressedPublicKey);

    const network = await _provider.getNetwork();
    logger.info('Vault initialised', {
      address:  _signer.address,
      chainId:  network.chainId.toString(),
      standard: WALLET_STANDARD_VERSION,
    });

    return GuardianWallet;
  },

  /** Return the OWF-standard Wallet object */
  get wallet()   { return GuardianWallet; },

  /** Return the raw ethers signer for internal contract calls */
  get signer()   { return _signer; },

  /** Return the provider */
  get provider() { return _provider; },

  /** Return the agent's checksummed address */
  get address()  { return _account ? _account.address : null; },

  /**
   * signTransaction() — top-level helper used by other modules.
   * Enforces Policy before signing.
   */
  async signTransaction(txRequest, policy) {
    return GuardianWallet.features['standard:signTransaction'].signTransaction(txRequest, policy);
  },
};

module.exports = vault;
