'use strict';

/**
 * meter.js — AEDC Meter Digital Twin
 *
 * Simulates the prepaid electricity meter O159006781284 (Abuja Electric / AEDC).
 *
 * Behaviour:
 *  - Starts at INITIAL_METER_UNITS (5.0)
 *  - Drops by UNITS_DROP_PER_TICK every TICK_INTERVAL_MS (5 minutes)
 *  - Emits a 'low' event when units fall below TRIGGER_THRESHOLD (3.0)
 *  - After a successful top-up the twin is updated with the new balance
 */

const EventEmitter = require('events');
const config       = require('./config');
const logger       = require('./logger');

class MeterTwin extends EventEmitter {
  constructor() {
    super();
    this.meterNumber  = config.METER_NUMBER;
    this.currentUnits = config.INITIAL_METER_UNITS;
    this._timer       = null;
    this._triggered   = false; // prevent duplicate triggers per low-event
  }

  /** Start the consumption simulation loop. */
  start() {
    logger.info('Meter digital twin started', {
      meter:     this.meterNumber,
      units:     this.currentUnits,
      threshold: config.TRIGGER_THRESHOLD,
      tickEvery: `${config.TICK_INTERVAL_MS / 60000} min`,
    });

    this._timer = setInterval(() => this._tick(), config.TICK_INTERVAL_MS);
    // Run an immediate check in case we start below threshold
    this._evaluate();
    return this;
  }

  /** Stop the simulation. */
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    logger.info('Meter twin stopped.');
  }

  /** Credit units after a successful top-up. */
  credit(units) {
    this.currentUnits += units;
    this._triggered    = false; // re-arm the trigger for the next dip
    logger.info('Meter credited', {
      added:   units.toFixed(2),
      balance: this.currentUnits.toFixed(2),
    });
    this.emit('credited', { units, balance: this.currentUnits });
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _tick() {
    this.currentUnits = Math.max(0, this.currentUnits - config.UNITS_DROP_PER_TICK);
    logger.debug('Meter tick', { units: this.currentUnits.toFixed(2) });
    this._evaluate();
  }

  _evaluate() {
    if (this.currentUnits < config.TRIGGER_THRESHOLD && !this._triggered) {
      this._triggered = true;
      logger.warn('LOW METER ALERT — triggering top-up', {
        units:     this.currentUnits.toFixed(2),
        threshold: config.TRIGGER_THRESHOLD,
      });
      this.emit('low', {
        meterNumber:  this.meterNumber,
        currentUnits: this.currentUnits,
        threshold:    config.TRIGGER_THRESHOLD,
      });
    }
  }

  /** Snapshot for status reporting. */
  status() {
    return {
      meterNumber:  this.meterNumber,
      currentUnits: this.currentUnits,
      threshold:    config.TRIGGER_THRESHOLD,
      isLow:        this.currentUnits < config.TRIGGER_THRESHOLD,
    };
  }
}

module.exports = MeterTwin;
