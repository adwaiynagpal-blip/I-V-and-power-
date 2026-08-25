"use strict";
let datasets = [];
let activeId = null;
let pollTimer = null;
let isPolling = false;
let datasetCounter = 0;
function activeSamples() {
    var _a, _b;
    return (_b = (_a = datasets.find((d) => d.id === activeId)) === null || _a === void 0 ? void 0 : _a.samples) !== null && _b !== void 0 ? _b : [];
}
function generateId() {
    return `ds-${++datasetCounter}`;
}
const $ = (id) => {
    const el = document.getElementById(id);
    if (!el)
        throw new Error(`Missing element #${id}`);
    return el;
};
const els = {
    connForm: $("conn-form"),
    deviceUrl: $("device-url"),
    pollInterval: $("poll-interval"),
    btnConnect: $("btn-connect"),
    btnPoll: $("btn-poll"),
    btnFetchOnce: $("btn-fetch-once"),
    btnExport: $("btn-export"),
    btnDemo: $("btn-demo"),
    btnClearAll: $("btn-clear-all"),
    status: $("status"),
    statusText: document.querySelector("#status .status-text"),
    scopeEmpty: $("scope-empty"),
    sampleCaption: $("sample-caption"),
    errorBanner: $("error-banner"),
    rawCount: $("raw-count"),
    tableBody: $("data-table-body"),
    canvas: $("scope"),
    valIsc: $("val-isc"),
    valVoc: $("val-voc"),
    valPmpp: $("val-pmpp"),
    valVmpp: $("val-vmpp"),
    valImpp: $("val-impp"),
    valFf: $("val-ff"),
    csvList: $("csv-list"),
    fileInput: $("file-input"),
    csvEmptyHint: $("csv-empty-hint"),
    activeCurveLabel: $("active-curve-label"),
};
const ctx = els.canvas.getContext("2d");
if (!ctx)
    throw new Error("Canvas 2D context unavailable");
