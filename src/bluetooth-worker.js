'use strict';

// Bluetooth Classic RFCOMM (Serial Port Profile) transport.
//
// Runs in a worker thread so blocking libc calls never freeze the Electron
// main process or the renderer. Uses Linux's AF_BLUETOOTH sockets through
// koffi (libc FFI).

const { parentPort } = require('worker_threads');
const koffi = require('koffi');

const libc = koffi.load('libc.so.6');

// Linux socket constants.
const AF_BLUETOOTH = 31;
const SOCK_STREAM = 1;
const BTPROTO_RFCOMM = 3;

// fcntl
const F_SETFL = 4;
const O_NONBLOCK = 0x800; // x86_64 Linux

// getsockopt
const SOL_SOCKET = 1;
const SO_ERROR = 4;

// poll(2)
const POLLOUT = 0x004;

// errno
const EAGAIN = 11; // == EWOULDBLOCK
const EINTR = 4;
const EINPROGRESS = 115;
const EALREADY = 114;

// libc function declarations (C-like prototypes).
const socketFn = libc.func('int socket(int domain, int type, int protocol)');
const connectFn = libc.func('int connect(int fd, const void *addr, unsigned int addrlen)');
const pollFn = libc.func('int poll(void *fds, unsigned long nfds, int timeout)');
const readFn = libc.func('intptr_t read(int fd, _Out_ uint8_t *buf, size_t count)');
const writeFn = libc.func('intptr_t write(int fd, const void *buf, size_t count)');
const closeFn = libc.func('int close(int fd)');
const fcntlFn = libc.func('int fcntl(int fd, int cmd, int arg)');
const getsockoptFn = libc.func(
  'int getsockopt(int fd, int level, int optname, _Inout_ int *optval, _Inout_ uint32_t *optlen)'
);

let fd = -1;
let stopping = false;

// Receive-side buffer for reassembling 'ff 04 00' vendor packets across
// partial read() calls and RFCOMM framing.
let rxBuffer = Buffer.alloc(0);

