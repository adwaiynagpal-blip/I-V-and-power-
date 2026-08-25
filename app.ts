/// <reference lib="dom" />

/* =====================================================
   Types
===================================================== */

interface Sample {
    voltage: number;
    current: number;
    power: number;
}

interface CurveDataset {
    id: string;
    label: string;
    samples: Sample[];
}

interface CurveStats {
    isc: number;
    voc: number;
    vmpp: number;
    impp: number;
    pmpp: number;
    fillFactor: number;
}

/* =====================================================
   State
===================================================== */

let datasets: CurveDataset[] = [];
let activeId: string | null = null;
let pollTimer: number | null = null;
let isPolling = false;
let datasetCounter = 0;

function activeSamples(): Sample[] {
    return datasets.find((d) => d.id === activeId)?.samples ?? [];
}

function generateId(): string {
    return `ds-${++datasetCounter}`;
}

/* =====================================================
   DOM references
===================================================== */

const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el as T;
};

const els = {
    connForm: $<HTMLFormElement>("conn-form"),
    deviceUrl: $<HTMLInputElement>("device-url"),
    pollInterval: $<HTMLInputElement>("poll-interval"),
    btnConnect: $<HTMLButtonElement>("btn-connect"),
    btnPoll: $<HTMLButtonElement>("btn-poll"),
    btnFetchOnce: $<HTMLButtonElement>("btn-fetch-once"),
    btnExport: $<HTMLButtonElement>("btn-export"),
    btnDemo: $<HTMLButtonElement>("btn-demo"),
    btnClearAll: $<HTMLButtonElement>("btn-clear-all"),
    status: $<HTMLDivElement>("status"),
    statusText: document.querySelector<HTMLSpanElement>("#status .status-text")!,
    scopeEmpty: $<HTMLParagraphElement>("scope-empty"),
    sampleCaption: $<HTMLParagraphElement>("sample-caption"),
    errorBanner: $<HTMLParagraphElement>("error-banner"),
    rawCount: $<HTMLSpanElement>("raw-count"),
    tableBody: $<HTMLTableSectionElement>("data-table-body"),
    canvas: $<HTMLCanvasElement>("scope"),
    valIsc: $<HTMLSpanElement>("val-isc"),
    valVoc: $<HTMLSpanElement>("val-voc"),
    valPmpp: $<HTMLSpanElement>("val-pmpp"),
    valVmpp: $<HTMLSpanElement>("val-vmpp"),
    valImpp: $<HTMLSpanElement>("val-impp"),
    valFf: $<HTMLSpanElement>("val-ff"),
    csvList: $<HTMLUListElement>("csv-list"),
    fileInput: $<HTMLInputElement>("file-input"),
    csvEmptyHint: $<HTMLParagraphElement>("csv-empty-hint"),
    activeCurveLabel: $<HTMLSpanElement>("active-curve-label"),
};

const ctx = els.canvas.getContext("2d");
if (!ctx) throw new Error("Canvas 2D context unavailable");

/* =====================================================
   Status / error helpers
===================================================== */

type StatusState = "idle" | "connected" | "polling" | "error";

function setStatus(state: StatusState, text: string): void {
    els.status.dataset.state = state;
    els.statusText.textContent = text;
}

function showError(message: string): void {
    els.errorBanner.textContent = message;
    els.errorBanner.hidden = false;
    setStatus("error", "Error");
}

function clearError(): void {
    els.errorBanner.hidden = true;
    els.errorBanner.textContent = "";
}

/* =====================================================
   Fetching + parsing device data
===================================================== */

/**
 * Accepts a handful of reasonable ESP32 JSON shapes so this works
 * with whatever field names the firmware happens to send:
 *   [{ "voltage": 0.1, "current": 3.5 }, ...]
 *   [{ "v": 0.1, "i": 3.5 }, ...]
 *   [[0.1, 3.5], [0.2, 3.4], ...]
 *   { "samples": [ ...one of the above... ] }
 */
function parseSamples(raw: unknown): Sample[] {
    const list: unknown = Array.isArray(raw)
        ? raw
        : typeof raw === "object" && raw !== null && "samples" in raw
            ? (raw as { samples: unknown }).samples
            : null;

    if (!Array.isArray(list)) {
        throw new Error("Unexpected response shape: expected an array of samples");
    }

    const out: Sample[] = list.map((entry, index): Sample => {
        let v: number | undefined;
        let i: number | undefined;

        if (Array.isArray(entry)) {
            v = Number(entry[0]);
            i = Number(entry[1]);
        } else if (typeof entry === "object" && entry !== null) {
            const obj = entry as Record<string, unknown>;
            v = Number(obj.voltage ?? obj.v ?? obj.V);
            i = Number(obj.current ?? obj.i ?? obj.I);
        }

        if (v === undefined || i === undefined || Number.isNaN(v) || Number.isNaN(i)) {
            throw new Error(`Sample ${index} is missing a valid voltage/current`);
        }

        return { voltage: v, current: i, power: v * i };
    });

    out.sort((a, b) => a.voltage - b.voltage);
    return out;
}