function setStatus(state, text) {
    els.status.dataset.state = state;
    els.statusText.textContent = text;
}
function showError(message) {
    els.errorBanner.textContent = message;
    els.errorBanner.hidden = false;
    setStatus("error", "Error");
}
function clearError() {
    els.errorBanner.hidden = true;
    els.errorBanner.textContent = "";
}
function parseSamples(raw) {
    const list = Array.isArray(raw)
        ? raw
        : typeof raw === "object" && raw !== null && "samples" in raw
            ? raw.samples
            : null;
    if (!Array.isArray(list)) {
        throw new Error("Unexpected response shape: expected an array of samples");
    }
    const out = list.map((entry, index) => {
        var _a, _b, _c, _d;
        let v;
        let i;
        if (Array.isArray(entry)) {
            v = Number(entry[0]);
            i = Number(entry[1]);
        }
        else if (typeof entry === "object" && entry !== null) {
            const obj = entry;
            v = Number((_b = (_a = obj.voltage) !== null && _a !== void 0 ? _a : obj.v) !== null && _b !== void 0 ? _b : obj.V);
            i = Number((_d = (_c = obj.current) !== null && _c !== void 0 ? _c : obj.i) !== null && _d !== void 0 ? _d : obj.I);
        }
        if (v === undefined || i === undefined || Number.isNaN(v) || Number.isNaN(i)) {
            throw new Error(`Sample ${index} is missing a valid voltage/current`);
        }
        return { voltage: v, current: i, power: v * i };
    });
    out.sort((a, b) => a.voltage - b.voltage);
    return out;
}
async function fetchFromDevice(url) {
    var _a;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) {
            throw new Error(`Device responded with HTTP ${res.status}`);
        }
        const contentType = (_a = res.headers.get("content-type")) !== null && _a !== void 0 ? _a : "";
        if (contentType.includes("text/csv") || url.toLowerCase().endsWith(".csv")) {
            const text = await res.text();
            return parseCsv(text);
        }
        const json = await res.json();
        return parseSamples(json);
    }
    finally {
        window.clearTimeout(timeout);
    }
}
function computeStats(data) {
    if (data.length < 2)
        return null;
    const isc = data.reduce((best, s) => Math.abs(s.voltage) < Math.abs(best.voltage) ? s : best).current;
    let voc = data[data.length - 1].voltage;
    for (let k = 0; k < data.length - 1; k++) {
        const a = data[k];
        const b = data[k + 1];
        if (a.current >= 0 && b.current <= 0) {
            const t = a.current === b.current ? 0 : a.current / (a.current - b.current);
            voc = a.voltage + t * (b.voltage - a.voltage);
            break;
        }
    }
    const mpp = data.reduce((best, s) => (s.power > best.power ? s : best));
    const fillFactor = isc > 0 && voc > 0 ? mpp.power / (isc * voc) : 0;
    return {
        isc,
        voc,
        vmpp: mpp.voltage,
        impp: mpp.current,
        pmpp: mpp.power,
        fillFactor,
    };
}
function fmt(n, digits = 3) {
    return n.toFixed(digits);
}
function renderReadouts(stats) {
    if (!stats) {
        [els.valIsc, els.valVoc, els.valPmpp, els.valVmpp, els.valImpp, els.valFf].forEach((el) => (el.textContent = "—"));
        return;
    }
    els.valIsc.textContent = fmt(stats.isc);
    els.valVoc.textContent = fmt(stats.voc);
    els.valPmpp.textContent = fmt(stats.pmpp);
    els.valVmpp.textContent = fmt(stats.vmpp);
    els.valImpp.textContent = fmt(stats.impp);
    els.valFf.textContent = fmt(stats.fillFactor, 3);
}
function renderTable(data) {
    els.rawCount.textContent = data.length ? `(${data.length})` : "";
    const rows = data
        .map((s, idx) => `<tr><td>${idx + 1}</td><td>${fmt(s.voltage, 4)}</td><td>${fmt(s.current, 4)}</td><td>${fmt(s.power, 4)}</td></tr>`)
        .join("");
    els.tableBody.innerHTML = rows;
}
const PAD = { top: 24, right: 56, bottom: 40, left: 56 };
function clearCanvas() {
    if (!ctx)
        return;
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
}
function drawGrid(maxV, maxI) {
    if (!ctx)
        return;
    const w = els.canvas.width - PAD.left - PAD.right;
    const h = els.canvas.height - PAD.top - PAD.bottom;
    const cols = 8;
    const rows = 6;
    ctx.strokeStyle = "rgba(75, 227, 138, 0.10)";
    ctx.lineWidth = 1;
    ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.fillStyle = "#4d5c55";
    for (let c = 0; c <= cols; c++) {
        const x = PAD.left + (w * c) / cols;
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, PAD.top + h);
        ctx.stroke();
        const v = (maxV * c) / cols;
        ctx.fillText(v.toFixed(2), x - 10, PAD.top + h + 18);
    }
    for (let r = 0; r <= rows; r++) {
        const y = PAD.top + (h * r) / rows;
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(PAD.left + w, y);
        ctx.stroke();
        const i = maxI - (maxI * r) / rows;
        ctx.fillText(i.toFixed(2), PAD.left - 42, y + 4);
    }
    ctx.fillStyle = "#7c9188";
    ctx.font = "12px 'IBM Plex Mono', monospace";
    ctx.fillText("Voltage (V)", PAD.left + w / 2 - 30, els.canvas.height - 8);
    ctx.save();
    ctx.translate(14, PAD.top + h / 2 + 30);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Current (A)", 0, 0);
    ctx.restore();
}
function drawTrace(data, valueOf, maxV, maxValue, color, glow) {
    if (!ctx || data.length === 0)
        return;
    const w = els.canvas.width - PAD.left - PAD.right;
    const h = els.canvas.height - PAD.top - PAD.bottom;
    const toX = (v) => PAD.left + (v / maxV) * w;
    const toY = (val) => PAD.top + h - (val / maxValue) * h;
    ctx.beginPath();
    data.forEach((s, idx) => {
        const x = toX(s.voltage);
        const y = toY(Math.max(0, valueOf(s)));
        if (idx === 0)
            ctx.moveTo(x, y);
        else
            ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
}
function drawMarker(x, y, maxV, maxValue, label) {
    if (!ctx)
        return;
    const w = els.canvas.width - PAD.left - PAD.right;
    const h = els.canvas.height - PAD.top - PAD.bottom;
    const px = PAD.left + (x / maxV) * w;
    const py = PAD.top + h - (y / maxValue) * h;
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#e8f3ec";
    ctx.fill();
    ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.fillStyle = "#e8f3ec";
    ctx.fillText(label, px + 8, py - 8);
}
function renderScope(data, stats) {
    clearCanvas();
    if (data.length === 0 || !stats) {
        els.scopeEmpty.style.display = "flex";
        return;
    }
    els.scopeEmpty.style.display = "none";
    const maxV = Math.max(...data.map((s) => s.voltage)) * 1.05;
    const maxI = Math.max(...data.map((s) => s.current)) * 1.15;
    drawGrid(maxV, maxI);
    drawTrace(data, (s) => s.current, maxV, maxI, "#4be38a", "rgba(75,227,138,0.9)");
    drawMarker(stats.vmpp, stats.impp, maxV, maxI, "MPP");
}
function parseCsv(text) {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0)
        throw new Error("CSV file is empty");
    const firstCells = lines[0].split(",");
    const firstIsNumeric = firstCells.every((c) => c.trim() !== "" && !isNaN(Number(c.trim())));
    const startRow = firstIsNumeric ? 0 : 1;
    const out = [];
    for (let i = startRow; i < lines.length; i++) {
        const cells = lines[i].split(",");
        if (cells.length < 2)
            continue;
        const v = Number(cells[0].trim());
        const iVal = Number(cells[1].trim());
        if (isNaN(v) || isNaN(iVal))
            continue;
        out.push({ voltage: v, current: iVal, power: v * iVal });
    }
    if (out.length === 0)
        throw new Error("No valid data rows found in CSV");
    out.sort((a, b) => a.voltage - b.voltage);
    return out;
}
function renderSidebar() {
    els.csvList.innerHTML = "";
    els.csvEmptyHint.hidden = datasets.length > 0;
    els.btnClearAll.disabled = datasets.length === 0;
    datasets.forEach((ds) => {
        const li = document.createElement("li");
        li.className = "csv-chip" + (ds.id === activeId ? " active" : "");
        li.dataset.id = ds.id;
        const labelSpan = document.createElement("span");
        labelSpan.className = "csv-chip-label";
        labelSpan.textContent = ds.label;
        labelSpan.title = ds.label;
        const removeBtn = document.createElement("button");
        removeBtn.className = "csv-chip-remove";
        removeBtn.setAttribute("aria-label", `Remove ${ds.label}`);
        removeBtn.innerHTML = "&#x2715;";
        removeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            removeDataset(ds.id);
        });
        li.appendChild(labelSpan);
        li.appendChild(removeBtn);
        li.addEventListener("click", () => setActive(ds.id));
        els.csvList.appendChild(li);
    });
}
function setActive(id) {
    var _a, _b;
    activeId = id;
    const ds = datasets.find((d) => d.id === id);
    const data = (_a = ds === null || ds === void 0 ? void 0 : ds.samples) !== null && _a !== void 0 ? _a : [];
    const stats = computeStats(data);
    els.activeCurveLabel.textContent = (_b = ds === null || ds === void 0 ? void 0 : ds.label) !== null && _b !== void 0 ? _b : "";
    renderReadouts(stats);
    renderTable(data);
    renderScope(data, stats);
    els.sampleCaption.textContent = data.length ? `${data.length} samples` : "No samples";
    els.btnExport.disabled = data.length === 0;
    renderSidebar();
}
function addDataset(label, samples) {
    const ds = { id: generateId(), label, samples };
    datasets.push(ds);
    setActive(ds.id);
}
function removeDataset(id) {
    var _a;
    const idx = datasets.findIndex((d) => d.id === id);
    if (idx === -1)
        return;
    datasets.splice(idx, 1);
    if (activeId === id) {
        const next = datasets[Math.min(idx, datasets.length - 1)];
        activeId = (_a = next === null || next === void 0 ? void 0 : next.id) !== null && _a !== void 0 ? _a : null;
    }
    if (activeId) {
        setActive(activeId);
    }
    else {
        clearCanvas();
        els.scopeEmpty.style.display = "flex";
        renderReadouts(null);
        renderTable([]);
        els.sampleCaption.textContent = "No samples loaded";
        els.btnExport.disabled = true;
        els.activeCurveLabel.textContent = "";
        renderSidebar();
    }
}
function clearAll() {
    datasets = [];
    activeId = null;
    clearCanvas();
    els.scopeEmpty.style.display = "flex";
    renderReadouts(null);
    renderTable([]);
    els.sampleCaption.textContent = "No samples loaded";
    els.btnExport.disabled = true;
    els.activeCurveLabel.textContent = "";
    renderSidebar();
}
async function fetchOnce() {
    var _a;
    const url = els.deviceUrl.value.trim();
    if (!url) {
        showError("Enter the device address first.");
        return;
    }
    try {
        clearError();
        const data = await fetchFromDevice(url);
        const urlObj = (() => { try {
            return new URL(url);
        }
        catch {
            return null;
        } })();
        const path = (_a = urlObj === null || urlObj === void 0 ? void 0 : urlObj.pathname) !== null && _a !== void 0 ? _a : "";
        const label = `Device${path && path !== "/" ? " " + path : ""}`;
        addDataset(label, data);
        setStatus(isPolling ? "polling" : "connected", isPolling ? "Polling" : "Connected");
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Could not reach device";
        showError(message);
    }
}
function startPolling() {
    const seconds = Math.max(1, Number(els.pollInterval.value) || 5);
    isPolling = true;
    els.btnPoll.textContent = "Stop polling";
    setStatus("polling", "Polling");
    pollTimer = window.setInterval(() => {
        void fetchOnce();
    }, seconds * 1000);
}
function stopPolling() {
    isPolling = false;
    els.btnPoll.textContent = "Start polling";
    if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
    setStatus("connected", "Connected");
}
function exportCsv() {
    var _a;
    const data = activeSamples();
    const ds = datasets.find((d) => d.id === activeId);
    const header = "Voltage (V),Current (A),Power (W)\n";
    const body = data.map((s) => `${s.voltage},${s.current},${s.power}`).join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(_a = ds === null || ds === void 0 ? void 0 : ds.label) !== null && _a !== void 0 ? _a : "curve"}_IV.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