// Pull every complete 'ff 04 00' vendor packet out of the receive stream.
// Handles packets split across reads and multiple packets per read; keeps a
// small tail so a marker straddling a chunk boundary is not lost.
function extractPackets() {
  const out = [];
  while (true) {
    const idx = rxBuffer.indexOf(Buffer.from([0xff, 0x04, 0x00]));
    if (idx < 0) {
      // No marker yet, keep the last 2 bytes in case 'ff'/'ff 04' straddles.
      rxBuffer = rxBuffer.length > 2 ? rxBuffer.subarray(rxBuffer.length - 2) : rxBuffer;
      break;
    }
    if (idx > 0) rxBuffer = rxBuffer.subarray(idx); // drop bytes before marker
    if (rxBuffer.length < 4) break;                 // need the length byte
    const total = 8 + rxBuffer[3];                  // header(8) + payload
    if (rxBuffer.length < total) break;             // wait for the rest
    out.push(rxBuffer.subarray(0, total));
    rxBuffer = rxBuffer.subarray(total);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Convert 'AA:BB:CC:DD:EE:FF' to the 10-byte sockaddr_rc buffer the kernel
// expects (rc_family + 6 little-endian bdaddr bytes + rc_channel + padding).
function buildSockaddr(bdAddr, channel) {
  const parts = bdAddr.trim().toUpperCase().split(':');
  if (parts.length !== 6) {
    throw new Error(`Invalid Bluetooth address: ${bdAddr}`);
  }
  const buf = Buffer.alloc(10);
  buf.writeUInt16LE(AF_BLUETOOTH, 0);
  for (let i = 0; i < 6; i++) {
    const val = parseInt(parts[5 - i], 16);
    if (Number.isNaN(val)) throw new Error(`Invalid Bluetooth address: ${bdAddr}`);
    buf[2 + i] = val;
  }
  buf[8] = channel;
  return buf;
}

// Wait until the socket becomes writable (connect completed) or timeout.
async function waitWritable(s, timeoutMs) {
  const start = Date.now();
  while (!stopping) {
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) return false;

    const pf = Buffer.alloc(8);
    pf.writeInt32LE(s, 0);
    pf.writeInt16LE(POLLOUT, 4);
    pf.writeInt16LE(0, 6);

    const pr = pollFn(pf, 1, Math.min(remaining, 100));
    if (pr < 0) {
      if (koffi.errno() === EINTR) continue;
      throw new Error(`poll() failed: errno ${koffi.errno()}`);
    }
    if (pr > 0) {
      return (pf.readInt16LE(6) & POLLOUT) !== 0;
    }
    await sleep(0); // let pending messages (e.g. 'disconnect') through
  }
  return false;
}

// Open a non-blocking RFCOMM socket, connect it, then check SO_ERROR.
async function doConnect(bdAddr, channel, timeoutMs) {
  const s = socketFn(AF_BLUETOOTH, SOCK_STREAM, BTPROTO_RFCOMM);
  if (s < 0) throw new Error(`socket() failed: errno ${koffi.errno()}`);

  try {
    fcntlFn(s, F_SETFL, O_NONBLOCK);

    const addr = buildSockaddr(bdAddr, channel);
    const res = connectFn(s, addr, addr.length);
    if (res !== 0) {
      const err = koffi.errno();
      if (err === EINPROGRESS || err === EALREADY || err === EAGAIN) {
        const writable = await waitWritable(s, timeoutMs);
        if (!writable) {
          throw new Error(`Connection timed out after ${timeoutMs} ms`);
        }
        const soErr = [0];
        const optlen = [4];
        if (getsockoptFn(s, SOL_SOCKET, SO_ERROR, soErr, optlen) !== 0) {
          throw new Error(`getsockopt() failed: errno ${koffi.errno()}`);
        }
        if (soErr[0] !== 0) {
          throw new Error(`connect() failed: errno ${soErr[0]}`);
        }
      } else {
        throw new Error(`connect() failed: errno ${err}`);
      }
    }
    return s;
  } catch (e) {
    closeFn(s);
    throw e;
  }
}

// Write all bytes, retrying on EAGAIN (socket stays non-blocking).
async function doWrite(data) {
  let off = 0;
  while (off < data.length) {
    if (stopping || fd < 0) throw new Error('Disconnected');
    const n = writeFn(fd, data.subarray(off), data.length - off);
    if (n > 0) {
      off += n;
      continue;
    }
    const err = koffi.errno();
    if (err === EINTR) continue;
    if (err === EAGAIN) {
      await sleep(10);
      continue;
    }
    throw new Error(`write() failed: errno ${err}`);
  }
}

// Read incoming bytes, reassemble complete 'ff 04 00' vendor packets, and
// forward them to the main process as { type: 'packet', hex }. Also detects
// peer close.
async function readLoop() {
  const buf = Buffer.alloc(1024);
  while (!stopping && fd >= 0) {
    const n = readFn(fd, buf, 1024);
    if (n > 0) {
      rxBuffer = Buffer.concat([rxBuffer, buf.subarray(0, n)]);
      if (rxBuffer.length > 65536) {
        // Safety cap: drop the oldest bytes.
        rxBuffer = rxBuffer.subarray(rxBuffer.length - 65536);
      }
      for (const pkt of extractPackets()) {
        parentPort.postMessage({ type: 'packet', hex: pkt.toString('hex') });
      }
      continue;
    }
    if (n === 0) break; // peer closed the socket
    const err = koffi.errno();
    if (err !== EINTR && err !== EAGAIN) break;
    await sleep(30);
  }

  if (!stopping) {
    stopping = true;
    parentPort.postMessage({ type: 'disconnected' });
  }
}

function closeFd() {
  if (fd >= 0) {
    try {
      closeFn(fd);
    } catch {
      /* ignore */
    }
    fd = -1;
  }
}

async function handleConnect(msg) {
  closeFd();
  stopping = false;

  const s = await doConnect(msg.bdAddr, msg.channel, msg.timeout || 8000);
  if (stopping || s < 0) {
    if (s >= 0) closeFn(s);
    return;
  }

  fd = s;
  parentPort.postMessage({ type: 'connected' });
  readLoop(); // fire-and-forget
}

async function handleSend(msg) {
  if (fd < 0) throw new Error('Not connected');
  await doWrite(Buffer.from(msg.data, 'hex'));
  parentPort.postMessage({ type: 'sent', id: msg.id });
}

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'connect':
      handleConnect(msg).catch((e) =>
        parentPort.postMessage({ type: 'connectError', message: e.message })
      );
      break;
    case 'send':
      handleSend(msg).catch((e) =>
        parentPort.postMessage({ type: 'sendError', id: msg.id, message: e.message })
      );
      break;
    case 'disconnect':
      stopping = true;
      closeFd();
      break;
    case 'stop':
      stopping = true;
      closeFd();
      process.exit(0);
      break;
    default:
      break;
  }
});
