// ============================================================
// USD Ladder Monitor v2 - 3-Bucket Portfolio Strategy
// ============================================================

// --- Constants ---
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const STORAGE_KEY = 'usdLadderMonitorV2';

const CORS_PROXIES = ['', 'https://api.allorigins.win/raw?url=', 'https://corsproxy.io/?url='];

const FRED_SERIES = {
  FFR:     { id: 'DFF',      label: 'FFR',          unit: '%', decimals: 2 },
  SOFR:    { id: 'SOFR',     label: 'SOFR',         unit: '%', decimals: 2 },
  US02Y:   { id: 'DGS2',     label: 'US 2Y',        unit: '%', decimals: 2 },
  USDJPY:  { id: 'DEXJPUS',  label: 'USD/JPY',      unit: '',  decimals: 2 },
  DXY:     { id: 'DTWEXBGS', label: 'DXY',          unit: '',  decimals: 1 },
  VIX:     { id: 'VIXCLS',   label: 'VIX',          unit: '',  decimals: 1 },
  CORECPI: { id: 'CPILFESL', label: 'Core CPI YoY', unit: '%', decimals: 1 },
};

const ETF_LIST = [
  { ticker: 'SGOV', name: '0-3M Treasury',   cat: 'bond',  color: '#3b82f6' },
  { ticker: 'SHV',  name: '0-1Y Treasury',   cat: 'bond',  color: '#06b6d4' },
  { ticker: 'BIL',  name: '1-3M T-Bill',     cat: 'bond',  color: '#6366f1' },
  { ticker: 'VGSH', name: '1-3Y Treasury',   cat: 'bond',  color: '#14b8a6' },
  { ticker: 'IEF',  name: '7-10Y Treasury',  cat: 'bond',  color: '#0ea5e9' },
  { ticker: 'VTI',  name: 'Total US Stock',  cat: 'equity', color: '#22c55e' },
  { ticker: 'SCHD', name: 'US Dividend',     cat: 'equity', color: '#84cc16' },
  { ticker: 'GLDM', name: 'Gold',            cat: 'commodity', color: '#eab308' },
  { ticker: 'IAU',  name: 'Gold (iShares)',   cat: 'commodity', color: '#ca8a04' },
  { ticker: 'XLE',  name: 'Energy/Oil',      cat: 'commodity', color: '#f97316' },
  { ticker: 'BTC',  name: 'Bitcoin',         cat: 'crypto', color: '#f59e0b' },
];

// Ladder offsets from base rate (relative method)
const LADDER_OFFSETS = [-5, -10, -15, -20, -25];
const LADDER_ALLOCS = [
  { pct: 20, alloc: 'MMF50/SGOV20/Gold10/BTC5/VTI15' },
  { pct: 20, alloc: 'MMF40/SGOV20/Gold10/BTC5/VTI25' },
  { pct: 20, alloc: 'MMF30/SGOV15/Gold10/BTC8/VTI37' },
  { pct: 10, alloc: 'MMF20/SGOV10/Gold10/BTC10/VTI50' },
  { pct: 10, alloc: 'MMF10/Gold10/BTC10/VTI70' },
];

// Bucket B target allocation
const BUCKET_B_ALLOC = [
  { name: 'USD MMF',       target: [20, 25], color: '#3b82f6' },
  { name: 'Short Bond (SGOV/BIL)', target: [15, 20], color: '#06b6d4' },
  { name: 'US Equity (VTI/SCHD)',  target: [15, 20], color: '#22c55e' },
  { name: 'Gold (GLDM/IAU)',       target: [10, 15], color: '#eab308' },
  { name: 'BTC',                    target: [5, 8],   color: '#f59e0b' },
  { name: 'Energy (XLE)',           target: [5, 5],   color: '#f97316' },
  { name: 'Cash Buffer',            target: [10, 12], color: '#94a3b8' },
];

// --- State ---
let state = loadState();
let timeSeriesChart = null;
let currentChartTab = 'rates';

function defaultState() {
  return {
    settings: { fredApiKey: '', ladderBaseRate: 159.6, dcaBudget: 5, autoRefreshHours: 0 },
    current: {},
    etfPrices: {},
    ladderDone: [],
    dcaThisMonth: 0,   // percentage deployed this month via DCA
    twistStartDate: null, // when twist condition started
    snapshots: [],
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) {}
  return defaultState();
}

function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('fredApiKey').value = state.settings.fredApiKey || '';
  document.getElementById('ladderBaseRate').value = state.settings.ladderBaseRate || 159.6;
  document.getElementById('dcaBudget').value = state.settings.dcaBudget || 5;
  document.getElementById('autoRefresh').value = state.settings.autoRefreshHours || 0;
  renderAll();
  setupAutoRefresh();
});

function renderAll() {
  renderAlertBanner();
  renderBucketOverview();
  renderMacroCards();
  setTimeout(addMacroCardTips, 100);
  renderStrategyMap();
  renderLadderSteps();
  renderRuleEngine();
  renderEtfCards();
  renderAllocationBars();
  renderHistory();
  initChart();
  updateLastUpdateDisplay();
}

// --- Settings ---
function toggleSettings() { document.getElementById('settingsPanel').classList.toggle('hidden'); }

function saveSettings() {
  state.settings.fredApiKey = document.getElementById('fredApiKey').value.trim();
  state.settings.ladderBaseRate = parseFloat(document.getElementById('ladderBaseRate').value) || 159.6;
  state.settings.dcaBudget = parseFloat(document.getElementById('dcaBudget').value) || 5;
  state.settings.autoRefreshHours = parseInt(document.getElementById('autoRefresh').value) || 0;
  saveState();
}

// --- Auto Refresh ---
let autoRefreshTimer = null;
let countdownTimer = null;
let nextRefreshTime = null;

function setupAutoRefresh() {
  // Clear existing timers
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

  const hours = state.settings.autoRefreshHours || 0;
  const nextEl = document.getElementById('nextUpdate');

  if (hours <= 0) {
    nextEl.classList.add('hidden');
    nextRefreshTime = null;
    return;
  }

  const intervalMs = hours * 60 * 60 * 1000;

  // Check if we should fetch immediately (last fetch was longer ago than interval)
  const lastFetch = state.current._lastFetch ? new Date(state.current._lastFetch).getTime() : 0;
  const elapsed = Date.now() - lastFetch;

  if (elapsed >= intervalMs && state.settings.fredApiKey) {
    // Due for refresh
    console.log('Auto-refresh: overdue, fetching now...');
    fetchAllData();
  }

  // Schedule next
  const timeUntilNext = elapsed >= intervalMs ? intervalMs : (intervalMs - elapsed);
  nextRefreshTime = Date.now() + timeUntilNext;

  autoRefreshTimer = setInterval(() => {
    console.log('Auto-refresh: fetching...');
    fetchAllData();
    nextRefreshTime = Date.now() + intervalMs;
  }, intervalMs);

  // If first fire is earlier than the interval, set a one-shot
  if (timeUntilNext < intervalMs) {
    setTimeout(() => {
      if (state.settings.autoRefreshHours > 0) {
        console.log('Auto-refresh: catch-up fetch');
        fetchAllData();
        nextRefreshTime = Date.now() + intervalMs;
      }
    }, timeUntilNext);
  }

  // Countdown display
  nextEl.classList.remove('hidden');
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 60000); // update every minute
}

function updateCountdown() {
  const el = document.getElementById('nextUpdate');
  if (!nextRefreshTime || !state.settings.autoRefreshHours) {
    el.classList.add('hidden');
    return;
  }
  const remaining = Math.max(0, nextRefreshTime - Date.now());
  const mins = Math.floor(remaining / 60000);
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  el.textContent = hrs > 0 ? `Next: ${hrs}h${m}m` : `Next: ${m}m`;
  el.classList.remove('hidden');
}

