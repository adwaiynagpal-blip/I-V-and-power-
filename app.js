"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
//  BLE CONFIGURATION — update these to match your ESP32 firmware
// ═══════════════════════════════════════════════════════════════════════════════
const BLE_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0'; // your GATT service UUID
const BLE_CHAR_UUID    = '12345678-1234-5678-1234-56789abcdef1'; // notify characteristic UUID
const CSV_TERMINATOR   = 'END\n';  // sentinel the ESP32 appends after the last CSV chunk
// ═══════════════════════════════════════════════════════════════════════════════

// ─── State ────────────────────────────────────────────────────────────────────
let datasets       = [];
let activeId       = null;
let datasetCounter = 0;
let bleDevice      = null;
let bleServer      = null;
let csvBuffer      = '';

function generateId() { return `ds-${++datasetCounter}`; }
function activeSamples() {
    return datasets.find(d => d.id === activeId)?.samples ?? [];
}

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const $ = id => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el;
};

const els = {
    connForm:         $('conn-form'),
    deviceName:       $('device-name'),
    btnConnect:       $('btn-connect'),
    btnDisconnect:    $('btn-disconnect'),
    btnExport:        $('btn-export'),
    btnDemo:          $('btn-demo'),
    btnClearAll:      $('btn-clear-all'),
    status:           $('status'),
    statusText:       document.querySelector('#status .status-text'),
    scopeEmpty:       $('scope-empty'),
    sampleCaption:    $('sample-caption'),
    errorBanner:      $('error-banner'),
    bleWarning:       $('ble-warning'),
    rawCount:         $('raw-count'),
    tableBody:        $('data-table-body'),
    canvas:           $('scope'),
    valIsc:           $('val-isc'),
    valVoc:           $('val-voc'),
    valPmpp:          $('val-pmpp'),
    valVmpp:          $('val-vmpp'),
    valImpp:          $('val-impp'),
    valFf:            $('val-ff'),
    csvList:          $('csv-list'),
    fileInput:        $('file-input'),
    csvEmptyHint:     $('csv-empty-hint'),
    activeCurveLabel: $('active-curve-label'),
};

const ctx = els.canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D context unavailable');

// ─── Status / Error ───────────────────────────────────────────────────────────
function setStatus(state, text) {
    els.status.dataset.state = state;
    els.statusText.textContent = text;
}
function showError(message) {
    els.errorBanner.textContent = message;
    els.errorBanner.hidden = false;
    setStatus('error', 'Error');
}
function clearError() {
    els.errorBanner.hidden = true;
    els.errorBanner.textContent = '';
}

// ─── CSV Parsing ──────────────────────────────────────────────────────────────
function parseCsv(text) {
    // Strip the BLE terminator if it's embedded in the text
    const cleaned = text.replace(/END\s*$/, '').trim();
    const lines = cleaned
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0);
    if (lines.length === 0) throw new Error('CSV file is empty');

    // Auto-detect header row
    const firstCells = lines[0].split(',');
    const firstIsNumeric = firstCells.every(c => c.trim() !== '' && !isNaN(Number(c.trim())));
    const startRow = firstIsNumeric ? 0 : 1;

    const out = [];
    for (let i = startRow; i < lines.length; i++) {
        const cells = lines[i].split(',');
        if (cells.length < 2) continue;
        const v    = Number(cells[0].trim());
        const iVal = Number(cells[1].trim());
        if (isNaN(v) || isNaN(iVal)) continue;
        out.push({ voltage: v, current: iVal, power: v * iVal });
    }
    if (out.length === 0) throw new Error('No valid data rows found in CSV');
    out.sort((a, b) => a.voltage - b.voltage);
    return out;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function computeStats(data) {
    if (data.length < 2) return null;
    const isc = data.reduce((best, s) =>
        Math.abs(s.voltage) < Math.abs(best.voltage) ? s : best
    ).current;

    let voc = data[data.length - 1].voltage;
    for (let k = 0; k < data.length - 1; k++) {
        const a = data[k], b = data[k + 1];
        if (a.current >= 0 && b.current <= 0) {
            const t = a.current === b.current ? 0 : a.current / (a.current - b.current);
            voc = a.voltage + t * (b.voltage - a.voltage);
            break;
        }
    }
    const mpp = data.reduce((best, s) => s.power > best.power ? s : best);
    const fillFactor = isc > 0 && voc > 0 ? mpp.power / (isc * voc) : 0;
    return { isc, voc, vmpp: mpp.voltage, impp: mpp.current, pmpp: mpp.power, fillFactor };
}

function fmt(n, digits = 3) { return n.toFixed(digits); }

