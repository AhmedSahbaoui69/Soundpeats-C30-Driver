'use strict';

// Find the SOUNDPEATS C30 among BlueZ devices by name metadata.

const { execFile } = require('child_process');

const DEVICE_LINE = /^Device\s+([0-9A-Fa-f:]{17})\s*(.*)$/;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('bluetoothctl', args, { timeout: 8000 }, (err, stdout) => {
      if (err) {
        reject(
          new Error(
            'bluetoothctl failed: ' +
              (err.code === 'ENOENT' ? 'not found (install bluez)' : err.message)
          )
        );
      } else {
        resolve(stdout);
      }
    });
  });
}

// First known device whose name matches `pattern`.
// Returns { address, name, connected } or null.
async function findDevice(pattern) {
  const re = new RegExp(pattern, 'i');
  const out = await run(['devices']);

  for (const line of out.split('\n')) {
    const m = DEVICE_LINE.exec(line.trim());
    if (!m || !re.test(m[2] || '')) continue;

    const address = m[1].toUpperCase();
    let name = m[2].trim();
    let connected = false;

    try {
      const info = await run(['info', address]);
      for (const row of info.split('\n')) {
        const nm = /^Name:\s*(.*)$/.exec(row.trim());
        if (nm) name = nm[1].trim();
        if (/^Connected:\s*yes$/i.test(row.trim())) connected = true;
      }
    } catch {
      // device no longer available, leave connected=false
    }

    return { address, name, connected };
  }

  return null;
}

module.exports = { findDevice };