// --- Helpers ---
function getLadderSteps() {
  const base = state.settings.ladderBaseRate;
  return LADDER_OFFSETS.map((offset, i) => ({
    step: i, rate: +(base + offset).toFixed(1), pct: LADDER_ALLOCS[i].pct,
    label: `Step ${i} (${offset > 0 ? '+' : ''}${offset})`, alloc: LADDER_ALLOCS[i].alloc,
  }));
}

function getPhase(ffr, us2y) {
  if (ffr == null) return { id: '--', label: '--', desc: '', color: '#64748b' };
  if (ffr >= 4.0) return { id: 'P1', label: 'Phase 1: Pre-Cut', desc: 'MMF60% + SGOV20% + 株20%', color: '#f59e0b' };
  if (ffr >= 3.5) return { id: 'P2', label: 'Phase 2: First Cut', desc: 'MMF30% + SGOV20% + 新規資産30% + 株20%', color: '#3b82f6' };
  if (ffr < 3.5 && us2y != null && us2y < ffr) return { id: 'P3', label: 'Phase 3: Cutting', desc: 'SGOV→中期債切替。MMF25%+株増', color: '#8b5cf6' };
  return { id: 'P2H', label: 'Phase 2-Hold', desc: 'FFR<3.5だがUS2Y>FFR。デュレーション延伸保留', color: '#f97316' };
}

function isInterventionAlert(usdjpy) { return usdjpy != null && usdjpy > 158; }
function isShortScoutEnabled(usdjpy) { return usdjpy != null && usdjpy >= 160; }
function isTwistCondition(ffr, usdjpy) { return ffr != null && usdjpy != null && ffr < 4.0 && usdjpy > 155; }
function isEtfShiftReady(ffr, us2y) { return ffr != null && us2y != null && ffr < 3.5 && us2y < ffr; }

// --- FRED API ---
async function fetchWithCorsRetry(url) {
  let lastError;
  for (const proxy of CORS_PROXIES) {
    try {
      const target = proxy ? proxy + encodeURIComponent(url) : url;
      const res = await fetch(target);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { lastError = e; continue; }
  }
  throw lastError;
}

async function fetchFredSeries(seriesId, apiKey) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=30&observation_start=${start}&observation_end=${end}`;
  const data = await fetchWithCorsRetry(url);
  return data.observations || [];
}

async function fetchFredCpiYoY(seriesId, apiKey) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 420 * 86400000).toISOString().slice(0, 10);
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=14&observation_start=${start}&observation_end=${end}`;
  const data = await fetchWithCorsRetry(url);
  const obs = (data.observations || []).filter(o => o.value !== '.');
  if (obs.length >= 13) {
    return +((parseFloat(obs[0].value) - parseFloat(obs[12].value)) / parseFloat(obs[12].value) * 100).toFixed(1);
  }
  return null;
}

async function fetchAllData() {
  const apiKey = state.settings.fredApiKey;
  if (!apiKey) { alert('FRED API Key required. Open Settings.'); toggleSettings(); return; }

  document.getElementById('fetchSpinner').classList.remove('hidden');
  try {
    const results = {};
    await Promise.all(Object.entries(FRED_SERIES).map(async ([key, s]) => {
      try {
        if (key === 'CORECPI') {
          const v = await fetchFredCpiYoY(s.id, apiKey);
          if (v !== null) results[key] = v;
        } else {
          const obs = await fetchFredSeries(s.id, apiKey);
          const valid = obs.find(o => o.value !== '.');
          if (valid) results[key] = parseFloat(valid.value);
        }
      } catch (e) { console.warn(`Failed: ${key}`, e); }
    }));

    state.current = { ...state.current, ...results, _lastFetch: new Date().toISOString() };

    // Track twist condition duration
    if (isTwistCondition(state.current.FFR, state.current.USDJPY)) {
      if (!state.twistStartDate) state.twistStartDate = new Date().toISOString().slice(0, 10);
    } else {
      state.twistStartDate = null;
    }

    takeSnapshot();
    saveState();
    renderAll();
  } catch (e) {
    alert('Fetch failed: ' + e.message);
  } finally {
    document.getElementById('fetchSpinner').classList.add('hidden');
  }
}

function takeSnapshot() {
  const today = new Date().toISOString().slice(0, 10);
  const snap = { date: today, ...state.current, ...state.etfPrices };
  delete snap._lastFetch;
  const idx = state.snapshots.findIndex(s => s.date === today);
  if (idx >= 0) state.snapshots[idx] = snap; else state.snapshots.push(snap);
  if (state.snapshots.length > 1000) state.snapshots = state.snapshots.slice(-1000);
  saveState();
}

// ============================================================
// RENDER FUNCTIONS
// ============================================================

// --- Alert Banner ---
function renderAlertBanner() {
  const el = document.getElementById('alertBanner');
  const c = state.current;
  const alerts = [];

  if (isInterventionAlert(c.USDJPY)) {
    const shortOk = isShortScoutEnabled(c.USDJPY);
    alerts.push(`<div class="alert-banner flex items-center justify-between">
      <div><span class="text-sm font-bold">⚠ 介入警戒モード</span> <span class="text-xs ml-2">USD/JPY ${c.USDJPY?.toFixed(1)} > 158</span></div>
      <div class="text-xs">ロング上限: 200K${shortOk ? ' | ショート偵察200K解禁' : ''} | レンジ158-161</div>
    </div>`);
  }

  if (isTwistCondition(c.FFR, c.USDJPY)) {
    const months = state.twistStartDate ? Math.floor((Date.now() - new Date(state.twistStartDate).getTime()) / (30 * 86400000)) : 0;
    const isDcaOnly = months >= 3;
    alerts.push(`<div class="warn-banner flex items-center justify-between mt-2">
      <div><span class="text-sm font-bold">🔀 ねじれ継続</span> <span class="text-xs ml-2">FFR↓ + 円安 (${months}ヶ月目)</span></div>
      <div class="text-xs">${isDcaOnly ? '⛔ まとめ買い禁止。月次DCAのみ' : 'DCA推奨。3ヶ月継続でまとめ買い禁止'}</div>
    </div>`);
  }

  if (alerts.length > 0) { el.innerHTML = alerts.join(''); el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); }
}

// --- Bucket Overview ---
function renderBucketOverview() {
  const c = state.current;

  // Bucket A
  const aEl = document.getElementById('bucketAContent');
  const intervention = isInterventionAlert(c.USDJPY);
  const lotLimit = intervention ? '200K' : '300-500K';
  const mode = intervention ? 'INTERVENTION' : 'NORMAL';
  document.getElementById('bucketABadge').textContent = mode;
  document.getElementById('bucketABadge').className = `smap-badge ${intervention ? 'bg-red-900 text-red-400' : 'bg-amber-900 text-amber-300'}`;

  aEl.innerHTML = `
    <div class="flex justify-between text-xs"><span class="text-slate-400">Mode</span><span class="${intervention ? 'text-red-400' : 'text-amber-300'}">${intervention ? 'Range 158-161' : 'Normal'}</span></div>
    <div class="flex justify-between text-xs"><span class="text-slate-400">Long Limit</span><span>${lotLimit}</span></div>
    ${isShortScoutEnabled(c.USDJPY) ? '<div class="flex justify-between text-xs"><span class="text-slate-400">Short Scout</span><span class="text-green-400">200K Enabled</span></div>' : ''}
    <div class="mt-2 p-2 rounded bg-slate-800 text-xs text-slate-400">益の50%→B / 30%→再投資 / 20%→生活</div>
  `;

  // Bucket B
  const bEl = document.getElementById('bucketBContent');
  const phase = getPhase(c.FFR, c.US02Y);
  document.getElementById('bucketBBadge').textContent = phase.id;
  document.getElementById('bucketBBadge').style.color = phase.color;

  const steps = getLadderSteps();
  const doneCount = state.ladderDone.length;
  const totalDeployed = state.ladderDone.reduce((s, i) => s + (LADDER_ALLOCS[i]?.pct || 0), 0);

  bEl.innerHTML = `
    <div class="flex justify-between text-xs"><span class="text-slate-400">Phase</span><span style="color:${phase.color}">${phase.label}</span></div>
    <div class="flex justify-between text-xs"><span class="text-slate-400">Ladder</span><span>${doneCount}/${steps.length} Steps (${totalDeployed}%)</span></div>
    <div class="flex justify-between text-xs"><span class="text-slate-400">Base Rate</span><span>${state.settings.ladderBaseRate}</span></div>
    <div class="flex justify-between text-xs"><span class="text-slate-400">Next Step</span><span>${steps.find(s => !state.ladderDone.includes(s.step))?.rate || 'All done'}</span></div>
    <div class="flex justify-between text-xs"><span class="text-slate-400">DCA</span><span>${state.dcaThisMonth}% / ${state.settings.dcaBudget}% target</span></div>
  `;
}

