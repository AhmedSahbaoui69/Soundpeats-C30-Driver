'use strict';

// Renderer for the SOUNDPEATS C30 window:

const api = window.soundpeats;
let osConnected = false;

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2200);
}

function renderStatus(data) {
  const device = document.getElementById('device');
  const isConnected = !!(data && data.os_connected);
  osConnected = isConnected;
  device.classList.toggle('connected', isConnected);
  device.classList.toggle('disconnected', !isConnected);

  const el = document.getElementById('statusText');
  if (isConnected) {
    const name = (data.detected && data.detected.name) || 'SOUNDPEATS C30';
    el.innerHTML = 'Connected to <b>' + name + '</b>';
  } else if (data && data.detected) {
    el.textContent = (data.detected.name || 'SOUNDPEATS C30') + ' not connected';
  } else {
    el.textContent = 'SOUNDPEATS C30 not found';
  }

  renderBattery(data && data.battery, isConnected);
  renderMode(data && isConnected ? data.mode : null);
}

// Move the sliding indicator to the active mode and animate the ANC level
// options in/out (only shown while ANC is active).
function renderMode(mode) {
  const toggle = document.getElementById('modeToggle');
  const options = Array.from(toggle.querySelectorAll('.mode-opt'));
  const activeIdx = options.findIndex(
    (o) => mode != null && Number(o.dataset.mode) === mode
  );
  options.forEach((o, i) => o.classList.toggle('active', i === activeIdx));

  const slider = toggle.querySelector('.mode-slider');
  if (activeIdx >= 0) {
    slider.dataset.pos = activeIdx;
    slider.classList.add('show');
  } else {
    slider.classList.remove('show');
  }

  const ancCard = document.getElementById('ancLevelCard');
  if (ancCard) ancCard.classList.toggle('collapsed', mode !== 1);
}

// Fill the three battery segments (case / left / right) on one line.
// The exact level is revealed inside the bar when hovering the segment.
function renderBattery(bat, isConnected) {
  const keys = ['case', 'left', 'right'];
  for (const key of keys) {
    const seg = document.querySelector('.batt-seg[data-key="' + key + '"]');
    if (!seg) continue;
    const fillEl = seg.querySelector('.batt-fill');
    const pctEl = seg.querySelector('.batt-pct');
    const pct = isConnected && bat ? bat[key] : null;

    if (pct == null) {
      fillEl.style.width = '0%';
      fillEl.className = 'batt-fill';
      pctEl.textContent = '';
      seg.classList.add('offline');
      continue;
    }
    seg.classList.remove('offline');

    const charging = bat[key + 'Charging'];
    const clamped = Math.max(0, Math.min(100, pct));
    fillEl.style.width = clamped + '%';
    let cls = 'batt-fill ' + (clamped <= 20 ? 'low' : clamped <= 40 ? 'ok' : 'good');
    if (charging) cls += ' charging';
    fillEl.className = cls;
    pctEl.textContent = pct + '%';
  }
}

async function refresh() {
  try {
    const d = await api.refresh();
    renderStatus(d);
    if (d.error) toast('Error: ' + d.error, 'error');
  } catch (e) {
    toast('Error: could not detect device', 'error');
  }
}

async function send(cmd, payload, label) {
  if (!osConnected) {
    toast('C30 not connected', 'error');
    return;
  }
  try {
    const d = await api.send(cmd, payload);
    if (d.ok) toast(label + ' Mode ON', 'success');
    else toast('Error: ' + (d.error || 'send failed'), 'error');
  } catch (e) {
    toast('Error: request failed', 'error');
  }
  // Re-read the headset's mode so the highlight updates right away.
  api.queryMode();
  setTimeout(() => api.getStatus().then(renderStatus), 150);
}

api.onStatus(renderStatus);

// Detect the C30 on launch, then keep polling so we notice connect/disconnect.
refresh();
setInterval(refresh, 5000);
