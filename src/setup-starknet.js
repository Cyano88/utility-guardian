'use strict';

/**
 * setup-starknet.js — Deploy a real OpenZeppelin Account on Starknet Sepolia
 *
 * Usage:
 *   node src/setup-starknet.js            → generate keypair + show funding address
 *   node src/setup-starknet.js --deploy   → deploy the account (must be funded first)
 */

require('dotenv').config();
const { Account, ec, stark, RpcProvider, hash, CallData, constants, TransactionType } = require('starknet');
const fs   = require('fs');
const path = require('path');

// ── Starknet Sepolia RPC ─────────────────────────────────────────────────────
const RPC_URL = process.env.STARKNET_RPC_URL || 'https://api.cartridge.gg/x/starknet/sepolia';

// OZ Account class hash on Starknet Sepolia (OpenZeppelin v0.8.1)
const OZ_CLASS_HASH = '0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f';

const provider = new RpcProvider({ nodeUrl: RPC_URL });

const DEPLOY_FLAG = process.argv.includes('--deploy');

// ── Divider ──────────────────────────────────────────────────────────────────
const div = () => console.log('─'.repeat(56));

async function main() {
  div();
  console.log('  Utility Guardian — Starknet Account Setup');
  div();

  // 1. Load or generate private key
  let privateKey = process.env.STARKNET_PRIVATE_KEY;

  if (!privateKey) {
    privateKey = stark.randomAddress();
    console.log('\n  No STARKNET_PRIVATE_KEY found — generating a new one.\n');
    console.log(`  ⚠  Save this private key in your .env file NOW:\n`);
    console.log(`     STARKNET_PRIVATE_KEY=${privateKey}\n`);
  } else {
    console.log('\n  Using STARKNET_PRIVATE_KEY from .env\n');
  }

  // 2. Derive public key
  const publicKey = ec.starkCurve.getStarkKey(privateKey);

  // 3. Pre-compute the account address
  const constructorCallData = CallData.compile({ publicKey });
  const accountAddress = hash.calculateContractAddressFromHash(
    publicKey,
    OZ_CLASS_HASH,
    constructorCallData,
    0
  );

  console.log(`  Public Key:      ${publicKey}`);
  console.log(`  Account Address: ${accountAddress}`);
  div();

  if (!DEPLOY_FLAG) {
    // ── Step 1: Show funding instructions ──────────────────────────────────
    console.log('\n  STEP 1 — Fund the account with Sepolia ETH:\n');
    console.log(`  Send ETH to:\n  ${accountAddress}\n`);
    console.log('  Faucets (sends STRK — recommended):');
    console.log('  • https://starknet-faucet.vercel.app');
    console.log('  • https://faucet.starknet.io\n');
    console.log('  STEP 2 — Add to your .env file:\n');
    console.log(`     STARKNET_PRIVATE_KEY=${privateKey}`);
    console.log(`     STARKNET_ACCOUNT_ADDRESS=${accountAddress}\n`);
    console.log('  STEP 3 — Once funded, deploy the account:\n');
    console.log('     node src/setup-starknet.js --deploy\n');
    div();
    return;
  }

  // ── Deploy mode ────────────────────────────────────────────────────────────
  console.log('\n  Deploying account on Starknet Sepolia...\n');

  // Check balance (ETH or STRK — Sepolia faucets send STRK)
  const ETH_TOKEN  = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
  const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
  let hasEth = false, hasStrk = false;
  try {
    const ethBal  = BigInt((await provider.callContract({ contractAddress: ETH_TOKEN,  entrypoint: 'balanceOf', calldata: [accountAddress] }))[0]);
    const strkBal = BigInt((await provider.callContract({ contractAddress: STRK_TOKEN, entrypoint: 'balanceOf', calldata: [accountAddress] }))[0]);
    hasEth  = ethBal  > 0n;
    hasStrk = strkBal > 0n;
    console.log(`  ETH  balance: ${(Number(ethBal)  / 1e18).toFixed(6)} ETH  ${hasEth  ? '✓' : '✗'}`);
    console.log(`  STRK balance: ${(Number(strkBal) / 1e18).toFixed(6)} STRK ${hasStrk ? '✓' : '✗'}`);
    if (!hasEth && !hasStrk) {
      console.error('\n  ✗ Account has no ETH or STRK. Fund it from the faucet first.\n');
      process.exit(1);
    }
  } catch (err) {
    console.warn(`  Could not check balance: ${err.message}`);
    hasStrk = true; // Sepolia faucets send STRK — assume V3 tx
    console.log('  Assuming STRK funded (Sepolia faucet default). Proceeding...\n');
  }

  const account = new Account({ provider, address: accountAddress, signer: privateKey });

  try {
    console.log('  Broadcasting deployAccount transaction...');
    // Use V3 tx (pays fees in STRK) if STRK is available; fallback to V1 (ETH)
    const deployOpts = hasStrk ? { version: 3 } : {};
    console.log(`  Fee token: ${hasStrk ? 'STRK (V3 tx)' : 'ETH (V1 tx)'}`);

    const deployResponse = await account.deployAccount({
      classHash: OZ_CLASS_HASH,
      constructorCalldata: constructorCallData,
      addressSalt: publicKey,
    }, deployOpts);

    const transaction_hash = deployResponse.transaction_hash;
    console.log(`\n  ✓ Deploy tx sent: ${transaction_hash}`);
    console.log('  Waiting for confirmation (may take ~30s)...');

    await provider.waitForTransaction(transaction_hash);

    console.log(`\n  ✓ Account deployed successfully!\n`);
    div();
    console.log(`  Contract Address: ${accountAddress}`);
    console.log(`  Tx Hash:          ${transaction_hash}`);
    div();
    console.log(`\n  View on Voyager:`);
    console.log(`  https://sepolia.voyager.online/contract/${accountAddress}\n`);
    console.log('  Add these to your .env:\n');
    console.log(`     STARKNET_PRIVATE_KEY=${privateKey}`);
    console.log(`     STARKNET_ACCOUNT_ADDRESS=${accountAddress}\n`);
    div();
  } catch (err) {
    if (err.message?.includes('already deployed') || err.message?.includes('address already')) {
      console.log(`\n  ✓ Account already deployed at ${accountAddress}\n`);
      console.log(`  View: https://sepolia.voyager.online/contract/${accountAddress}\n`);
    } else {
      console.error(`\n  ✗ Deployment failed: ${err.message}\n`);
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