// --- Macro Cards ---
function renderMacroCards() {
  const container = document.getElementById('macroCards');
  container.innerHTML = '';
  Object.entries(FRED_SERIES).forEach(([key, series]) => {
    const value = state.current[key];
    const formatted = value != null ? value.toFixed(series.decimals) + series.unit : '--';
    const trend = getTrend(key);
    const trendClass = trend > 0 ? 'indicator-up' : trend < 0 ? 'indicator-down' : 'indicator-neutral';
    const trendArrow = trend > 0 ? '&#9650;' : trend < 0 ? '&#9660;' : '&#9644;';
    const card = document.createElement('div');
    card.className = 'card p-3';
    card.innerHTML = `
      <div class="text-[10px] text-slate-400 truncate">${series.label}</div>
      <div class="text-lg font-bold text-white mt-1">${formatted}</div>
      <div class="text-xs ${trendClass} mt-1">${trendArrow} ${trend !== null ? Math.abs(trend).toFixed(2) : ''}</div>
      <div class="sparkline-container mt-1"><canvas id="spark-${key}"></canvas></div>
    `;
    container.appendChild(card);
    setTimeout(() => drawSparkline(key), 50);
  });
}

function getTrend(key) {
  const snaps = state.snapshots;
  if (snaps.length < 2) return null;
  const rev = [...snaps].reverse();
  const latest = rev.find(s => s[key] != null);
  const prev = rev.slice(1).find(s => s[key] != null);
  if (!latest || !prev) return null;
  return latest[key] - prev[key];
}

function drawSparkline(key) {
  const canvas = document.getElementById(`spark-${key}`);
  if (!canvas) return;
  const data = state.snapshots.filter(s => s[key] != null).slice(-30).map(s => ({ x: s.date, y: s[key] }));
  if (data.length < 2) return;
  new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: data.map(d => d.x), datasets: [{ data: data.map(d => d.y), borderColor: '#3b82f6', borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, animation: false }
  });
}

// --- ETF Cards ---
function renderEtfCards() {
  const container = document.getElementById('etfCards');
  container.innerHTML = '';
  const catBorder = { bond: 'border-l-blue-500', equity: 'border-l-green-500', commodity: 'border-l-yellow-500', crypto: 'border-l-orange-500' };
  ETF_LIST.forEach(etf => {
    const price = state.etfPrices[etf.ticker];
    const card = document.createElement('div');
    card.className = `card p-2 border-l-4 ${catBorder[etf.cat] || ''}`;
    card.innerHTML = `
      <div class="text-[10px] text-slate-400 truncate">${etf.name}</div>
      <div class="text-xs font-bold text-white">${etf.ticker}</div>
      <div class="text-sm font-semibold mt-1">${price != null ? '$' + price.toFixed(2) : '--'}</div>
    `;
    container.appendChild(card);
  });
}

// --- Allocation Bars ---
function renderAllocationBars() {
  const container = document.getElementById('allocationBars');
  container.innerHTML = BUCKET_B_ALLOC.map(a => `
    <div class="flex items-center gap-3">
      <div class="w-36 text-xs text-slate-400 truncate">${a.name}</div>
      <div class="flex-1 progress-track">
        <div class="progress-fill" style="width: ${(a.target[0] + a.target[1]) / 2}%; background: ${a.color}; opacity: 0.7;"></div>
      </div>
      <div class="w-20 text-xs text-right text-slate-300">${a.target[0]}-${a.target[1]}%</div>
    </div>
  `).join('');
}

// --- Ladder Steps ---
function renderLadderSteps() {
  const container = document.getElementById('ladderSteps');
  container.innerHTML = '';
  const c = state.current;
  const steps = getLadderSteps();
  const phase = getPhase(c.FFR, c.US02Y);

  document.getElementById('phaseLabel').textContent = phase.label;
  document.getElementById('phaseLabel').style.color = phase.color;
  document.getElementById('phaseDesc').textContent = phase.desc;

  let activeStep = -1;
  if (c.USDJPY != null) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (c.USDJPY <= steps[i].rate && !state.ladderDone.includes(i)) { activeStep = i; break; }
    }
  }

  steps.forEach(s => {
    const isDone = state.ladderDone.includes(s.step);
    const isActive = s.step === activeStep;
    const cls = isDone ? 'step-done' : isActive ? 'step-active' : 'step-pending';
    const row = document.createElement('div');
    row.className = `flex items-center gap-2 p-2 rounded-lg border cursor-pointer text-sm ${cls}`;
    row.onclick = () => { toggleStepDone(s.step); };
    row.innerHTML = `
      <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center text-[10px] flex-shrink-0">${isDone ? '✓' : s.step}</div>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-medium truncate">${s.label} → ${s.rate}</div>
        <div class="text-[10px] text-slate-400">${s.pct}% | ${s.alloc}</div>
      </div>
    `;
    container.appendChild(row);
  });

  // DCA tracker
  const dcaFill = document.getElementById('dcaFill');
  const dcaPct = document.getElementById('dcaPct');
  const target = state.settings.dcaBudget || 5;
  const pct = Math.min(100, (state.dcaThisMonth / target) * 100);
  dcaFill.style.width = pct + '%';
  dcaPct.textContent = `${state.dcaThisMonth}/${target}%`;

  // Recommended action
  const actionEl = document.getElementById('recommendedAction');
  const actions = [];
  if (c.USDJPY == null) { actionEl.textContent = 'Fetch data first'; return; }

  if (activeStep >= 0) {
    actions.push(`Step ${activeStep} ready (${steps[activeStep].rate}円). ${steps[activeStep].pct}% deploy → ${steps[activeStep].alloc}`);
  }
  if (c.VIX > 30) actions.push('🛑 VIX>30: HALT all new investments');

  const twistMonths = state.twistStartDate ? Math.floor((Date.now() - new Date(state.twistStartDate).getTime()) / (30 * 86400000)) : 0;
  if (twistMonths >= 3) actions.push('ねじれ3M超: DCAのみ。まとめ買い禁止');
  else if (isTwistCondition(c.FFR, c.USDJPY)) actions.push('ねじれ進行中: DCA推奨');

  if (actions.length === 0) actions.push('No immediate action. Continue monitoring.');
  actionEl.textContent = actions.join(' | ');
}

function toggleStepDone(step) {
  const idx = state.ladderDone.indexOf(step);
  if (idx >= 0) state.ladderDone.splice(idx, 1); else state.ladderDone.push(step);
  saveState(); renderLadderSteps(); renderBucketOverview();
}