function renderReadouts(stats) {
    if (!stats) {
        [els.valIsc, els.valVoc, els.valPmpp, els.valVmpp, els.valImpp, els.valFf]
            .forEach(el => el.textContent = '—');
        return;
    }
    els.valIsc.textContent  = fmt(stats.isc);
    els.valVoc.textContent  = fmt(stats.voc);
    els.valPmpp.textContent = fmt(stats.pmpp);
    els.valVmpp.textContent = fmt(stats.vmpp);
    els.valImpp.textContent = fmt(stats.impp);
    els.valFf.textContent   = fmt(stats.fillFactor, 3);
}

// ─── Raw Data Table ───────────────────────────────────────────────────────────
function renderTable(data) {
    els.rawCount.textContent = data.length ? `(${data.length})` : '';
    els.tableBody.innerHTML = data.map((s, idx) =>
        `<tr><td>${idx + 1}</td><td>${fmt(s.voltage, 4)}</td><td>${fmt(s.current, 4)}</td><td>${fmt(s.power, 4)}</td></tr>`
    ).join('');
}

// ─── Canvas / Scope ───────────────────────────────────────────────────────────
const PAD = { top: 24, right: 56, bottom: 40, left: 56 };

function clearCanvas() {
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
}

function drawGrid(maxV, maxI) {
    const w = els.canvas.width  - PAD.left - PAD.right;
    const h = els.canvas.height - PAD.top  - PAD.bottom;
    const cols = 8, rows = 6;

    ctx.strokeStyle = 'rgba(75, 227, 138, 0.10)';
    ctx.lineWidth = 1;
    ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.fillStyle = '#4d5c55';

    for (let c = 0; c <= cols; c++) {
        const x = PAD.left + (w * c) / cols;
        ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + h); ctx.stroke();
        ctx.fillText(((maxV * c) / cols).toFixed(2), x - 10, PAD.top + h + 18);
    }
    for (let r = 0; r <= rows; r++) {
        const y = PAD.top + (h * r) / rows;
        ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + w, y); ctx.stroke();
        ctx.fillText((maxI - (maxI * r) / rows).toFixed(2), PAD.left - 42, y + 4);
    }

    ctx.fillStyle = '#7c9188';
    ctx.font = "12px 'IBM Plex Mono', monospace";
    ctx.fillText('Voltage (V)', PAD.left + w / 2 - 30, els.canvas.height - 8);
    ctx.save();
    ctx.translate(14, PAD.top + h / 2 + 30);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Current (A)', 0, 0);
    ctx.restore();
}

