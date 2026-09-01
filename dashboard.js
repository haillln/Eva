/* =================================================================
   EVA — TRADING JOURNAL DASHBOARD (dashboard.js)
   Rebuilt from scratch. The old dashboard.html/dashboard.js were
   used as VISUAL REFERENCE ONLY — nothing from their JS was reused.

   Firebase project: eval-61cd9 (EVA)
   Firestore layout (confirmed from journal.js / accounts.html):
     users/{uid}
     users/{uid}/accounts/{accountId}          <- ALL journal accounts
                                                   (funded/challenge accounts
                                                    live in a separate part
                                                    of the app — challenge.html
                                                    — and are never read here)
     users/{uid}/accounts/{accountId}/trades/{tradeId}

   Account fields actually written by accounts.html:
     name, broker, accountType ('Live'|'Demo'|'Prop Firm'), currency,
     initialBalance, currentBalance, createdAt, updatedAt, isActive
     NOTE: currentBalance is written once at creation/edit time and is
     NEVER kept in sync with trades anywhere in the old code — that's
     why this dashboard computes balance/equity itself from
     initialBalance + the sum of real trade P/L, instead of trusting
     the stored currentBalance field.

   Trade fields actually written by journal.js (handleAddTrade):
     accountId, instrument, direction ('LONG'|'SHORT'), tradeDate,
     lotSize, entryPrice, exitPrice, stopLoss, takeProfit, session,
     strategy, setup, notes, tradeRating, entryTime, exitTime,
     profitLoss, risk, riskReward, result ('Win'|'Loss'|'BE'),
     marketCondition, timeframe, rating, emotionBefore/During/After,
     confidence, discipline, followedPlan, mistakes, lessons,
     createdAt, updatedAt
   ================================================================= */

import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, query, orderBy, getDocs
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

/* -----------------------------------------------------------------
   0. FIREBASE — reuse the app layout.html already initialized
   ----------------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyDGh-M9Ps_fy1k8u-r0H899U0L-LQQBKZI",
  authDomain: "eval-61cd9.firebaseapp.com",
  projectId: "eval-61cd9",
  storageBucket: "eval-61cd9.firebasestorage.app",
  messagingSenderId: "843373749164",
  appId: "1:843373749164:web:cc93d5513895ca10065009",
  measurementId: "G-R6D77DNJXT"
};
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* -----------------------------------------------------------------
   1. DOM HELPERS
   ----------------------------------------------------------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function byId(id) { return document.getElementById(id); }

function waitForElement(selector, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      const el = document.querySelector(selector);
      if (el) resolve(el); else reject(new Error(`Timed out waiting for ${selector}`));
    }, timeoutMs);
  });
}

/* -----------------------------------------------------------------
   2. FORMATTERS
   ----------------------------------------------------------------- */