// --- Rule Engine ---
function renderRuleEngine() {
  const container = document.getElementById('ruleChecks');
  const c = state.current;
  const twistMonths = state.twistStartDate ? Math.floor((Date.now() - new Date(state.twistStartDate).getTime()) / (30 * 86400000)) : 0;

  const rules = [
    { name: 'VIX Stress', desc: 'VIX > 30 → MMF床+5%、新規投資停止', check: () => {
      if (c.VIX == null) return { s: 'neutral', t: 'No data' };
      if (c.VIX > 30) return { s: 'red', t: `VIX=${c.VIX.toFixed(1)} HALT` };
      if (c.VIX > 25) return { s: 'yellow', t: `VIX=${c.VIX.toFixed(1)} 警戒` };
      return { s: 'green', t: `VIX=${c.VIX.toFixed(1)} OK` };
    }},
    { name: 'Intervention Alert', desc: 'USD/JPY > 158 → ロング200K制限', check: () => {
      if (c.USDJPY == null) return { s: 'neutral', t: 'No data' };
      if (c.USDJPY >= 160) return { s: 'red', t: `${c.USDJPY.toFixed(1)}円 ショート偵察200K解禁` };
      if (c.USDJPY > 158) return { s: 'yellow', t: `${c.USDJPY.toFixed(1)}円 介入警戒。ロング200K上限` };
      return { s: 'green', t: `${c.USDJPY.toFixed(1)}円 通常モード` };
    }},
    { name: 'ETF Shift (Revised)', desc: 'FFR < 3.5% AND US2Y < FFR → デュレーション延伸OK', check: () => {
      if (c.FFR == null || c.US02Y == null) return { s: 'neutral', t: 'No data' };
      if (isEtfShiftReady(c.FFR, c.US02Y)) return { s: 'green', t: `FFR=${c.FFR.toFixed(2)}% US2Y=${c.US02Y.toFixed(2)}% → SGOV→中期債切替OK` };
      if (c.FFR < 3.5) return { s: 'yellow', t: `FFR<3.5%だがUS2Y(${c.US02Y.toFixed(2)}%)>FFR。デュレーション延伸保留` };
      if (c.FFR < 4.0) return { s: 'blue', t: `FFR=${c.FFR.toFixed(2)}% 閾値3.5%に接近中` };
      return { s: 'green', t: `FFR=${c.FFR.toFixed(2)}% MMF利回り良好` };
    }},
    { name: 'Twist Monitor', desc: 'FFR↓ + USD/JPY>155 が3ヶ月 → DCAのみ', check: () => {
      if (!isTwistCondition(c.FFR, c.USDJPY)) return { s: 'green', t: 'ねじれなし or 条件不成立' };
      if (twistMonths >= 3) return { s: 'red', t: `${twistMonths}ヶ月継続 ⛔ まとめ買い禁止。DCAのみ` };
      return { s: 'yellow', t: `${twistMonths}ヶ月目。3ヶ月で制限発動` };
    }},
    { name: 'Rate Cut Signal', desc: 'FFR - US2Y スプレッドで利下げ織込み判定', check: () => {
      if (c.FFR == null || c.US02Y == null) return { s: 'neutral', t: 'No data' };
      const spread = c.FFR - c.US02Y;
      if (spread > 0.5) return { s: 'red', t: `Spread=${spread.toFixed(2)}% 強い利下げシグナル` };
      if (spread > 0.2) return { s: 'yellow', t: `Spread=${spread.toFixed(2)}% 中程度の利下げ期待` };
      if (spread < -0.1) return { s: 'blue', t: `Spread=${spread.toFixed(2)}% US2Y>FFR: 利下げ停止/再利上げ織込み` };
      return { s: 'green', t: `Spread=${spread.toFixed(2)}% 安定` };
    }},
    { name: 'Currency Range', desc: '為替±10円で臨時レビュー', check: () => {
      if (c.USDJPY == null) return { s: 'neutral', t: 'No data' };
      const base = state.settings.ladderBaseRate;
      if (Math.abs(c.USDJPY - base) >= 10) return { s: 'red', t: `Base(${base})から${(c.USDJPY - base).toFixed(1)}円乖離 → 臨時レビュー` };
      if (Math.abs(c.USDJPY - base) >= 7) return { s: 'yellow', t: `Base(${base})から${(c.USDJPY - base).toFixed(1)}円乖離` };
      return { s: 'green', t: `Base(${base})近傍` };
    }},
    { name: 'Inflation Check', desc: 'Core CPI > FFR+1% → 金/REIT/配当株へ分散', check: () => {
      if (c.CORECPI == null) return { s: 'neutral', t: 'No data' };
      const th = (c.FFR || 4.0) + 1.0;
      if (c.CORECPI > th) return { s: 'red', t: `CPI ${c.CORECPI}% > FFR+1%(${th.toFixed(1)}%) 円資産を金/REITへ` };
      return { s: 'green', t: `CPI ${c.CORECPI}% OK` };
    }},
    { name: 'Ladder Trigger', desc: 'USD/JPYが相対値Stepに到達', check: () => {
      if (c.USDJPY == null) return { s: 'neutral', t: 'No data' };
      const steps = getLadderSteps();
      for (const s of steps) {
        if (c.USDJPY <= s.rate && !state.ladderDone.includes(s.step)) {
          return { s: 'yellow', t: `Step ${s.step} ready (${s.rate}円). ${s.pct}% → ${s.alloc}` };
        }
      }
      const next = steps.find(s => !state.ladderDone.includes(s.step));
      if (next) return { s: 'green', t: `Next: ${next.rate}円 (あと${(c.USDJPY - next.rate).toFixed(1)}円)` };
      return { s: 'green', t: 'All steps completed' };
    }},
  ];

  const statusCls = { green: 'status-green', yellow: 'status-yellow', red: 'status-red', blue: 'status-blue', neutral: 'bg-slate-700 text-slate-400' };
  const statusLabel = { green: 'OK', yellow: 'WARN', red: 'ALERT', blue: 'INFO', neutral: 'N/A' };

  container.innerHTML = rules.map(r => {
    const res = r.check();
    return `<div class="flex items-start gap-3 p-2.5 rounded-lg bg-slate-800/40">
      <div class="px-2.5 py-1 rounded text-xs font-bold whitespace-nowrap mt-0.5 ${statusCls[res.s]}">${statusLabel[res.s]}</div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-white">${r.name}</div>
        <div class="text-xs text-slate-500 mt-0.5">${r.desc}</div>
        <div class="text-sm mt-1 font-medium">${res.t}</div>
      </div>
    </div>`;
  }).join('');
}

// --- Strategy Map ---
function renderStrategyMap() {
  renderIndicatorFlow();
  renderPhaseArc();
  renderLadderGauge();
}

function renderIndicatorFlow() {
  const el = document.getElementById('strategyFlow');
  if (!el) return;
  const c = state.current;
  const hasData = c.FFR != null;
  const mmfActive = hasData && c.FFR >= 3.5;
  const etfActive = hasData && !mmfActive && c.US02Y != null && c.US02Y < c.FFR;
  const holdMode = hasData && c.FFR < 3.5 && c.US02Y != null && c.US02Y >= c.FFR;

  el.innerHTML = '';

  // FRB
  el.appendChild(makeNode('🏛', 'FRB', c.FFR != null ? c.FFR.toFixed(2) + '%' : '--', '#f59e0b', '#451a03', hasData));
  el.appendChild(makeArrow(hasData, ''));
  // SOFR
  el.appendChild(makeNode('📊', 'SOFR', c.SOFR != null ? c.SOFR.toFixed(2) + '%' : '--', '#3b82f6', '#172554', hasData));

  // Branch
  const branch = document.createElement('div');
  branch.className = 'w-full flex items-start mt-0';

  // Left: MMF
  const left = document.createElement('div');
  left.className = 'flex-1 flex flex-col items-center';
  left.appendChild(makeArrow(mmfActive, ''));
  left.appendChild(makeNode('💰', 'MMF', c.SOFR != null ? '≈' + c.SOFR.toFixed(1) + '%' : '--', '#4ade80', '#052e16', mmfActive,
    mmfActive ? ['EARNING', 'bg-green-900 text-green-400'] : null));

  // Right: US02Y → ETF
  const right = document.createElement('div');
  right.className = 'flex-1 flex flex-col items-center';
  right.appendChild(makeArrow(etfActive || holdMode, ''));
  right.appendChild(makeNode('📉', 'US 2Y', c.US02Y != null ? c.US02Y.toFixed(2) + '%' : '--', '#06b6d4', '#083344', etfActive || holdMode,
    holdMode ? ['HOLD', 'bg-orange-900 text-orange-400'] : etfActive ? ['SHIFT', 'bg-purple-900 text-purple-400'] : null));
  right.appendChild(makeArrow(etfActive, ''));
  right.appendChild(makeNode('📈', 'Bond ETF', 'SGOV/SHV', '#8b5cf6', '#2e1065', etfActive,
    etfActive ? ['GO', 'bg-purple-900 text-purple-400'] : null));

  const mid = document.createElement('div');
  mid.className = 'flex items-center pt-6';
  mid.innerHTML = '<div class="text-[10px] text-slate-600 px-1">OR</div>';

  branch.appendChild(left);
  branch.appendChild(mid);
  branch.appendChild(right);
  el.appendChild(branch);

  // New assets row
  el.appendChild(makeArrow(hasData, ''));
  const newRow = document.createElement('div');
  newRow.className = 'w-full grid grid-cols-3 gap-2';
  newRow.appendChild(makeSmallNode('🥇', 'Gold', '#eab308', hasData));
  newRow.appendChild(makeSmallNode('₿', 'BTC', '#f59e0b', hasData));
  newRow.appendChild(makeSmallNode('🛢', 'XLE', '#f97316', hasData));
  el.appendChild(newRow);
}