function drawTrace(data, valueOf, maxV, maxValue, color, glow) {
    if (data.length === 0) return;
    const w = els.canvas.width  - PAD.left - PAD.right;
    const h = els.canvas.height - PAD.top  - PAD.bottom;
    const toX = v   => PAD.left + (v   / maxV)     * w;
    const toY = val => PAD.top  + h   - (val / maxValue) * h;
    ctx.beginPath();
    data.forEach((s, idx) => {
        const x = toX(s.voltage);
        const y = toY(Math.max(0, valueOf(s)));
        idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function drawMarker(x, y, maxV, maxValue, label) {
    const w = els.canvas.width  - PAD.left - PAD.right;
    const h = els.canvas.height - PAD.top  - PAD.bottom;
    const px = PAD.left + (x / maxV)     * w;
    const py = PAD.top  + h - (y / maxValue) * h;
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#e8f3ec';
    ctx.fill();
    ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.fillStyle = '#e8f3ec';
    ctx.fillText(label, px + 8, py - 8);
}

function renderScope(data, stats) {
    clearCanvas();
    if (data.length === 0 || !stats) {
        els.scopeEmpty.style.display = 'flex';
        return;
    }
    els.scopeEmpty.style.display = 'none';
    const maxV = Math.max(...data.map(s => s.voltage)) * 1.05;
    const maxI = Math.max(...data.map(s => s.current)) * 1.15;
    drawGrid(maxV, maxI);
    drawTrace(data, s => s.current, maxV, maxI, '#4be38a', 'rgba(75,227,138,0.9)');
    drawMarker(stats.vmpp, stats.impp, maxV, maxI, 'MPP');
}

// ─── Dataset Management ───────────────────────────────────────────────────────
function renderSidebar() {
    els.csvList.innerHTML = '';
    els.csvEmptyHint.hidden = datasets.length > 0;
    els.btnClearAll.disabled = datasets.length === 0;

    datasets.forEach(ds => {
        const li = document.createElement('li');
        li.className = 'csv-chip' + (ds.id === activeId ? ' active' : '');
        li.dataset.id = ds.id;

        const labelSpan = document.createElement('span');
        labelSpan.className = 'csv-chip-label';
        labelSpan.textContent = ds.label;
        labelSpan.title = ds.label;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'csv-chip-remove';
        removeBtn.setAttribute('aria-label', `Remove ${ds.label}`);
        removeBtn.innerHTML = '&#x2715;';
        removeBtn.addEventListener('click', e => { e.stopPropagation(); removeDataset(ds.id); });

        li.appendChild(labelSpan);
        li.appendChild(removeBtn);
        li.addEventListener('click', () => setActive(ds.id));
        els.csvList.appendChild(li);
    });
}

function setActive(id) {
    activeId = id;
    const ds    = datasets.find(d => d.id === id);
    const data  = ds?.samples ?? [];
    const stats = computeStats(data);
    els.activeCurveLabel.textContent = ds?.label ?? '';
    renderReadouts(stats);
    renderTable(data);
    renderScope(data, stats);
    els.sampleCaption.textContent = data.length ? `${data.length} samples` : 'No samples';
    els.btnExport.disabled = data.length === 0;
    renderSidebar();
}

function addDataset(label, samples) {
    const ds = { id: generateId(), label, samples };
    datasets.push(ds);
    setActive(ds.id);
}

function removeDataset(id) {
    const idx = datasets.findIndex(d => d.id === id);
    if (idx === -1) return;
    datasets.splice(idx, 1);
    if (activeId === id) {
        const next = datasets[Math.min(idx, datasets.length - 1)];
        activeId = next?.id ?? null;
    }
    if (activeId) {
        setActive(activeId);
    } else {
        clearCanvas();
        els.scopeEmpty.style.display = 'flex';
        renderReadouts(null);
        renderTable([]);
        els.sampleCaption.textContent = 'No samples loaded';
        els.btnExport.disabled = true;
        els.activeCurveLabel.textContent = '';
        renderSidebar();
    }
}

function clearAll() {
    datasets = []; activeId = null;
    clearCanvas();
    els.scopeEmpty.style.display = 'flex';
    renderReadouts(null);
    renderTable([]);
    els.sampleCaption.textContent = 'No samples loaded';
    els.btnExport.disabled = true;
    els.activeCurveLabel.textContent = '';
    renderSidebar();
}

// ─── BLE Manager ─────────────────────────────────────────────────────────────

/** Update UI to reflect a live BLE connection */
function setBleUiConnected() {
    els.btnConnect.disabled    = true;
    els.btnDisconnect.disabled = false;
    setStatus('connected', 'BLE Connected');
}

/** Update UI to reflect no BLE connection */
function setBleUiDisconnected() {
    els.btnConnect.disabled    = false;
    els.btnDisconnect.disabled = true;
    bleServer = null;
    csvBuffer = '';
}

/**
 * Called by the browser when the GATT server disconnects unexpectedly.
 * Shows an error and re-enables the Connect button so the user can reconnect.
 */
function onBleDisconnect() {
    setBleUiDisconnected();
    showError('ESP32 disconnected. Click "Connect via BLE" to reconnect.');
}

/**
 * Receives chunked BLE notifications from the ESP32.
 * Accumulates chunks into csvBuffer until the CSV_TERMINATOR is detected,
 * then calls handleCsvComplete() with the full CSV text.
 */
function onBleNotification(event) {
    const chunk = new TextDecoder().decode(event.target.value);
    csvBuffer += chunk;

    if (csvBuffer.includes(CSV_TERMINATOR)) {
        // Split on the terminator; keep any data after it for the next scan
        const parts   = csvBuffer.split(CSV_TERMINATOR);
        const csvText = parts[0];
        csvBuffer     = parts.slice(1).join(CSV_TERMINATOR); // carry-forward overflow
        handleCsvComplete(csvText);
    }
}

/**
 * Parses a complete CSV string received over BLE and adds it as a new dataset.
 * The dataset is automatically labelled with the current time (HH:MM:SS).
 */
function handleCsvComplete(csvText) {
    try {
        clearError();
        const samples = parseCsv(csvText);
        const now     = new Date();
        const hh      = now.getHours()  .toString().padStart(2, '0');
        const mm      = now.getMinutes().toString().padStart(2, '0');
        const ss      = now.getSeconds().toString().padStart(2, '0');
        const label   = `Scan ${hh}:${mm}:${ss}`;
        addDataset(label, samples);
        setStatus('connected', `BLE · Last scan ${hh}:${mm}:${ss}`);
    } catch (err) {
        showError(`CSV parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Opens the Web Bluetooth device picker filtered by BLE_SERVICE_UUID (or
 * optionally by device name if the user typed one), connects to the GATT
 * server, finds the notify characteristic, and starts notifications.
 */
async function connectBle() {
    if (!navigator.bluetooth) {
        showError('Web Bluetooth is not supported. Use Chrome or Edge on desktop.');
        return;
    }
    try {
        clearError();
        setStatus('connecting', 'Connecting…');
        els.btnConnect.disabled = true;

        const nameFilter = els.deviceName.value.trim();

        // Build request options:
        //  • If the user provided a device name, filter by name and list
        //    the service as optional so we can still access it after pairing.
        //  • Otherwise filter directly by the service UUID.
        const requestOptions = nameFilter
            ? { filters: [{ name: nameFilter }], optionalServices: [BLE_SERVICE_UUID] }
            : { filters: [{ services: [BLE_SERVICE_UUID] }] };

        bleDevice = await navigator.bluetooth.requestDevice(requestOptions);
        bleDevice.addEventListener('gattserverdisconnected', onBleDisconnect);

        bleServer = await bleDevice.gatt.connect();
        const service        = await bleServer.getPrimaryService(BLE_SERVICE_UUID);
        const characteristic = await service.getCharacteristic(BLE_CHAR_UUID);

        await characteristic.startNotifications();
        characteristic.addEventListener('characteristicvaluechanged', onBleNotification);

        setBleUiConnected();
    } catch (err) {
        setBleUiDisconnected();
        if (err.name === 'NotFoundError') {
            // User closed the picker — not really an error
            setStatus('idle', 'Idle');
        } else {
            showError(`BLE error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

/** Manually disconnect from the currently paired ESP32 device. */
function disconnectBle() {
    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();   // triggers onBleDisconnect via event
    }
    setBleUiDisconnected();
    setStatus('idle', 'Disconnected');
}

// ─── Export ───────────────────────────────────────────────────────────────────
function exportCsv() {
    const data = activeSamples();
    const ds   = datasets.find(d => d.id === activeId);
    const header = 'Voltage (V),Current (A),Power (W)\n';
    const body   = data.map(s => `${s.voltage},${s.current},${s.power}`).join('\n');
    const blob   = new Blob([header + body], { type: 'text/csv' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url;
    a.download = `${ds?.label ?? 'curve'}_IV.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ─── Demo Data ────────────────────────────────────────────────────────────────
function generateDemoSamples() {
    const Iph = 3.55, I0 = 3.2e-9, n = 1.3, Rs = 0.02, Rsh = 200, Vt = 0.02585;
    const solveI = (v, guess) => {
        let i = guess;
        for (let iter = 0; iter < 100; iter++) {
            const f  = Iph - I0 * (Math.exp((v + i*Rs)/(n*Vt)) - 1) - (v + i*Rs)/Rsh - i;
            const df = -I0 * (Rs/(n*Vt)) * Math.exp((v + i*Rs)/(n*Vt)) - Rs/Rsh - 1;
            const next = i - f/df;
            if (Math.abs(next - i) < 1e-9) { i = next; break; }
            i = next;
        }
        return i;
    };
    const out = []; let guess = Iph;
    for (let v = 0; v <= 0.75; v += 0.0025) {
        const i = solveI(v, guess);
        if (i < -0.01) break;
        guess = i;
        out.push({ voltage: v, current: i, power: v * i });
    }
    return out;
}

// ─── File Upload / Drag-Drop ──────────────────────────────────────────────────
function handleFiles(files) {
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                clearError();
                const samples = parseCsv(reader.result);
                addDataset(file.name.replace(/\.csv$/i, ''), samples);
            } catch (err) {
                showError(`${file.name}: ${err instanceof Error ? err.message : 'Failed to parse CSV'}`);
            }
        };
        reader.readAsText(file);
    });
}

function setupDragDrop() {
    const sidebar = document.querySelector('.csv-sidebar');
    if (!sidebar) return;
    sidebar.addEventListener('dragover',  e => { e.preventDefault(); sidebar.classList.add('drag-over'); });
    sidebar.addEventListener('dragleave', ()  => sidebar.classList.remove('drag-over'));
    sidebar.addEventListener('drop', e => {
        e.preventDefault();
        sidebar.classList.remove('drag-over');
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) handleFiles(files);
    });
}

// ─── Browser capability check ─────────────────────────────────────────────────
if (!navigator.bluetooth) {
    els.bleWarning.hidden = false;
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
els.connForm.addEventListener('submit',   e => { e.preventDefault(); void connectBle(); });
els.btnDisconnect.addEventListener('click', disconnectBle);
els.btnExport.addEventListener('click',   exportCsv);
els.btnClearAll.addEventListener('click', clearAll);
els.btnDemo.addEventListener('click', () => {
    clearError();
    addDataset('Demo data', generateDemoSamples());
    setStatus('idle', 'Demo loaded');
});
els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files?.length > 0) {
        handleFiles(els.fileInput.files);
        els.fileInput.value = '';
    }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
setupDragDrop();
renderReadouts(null);
renderSidebar();
els.scopeEmpty.style.display = 'flex';
