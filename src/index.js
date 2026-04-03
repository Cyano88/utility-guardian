'use strict';

/**
 * index.js — Entry point for The Utility Guardian
 *
 * Run:  node src/index.js
 * Dev:  node --watch src/index.js
 */

const logger           = require('./logger');
const UtilityGuardian  = require('./agent');

// ─── Validate required env vars before anything else ─────────────────────────
const REQUIRED_ENV = [
  'AGENT_PRIVATE_KEY',
  'VTPASS_API_KEY',
  'VTPASS_SECRET_KEY',
  'VTPASS_PUBLIC_KEY',
  'ADMIN_REVENUE_WALLET',
  'SMTP_USER',
  'SMTP_PASS',
  'NOTIFY_TO',
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  // Load .env and re-check
  require('dotenv').config();
  const stillMissing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (stillMissing.length) {
    logger.error('Missing required environment variables', { vars: stillMissing });
    logger.error('Copy .env.example → .env and fill in the values.');
    process.exit(1);
  }
} else {
  require('dotenv').config();
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const guardian = new UtilityGuardian();

guardian.start().catch((err) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully…`);
  await guardian.stop();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
