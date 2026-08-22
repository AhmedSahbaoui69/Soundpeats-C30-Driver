'use strict';

// Application controller: owns the RFCOMM worker thread and auto-detects the
// C30 from BlueZ metadata. Exposes an async API used by the Electron main
// process (see main.js).

const { Worker } = require('worker_threads');
const path = require('path');
const { EventEmitter } = require('events');

const { constructCommand, parsePacket, parseBattery, parseMode, CMD } = require('./protocol');
const config = require('./config');
const { findDevice } = require('./discovery');

const WORKER_PATH = path.join(__dirname, 'bluetooth-worker.js');

// How often to re-query the earbuds' battery levels while connected
const BATTERY_POLL_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SoundpeatsApp extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.detected = null;      // { address, name } of the C30, when found
    this.osConnected = false;  // whether the OS reports the C30 connected
    this.lastError = '';

    // Latest battery readings (percent, or null until first poll).
    this.battery = {
      left: null,
      right: null,
      case: null,
      leftCharging: false,
      rightCharging: false,
      caseCharging: false,
      updatedAt: 0,
    };

    // Current ANC mode (0=Normal, 1=ANC, 2=Transparency), or null.
    this.mode = null;

    this.worker = null;
    this._connecting = false;
    this._connectResolver = null;
    this._sendId = 0;
    this._pendingSends = new Map();
    this._lastCommandTime = 0;
    this._batteryTimer = null;
  }

  // -- worker lifecycle ----------------------------------------------------

  _startWorker() {
    if (this.worker) return;
    this.worker = new Worker(WORKER_PATH);
    this.worker.on('message', (msg) => this._onWorkerMessage(msg));
    this.worker.on('error', (err) => {
      this.connected = false;
      this._setError('Bluetooth worker error: ' + err.message);
      this.worker = null;
      this._stopBatteryPolling();
      this._resetBattery();
      this._resolveConnect(false);
      this.emit('status');
    });
    this.worker.on('exit', () => {
      this.worker = null;
      this.connected = false;
      this._stopBatteryPolling();
      this._resetBattery();
      this._resolveConnect(false);
      this.emit('status');
    });
  }

  _resolveConnect(value) {
    this._connecting = false;
    if (this._connectResolver) {
      const resolve = this._connectResolver;
      this._connectResolver = null;
      resolve(value);
    }
  }

  _setError(message) {
    this.lastError = message;
  }

  _resetBattery() {
    this.battery.left = null;
    this.battery.right = null;
    this.battery.case = null;
    this.battery.leftCharging = false;
    this.battery.rightCharging = false;
    this.battery.caseCharging = false;
    this.battery.updatedAt = 0;
    this.mode = null;
  }

  // Ingest one device->host vendor packet; pick out battery levels and mode.
  _onPacket(hex) {
    const pkt = parsePacket(hex);
    if (!pkt) return;

    const bat = parseBattery(pkt);
    if (bat) {
      switch (pkt.command) {
        case CMD.BATTERY_LEFT:
          this.battery.left = bat.percent;
          this.battery.leftCharging = bat.charging;
          break;
        case CMD.BATTERY_RIGHT:
          this.battery.right = bat.percent;
          this.battery.rightCharging = bat.charging;
          break;
        case CMD.BATTERY_CASE:
          this.battery.case = bat.percent;
          this.battery.caseCharging = bat.charging;
          break;
        default:
          return;
      }
      this.battery.updatedAt = Date.now();
      this.emit('status');
      return;
    }

    const mode = parseMode(pkt);
    if (mode) {
      this.mode = mode.mode;
      this.emit('status');
    }
  }

  // Send one round of battery queries (left, right, case).
  async queryBattery() {
    if (!this.connected) return false;
    for (const cmd of [CMD.BATTERY_LEFT, CMD.BATTERY_RIGHT, CMD.BATTERY_CASE]) {
      await this.sendCommand(cmd);
    }
    return true;
  }

  // Ask the headset which mode (ANC / Transparency / Normal) is active.
  async queryMode() {
    if (!this.connected) return false;
    return this.sendCommand(CMD.MODE_GET);
  }

  _startBatteryPolling() {
    this._stopBatteryPolling();
    this._pollStatus(); // grab values immediately on connect
    this._batteryTimer = setInterval(() => {
      this._pollStatus();
    }, BATTERY_POLL_MS);
  }

  _pollStatus() {
    this.queryBattery().catch(() => {});
    this.queryMode().catch(() => {});
  }

  _stopBatteryPolling() {
    if (this._batteryTimer) {
      clearInterval(this._batteryTimer);
      this._batteryTimer = null;
    }
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'connected':
        this.connected = true;
        this.lastError = '';
        this._resolveConnect(true);
        this._startBatteryPolling();
        this.emit('status');
        break;

      case 'connectError':
        this.connected = false;
        this._setError(msg.message || 'Connection failed');
        this._resolveConnect(false);
        this.emit('status');
        break;

      case 'disconnected':
        this.connected = false;
        this._stopBatteryPolling();
        this._resetBattery();
        this.emit('status');
        break;

      case 'packet':
        this._onPacket(msg.hex);
        break;

      case 'sent': {
        const pending = this._pendingSends.get(msg.id);
        if (pending) {
          this._pendingSends.delete(msg.id);
          pending.resolve(true);
        }
        break;
      }

      case 'sendError': {
        const pending = this._pendingSends.get(msg.id);
        if (pending) {
          this._pendingSends.delete(msg.id);
          this._setError(msg.message || 'Send failed');
          pending.resolve(false);
        }
        this.emit('status');
        break;
      }

      default:
        break;
    }
  }

  // -- public API -----------------------------------------------------------

  connect(timeout = config.CONNECTION_TIMEOUT) {
    if (this.connected) return Promise.resolve(true);
    if (this._connecting) return Promise.resolve(false); // a connect is already in flight

    this._connecting = true;
    this._startWorker();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this._connecting = false;
        clearTimeout(timer);
        resolve(value);
      };
      // Safety net: resolve even if the worker never answers.
      const timer = setTimeout(() => finish(false), timeout + 3000);

      this._connectResolver = finish;
      this.worker.postMessage({
        type: 'connect',
        bdAddr: this.detected.address,
        channel: config.RFCOMM_CHANNEL,
        timeout,
      });
    });
  }

  disconnect() {
    this.connected = false;
    this._connecting = false;
    this._stopBatteryPolling();
    this._resetBattery();
    if (this.worker) {
      this.worker.postMessage({ type: 'disconnect' });
      this.worker.postMessage({ type: 'stop' });
      this.worker = null;
    }
    this._resolveConnect(false);
    for (const pending of this._pendingSends.values()) pending.resolve(false);
    this._pendingSends.clear();
    this.emit('status');
  }

  // Re-read BlueZ metadata and auto-detect the C30 by name. When the OS
  // reports it connected, keep the RFCOMM command channel open.
  async refresh() {
    let device;
    try {
      device = await findDevice(config.DEVICE_NAME_PATTERN);
    } catch (e) {
      this.detected = null;
      this.osConnected = false;
      this._setError(e.message);
      if (this.connected) this.disconnect();
      this.emit('status');
      return this.getStatus();
    }

    this.detected = device ? { address: device.address, name: device.name || device.address } : null;
    this.osConnected = device ? device.connected : false;
    if (device) this._setError('');

    if (this.osConnected) {
      if (!this.connected) this.connect().then(() => this.emit('status'));
    } else if (this.connected) {
      this.disconnect();
    }

    this.emit('status');
    return this.getStatus();
  }

  async sendCommand(cmd, payloadHex = '') {
    if (!this.detected) {
      this._setError('C30 not detected');
      return false;
    }
    if (!this.osConnected) {
      this._setError('C30 not connected');
      return false;
    }
    if (!this.connected) {
      const ok = await this.connect();
      if (!ok) {
        this._setError('Could not open command channel');
        return false;
      }
    }

    // Rate limiting between commands.
    const elapsed = Date.now() - this._lastCommandTime;
    if (elapsed < config.COMMAND_DELAY) {
      await sleep(config.COMMAND_DELAY - elapsed);
    }

    const payload = payloadHex ? Buffer.from(payloadHex, 'hex') : Buffer.alloc(0);
    const packet = constructCommand(cmd, payload);
    const id = ++this._sendId;

    const result = new Promise((resolve) => {
      this._pendingSends.set(id, { resolve });
    });

    this.worker.postMessage({ type: 'send', id, data: packet.toString('hex') });
    this._lastCommandTime = Date.now();

    return Promise.race([
      result,
      sleep(5000).then(() => {
        this._pendingSends.delete(id);
        return false;
      }),
    ]);
  }

  getStatus() {
    return {
      detected: this.detected,
      os_connected: this.osConnected,
      error: this.lastError,
      battery: { ...this.battery },
      mode: this.mode,
    };
  }
}

module.exports = { SoundpeatsApp };