function makeNode(icon, title, value, color, bg, active, badge) {
  const el = document.createElement('div');
  el.className = `smap-node w-full ${active ? 'active' : ''}`;
  el.style.cssText = `background:${bg}; border:2px solid ${active ? color : '#334155'};`;
  el.innerHTML = `<div class="flex items-center justify-between">
    <div class="text-xs font-bold" style="color:${active ? color : '#64748b'}">${icon} ${title}</div>
    <div class="text-sm font-bold" style="color:${active ? '#fff' : '#64748b'}">${value}</div>
  </div>${badge ? `<div class="mt-1 text-right"><span class="smap-badge ${badge[1]}">${badge[0]}</span></div>` : ''}`;
  return el;
}

function makeSmallNode(icon, title, color, active) {
  const el = document.createElement('div');
  el.className = `smap-node text-center ${active ? 'active' : ''}`;
  el.style.cssText = `background:#1a1a2e; border:1px solid ${active ? color : '#334155'}; padding:6px;`;
  el.innerHTML = `<div class="text-base">${icon}</div><div class="text-[10px] font-bold" style="color:${color}">${title}</div>`;
  return el;
}

function makeArrow(active, label) {
  const el = document.createElement('div');
  el.className = 'flex flex-col items-center';
  el.innerHTML = `<div class="smap-flow-line ${active ? 'active' : ''}" style="height:14px;"></div>
    <div class="smap-arrow ${active ? 'active' : ''}">▼</div>
    <div class="smap-flow-line ${active ? 'active' : ''}" style="height:6px;"></div>`;
  return el;
}

// --- Phase Arc ---
function renderPhaseArc() {
  const svg = document.getElementById('phaseArc');
  const labelEl = document.getElementById('phaseArcLabel');
  const actionEl = document.getElementById('phaseArcAction');
  if (!svg) return;
  const c = state.current;
  const ffr = c.FFR;

  const cx = 160, cy = 170, r = 130;
  const phases = [
    { label: 'Hike',     range: [5.0, 6.0], color: '#ef4444', action: 'MMF全力' },
    { label: 'Peak',     range: [4.0, 5.0], color: '#f59e0b', action: 'MMF維持+ETF構築' },
    { label: '1st Cut',  range: [3.5, 4.0], color: '#3b82f6', action: 'MMF→ETFシフト' },
    { label: 'Cutting',  range: [2.5, 3.5], color: '#8b5cf6', action: 'ETF拡大(US2Y条件付)' },
    { label: 'Low',      range: [0, 2.5],   color: '#10b981', action: 'ETF利確→株シフト' },
  ];

  let activeIdx = -1;
  if (ffr != null) {
    for (let i = 0; i < phases.length; i++) {
      if (ffr >= phases[i].range[0] && ffr < phases[i].range[1]) { activeIdx = i; break; }
    }
    if (activeIdx === -1 && ffr >= 6) activeIdx = 0;
  }

  const totalAngle = Math.PI;
  const segAngle = totalAngle / phases.length;
  let svg_c = '';

  phases.forEach((p, i) => {
    const s = Math.PI + i * segAngle + 0.03;
    const e = Math.PI + (i + 1) * segAngle - 0.03;
    const x1 = cx + r * Math.cos(s), y1 = cy + r * Math.sin(s);
    const x2 = cx + r * Math.cos(e), y2 = cy + r * Math.sin(e);
    const dim = activeIdx >= 0 && i !== activeIdx ? 'dimmed' : '';
    svg_c += `<path class="phase-arc-segment ${dim}" d="M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}" fill="none" stroke="${p.color}" stroke-width="${i === activeIdx ? 18 : 10}" stroke-linecap="round"/>`;
    const ma = Math.PI + (i + 0.5) * segAngle;
    const lx = cx + (r + 24) * Math.cos(ma), ly = cy + (r + 24) * Math.sin(ma);
    svg_c += `<text x="${lx}" y="${ly}" fill="${i === activeIdx ? p.color : '#64748b'}" font-size="11" text-anchor="middle" font-weight="${i === activeIdx ? 'bold' : 'normal'}">${p.label}</text>`;
    // Range label
    const rlx = cx + (r + 36) * Math.cos(ma), rly = cy + (r + 36) * Math.sin(ma);
    svg_c += `<text x="${rlx}" y="${rly}" fill="${i === activeIdx ? p.color : '#475569'}" font-size="8" text-anchor="middle" opacity="0.7">${p.range[0]}-${p.range[1]}%</text>`;
  });

  if (ffr != null) {
    const clamped = Math.max(0, Math.min(6, ffr));
    const angle = Math.PI + (1 - clamped / 6) * totalAngle;
    const nx = cx + (r - 35) * Math.cos(angle), ny = cy + (r - 35) * Math.sin(angle);
    svg_c += `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="white" stroke-width="3" stroke-linecap="round"/>`;
    svg_c += `<circle cx="${cx}" cy="${cy}" r="6" fill="white"/>`;
    svg_c += `<text x="${cx}" y="${cy + 24}" fill="white" font-size="20" text-anchor="middle" font-weight="bold">${ffr.toFixed(2)}%</text>`;
  }
  svg.innerHTML = svg_c;

  if (activeIdx >= 0) {
    // Check for Phase 2-Hold
    const phase = getPhase(ffr, c.US02Y);
    labelEl.innerHTML = `<div class="text-base font-bold" style="color:${phase.color}">${phase.label}</div>`;
    actionEl.innerHTML = `<span class="font-medium" style="color:${phase.color}">${phase.desc}</span>`;
  } else {
    labelEl.innerHTML = '<div class="text-base text-slate-500">--</div>';
    actionEl.textContent = '--';
  }
}