function generateDemoSamples() {
    const Iph = 3.55;
    const I0 = 3.2e-9;
    const n = 1.3;
    const Rs = 0.02;
    const Rsh = 200;
    const Vt = 0.02585;
    const solveI = (v, guess) => {
        let i = guess;
        for (let iter = 0; iter < 100; iter++) {
            const f = Iph - I0 * (Math.exp((v + i * Rs) / (n * Vt)) - 1) - (v + i * Rs) / Rsh - i;
            const df = -I0 * (Rs / (n * Vt)) * Math.exp((v + i * Rs) / (n * Vt)) - Rs / Rsh - 1;
            const next = i - f / df;
            if (Math.abs(next - i) < 1e-9) {
                i = next;
                break;
            }
            i = next;
        }
        return i;
    };
    const out = [];
    let guess = Iph;
    for (let v = 0; v <= 0.75; v += 0.0025) {
        const i = solveI(v, guess);
        if (i < -0.01)
            break;
        guess = i;
        out.push({ voltage: v, current: i, power: v * i });
    }
    return out;
}
function handleFiles(files) {
    Array.from(files).forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                clearError();
                const samples = parseCsv(reader.result);
                const label = file.name.replace(/\.csv$/i, "");
                addDataset(label, samples);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : "Failed to parse CSV";
                showError(`${file.name}: ${msg}`);
            }
        };
        reader.readAsText(file);
    });
}
function setupDragDrop() {
    const sidebar = document.querySelector(".csv-sidebar");
    if (!sidebar)
        return;
    sidebar.addEventListener("dragover", (e) => {
        e.preventDefault();
        sidebar.classList.add("drag-over");
    });
    sidebar.addEventListener("dragleave", () => sidebar.classList.remove("drag-over"));
    sidebar.addEventListener("drop", (e) => {
        var _a;
        e.preventDefault();
        sidebar.classList.remove("drag-over");
        const files = (_a = e.dataTransfer) === null || _a === void 0 ? void 0 : _a.files;
        if (files && files.length > 0)
            handleFiles(files);
    });
}
els.connForm.addEventListener("submit", (e) => {
    e.preventDefault();
    els.btnPoll.disabled = false;
    els.btnFetchOnce.disabled = false;
    void fetchOnce();
});
els.btnPoll.addEventListener("click", () => {
    if (isPolling)
        stopPolling();
    else
        startPolling();
});
els.btnFetchOnce.addEventListener("click", () => {
    void fetchOnce();
});
els.btnExport.addEventListener("click", exportCsv);
els.btnClearAll.addEventListener("click", clearAll);
els.btnDemo.addEventListener("click", () => {
    clearError();
    addDataset("Demo data", generateDemoSamples());
    setStatus("connected", "Demo data");
});
els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files && els.fileInput.files.length > 0) {
        handleFiles(els.fileInput.files);
        els.fileInput.value = "";
    }
});
setupDragDrop();
renderReadouts(null);
renderSidebar();
els.scopeEmpty.style.display = "flex";