async function fetchFromDevice(url: string): Promise<Sample[]> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);

    try {
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) {
            throw new Error(`Device responded with HTTP ${res.status}`);
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("text/csv") || url.toLowerCase().endsWith(".csv")) {
            const text = await res.text();
            return parseCsv(text);
        }
        const json: unknown = await res.json();
        return parseSamples(json);
    } finally {
        window.clearTimeout(timeout);
    }
}

/* =====================================================
   Curve statistics
===================================================== */

function computeStats(data: Sample[]): CurveStats | null {
    if (data.length < 2) return null;

    // Isc: current at (or nearest to) V = 0.
    const isc = data.reduce((best, s) =>
        Math.abs(s.voltage) < Math.abs(best.voltage) ? s : best
    ).current;

    // Voc: voltage where current crosses zero, linearly interpolated.
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

    // MPP: sample with maximum power.
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

/* =====================================================
   Rendering: readouts + table
===================================================== */

function fmt(n: number, digits = 3): string {
    return n.toFixed(digits);
}

function renderReadouts(stats: CurveStats | null): void {
    if (!stats) {
        [els.valIsc, els.valVoc, els.valPmpp, els.valVmpp, els.valImpp, els.valFf].forEach(
            (el) => (el.textContent = "—")
        );
        return;
    }
    els.valIsc.textContent = fmt(stats.isc);
    els.valVoc.textContent = fmt(stats.voc);
    els.valPmpp.textContent = fmt(stats.pmpp);
    els.valVmpp.textContent = fmt(stats.vmpp);
    els.valImpp.textContent = fmt(stats.impp);
    els.valFf.textContent = fmt(stats.fillFactor, 3);
}

function renderTable(data: Sample[]): void {
    els.rawCount.textContent = data.length ? `(${data.length})` : "";
    const rows = data
        .map(
            (s, idx) =>
                `<tr><td>${idx + 1}</td><td>${fmt(s.voltage, 4)}</td><td>${fmt(
                    s.current,
                    4
                )}</td><td>${fmt(s.power, 4)}</td></tr>`
        )
        .join("");
    els.tableBody.innerHTML = rows;
}

/* =====================================================
   Rendering: scope canvas
===================================================== */

const PAD = { top: 24, right: 56, bottom: 40, left: 56 };

function clearCanvas(): void {
    if (!ctx) return;
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
}

function drawGrid(maxV: number, maxI: number): void {
    if (!ctx) return;
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

    // Axis labels
    ctx.fillStyle = "#7c9188";
    ctx.font = "12px 'IBM Plex Mono', monospace";
    ctx.fillText("Voltage (V)", PAD.left + w / 2 - 30, els.canvas.height - 8);

    ctx.save();
    ctx.translate(14, PAD.top + h / 2 + 30);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Current (A)", 0, 0);
    ctx.restore();
}

function drawTrace(
    data: Sample[],
    valueOf: (s: Sample) => number,
    maxV: number,
    maxValue: number,
    color: string,
    glow: string
): void {
    if (!ctx || data.length === 0) return;
    const w = els.canvas.width - PAD.left - PAD.right;
    const h = els.canvas.height - PAD.top - PAD.bottom;

    const toX = (v: number) => PAD.left + (v / maxV) * w;
    const toY = (val: number) => PAD.top + h - (val / maxValue) * h;

    ctx.beginPath();
    data.forEach((s, idx) => {
        const x = toX(s.voltage);
        const y = toY(Math.max(0, valueOf(s)));
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function drawMarker(x: number, y: number, maxV: number, maxValue: number, label: string): void {
    if (!ctx) return;
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

function renderScope(data: Sample[], stats: CurveStats | null): void {
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

/* =====================================================
   CSV Parsing
===================================================== */

function parseCsv(text: string): Sample[] {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    if (lines.length === 0) throw new Error("CSV file is empty");

    // Skip header row if first cell is non-numeric
    const firstCells = lines[0].split(",");
    const firstIsNumeric = firstCells.every((c) => c.trim() !== "" && !isNaN(Number(c.trim())));
    const startRow = firstIsNumeric ? 0 : 1;

    const out: Sample[] = [];
    for (let i = startRow; i < lines.length; i++) {
        const cells = lines[i].split(",");
        if (cells.length < 2) continue;
        const v = Number(cells[0].trim());
        const iVal = Number(cells[1].trim());
        if (isNaN(v) || isNaN(iVal)) continue;
        out.push({ voltage: v, current: iVal, power: v * iVal });
    }

    if (out.length === 0) throw new Error("No valid data rows found in CSV");
    out.sort((a, b) => a.voltage - b.voltage);
    return out;
}

/* =====================================================
   Sidebar rendering
===================================================== */

function renderSidebar(): void {
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

/* =====================================================
   Orchestration
===================================================== */

function setActive(id: string): void {
    activeId = id;
    const ds = datasets.find((d) => d.id === id);
    const data = ds?.samples ?? [];
    const stats = computeStats(data);
    els.activeCurveLabel.textContent = ds?.label ?? "";
    renderReadouts(stats);
    renderTable(data);
    renderScope(data, stats);
    els.sampleCaption.textContent = data.length ? `${data.length} samples` : "No samples";
    els.btnExport.disabled = data.length === 0;
    renderSidebar();
}

function addDataset(label: string, samples: Sample[]): void {
    const ds: CurveDataset = { id: generateId(), label, samples };
    datasets.push(ds);
    setActive(ds.id);
}

function removeDataset(id: string): void {
    const idx = datasets.findIndex((d) => d.id === id);
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
        els.scopeEmpty.style.display = "flex";
        renderReadouts(null);
        renderTable([]);
        els.sampleCaption.textContent = "No samples loaded";
        els.btnExport.disabled = true;
        els.activeCurveLabel.textContent = "";
        renderSidebar();
    }
}

function clearAll(): void {
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

async function fetchOnce(): Promise<void> {
    const url = els.deviceUrl.value.trim();
    if (!url) {
        showError("Enter the device address first.");
        return;
    }
    try {
        clearError();
        const data = await fetchFromDevice(url);
        const urlObj = (() => { try { return new URL(url); } catch { return null; } })();
        const path = urlObj?.pathname ?? "";
        const label = `Device${path && path !== "/" ? " " + path : ""}`;
        addDataset(label, data);
        setStatus(isPolling ? "polling" : "connected", isPolling ? "Polling" : "Connected");
    } catch (err) {
        const message = err instanceof Error ? err.message : "Could not reach device";
        showError(message);
    }
}

function startPolling(): void {
    const seconds = Math.max(1, Number(els.pollInterval.value) || 5);
    isPolling = true;
    els.btnPoll.textContent = "Stop polling";
    setStatus("polling", "Polling");
    pollTimer = window.setInterval(() => {
        void fetchOnce();
    }, seconds * 1000);
}

function stopPolling(): void {
    isPolling = false;
    els.btnPoll.textContent = "Start polling";
    if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
    setStatus("connected", "Connected");
}

function exportCsv(): void {
    const data = activeSamples();
    const ds = datasets.find((d) => d.id === activeId);
    const header = "Voltage (V),Current (A),Power (W)\n";
    const body = data.map((s) => `${s.voltage},${s.current},${s.power}`).join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${ds?.label ?? "curve"}_IV.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

/** Single-diode model, used only for the "Load demo data" button. */
function generateDemoSamples(): Sample[] {
    const Iph = 3.55;
    const I0 = 3.2e-9;
    const n = 1.3;
    const Rs = 0.02;
    const Rsh = 200;
    const Vt = 0.02585;

    const solveI = (v: number, guess: number): number => {
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

    const out: Sample[] = [];
    let guess = Iph;
    for (let v = 0; v <= 0.75; v += 0.0025) {
        const i = solveI(v, guess);
        if (i < -0.01) break;
        guess = i;
        out.push({ voltage: v, current: i, power: v * i });
    }
    return out;
}

/* =====================================================
   File upload + drag-and-drop
===================================================== */

function handleFiles(files: FileList): void {
    Array.from(files).forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                clearError();
                const samples = parseCsv(reader.result as string);
                const label = file.name.replace(/\.csv$/i, "");
                addDataset(label, samples);
            } catch (err) {
                const msg = err instanceof Error ? err.message : "Failed to parse CSV";
                showError(`${file.name}: ${msg}`);
            }
        };
        reader.readAsText(file);
    });
}

function setupDragDrop(): void {
    const sidebar = document.querySelector<HTMLElement>(".csv-sidebar");
    if (!sidebar) return;

    sidebar.addEventListener("dragover", (e) => {
        e.preventDefault();
        sidebar.classList.add("drag-over");
    });
    sidebar.addEventListener("dragleave", () => sidebar.classList.remove("drag-over"));
    sidebar.addEventListener("drop", (e) => {
        e.preventDefault();
        sidebar.classList.remove("drag-over");
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) handleFiles(files);
    });
}

/* =====================================================
   Event wiring
===================================================== */

els.connForm.addEventListener("submit", (e: SubmitEvent) => {
    e.preventDefault();
    els.btnPoll.disabled = false;
    els.btnFetchOnce.disabled = false;
    void fetchOnce();
});

els.btnPoll.addEventListener("click", () => {
    if (isPolling) stopPolling();
    else startPolling();
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

/* =====================================================
   Initial state
===================================================== */

renderReadouts(null);
renderSidebar();
els.scopeEmpty.style.display = "flex";