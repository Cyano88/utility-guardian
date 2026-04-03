'use strict';

/**
 * notify.js — Email notification service (Nodemailer)
 *
 * Sends a rich HTML email to the customer after every successful top-up.
 * Includes:
 *   - 20-digit electricity token (prominently displayed)
 *   - Base transaction hash with block-explorer link
 *   - Full fee breakdown (top-up cost, VTpass fee, agent 1% service fee)
 *   - Meter balance after credit
 */

const nodemailer = require('nodemailer');
const config     = require('./config');
const logger     = require('./logger');

// ─── Singleton transporter ────────────────────────────────────────────────────
let _transporter = null;

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host:   config.SMTP_HOST,
      port:   config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

// ─── Email builder ────────────────────────────────────────────────────────────

/**
 * sendTopupConfirmation(opts)
 *
 * @param {Object} opts
 * @param {string} opts.token           - 20-digit electricity token
 * @param {string} opts.txHash          - Base chain transaction hash
 * @param {string} opts.meterNumber     - AEDC meter number
 * @param {number} opts.topupAmountNGN  - amount charged to VTpass in NGN
 * @param {number} opts.topupAmountUSD  - equivalent in USD
 * @param {number} opts.agentFeeUSD     - 1% service fee in USD
 * @param {number} opts.vtpassFeeUSD    - VTpass processing fee in USD
 * @param {number} opts.totalWithdrawnUSD - total USDC pulled from Aave
 * @param {number} opts.unitsAdded      - electricity units credited
 * @param {number} opts.newBalance      - meter balance after top-up
 */
async function sendTopupConfirmation(opts) {
  const {
    token,
    txHash,
    meterNumber,
    topupAmountNGN,
    topupAmountUSD,
    agentFeeUSD,
    vtpassFeeUSD,
    totalWithdrawnUSD,
    unitsAdded,
    newBalance,
  } = opts;

  const explorerUrl = `https://basescan.org/tx/${txHash}`;
  const now         = new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <style>
    body  { font-family: Arial, sans-serif; background:#f4f4f4; margin:0; padding:0; }
    .wrap { max-width:600px; margin:24px auto; background:#fff; border-radius:8px; overflow:hidden; }
    .hdr  { background:#1a1a2e; color:#fff; padding:24px 32px; }
    .hdr h1 { margin:0; font-size:22px; }
    .hdr p  { margin:4px 0 0; color:#aaa; font-size:13px; }
    .body { padding:24px 32px; }
    .token-box {
      background:#f0f9ff; border:2px solid #0ea5e9;
      border-radius:8px; padding:20px; text-align:center; margin:20px 0;
    }
    .token-box .label { font-size:12px; color:#666; text-transform:uppercase; letter-spacing:1px; }
    .token-box .token { font-size:28px; font-weight:bold; color:#0369a1;
                        letter-spacing:4px; font-family:monospace; margin:8px 0; }
    table  { width:100%; border-collapse:collapse; margin:20px 0; }
    td,th  { padding:10px 12px; text-align:left; border-bottom:1px solid #eee; font-size:14px; }
    th     { background:#f8f8f8; font-weight:600; color:#444; }
    .total-row td { font-weight:bold; border-top:2px solid #ddd; background:#fafafa; }
    .txhash { word-break:break-all; font-family:monospace; font-size:12px; color:#0369a1; }
    .footer { background:#f8f8f8; padding:16px 32px; font-size:12px; color:#888; text-align:center; }
    .badge  { display:inline-block; background:#dcfce7; color:#166534;
              border-radius:4px; padding:2px 8px; font-size:12px; font-weight:bold; }
  </style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Utility Guardian ⚡</h1>
    <p>Autonomous Power Top-Up Confirmation &nbsp;|&nbsp; ${now}</p>
  </div>
  <div class="body">
    <p>Your AEDC prepaid meter has been topped up automatically.</p>

    <div class="token-box">
      <div class="label">Your 20-Digit Electricity Token</div>
      <div class="token">${token}</div>
      <div>Enter this code on your meter to load <strong>${unitsAdded.toFixed(2)} units</strong></div>
    </div>

    <table>
      <tr><th colspan="2">Transaction Details</th></tr>
      <tr><td>Meter Number</td>     <td>${meterNumber}</td></tr>
      <tr><td>Units Credited</td>   <td>${unitsAdded.toFixed(2)} kWh</td></tr>
      <tr><td>New Meter Balance</td><td><span class="badge">${newBalance.toFixed(2)} units</span></td></tr>
      <tr><td>Date / Time</td>      <td>${now} (WAT)</td></tr>
    </table>

    <table>
      <tr><th colspan="2">Fee Breakdown</th></tr>
      <tr><td>Electricity Top-Up</td>      <td>₦${topupAmountNGN.toLocaleString()} ≈ $${topupAmountUSD.toFixed(4)} USDC</td></tr>
      <tr><td>VTpass Processing Fee</td>   <td>$${vtpassFeeUSD.toFixed(4)} USDC</td></tr>
      <tr><td>Guardian Service Fee (1%)</td><td>$${agentFeeUSD.toFixed(4)} USDC</td></tr>
      <tr class="total-row">
        <td>Total Withdrawn from Aave</td><td>$${totalWithdrawnUSD.toFixed(4)} USDC</td>
      </tr>
    </table>

    <table>
      <tr><th colspan="2">On-Chain Reference</th></tr>
      <tr>
        <td>Base Transaction</td>
        <td><a class="txhash" href="${explorerUrl}">${txHash}</a></td>
      </tr>
      <tr><td>Network</td><td>Base Mainnet (Chain ID 8453)</td></td></tr>
    </table>

    <p style="font-size:13px;color:#666;">
      Funds were withdrawn from your USDC position on <strong>Aave V3 (Base)</strong>,
      converted at ₦${config.NGN_USD_RATE}/$ and routed through VTpass to AEDC.
      Idle USDC continues to earn yield until the next top-up.
    </p>
  </div>
  <div class="footer">
    Utility Guardian &mdash; OpenWallet Foundation Hackathon Demo &mdash;
    <a href="${explorerUrl}">View on BaseScan</a>
  </div>
</div>
</body>
</html>`;

  const mailOptions = {
    from:    `"Utility Guardian ⚡" <${config.SMTP_USER}>`,
    to:      config.NOTIFY_TO,
    subject: `⚡ Power Top-Up Successful — Token: ${token.replace(/-/g, ' ')}`,
    html,
    text: [
      `AEDC Meter Top-Up Confirmed`,
      `Meter: ${meterNumber}`,
      `Token: ${token}`,
      `Units Added: ${unitsAdded.toFixed(2)}`,
      `New Balance: ${newBalance.toFixed(2)} units`,
      `Top-Up Amount: ₦${topupAmountNGN} ($${topupAmountUSD.toFixed(4)} USDC)`,
      `Agent Fee (1%): $${agentFeeUSD.toFixed(4)} USDC`,
      `Total Withdrawn from Aave: $${totalWithdrawnUSD.toFixed(4)} USDC`,
      `Base Tx: ${explorerUrl}`,
    ].join('\n'),
  };

  try {
    const info = await getTransporter().sendMail(mailOptions);
    logger.info('Notification email sent', { messageId: info.messageId, to: config.NOTIFY_TO });
    return info;
  } catch (err) {
    // Non-fatal — log and continue; the top-up already succeeded
    logger.error('Failed to send notification email', { error: err.message });
  }
}

module.exports = { sendTopupConfirmation };
