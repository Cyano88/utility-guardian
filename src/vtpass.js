'use strict';

/**
 * vtpass.js — VTpass API Client (AEDC / Abuja Electric prepaid top-up)
 *
 * API docs: https://www.vtpass.com/documentation/
 *
 * The agent calls the /pay endpoint with:
 *   serviceID:       "abuja-electric"
 *   variation_code:  "prepaid"
 *   billersCode:     meter number
 *   amount:          top-up amount in NGN
 *   request_id:      unique per-transaction ID (YYYYMMDDHHmm + random)
 *   phone:           registered phone (from env)
 */

const axios   = require('axios');
const crypto  = require('crypto');
const config  = require('./config');
const logger  = require('./logger');

// ─── VTpass response codes ────────────────────────────────────────────────────
const SUCCESS_CODE = '000';

class VTpassClient {
  constructor() {
    this.baseURL    = config.VTPASS_BASE_URL;
    this.apiKey     = config.VTPASS_API_KEY;
    this.secretKey  = config.VTPASS_SECRET_KEY;
    this.publicKey  = config.VTPASS_PUBLIC_KEY;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Generate a unique request_id: YYYYMMDDHHmm + 8-char random hex */
  _buildRequestId() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts  = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      pad(now.getHours()),
      pad(now.getMinutes()),
    ].join('');                                  // YYYYMMDDHHmm (12 chars)
    const rand = crypto.randomBytes(4).toString('hex'); // 8 chars
    return `${ts}${rand}`;                       // e.g. "202604031435a1b2c3d4"
  }

  /** Build the Basic-auth header that VTpass uses. */
  _authHeaders() {
    // VTpass uses api-key + public-key in headers; secret-key for HMAC in some endpoints.
    return {
      'api-key':    this.apiKey,
      'public-key': this.publicKey,
      'Content-Type': 'application/json',
    };
  }

  // ─── Meter verification (before payment) ──────────────────────────────────

  /**
   * verifyMeter(meterNumber) — validate the meter and retrieve customer name.
   * Always call this before pay() to confirm the meter number is correct.
   */
  async verifyMeter(meterNumber) {
    logger.info('Verifying AEDC meter', { meterNumber });
    const response = await axios.post(
      `${this.baseURL}/merchant-verify`,
      {
        billersCode:   meterNumber,
        serviceID:     'abuja-electric',
        type:          'prepaid',
      },
      { headers: this._authHeaders(), timeout: 15_000 }
    );

    const data = response.data;
    if (!data || data.code !== SUCCESS_CODE) {
      throw new VTpassError(
        `Meter verification failed: ${data?.response_description || 'unknown error'}`,
        data
      );
    }

    logger.info('Meter verified', {
      customerName: data.content?.Customer_Name,
      meterNumber:  data.content?.Meter_Number,
    });
    return data.content;
  }

  // ─── Payment ──────────────────────────────────────────────────────────────

  /**
   * pay(meterNumber, amountNGN, phone) — purchase electricity units.
   *
   * @param {string} meterNumber  - AEDC meter number
   * @param {number} amountNGN    - amount in Nigerian Naira
   * @param {string} phone        - customer phone (for VTpass records)
   * @returns {{ token: string, units: number, requestId: string, raw: object }}
   */
  async pay(meterNumber, amountNGN, phone = '08000000000') {
    const requestId = this._buildRequestId();
    logger.info('Initiating VTpass AEDC payment', {
      meterNumber,
      amountNGN,
      requestId,
    });

    const payload = {
      request_id:    requestId,
      serviceID:     'abuja-electric',
      billersCode:   meterNumber,
      variation_code:'prepaid',
      amount:        amountNGN,
      phone,
    };

    const response = await axios.post(
      `${this.baseURL}/pay`,
      payload,
      { headers: this._authHeaders(), timeout: 30_000 }
    );

    const data = response.data;
    logger.debug('VTpass raw response', { code: data?.code, requestId });

    if (!data || data.code !== SUCCESS_CODE) {
      throw new VTpassError(
        `Payment failed [${data?.code}]: ${data?.response_description || 'unknown'}`,
        data
      );
    }

    // Extract the 20-digit electricity token from the response
    const purchased = data.purchased_code || data.content?.transactions?.product_name || '';
    const token     = this._extractToken(data);
    const units     = parseFloat(data.content?.transactions?.units || 0);

    logger.info('VTpass payment successful', { token, units, requestId });

    return {
      token,
      units,
      requestId,
      transactionId: data.content?.transactions?.transactionId,
      raw:           data,
    };
  }

  /** Pull the 20-digit token from the VTpass response object. */
  _extractToken(data) {
    // VTpass can return the token in several locations depending on version
    const candidates = [
      data.token,
      data.purchased_code,
      data.content?.token,
      data.content?.transactions?.token,
      data.content?.transactions?.product_name,
    ];
    for (const c of candidates) {
      if (c && /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/.test(String(c).replace(/\s/g, ''))) {
        return String(c).replace(/[^0-9]/g, '').replace(/(\d{4})(?=\d)/g, '$1-');
      }
    }
    // fallback — return whatever is in purchased_code
    return candidates.find(Boolean) || 'TOKEN_UNAVAILABLE';
  }

  /** Check the status of a previous transaction by request_id. */
  async queryTransaction(requestId) {
    const response = await axios.post(
      `${this.baseURL}/requery`,
      { request_id: requestId },
      { headers: this._authHeaders(), timeout: 15_000 }
    );
    return response.data;
  }
}

class VTpassError extends Error {
  constructor(message, rawResponse) {
    super(message);
    this.name        = 'VTpassError';
    this.rawResponse = rawResponse;
  }
}

module.exports = { VTpassClient, VTpassError };
