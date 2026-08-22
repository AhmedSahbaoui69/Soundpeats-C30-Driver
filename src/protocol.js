'use strict';

// SOUNDPEATS C30 SPP command packet builder / response parser.
//
// Request  : ff 04 00 LL 00 0a 03 CMD [PAYLOAD]
// Response : ff 04 00 LL 00 0a 83 CMD [PAYLOAD]
//
//   LL  = payload length (not including DIR/CMD)
//   03  = host -> device direction
//   83  = device -> host direction
//   CMD = command id

const HEADER = Buffer.from([0xff, 0x04, 0x00]);
const DIR_HOST = 0x03;
const DIR_DEVICE = 0x83;

// Command ids
// 0x06/0x07/0x23 are polled together and return the battery
// percentage of the left earbud, right earbud and charging case:
//   response payload = [status, percent]
const CMD = {
  BATTERY_LEFT: 0x06,
  BATTERY_RIGHT: 0x07,
  BATTERY_CASE: 0x23,
  MODE_GET: 0x10, // returns [status, mode]
  MODE: 0x11,     // set mode (payload = mode value)
  ANC_LEVEL: 0x25,
};

// Mode values, identical for the 0x11 set payload and the 0x10 get response.
const MODE = {
  NORMAL: 0x00,
  ANC: 0x01,
  TRANSPARENCY: 0x02,
};

const MODE_NAMES = {
  [MODE.NORMAL]: 'Normal',
  [MODE.ANC]: 'ANC',
  [MODE.TRANSPARENCY]: 'Transparency',
};

function constructCommand(command, payload = Buffer.alloc(0)) {
  return Buffer.concat([
    HEADER,
    Buffer.from([payload.length, 0x00, 0x0a, DIR_HOST, command]),
    payload,
  ]);
}

// Parse one complete vendor packet (Buffer or hex string).
// Returns { command, direction, payload } or null if malformed / incomplete.
function parsePacket(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'hex');
  if (b.length < 8) return null;
  if (b[0] !== 0xff || b[1] !== 0x04 || b[2] !== 0x00) return null;
  const length = b[3];
  if (b.length < 8 + length) return null;
  return {
    command: b[7],
    direction: b[6],
    payload: b.subarray(8, 8 + length),
  };
}

// Extract battery percentage (+charging flag) from a parsed battery response.
// Returns { percent, charging } or null when the payload isn't battery-shaped.
function parseBattery(pkt) {
  if (!pkt) return null;
  if (pkt.command !== CMD.BATTERY_LEFT &&
      pkt.command !== CMD.BATTERY_RIGHT &&
      pkt.command !== CMD.BATTERY_CASE) {
    return null;
  }
  if (pkt.payload.length < 2) return null;
  return {
    percent: pkt.payload[1],
    charging: pkt.payload[0] === 0x01,
  };
}

// Extract the current ANC mode from a 0x10 response ([status, mode]).
// Returns { mode, name } or null.
function parseMode(pkt) {
  if (!pkt) return null;
  if (pkt.command !== CMD.MODE_GET) return null;
  if (pkt.payload.length < 2) return null;
  const mode = pkt.payload[1];
  return {
    mode,
    name: MODE_NAMES[mode] || `Mode ${mode}`,
  };
}

module.exports = {
  constructCommand,
  parsePacket,
  parseBattery,
  parseMode,
  CMD,
  MODE,
  DIR_HOST,
  DIR_DEVICE,
};