function fmtMoney(n) {
  const num = Number(n) || 0;
  const sign = num > 0 ? "+" : num < 0 ? "-" : "";
  return `${sign}$${Math.abs(num).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtBalance(n) {
  const num = Number(n) || 0;
  const sign = num < 0 ? "-" : "";
  return `${sign}$${Math.abs(num).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${Number(n).toFixed(digits)}%`;
}
function fmtR(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${Number(n).toFixed(2)}R`;
}
function fmtDateLabel(d) {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric" });
}
function fmtDateShort(d) {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function dateKey(d) {
  // Local-time YYYY-MM-DD key (not UTC) so "today" always matches the user's day.
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function friendlyFirebaseError(err) {
  const code = err && err.code ? err.code : "";
  if (code.includes("permission-denied")) return "You don't have permission to view this data.";
  if (code.includes("unavailable")) return "Connection issue — check your network.";
  return "Something went wrong loading your data.";
}

/* -----------------------------------------------------------------
   3. TOAST
   ----------------------------------------------------------------- */
function ensureToastHost() {
  let host = byId("dbToastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "dbToastHost";
    document.body.appendChild(host);
  }
  return host;
}
function showToast(message, kind = "info") {
  const host = ensureToastHost();
  const colors = { info: "#3B82F6", success: "#22C55E", error: "#EF4444" };
  const el = document.createElement("div");
  el.textContent = message;
  el.style.cssText = `pointer-events:auto;background:${colors[kind] || colors.info};color:#fff;padding:10px 18px;border-radius:10px;font-size:0.86rem;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.35);max-width:90vw;text-align:center;`;
  host.appendChild(el);
  setTimeout(() => { el.style.transition = "opacity .3s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 3200);
}

/* -----------------------------------------------------------------
   4. STATE — single source of truth
   ----------------------------------------------------------------- */
const state = {
  uid: null,
  username: "Trader",
  accounts: [],                // normalized account docs
  selectedAccountId: null,
  unsubAccounts: null,
  unsubTrades: null,
  rawTrades: [],                // normalized trades for the selected account (unfiltered)
  dateRange: "month",           // 'today'|'week'|'month'|'year'|'all'|'custom'
  customStart: null,            // Date | null
  customEnd: null,              // Date | null
  calView: "month",             // 'month'|'week'|'year'
  calRefDate: new Date(),       // month/week/year currently displayed in the calendar
  echarts: null,                // loaded ECharts module (window.echarts)
  equityChart: null,
  dailyChart: null,
  drawdownChart: null,
  activeDayKey: null
};

function accountStorageKey() { return `eva-dashboard-selected-account-${state.uid}`; }

/* -----------------------------------------------------------------
   5. NORMALIZATION LAYER
   Never guesses fields that aren't there — real schema only.
   ----------------------------------------------------------------- */
function normalizeAccount(id, raw) {
  const initialBalance = Number(raw.initialBalance) || 0;
  return {
    id,
    name: raw.name || raw.accountName || "Untitled Account",
    broker: raw.broker || raw.brokerName || raw.platform || "",
    accountType: raw.accountType || raw.status || "Live",
    currency: raw.currency || "USD",
    initialBalance,
    isActive: raw.isActive !== false,
    createdAt: raw.createdAt || null
  };
}

function normalizeTrade(id, raw) {
  const profitLoss = Number(raw.profitLoss) || 0;
  const risk = raw.risk !== undefined && raw.risk !== null && raw.risk !== "" ? Number(raw.risk) : null;
  const rMultiple = (risk && risk > 0) ? profitLoss / risk : null;
  let tradeDate = null;
  if (raw.tradeDate) tradeDate = raw.tradeDate.toDate ? raw.tradeDate.toDate() : new Date(raw.tradeDate);
  // Real classification derived from the actual P/L sign — never trusts a
  // possibly-stale stored `result` label, so WIN/LOSS/BE can never disagree
  // with the dollar amount (this is the exact rule the brief's mandatory
  // loss test is checking).
  const classification = profitLoss > 0 ? "WIN" : profitLoss < 0 ? "LOSS" : "BREAK-EVEN";
  return {
    id,
    accountId: raw.accountId || null,
    instrument: raw.instrument || "—",
    direction: raw.direction === "SHORT" ? "SHORT" : "LONG",
    tradeDate,
    entryTime: raw.entryTime || "",
    exitTime: raw.exitTime || "",
    lotSize: Number(raw.lotSize) || 0,
    entryPrice: raw.entryPrice ?? null,
    exitPrice: raw.exitPrice ?? null,
    stopLoss: raw.stopLoss ?? null,
    takeProfit: raw.takeProfit ?? null,
    session: raw.session || "",
    strategy: raw.strategy || "",
    setup: raw.setup || "",
    notes: raw.notes || "",
    profitLoss,
    risk,
    riskReward: raw.riskReward || "",
    rMultiple,
    result: classification,
    tradeRating: raw.tradeRating || null
  };
}

/* -----------------------------------------------------------------
   6. DATA LAYER — Firestore
   ----------------------------------------------------------------- */
function subscribeAccounts() {
  if (state.unsubAccounts) { state.unsubAccounts(); state.unsubAccounts = null; }
  const colRef = collection(db, "users", state.uid, "accounts");
  state.unsubAccounts = onSnapshot(colRef, (snap) => {
    state.accounts = snap.docs.map(d => normalizeAccount(d.id, d.data()));
    renderAccountList();

    if (state.accounts.length === 0) {
      state.selectedAccountId = null;
      showNoAccountsState();
      return;
    }

    const saved = localStorage.getItem(accountStorageKey());
    let target = state.accounts.some(a => a.id === state.selectedAccountId) ? state.selectedAccountId
      : (saved && state.accounts.some(a => a.id === saved)) ? saved
      : state.accounts[0].id;

    selectAccount(target);
  }, (err) => {
    showToast(friendlyFirebaseError(err), "error");
  });
}

function selectAccount(accountId) {
  const changed = state.selectedAccountId !== accountId;
  state.selectedAccountId = accountId;
  localStorage.setItem(accountStorageKey(), accountId);
  byId("db-root").setAttribute("data-account-id", accountId || "");
  showContentState();
  updateAccountTrigger();
  renderAccountList();

  if (changed || !state.unsubTrades) subscribeTrades(accountId);
}

function subscribeTrades(accountId) {
  if (state.unsubTrades) { state.unsubTrades(); state.unsubTrades = null; }
  if (!accountId) { state.rawTrades = []; recomputeAndRender(); return; }

  const loadingRow = byId("db-loading-row");
  if (loadingRow) loadingRow.hidden = false;

  const q = query(collection(db, "users", state.uid, "accounts", accountId, "trades"), orderBy("tradeDate", "asc"));
  state.unsubTrades = onSnapshot(q, (snap) => {
    state.rawTrades = snap.docs.map(d => normalizeTrade(d.id, d.data())).filter(t => t.tradeDate instanceof Date && !isNaN(t.tradeDate));
    if (loadingRow) loadingRow.hidden = true;
    recomputeAndRender();
  }, (err) => {
    if (loadingRow) loadingRow.hidden = true;
    showToast(friendlyFirebaseError(err), "error");
  });
}

/* -----------------------------------------------------------------
   7. CALCULATION ENGINE — pure functions, no DOM
   ----------------------------------------------------------------- */
function getRangeBounds(range) {
  const now = new Date();
  let start = null, end = null;
  if (range === "today") {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (range === "week") {
    const day = (now.getDay() + 6) % 7; // Monday = 0
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day, 0, 0, 0, 0);
    end = new Date(start); end.setDate(end.getDate() + 6); end.setHours(23, 59, 59, 999);
  } else if (range === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (range === "year") {
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else if (range === "custom") {
    start = state.customStart ? new Date(state.customStart.getFullYear(), state.customStart.getMonth(), state.customStart.getDate(), 0, 0, 0, 0) : null;
    end = state.customEnd ? new Date(state.customEnd.getFullYear(), state.customEnd.getMonth(), state.customEnd.getDate(), 23, 59, 59, 999) : null;
  }
  // 'all' => null, null (no bounds)
  return { start, end };
}

function filterTrades(trades, range) {
  const { start, end } = getRangeBounds(range);
  if (!start && !end) return trades.slice();
  return trades.filter(t => {
    if (!t.tradeDate) return false;
    if (start && t.tradeDate < start) return false;
    if (end && t.tradeDate > end) return false;
    return true;
  });
}

/* Chronological equity curve, ALWAYS built from the full (unfiltered) trade
   history — a filtered range can't be used to compute balance/equity or the
   running-peak drawdown correctly, since both depend on everything that
   happened before the range too. */
function calculateEquity(allTradesChronological, initialBalance) {
  const points = [{ date: null, equity: initialBalance, pl: 0, tradeId: null }];
  let running = initialBalance;
  for (const t of allTradesChronological) {
    running += t.profitLoss;
    points.push({ date: t.tradeDate, equity: running, pl: t.profitLoss, tradeId: t.id });
  }
  return points;
}

/* Running-peak drawdown — NEVER looks ahead. See MANDATORY DRAWDOWN TEST:
   10000,10200,10000,10500,10300 -> dd 0,0,200,0,200 */
function calculateDrawdown(equityPoints) {
  let peak = -Infinity;
  const out = [];
  for (const p of equityPoints) {
    peak = Math.max(peak, p.equity);
    out.push({ date: p.date, equity: p.equity, peak, drawdown: peak - p.equity });
  }
  return out;
}

function calculateDailyPL(trades) {
  const map = new Map(); // dateKey -> { date, pl, count, wins, losses, be }
  for (const t of trades) {
    if (!t.tradeDate) continue;
    const key = dateKey(t.tradeDate);
    if (!map.has(key)) map.set(key, { date: new Date(t.tradeDate.getFullYear(), t.tradeDate.getMonth(), t.tradeDate.getDate()), pl: 0, count: 0, wins: 0, losses: 0, be: 0 });
    const entry = map.get(key);
    entry.pl += t.profitLoss;
    entry.count += 1;
    if (t.result === "WIN") entry.wins += 1;
    else if (t.result === "LOSS") entry.losses += 1;
    else entry.be += 1;
  }
  return Array.from(map.entries()).map(([key, v]) => ({ key, ...v })).sort((a, b) => a.date - b.date);
}

function aggregateCalendar(trades) {
  const dailyPL = calculateDailyPL(trades);
  const map = new Map();
  dailyPL.forEach(d => map.set(d.key, d));
  return map; // dateKey -> {date, pl, count, wins, losses, be}
}

function calculateStatistics(filteredTrades, initialBalance, allTradesChronological) {
  const totalTrades = filteredTrades.length;
  const wins = filteredTrades.filter(t => t.result === "WIN");
  const losses = filteredTrades.filter(t => t.result === "LOSS");
  const totalPL = filteredTrades.reduce((s, t) => s + t.profitLoss, 0);

  const todayKey = dateKey(new Date());
  const todaysPL = allTradesChronological.filter(t => t.tradeDate && dateKey(t.tradeDate) === todayKey).reduce((s, t) => s + t.profitLoss, 0);

  const grossProfit = wins.reduce((s, t) => s + t.profitLoss, 0);
  const grossLoss = losses.reduce((s, t) => s + t.profitLoss, 0); // negative
  const winRate = totalTrades ? (wins.length / totalTrades) * 100 : null;
  const avgWin = wins.length ? grossProfit / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  const profitFactor = grossLoss !== 0 ? Math.abs(grossProfit / grossLoss) : (grossProfit > 0 ? null : null);
  const rValues = filteredTrades.map(t => t.rMultiple).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  const avgR = rValues.length ? rValues.reduce((s, v) => s + v, 0) / rValues.length : null;
  const largestWin = wins.length ? Math.max(...wins.map(t => t.profitLoss)) : null;
  const largestLoss = losses.length ? Math.min(...losses.map(t => t.profitLoss)) : null;

  // Full-history equity + running-peak drawdown (never scoped to the filter —
  // a max drawdown can't be judged correctly from a partial window).
  const equityPoints = calculateEquity(allTradesChronological, initialBalance);
  const ddPoints = calculateDrawdown(equityPoints);
  const maxDrawdown = ddPoints.length ? Math.max(...ddPoints.map(p => p.drawdown)) : 0;
  const currentDrawdown = ddPoints.length ? ddPoints[ddPoints.length - 1].drawdown : 0;
  const recoveryFactor = maxDrawdown > 0 ? totalPL / maxDrawdown : null;

  const dailyPL = calculateDailyPL(filteredTrades);
  const bestDay = dailyPL.length ? dailyPL.reduce((a, b) => (b.pl > a.pl ? b : a)) : null;
  const worstDay = dailyPL.length ? dailyPL.reduce((a, b) => (b.pl < a.pl ? b : a)) : null;

  const balance = equityPoints[equityPoints.length - 1].equity;
  const equity = balance; // no open-position data exists in this schema — closed-trade journal only

  return {
    balance, equity, totalPL, todaysPL, totalTrades,
    winRate, avgWin, avgLoss, profitFactor, avgR,
    largestWin, largestLoss, maxDrawdown, currentDrawdown, recoveryFactor,
    bestDay, worstDay, equityPoints, ddPoints, dailyPL
  };
}

/* -----------------------------------------------------------------
   8. RENDER — STATE ROOT
   ----------------------------------------------------------------- */
function showNoAccountsState() {
  byId("db-no-accounts-state").hidden = false;
  byId("db-content").hidden = true;
  updateAccountTrigger();
}
function showContentState() {
  byId("db-no-accounts-state").hidden = true;
  byId("db-content").hidden = false;
}

function currentAccount() {
  return state.accounts.find(a => a.id === state.selectedAccountId) || null;
}

function recomputeAndRender() {
  const acc = currentAccount();
  if (!acc) return;
  const filtered = filterTrades(state.rawTrades, state.dateRange);
  const stats = calculateStatistics(filtered, acc.initialBalance, state.rawTrades);
  renderHero(stats);
  renderStatGrid(stats);
  renderFilterSummary(filtered.length);
  renderEquityChart(stats.equityPoints);
  renderDailyChart(filterTrades(state.rawTrades, state.dateRange));
  renderDrawdownChart(stats.ddPoints);
  renderCalendar();
}

/* -----------------------------------------------------------------
   9. ACCOUNT SELECTOR
   ----------------------------------------------------------------- */
function accountBalanceOf(acc) {
  const trades = acc.id === state.selectedAccountId ? state.rawTrades : null;
  // We only have live trade totals for the currently-subscribed account;
  // for the others in the list we show their stored initial balance plus
  // "—" until selected, rather than fabricating a number. If we already
  // loaded them once this session (cache), use that.
  if (trades) {
    const total = trades.reduce((s, t) => s + t.profitLoss, 0);
    return acc.initialBalance + total;
  }
  return acc.__cachedBalance !== undefined ? acc.__cachedBalance : acc.initialBalance;
}

function updateAccountTrigger() {
  const acc = currentAccount();
  const nameEl = byId("db-account-trigger-name");
  const metaEl = byId("db-account-trigger-meta");
  if (!acc) {
    nameEl.textContent = state.accounts.length ? "Select account" : "No accounts yet";
    metaEl.textContent = "";
    return;
  }
  nameEl.textContent = acc.name;
  metaEl.textContent = fmtBalance(accountBalanceOf(acc));
}

function renderAccountList() {
  const list = byId("db-account-list");
  if (!list) return;
  if (state.accounts.length === 0) {
    list.innerHTML = `<div class="db-account-empty">No journal accounts yet. Create one to start tracking your trading.</div>`;
    return;
  }
  list.innerHTML = state.accounts.map(acc => {
    const active = acc.id === state.selectedAccountId;
    const isDemo = /demo/i.test(acc.accountType);
    return `
      <button type="button" class="db-account-item${active ? " db-active" : ""}" data-account-id="${escapeHtml(acc.id)}" role="option" aria-selected="${active}">
        <span class="db-account-item-dot${isDemo ? " db-dot-demo" : ""}"></span>
        <span class="db-account-item-info">
          <span class="db-account-item-name">${escapeHtml(acc.name)}</span>
          <span class="db-account-item-meta">${escapeHtml(acc.accountType)}${acc.broker ? " · " + escapeHtml(acc.broker) : ""} · ID ${escapeHtml(acc.id.slice(0, 6))}</span>
        </span>
        <span class="db-account-item-balance">${fmtBalance(accountBalanceOf(acc))}</span>
        ${active ? `<svg class="db-account-item-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>` : ""}
      </button>`;
  }).join("");
}

function positionAccountPanel() {
  const trigger = byId("db-account-trigger");
  const panel = byId("db-account-panel");
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const bottomNavClearance = 92; // keep clear of the shared bottom nav on mobile
  const panelWidth = Math.min(300, vw * 0.92);
  const maxHeight = Math.max(180, vh - bottomNavClearance - rect.bottom - 16);

  let left = rect.left;
  if (left + panelWidth > vw - 8) left = vw - panelWidth - 8;
  if (left < 8) left = 8;

  let top = rect.bottom + 8;
  // If there isn't enough room below, open upward instead of clipping.
  if (maxHeight < 160 && rect.top > vh / 2) {
    panel.style.maxHeight = Math.min(360, rect.top - 16) + "px";
    top = Math.max(8, rect.top - Math.min(360, rect.top - 16) - 8);
  } else {
    panel.style.maxHeight = Math.min(360, maxHeight) + "px";
  }

  panel.style.width = panelWidth + "px";
  panel.style.left = left + "px";
  panel.style.top = top + "px";
}

function openAccountPanel() {
  positionAccountPanel();
  byId("db-account-panel").classList.add("db-open");
  byId("db-account-backdrop").classList.add("db-open");
  byId("db-account-trigger").classList.add("db-open");
  byId("db-account-trigger").setAttribute("aria-expanded", "true");
}
function closeAccountPanel() {
  byId("db-account-panel").classList.remove("db-open");
  byId("db-account-backdrop").classList.remove("db-open");
  byId("db-account-trigger").classList.remove("db-open");
  byId("db-account-trigger").setAttribute("aria-expanded", "false");
}

function wireAccountSelector() {
  const trigger = byId("db-account-trigger");
  const panel = byId("db-account-panel");
  const backdrop = byId("db-account-backdrop");

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.classList.contains("db-open")) closeAccountPanel(); else openAccountPanel();
  });
  panel.addEventListener("click", (e) => {
    const item = e.target.closest("[data-account-id]");
    if (!item) return;
    selectAccount(item.getAttribute("data-account-id"));
    closeAccountPanel();
  });
  backdrop.addEventListener("click", closeAccountPanel);
  window.addEventListener("resize", () => { if (panel.classList.contains("db-open")) positionAccountPanel(); });
  window.addEventListener("scroll", () => { if (panel.classList.contains("db-open")) positionAccountPanel(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAccountPanel(); });
}

/* -----------------------------------------------------------------
   10. HERO + STAT GRID RENDER
   ----------------------------------------------------------------- */
function setStat(id, text, cls) {
  const el = byId(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("db-pos", "db-neg", "db-neu");
  if (cls) el.classList.add(cls);
}
function plClass(n) { return n > 0 ? "db-pos" : n < 0 ? "db-neg" : "db-neu"; }

function renderHero(stats) {
  setStat("stat-balance", fmtBalance(stats.balance));
  setStat("stat-equity", fmtBalance(stats.equity));
  setStat("stat-total-pl", fmtMoney(stats.totalPL), plClass(stats.totalPL));
  setStat("stat-today-pl", fmtMoney(stats.todaysPL), plClass(stats.todaysPL));

  byId("stat-balance-sub").textContent = "Initial + all real trade P/L";
  byId("stat-equity-sub").textContent = "Balance from closed trades";
  byId("stat-total-pl-sub").textContent = `${state.rawTrades.length} trade${state.rawTrades.length === 1 ? "" : "s"} all-time`;
  byId("stat-today-pl-sub").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function renderStatGrid(s) {
  setStat("stat-total-trades", String(s.totalTrades));
  setStat("stat-win-rate", s.winRate === null ? "—" : fmtPct(s.winRate));
  setStat("stat-avg-win", s.avgWin === null ? "—" : fmtMoney(s.avgWin), "db-pos");
  setStat("stat-avg-loss", s.avgLoss === null ? "—" : fmtMoney(s.avgLoss), "db-neg");
  setStat("stat-profit-factor", s.profitFactor === null ? "—" : s.profitFactor.toFixed(2));
  setStat("stat-avg-r", s.avgR === null ? "—" : fmtR(s.avgR), s.avgR > 0 ? "db-pos" : s.avgR < 0 ? "db-neg" : "");
  setStat("stat-largest-win", s.largestWin === null ? "—" : fmtMoney(s.largestWin), "db-pos");
  setStat("stat-largest-loss", s.largestLoss === null ? "—" : fmtMoney(s.largestLoss), "db-neg");
  setStat("stat-drawdown", fmtBalance(s.maxDrawdown), s.maxDrawdown > 0 ? "db-neg" : "db-neu");
  setStat("stat-recovery", s.recoveryFactor === null ? "—" : `${s.recoveryFactor.toFixed(2)}x`);
  setStat("stat-best-day", s.bestDay ? `${fmtMoney(s.bestDay.pl)}` : "—", s.bestDay ? plClass(s.bestDay.pl) : "");
  setStat("stat-worst-day", s.worstDay ? `${fmtMoney(s.worstDay.pl)}` : "—", s.worstDay ? plClass(s.worstDay.pl) : "");
}

function renderFilterSummary(count) {
  const labels = { today: "today", week: "this week", month: "this month", year: "this year", all: "all time", custom: "custom range" };
  byId("db-filter-summary").textContent = `${count} trade${count === 1 ? "" : "s"} · ${labels[state.dateRange] || ""}`;
}

/* -----------------------------------------------------------------
   11. DATE FILTER PILLS + CUSTOM RANGE MODAL
   ----------------------------------------------------------------- */
function wireDateFilter() {
  const row = byId("db-date-filter");
  row.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-range]");
    if (!btn) return;
    const range = btn.getAttribute("data-range");
    if (range === "custom") { openModal("db-custom-range-modal"); return; }
    $all("button", row).forEach(b => b.classList.remove("db-active"));
    btn.classList.add("db-active");
    state.dateRange = range;
    recomputeAndRender();
  });

  byId("db-custom-range-apply").addEventListener("click", () => {
    const startVal = byId("db-custom-start").value;
    const endVal = byId("db-custom-end").value;
    if (!startVal || !endVal) { showToast("Choose both a start and end date.", "error"); return; }
    const start = new Date(startVal + "T00:00:00");
    const end = new Date(endVal + "T00:00:00");
    if (start > end) { showToast("Start date must be before end date.", "error"); return; }
    state.customStart = start;
    state.customEnd = end;
    state.dateRange = "custom";
    $all("#db-date-filter button").forEach(b => b.classList.remove("db-active"));
    $(`#db-date-filter [data-range="custom"]`).classList.add("db-active");
    closeModal("db-custom-range-modal");
    recomputeAndRender();
  });
}

/* -----------------------------------------------------------------
   12. MODAL HELPERS (in-page only — never alert/confirm/prompt)
   ----------------------------------------------------------------- */
function openModal(id) {
  const modal = byId(id);
  if (!modal) return;
  modal.classList.add("db-open");
  modal.setAttribute("aria-hidden", "false");
}
function closeModal(id) {
  const modal = byId(id);
  if (!modal) return;
  modal.classList.remove("db-open");
  modal.setAttribute("aria-hidden", "true");
}
function wireModals() {
  $all("[data-close-modal]").forEach(btn => {
    btn.addEventListener("click", () => closeModal(btn.getAttribute("data-close-modal")));
  });
  $all(".db-modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(overlay.id); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    $all(".db-modal-overlay.db-open").forEach(m => closeModal(m.id));
  });
}

/* -----------------------------------------------------------------
   13. CHARTS (ECharts) — dynamically loaded, theme-aware
   ----------------------------------------------------------------- */
function loadECharts() {
  if (window.echarts) return Promise.resolve(window.echarts);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/echarts/5.4.3/echarts.min.js";
    script.onload = () => resolve(window.echarts);
    script.onerror = () => reject(new Error("Failed to load charting library."));
    document.head.appendChild(script);
  });
}

function isDarkTheme() {
  return document.documentElement.getAttribute("data-eva-theme") !== "light";
}
function chartTextColor() { return isDarkTheme() ? "#94A3B8" : "#5B6472"; }
function chartGridColor() { return isDarkTheme() ? "rgba(255,255,255,0.08)" : "rgba(11,14,20,0.09)"; }
function chartAccent() { return "#6366F1"; }

function baseAxisStyle() {
  return {
    axisLine: { lineStyle: { color: chartGridColor() } },
    axisLabel: { color: chartTextColor(), fontSize: 11 },
    splitLine: { lineStyle: { color: chartGridColor() } }
  };
}

function renderEquityChart(equityPoints) {
  const el = byId("equity-chart");
  const emptyEl = byId("equity-chart-empty");
  if (!state.echarts) { if (emptyEl) emptyEl.hidden = false; return; }
  if (equityPoints.length <= 1) {
    if (emptyEl) emptyEl.hidden = false;
    if (state.equityChart) state.equityChart.clear();
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  if (!state.equityChart) state.equityChart = state.echarts.init(el);

  const acc = currentAccount();
  const first = equityPoints[0].equity;
  const last = equityPoints[equityPoints.length - 1].equity;
  const up = last >= first;
  byId("db-equity-sub").textContent = `${equityPoints.length - 1} trades · started at ${fmtBalance(first)}`;

  const xData = equityPoints.map((p, i) => (i === 0 ? "Start" : fmtDateShort(p.date)));
  const yData = equityPoints.map(p => Number(p.equity.toFixed(2)));

  state.equityChart.setOption({
    grid: { left: 48, right: 16, top: 20, bottom: 30 },
    tooltip: {
      trigger: "axis",
      backgroundColor: isDarkTheme() ? "#12161F" : "#FFFFFF",
      borderColor: chartGridColor(),
      textStyle: { color: isDarkTheme() ? "#F5F6F8" : "#0B0E14" },
      formatter: (params) => {
        const p = params[0];
        return `${p.axisValue}<br/>Equity: <b>${fmtBalance(p.data)}</b>`;
      }
    },
    xAxis: { type: "category", data: xData, boundaryGap: false, ...baseAxisStyle() },
    yAxis: { type: "value", ...baseAxisStyle(), axisLabel: { ...baseAxisStyle().axisLabel, formatter: (v) => "$" + Number(v).toLocaleString() } },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 4 }],
    series: [{
      type: "line", data: yData, smooth: true, symbol: "circle", symbolSize: 5, showSymbol: false,
      lineStyle: { width: 2.5, color: up ? "#22C55E" : "#EF4444" },
      itemStyle: { color: up ? "#22C55E" : "#EF4444" },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: (up ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)") }, { offset: 1, color: "rgba(0,0,0,0)" }] } }
    }]
  }, true);
  state.equityChart.resize();
}

function renderDailyChart(trades) {
  const el = byId("daily-pl-chart");
  const daily = calculateDailyPL(trades);
  const emptyEl = el.querySelector(".db-chart-empty");
  if (!state.echarts || daily.length === 0) { if (emptyEl) emptyEl.hidden = false; if (state.dailyChart) state.dailyChart.clear(); return; }
  if (emptyEl) emptyEl.hidden = true;
  if (!state.dailyChart) state.dailyChart = state.echarts.init(el);

  const xData = daily.map(d => fmtDateShort(d.date));
  const yData = daily.map(d => Number(d.pl.toFixed(2)));

  state.dailyChart.setOption({
    grid: { left: 48, right: 12, top: 16, bottom: 28 },
    tooltip: {
      trigger: "axis",
      backgroundColor: isDarkTheme() ? "#12161F" : "#FFFFFF",
      borderColor: chartGridColor(),
      textStyle: { color: isDarkTheme() ? "#F5F6F8" : "#0B0E14" },
      formatter: (params) => { const p = params[0]; return `${p.axisValue}<br/>P/L: <b>${fmtMoney(p.data)}</b>`; }
    },
    xAxis: { type: "category", data: xData, ...baseAxisStyle() },
    yAxis: { type: "value", ...baseAxisStyle(), axisLabel: { ...baseAxisStyle().axisLabel, formatter: (v) => "$" + Number(v).toLocaleString() } },
    series: [{ type: "bar", data: yData, barMaxWidth: 22, itemStyle: { color: (p) => p.data >= 0 ? "#22C55E" : "#EF4444", borderRadius: [3, 3, 0, 0] } }]
  }, true);
  state.dailyChart.resize();
}

function renderDrawdownChart(ddPoints) {
  const el = byId("drawdown-chart");
  const emptyEl = el.querySelector(".db-chart-empty");
  if (!state.echarts || ddPoints.length <= 1) { if (emptyEl) emptyEl.hidden = false; if (state.drawdownChart) state.drawdownChart.clear(); return; }
  if (emptyEl) emptyEl.hidden = true;
  if (!state.drawdownChart) state.drawdownChart = state.echarts.init(el);

  const xData = ddPoints.map((p, i) => (i === 0 ? "Start" : fmtDateShort(p.date)));
  const yData = ddPoints.map(p => -Number(p.drawdown.toFixed(2))); // shown as negative depth

  state.drawdownChart.setOption({
    grid: { left: 48, right: 12, top: 16, bottom: 28 },
    tooltip: {
      trigger: "axis",
      backgroundColor: isDarkTheme() ? "#12161F" : "#FFFFFF",
      borderColor: chartGridColor(),
      textStyle: { color: isDarkTheme() ? "#F5F6F8" : "#0B0E14" },
      formatter: (params) => { const p = params[0]; return `${p.axisValue}<br/>Drawdown: <b>${fmtBalance(Math.abs(p.data))}</b>`; }
    },
    xAxis: { type: "category", data: xData, boundaryGap: false, ...baseAxisStyle() },
    yAxis: { type: "value", ...baseAxisStyle(), axisLabel: { ...baseAxisStyle().axisLabel, formatter: (v) => "$" + Number(v).toLocaleString() } },
    series: [{
      type: "line", data: yData, smooth: false, showSymbol: false,
      lineStyle: { width: 2, color: "#EF4444" },
      areaStyle: { color: "rgba(239,68,68,0.18)" }
    }]
  }, true);
  state.drawdownChart.resize();
}

function resizeAllCharts() {
  [state.equityChart, state.dailyChart, state.drawdownChart].forEach(c => c && c.resize());
}

/* -----------------------------------------------------------------
   14. CALENDAR — Month / Week / Year, real trade data only
   ----------------------------------------------------------------- */
function wireCalendarControls() {
  byId("db-cal-view-switch").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    $all("#db-cal-view-switch button").forEach(b => b.classList.remove("db-active"));
    btn.classList.add("db-active");
    state.calView = btn.getAttribute("data-view");
    byId("db-cal-month-view").hidden = state.calView !== "month";
    byId("db-cal-week-view").hidden = state.calView !== "week";
    byId("db-cal-year-view").hidden = state.calView !== "year";
    renderCalendar();
  });
  byId("db-cal-today-btn").addEventListener("click", () => { state.calRefDate = new Date(); renderCalendar(); });
  byId("db-cal-prev-btn").addEventListener("click", () => { navigateCalendar(-1); });
  byId("db-cal-next-btn").addEventListener("click", () => { navigateCalendar(1); });
}

function navigateCalendar(dir) {
  const d = new Date(state.calRefDate);
  if (state.calView === "month") d.setMonth(d.getMonth() + dir);
  else if (state.calView === "week") d.setDate(d.getDate() + dir * 7);
  else d.setFullYear(d.getFullYear() + dir);
  state.calRefDate = d;
  renderCalendar();
}

function renderCalendar() {
  const calMap = aggregateCalendar(state.rawTrades); // calendar always reflects the FULL account history
  if (state.calView === "month") renderCalendarMonth(calMap);
  else if (state.calView === "week") renderCalendarWeek(calMap);
  else renderCalendarYear(calMap);
}

function dayCellClass(entry) {
  if (!entry || entry.count === 0) return "";
  if (entry.pl > 0) return "db-day-pos";
  if (entry.pl < 0) return "db-day-neg";
  return "db-day-be";
}

function renderCalendarMonth(calMap) {
  const ref = state.calRefDate;
  const year = ref.getFullYear(), month = ref.getMonth();
  byId("db-cal-title").textContent = ref.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(new Date());

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(`<div class="db-cal-day db-cal-blank"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const key = dateKey(d);
    const entry = calMap.get(key);
    const hasTrades = !!(entry && entry.count > 0);
    const cls = ["db-cal-day"];
    if (hasTrades) { cls.push("db-has-trades", dayCellClass(entry)); }
    if (key === todayKey) cls.push("db-is-today");
    cells.push(`
      <div class="${cls.join(" ")}" ${hasTrades ? `data-day-key="${key}"` : ""}>
        <span class="db-cal-day-num">${day}</span>
        ${hasTrades ? `<span class="db-cal-day-pl">${fmtMoney(entry.pl)}</span><span class="db-cal-day-count">${entry.count} trade${entry.count === 1 ? "" : "s"}</span>` : ""}
      </div>`);
  }
  const grid = byId("db-cal-grid");
  grid.innerHTML = cells.join("");
  grid.querySelectorAll("[data-day-key]").forEach(cell => {
    cell.addEventListener("click", () => openDayModal(cell.getAttribute("data-day-key")));
  });
}

function renderCalendarWeek(calMap) {
  const ref = state.calRefDate;
  const day = (ref.getDay() + 6) % 7; // Monday = 0
  const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - day);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  byId("db-cal-title").textContent = `${fmtDateShort(start)} – ${fmtDateShort(end)}`;

  const rows = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = dateKey(d);
    const entry = calMap.get(key);
    const hasTrades = !!(entry && entry.count > 0);
    rows.push(`
      <div class="db-cal-week-row" ${hasTrades ? `data-day-key="${key}"` : ""} style="${hasTrades ? "" : "opacity:.55;cursor:default;"}">
        <div>
          <div class="db-cal-week-date">${d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</div>
          <div class="db-cal-week-meta">${hasTrades ? `${entry.count} trade${entry.count === 1 ? "" : "s"} · ${entry.wins}W / ${entry.losses}L${entry.be ? ` / ${entry.be}BE` : ""}` : "No trades"}</div>
        </div>
        <div class="db-num ${hasTrades ? plClass(entry.pl) : "db-neu"}">${hasTrades ? fmtMoney(entry.pl) : "—"}</div>
      </div>`);
  }
  const list = byId("db-cal-week-list");
  list.innerHTML = rows.join("");
  list.querySelectorAll("[data-day-key]").forEach(row => row.addEventListener("click", () => openDayModal(row.getAttribute("data-day-key"))));
}

function renderCalendarYear(calMap) {
  const ref = state.calRefDate;
  const year = ref.getFullYear();
  byId("db-cal-title").textContent = String(year);

  const tiles = [];
  for (let m = 0; m < 12; m++) {
    const monthName = new Date(year, m, 1).toLocaleDateString("en-US", { month: "long" });
    let pl = 0, count = 0;
    for (const [key, entry] of calMap.entries()) {
      const d = entry.date;
      if (d.getFullYear() === year && d.getMonth() === m) { pl += entry.pl; count += entry.count; }
    }
    tiles.push(`
      <div class="db-cal-year-tile" data-month="${m}">
        <span class="db-cal-year-tile-name">${monthName}</span>
        <span class="db-cal-year-tile-pl ${count ? plClass(pl) : "db-neu"}">${count ? fmtMoney(pl) : "—"}</span>
        <span class="db-cal-year-tile-meta">${count} trade${count === 1 ? "" : "s"}</span>
      </div>`);
  }
  const grid = byId("db-cal-year-grid");
  grid.innerHTML = tiles.join("");
  grid.querySelectorAll("[data-month]").forEach(tile => {
    tile.addEventListener("click", () => {
      const m = Number(tile.getAttribute("data-month"));
      state.calRefDate = new Date(year, m, 1);
      state.calView = "month";
      $all("#db-cal-view-switch button").forEach(b => b.classList.remove("db-active"));
      $(`#db-cal-view-switch [data-view="month"]`).classList.add("db-active");
      byId("db-cal-month-view").hidden = false;
      byId("db-cal-week-view").hidden = true;
      byId("db-cal-year-view").hidden = true;
      renderCalendar();
    });
  });
}