// --- Ladder Gauge ---
function renderLadderGauge() {
  const container = document.getElementById('ladderGauge');
  const info = document.getElementById('ladderGaugeInfo');
  if (!container) return;
  const c = state.current;
  const usdjpy = c.USDJPY;
  const steps = getLadderSteps();

  const allRates = steps.map(s => s.rate);
  const gaugeMin = Math.min(...allRates) - 5;
  const gaugeMax = Math.max(usdjpy || 165, state.settings.ladderBaseRate + 5);
  const pct = v => Math.max(0, Math.min(100, ((v - gaugeMin) / (gaugeMax - gaugeMin)) * 100));

  const stepColors = ['#4ade80', '#22d3ee', '#3b82f6', '#8b5cf6', '#a855f7'];
  let h = `<div class="relative">
    <div class="h-3 rounded-full" style="background: linear-gradient(to right, #166534, #854d0e, #991b1b);"></div>`;

  steps.forEach((s, i) => {
    const pos = pct(s.rate);
    const done = state.ladderDone.includes(s.step);
    h += `<div class="absolute" style="left:${pos}%;top:0">
      <div style="position:absolute;left:-1px;top:-3px;width:3px;height:20px;background:${stepColors[i]};border-radius:2px;opacity:${done ? 1 : 0.6}"></div>
      <div style="position:absolute;left:50%;top:24px;transform:translateX(-50%);font-size:9px;color:${stepColors[i]};white-space:nowrap;font-weight:600">${s.rate}</div>
      <div style="position:absolute;left:50%;top:35px;transform:translateX(-50%);font-size:8px;color:#64748b">S${s.step}${done ? '✓' : ''}</div>
    </div>`;
  });

  // Base rate marker
  const basePos = pct(state.settings.ladderBaseRate);
  h += `<div style="position:absolute;left:${basePos}%;top:-3px">
    <div style="position:absolute;left:-1px;top:0;width:3px;height:20px;background:#f59e0b;border-radius:2px;opacity:0.5"></div>
    <div style="position:absolute;left:50%;top:24px;transform:translateX(-50%);font-size:8px;color:#f59e0b;white-space:nowrap">Base</div>
  </div>`;

  if (usdjpy != null) {
    const pos = pct(usdjpy);
    h += `<div style="position:absolute;left:${pos}%;top:-18px;transform:translateX(-50%);z-index:10">
      <div style="font-size:11px;font-weight:bold;color:white;text-align:center;background:#0f172a;padding:1px 5px;border-radius:4px;border:1px solid #e2e8f0">${usdjpy.toFixed(1)}</div>
      <div style="text-align:center;font-size:12px;line-height:1;margin-top:-2px">▼</div>
    </div>`;
  }

  h += `</div><div class="flex justify-between mt-10 text-[9px] text-slate-500"><span>← 円高</span><span>円安 →</span></div>`;
  container.innerHTML = h;

  // Info
  if (!info) return;
  let infoH = '';
  if (usdjpy != null) {
    const next = steps.find(s => !state.ladderDone.includes(s.step));
    if (next) {
      const diff = usdjpy - next.rate;
      infoH += `<div class="flex items-center justify-between p-2 rounded-lg bg-slate-800">
        <span class="text-[10px] text-slate-400">Next: Step ${next.step} (${next.rate})</span>
        <span class="text-[10px] font-bold ${diff > 0 ? 'text-yellow-400' : 'text-green-400'}">${diff > 0 ? `あと${diff.toFixed(1)}円` : '✅ 到達'}</span>
      </div>`;
    }
    const doneCount = state.ladderDone.length;
    const totalPct = state.ladderDone.reduce((s, i) => s + (LADDER_ALLOCS[i]?.pct || 0), 0);
    infoH += `<div class="flex items-center justify-between p-2 rounded-lg bg-slate-800">
      <span class="text-[10px] text-slate-400">Progress</span>
      <span class="text-[10px] font-bold">${doneCount}/${steps.length} (${totalPct}% deployed)</span>
    </div>`;
  }
  info.innerHTML = infoH;
}

// --- Charts ---
function initChart() {
  const canvas = document.getElementById('timeSeriesChart');
  if (!canvas) return;
  if (timeSeriesChart) { timeSeriesChart.destroy(); timeSeriesChart = null; }
  timeSeriesChart = new Chart(canvas.getContext('2d'), {
    type: 'line', data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10 } } }, tooltip: { backgroundColor: '#1e293b', titleColor: '#e2e8f0', bodyColor: '#e2e8f0', borderColor: '#475569', borderWidth: 1 } },
      scales: { x: { type: 'time', time: { unit: 'day', displayFormats: { day: 'MM/dd' } }, ticks: { color: '#64748b', maxTicksLimit: 15 }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } } },
      animation: false,
    }
  });
  updateChart();
}

const CHART_CONFIGS = {
  rates: { keys: ['FFR', 'SOFR', 'US02Y'], colors: ['#f59e0b', '#3b82f6', '#10b981'], labels: ['FFR', 'SOFR', 'US 2Y'] },
  forex: { keys: ['USDJPY', 'DXY'], colors: ['#f43f5e', '#8b5cf6'], labels: ['USD/JPY', 'DXY'] },
  etf: { keys: ['SGOV', 'SHV', 'GLDM', 'BTC', 'VTI', 'XLE'], colors: ['#3b82f6', '#06b6d4', '#eab308', '#f59e0b', '#22c55e', '#f97316'], labels: ['SGOV', 'SHV', 'Gold', 'BTC', 'VTI', 'XLE'] },
  risk: { keys: ['VIX', 'CORECPI'], colors: ['#ef4444', '#f59e0b'], labels: ['VIX', 'Core CPI'] },
};

function switchChart(tab) {
  currentChartTab = tab;
  document.querySelectorAll('#chartTabs button').forEach(b => b.className = b.dataset.tab === tab ? 'pb-1 tab-active text-sm' : 'pb-1 tab-inactive text-sm');
  updateChart();
}

function updateChart() {
  if (!timeSeriesChart) return;
  const cfg = CHART_CONFIGS[currentChartTab];
  if (!cfg) return;
  timeSeriesChart.data.datasets = cfg.keys.map((k, i) => ({
    label: cfg.labels[i],
    data: state.snapshots.filter(s => s[k] != null).map(s => ({ x: s.date, y: s[k] })),
    borderColor: cfg.colors[i], backgroundColor: cfg.colors[i] + '20', borderWidth: 2, pointRadius: 2, tension: 0.3, fill: false,
  }));
  timeSeriesChart.update();
}

// --- History ---
function renderHistory() {
  const allKeys = ['date', ...Object.keys(FRED_SERIES), ...ETF_LIST.map(e => e.ticker)];
  document.getElementById('historyHeader').innerHTML = allKeys.map(k => `<th class="px-2 py-1.5 text-left text-[10px]">${k}</th>`).join('');
  const recent = [...state.snapshots].reverse().slice(0, 50);
  document.getElementById('historyBody').innerHTML = recent.map(snap =>
    '<tr class="border-b border-slate-800">' + allKeys.map(k => {
      const v = snap[k];
      return `<td class="px-2 py-1 text-[10px]">${v != null ? (typeof v === 'number' ? v.toFixed(2) : v) : ''}</td>`;
    }).join('') + '</tr>'
  ).join('');
}

// --- ETF Input Modal ---
function openEtfInput() {
  document.getElementById('etfInputs').innerHTML = ETF_LIST.map(e => `
    <div class="flex items-center gap-2">
      <label class="w-14 text-xs font-medium">${e.ticker}</label>
      <input type="number" step="0.01" id="etf-in-${e.ticker}" value="${state.etfPrices[e.ticker] || ''}" placeholder="Price" class="flex-1 text-sm">
    </div>
  `).join('');
  document.getElementById('etfModal').classList.remove('hidden');
}
function closeEtfInput() { document.getElementById('etfModal').classList.add('hidden'); }
function saveEtfPrices() {
  ETF_LIST.forEach(e => {
    const v = parseFloat(document.getElementById(`etf-in-${e.ticker}`).value);
    if (!isNaN(v)) state.etfPrices[e.ticker] = v;
  });
  takeSnapshot(); saveState(); renderEtfCards(); renderHistory(); updateChart(); closeEtfInput();
}