/* -----------------------------------------------------------------
   15. DAY MODAL
   ----------------------------------------------------------------- */
function openDayModal(key) {
  state.activeDayKey = key;
  const [y, m, d] = key.split("-").map(Number);
  const dayDate = new Date(y, m - 1, d);
  const dayTrades = state.rawTrades.filter(t => t.tradeDate && dateKey(t.tradeDate) === key);

  byId("db-day-modal-title").textContent = fmtDateLabel(dayDate);
  const pl = dayTrades.reduce((s, t) => s + t.profitLoss, 0);
  const wins = dayTrades.filter(t => t.result === "WIN").length;
  const decisive = dayTrades.filter(t => t.result !== "BREAK-EVEN").length;

  setStat("db-day-pl", fmtMoney(pl), plClass(pl));
  setStat("db-day-count", String(dayTrades.length));
  setStat("db-day-winrate", decisive ? fmtPct((wins / decisive) * 100) : "—");

  const list = byId("db-day-trades-list");
  if (dayTrades.length === 0) {
    list.innerHTML = `<div class="db-day-empty">No trades recorded for this day.</div>`;
  } else {
    list.innerHTML = dayTrades.map(t => `
      <div class="db-trade-row">
        <div class="db-trade-row-top">
          <span class="db-trade-row-symbol">
            ${escapeHtml(t.instrument)}
            <span class="db-pill ${t.direction === "SHORT" ? "db-pill-short" : "db-pill-long"}">${t.direction}</span>
          </span>
          <span class="db-trade-row-pl ${plClass(t.profitLoss)}">${fmtMoney(t.profitLoss)}</span>
        </div>
        <div class="db-trade-row-meta">
          ${t.entryTime ? `<span>Entry ${escapeHtml(t.entryTime)}</span>` : ""}
          ${t.entryPrice !== null ? `<span>@ ${escapeHtml(String(t.entryPrice))}</span>` : ""}
          ${t.session ? `<span>${escapeHtml(t.session)}</span>` : ""}
          ${t.strategy ? `<span>${escapeHtml(t.strategy)}</span>` : ""}
          ${t.riskReward ? `<span>${escapeHtml(t.riskReward)}</span>` : ""}
          <span>${t.result === "WIN" ? "Win" : t.result === "LOSS" ? "Loss" : "Break-even"}</span>
        </div>
      </div>`).join("");
  }
  openModal("db-day-modal");
}