// --- Export/Import ---
function exportData() {
  if (!state.snapshots.length) { alert('No data'); return; }
  const keys = new Set(); state.snapshots.forEach(s => Object.keys(s).forEach(k => keys.add(k)));
  const cols = ['date', ...[...keys].filter(k => k !== 'date').sort()];
  const csv = [cols.join(','), ...state.snapshots.map(s => cols.map(k => s[k] ?? '').join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `usd-ladder-v2-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function importData(event) {
  const f = event.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    const lines = e.target.result.split('\n').filter(l => l.trim());
    if (lines.length < 2) return;
    const keys = lines[0].split(',').map(k => k.trim());
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',');
      const snap = {};
      keys.forEach((k, j) => {
        const v = vals[j]?.trim();
        if (k === 'date') snap.date = v;
        else if (v && !isNaN(parseFloat(v))) snap[k] = parseFloat(v);
      });
      if (snap.date) {
        const idx = state.snapshots.findIndex(s => s.date === snap.date);
        if (idx >= 0) state.snapshots[idx] = { ...state.snapshots[idx], ...snap };
        else state.snapshots.push(snap);
      }
    }
    state.snapshots.sort((a, b) => a.date.localeCompare(b.date));
    saveState(); renderAll(); alert(`Imported ${lines.length - 1} rows`);
  };
  reader.readAsText(f);
  event.target.value = '';
}

function clearAllData() { state = defaultState(); saveState(); location.reload(); }

function updateLastUpdateDisplay() {
  const el = document.getElementById('lastUpdate');
  const t = state.current._lastFetch;
  if (t) { const d = new Date(t); el.textContent = `Last: ${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`; }
}

// ============================================================
// TOOLTIP SYSTEM
// ============================================================
const TIPS = {
  bucketA: {
    title: 'Bucket A: FX Trade (短期トレード)',
    body: `<p>USD/JPYの短期売買で積極的にリターンを狙うバケツ。専用資金1,000万円。週〜日次で判断。</p>
<div class="tip-label">介入警戒モード</div>
<p>USD/JPY > 158円で自動発動。日本政府の為替介入リスクが高まるため、ポジションを絞る。</p>
<ul>
  <li><b>ロング上限: 200K</b>（通常は300-500K）</li>
  <li><b>160円タッチ: ショート偵察200K解禁</b>（介入の下落を狙う）</li>
  <li><b>レンジ戦略: 158-161円</b>の往復を取る</li>
  <li>155円以下に戻れば通常モードに復帰</li>
</ul>
<div class="tip-label">FX益の配分ルール</div>
<ul>
  <li>50% → Bucket B（長期投資の原資）</li>
  <li>30% → 証拠金に再投資（複利）</li>
  <li>20% → 生活費バッファー</li>
</ul>
<div class="tip-label">一方通行ルール</div>
<p>A→Bへの送金はOK。<b>B→Aは禁止</b>（トレード資金の膨張防止）。</p>
<div class="tip-action"><span>⚡ 判断基準: 介入警戒バッジの色を確認。赤=ロング制限中。</span></div>`
  },

  bucketB: {
    title: 'Bucket B: Multi-Asset Core (長期コア)',
    body: `<p>金利・マクロ環境を見ながら複数資産に分散投資するバケツ。月〜四半期で判断。</p>
<div class="tip-label">はしご戦略（相対値方式）</div>
<p>USD/JPYが「Base Rate（起点）から何円下がったか」でStepが発動。固定レートではなく相対値なので、どの水準からでも使える。</p>
<ul>
  <li>Step 0: Base -5円 → 20%投入</li>
  <li>Step 1: Base -10円 → 20%投入</li>
  <li>...段階的に円高で買い増し</li>
</ul>
<div class="tip-label">DCA（ドルコスト平均法）</div>
<p>ねじれ環境（利下げなのに円安）では、はしごが発動しにくい。DCA枠（月5%）で金・BTCを中心に「待機しながらも少しずつ動く」。3ヶ月ねじれ継続でまとめ買い禁止→DCAのみに制限。</p>
<div class="tip-label">新規アセット</div>
<ul>
  <li><b>金（GLDM/IAU）:</b> 地政学リスク + ドル信認低下ヘッジ</li>
  <li><b>BTC:</b> 既存資産との非相関性</li>
  <li><b>原油（XLE）:</b> イラン地政学リスクヘッジ</li>
</ul>
<div class="tip-action"><span>⚡ Phase表示とDCA進捗を確認して、今月やるべきことを把握。</span></div>`
  },

  bucketC: {
    title: 'Bucket C: Floor (安全床)',
    body: `<p>何があっても減らさない資金。生活費・緊急時の安全網。</p>
<div class="tip-label">構成</div>
<ul>
  <li>円MMF: 10%（流動性最高の安全資産）</li>
  <li>円現金: 10%（すぐ使える生活防衛資金）</li>
</ul>
<div class="tip-label">絶対ルール</div>
<p>A（FX）やB（投資）からCへの流入は禁止。CからA/Bへの転用も禁止。このバケツは投資戦略から完全に独立している。</p>
<p>相場がどれだけ動いても、VIXが100になっても、ここは触らない。</p>
<div class="tip-action"><span>⚡ 行動不要。常に20%を維持しているか定期的に確認するだけ。</span></div>`
  },

  indicatorFlow: {
    title: 'Indicator Flow (指標の因果関係)',
    body: `<p>FRBの金利決定からあなたの投資判断までの「情報の流れ」を可視化。光っている経路が今アクティブなパス。</p>
<div class="tip-label">左パス（MMF）</div>
<p>FRB → SOFR → MMF。政策金利が高いとき、MMFの利回りが魅力的。SOFRの値がそのままMMFの概算利回り。<b>FFR ≥ 3.5%</b>でこのパスが光る。</p>
<div class="tip-label">右パス（ETF）</div>
<p>US 2年債利回りが市場の「先読み」。FFRより先に下がり始めたら利下げ織り込みのサイン。<b>FFR < 3.5% かつ US2Y < FFR</b> のとき、短期債ETFに切り替えてキャピタルゲインを狙う。</p>
<div class="tip-label">下段（新規アセット）</div>
<p>金/BTC/XLEはどちらのパスでも並行保有。ドル・金利に依存しない分散先。</p>
<div class="tip-label">現在の注目ポイント</div>
<p>US2Y(3.78%) > FFR(3.64%) の逆転が発生中。市場が利下げ停止を織り込んでおり、右パス（ETF）の発動条件を満たさない。これが「Phase 2-Hold」の根拠。</p>
<div class="tip-action"><span>⚡ 左パス（MMF）が光っていれば利息で稼ぐフェーズ。右パスに切り替わったらETFに注力。</span></div>`
  },

  rateCycle: {
    title: 'Rate Cycle Position (金利サイクル)',
    body: `<p>FRBの政策金利がサイクルのどこにあるかを半円ゲージで表示。針の位置が現在のFFR。</p>
<div class="tip-label">5つのフェーズ</div>
<ul>
  <li><b style="color:#ef4444">Hike (5-6%)</b>: 利上げ期。MMF全力で金利収入最大化</li>
  <li><b style="color:#f59e0b">Peak (4-5%)</b>: 頂上テラス。MMF維持しつつETF構築開始</li>
  <li><b style="color:#3b82f6">1st Cut (3.5-4%)</b>: 利下げ初動。MMF→ETFシフト開始</li>
  <li><b style="color:#8b5cf6">Cutting (2.5-3.5%)</b>: 利下げ加速。ETF拡大（※US2Y条件付き）</li>
  <li><b style="color:#10b981">Low (0-2.5%)</b>: 低金利。ETF利確→株式シフト</li>
</ul>
<div class="tip-label">Phase 2-Hold とは？</div>
<p>FFRが3.5%を割っても、US2Y > FFR（市場が利下げ継続を疑っている）場合は債券デュレーションの延伸を保留する特殊状態。安易にIEF等の中期債に移ると、利下げ停止時に価格下落リスクがある。</p>
<div class="tip-action"><span>⚡ 針が1st Cutにあれば移行準備。Cuttingに入ったらUS2Y条件をチェック。</span></div>`
  },

  ladderGaugeHelp: {
    title: 'USD/JPY Ladder Gauge (はしごゲージ)',
    body: `<p>横バーに5つのStepマーカーと現在のUSD/JPYポインターを表示。左が円高、右が円安。</p>
<div class="tip-label">相対値方式</div>
<p>「Base Rate」からの下落幅でStepが決まる。<b>Base=159.6</b>なら:</p>
<ul>
  <li>Step 0: 154.6円（-5円）→ 20%投入</li>
  <li>Step 1: 149.6円（-10円）→ 20%投入</li>
  <li>Step 2: 144.6円（-15円）→ 20%投入</li>
  <li>Step 3: 139.6円（-20円）→ 10%投入</li>
  <li>Step 4: 134.6円（-25円）→ 10%投入</li>
</ul>
<p>Baseは設定で変更可能。相場水準が変わったらBaseを更新するだけで全Stepが連動して動く。</p>
<div class="tip-label">Stepをクリックすると？</div>
<p>実行済みの記録をトグル（✓マーク）。実際にドル転・買付を行ったらクリックしてチェック。</p>
<div class="tip-action"><span>⚡ ポインターがStepに到達したら、Ladder StatusでAllocを確認して実行。</span></div>`
  },

  ladderStatus: {
    title: 'Ladder Status (はしご進捗)',
    body: `<p>はしご戦略の実行状況をPhase判定・Step一覧・DCA進捗・推奨アクションでまとめて表示。</p>
<div class="tip-label">Phase判定（v2改訂版）</div>
<ul>
  <li><b>Phase 1</b>: FFR ≥ 4.0% → MMF中心</li>
  <li><b>Phase 2</b>: 3.5% ≤ FFR < 4.0% → ETFシフト開始</li>
  <li><b>Phase 3</b>: FFR < 3.5% <b>かつ US2Y < FFR</b> → 中期債切替OK</li>
  <li><b>Phase 2-Hold</b>: FFR < 3.5% だがUS2Y > FFR → デュレーション延伸保留</li>
</ul>
<div class="tip-label">DCA Progress</div>
<p>月次5%の定額投資の進捗バー。ねじれ環境で「無限待機」を防ぐための仕組み。毎月バーが100%に達するよう分散投資する。金・BTCを中心に。</p>
<div class="tip-label">各Stepのアロケーション</div>
<p>Step 0は保守的（MMF50%）。Step 4は攻撃的（VTI70%）。円高が進むほどリスク資産比率を上げる設計。</p>
<div class="tip-action"><span>⚡ Recommendedの指示に従う。ねじれDCA推奨なら金・BTCを少額ずつ。</span></div>`
  },

  ruleEngine: {
    title: 'Rule Engine (自動判定ルール)',
    body: `<p>8つの戦略ルールをリアルタイムで自動判定。OK/WARN/ALERT/INFOの4段階。</p>
<div class="tip-label">各ルールの意味</div>
<ul>
  <li><b>VIX Stress:</b> 恐怖指数。30超で全投資停止。暴落時の防衛ルール</li>
  <li><b>Intervention Alert:</b> 158円超で介入警戒。FXトレードのポジション制限</li>
  <li><b>ETF Shift:</b> 旧版はFFRだけで判定→v2はUS2Y条件を追加。安易なデュレーション延伸を防止</li>
  <li><b>Twist Monitor:</b> ねじれ（利下げ+円安）の継続期間を計測。3ヶ月でまとめ買い禁止</li>
  <li><b>Rate Cut Signal:</b> FFR - US2Yスプレッド。プラスなら利下げ期待、マイナスなら利下げ停止</li>
  <li><b>Currency Range:</b> Baseレートからの乖離を監視。±10円で臨時レビュー</li>
  <li><b>Inflation Check:</b> CPI > FFR+1% ならインフレが金利収入を侵食。金/REITへ</li>
  <li><b>Ladder Trigger:</b> USD/JPYがStep到達レートに達したか監視</li>
</ul>
<div class="tip-action"><span>⚡ ALERTが1つでもあれば最優先で対処。WARNは準備・監視強化。OKは放置OK。</span></div>`
  },

  allocation: {
    title: 'Bucket B Target Allocation (目標配分)',
    body: `<p>Bucket Bのアセットアロケーション目標値。バーの長さが目標レンジの中央値。</p>
<div class="tip-label">各カテゴリの役割</div>
<ul>
  <li><b>USD MMF (20-25%):</b> ドル建て安全資産。金利で稼ぐ。MMF利回り低下時に縮小</li>
  <li><b>Short Bond (15-20%):</b> SGOV/BIL。利下げ時にキャピタルゲインも狙える「攻めの安全資産」</li>
  <li><b>US Equity (15-20%):</b> VTI/SCHD。長期成長＋配当。旧版40%から大幅削減（関税・景気懸念）</li>
  <li><b>Gold (10-15%):</b> 新規追加。地政学リスク＋ドル信認低下のヘッジ</li>
  <li><b>BTC (5-8%):</b> 新規追加。非相関資産。ねじれ環境で既存モデルが崩れたときの保険</li>
  <li><b>Energy (5%):</b> 新規追加。イラン地政学＋原油供給制約ヘッジ</li>
  <li><b>Cash Buffer (10-12%):</b> 次の好機に備える弾薬庫</li>
</ul>
<div class="tip-label">リバランスのタイミング</div>
<p>四半期に1回、または特定のルールが発動したときに確認。Phase移行時にはアロケーション比率自体が変わる。</p>
<div class="tip-action"><span>⚡ 実際の保有比率がこの目標レンジ内に収まっているか定期的にチェック。</span></div>`
  },
};

// Tooltip initialization
document.addEventListener('DOMContentLoaded', () => {
  initTooltips();
});

function initTooltips() {
  const panel = document.getElementById('tipPanel');
  const content = document.getElementById('tipContent');

  document.querySelectorAll('.has-tip').forEach(el => {
    el.addEventListener('click', (e) => {
      // Only trigger on the ? icon area (top-right corner)
      const rect = el.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      if (clickX < rect.width - 30 || clickY > 30) return;

      const tipKey = el.dataset.tip;
      const tip = TIPS[tipKey];
      if (!tip) return;

      content.innerHTML = `<h4>${tip.title}</h4>${tip.body}`;

      // Position near the element
      const panelW = 400;
      let left = e.clientX - panelW / 2;
      let top = rect.bottom + 8;

      // Keep in viewport
      if (left < 10) left = 10;
      if (left + panelW > window.innerWidth - 10) left = window.innerWidth - panelW - 10;
      if (top + 400 > window.innerHeight) top = rect.top - 400 - 8;
      if (top < 10) top = 10;

      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.classList.add('visible');
      e.stopPropagation();
    });
  });

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target)) closeTip();
  });

  // Close on scroll
  document.addEventListener('scroll', () => closeTip(), { passive: true });
}

function closeTip() {
  document.getElementById('tipPanel').classList.remove('visible');
}

// Also add tips for individual macro indicator cards
function addMacroCardTips() {
  const macroTips = {
    FFR: 'FRBが決定する政策金利。全ての金利商品の基準。高いほどMMF利回りが良い。3.5%を下回るとETFシフトを検討。',
    SOFR: '翌日物レポ金利。FFRの「実勢値」。MMFの利回りはこれにほぼ連動。FFRとの乖離が大きいと市場にストレス。',
    US02Y: '市場が2年先の金利を予想した値。FFRより先に動く「先行指標」。US2Y < FFR なら利下げ織込み。US2Y > FFR なら利下げ停止疑念。',
    USDJPY: 'ドル円レート。はしご戦略のStep判定に使用。158超で介入警戒モード。155以下で通常モード復帰。',
    DXY: 'ドルの総合的な強弱指数（貿易加重）。ドル円だけでなく世界全体のドル需給を反映。',
    VIX: '恐怖指数。20以下=平常、25-30=警戒、30超=パニック（新規投資全停止）。',
    CORECPI: 'コアCPI前年比。インフレの体温計。FFR+1%を超えると金利収入がインフレに負けている。',
  };

  document.querySelectorAll('#macroCards .card').forEach(card => {
    const label = card.querySelector('.text-\\[10px\\]')?.textContent?.trim();
    const key = Object.keys(FRED_SERIES).find(k => FRED_SERIES[k].label === label);
    if (key && macroTips[key]) {
      card.style.cursor = 'help';
      card.title = macroTips[key];
    }
  });
}