/* -----------------------------------------------------------------
   16. THEME REACTIVITY — redraw charts if the shared toggle flips theme
   ----------------------------------------------------------------- */
function watchTheme() {
  const observer = new MutationObserver(() => {
    if (!state.echarts) return;
    const acc = currentAccount();
    if (!acc) return;
    const filtered = filterTrades(state.rawTrades, state.dateRange);
    const stats = calculateStatistics(filtered, acc.initialBalance, state.rawTrades);
    renderEquityChart(stats.equityPoints);
    renderDailyChart(filtered);
    renderDrawdownChart(stats.ddPoints);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-eva-theme"] });
}

/* -----------------------------------------------------------------
   17. REFRESH BUTTON
   ----------------------------------------------------------------- */
function wireRefreshButton() {
  const btn = byId("db-refresh-btn");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      // Firestore listeners are already realtime; this re-reads once for an
      // immediate confirmation and re-renders synchronously from the cache.
      if (state.selectedAccountId) {
        await getDocs(collection(db, "users", state.uid, "accounts", state.selectedAccountId, "trades"));
      }
      recomputeAndRender();
      showToast("Dashboard refreshed.", "success");
    } catch (err) {
      showToast(friendlyFirebaseError(err), "error");
    } finally {
      btn.disabled = false;
    }
  });
}

/* -----------------------------------------------------------------
   18. WELCOME NAME
   ----------------------------------------------------------------- */
async function loadUsername(authUser) {
  state.username = authUser.displayName || (authUser.email ? authUser.email.split("@")[0] : "Trader");
  const h1 = byId("db-welcome");
  if (h1) h1.textContent = `Welcome, ${state.username}`;
}

/* -----------------------------------------------------------------
   19. BOOT
   ----------------------------------------------------------------- */
async function boot() {
  await waitForElement("#db-root");

  wireAccountSelector();
  wireDateFilter();
  wireModals();
  wireCalendarControls();
  wireRefreshButton();
  window.addEventListener("resize", resizeAllCharts);
  watchTheme();

  loadECharts().then((ec) => {
    state.echarts = ec;
    recomputeAndRenderIfReady();
  }).catch(() => {
    showToast("Charts couldn't load — statistics and calendar still work.", "error");
  });

  onAuthStateChanged(auth, (user) => {
    if (!user) { window.location.href = "login.html"; return; }
    state.uid = user.uid;
    loadUsername(user);
    subscribeAccounts();
  });
}

function recomputeAndRenderIfReady() {
  if (state.selectedAccountId) recomputeAndRender();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
