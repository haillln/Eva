

/*
 * EVA — FUNDED CHALLENGE COMMAND CENTER
 * challenge.js
 *
 * Firebase v12 module. Designed to work with the existing challenge.html
 * without requiring a framework or a second backend.
 *
 * Firestore base path:
 *   users/{uid}/accounts/{accountId}
 *   users/{uid}/accounts/{accountId}/trades/{tradeId}
 *
 * Optional challenge subcollections (read when rules permit them):
 *   phases, rules, dailyStatus, performance, payouts, alerts, riskManagement
 *
 * IMPORTANT:
 * The supplied Firestore rules explicitly authorize users/{uid}/accounts and
 * the trades subcollection, but not arbitrary challenge subcollections. This
 * file therefore treats the account document + trades as the authoritative
 * minimum data source and gracefully falls back when optional subcollections
 * are denied. Derived dashboard metrics are calculated locally from trades.
 */

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  limit,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

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

const ROOT = "challenge-command-center";
const ACCOUNTS = "accounts";
const TRADES = "trades";
const OPTIONAL = ["phases", "rules", "dailyStatus", "performance", "payouts", "alerts", "riskManagement"];

const state = {
  uid: null,
  user: null,
  accounts: [],
  activeAccountId: null,
  account: null,
  trades: [],
  optional: {},
  unsubscribeTrades: null,
  unsubscribeAccount: null,
  loading: false,
  activeTradeSlot: 1,
  performancePeriod: "month",
  growthPeriod: "month",
  calendarView: "month",
  calendarDate: new Date(),
  explorerLevel: "year",
  explorerValue: new Date().getFullYear().toString(),
  customRange: null,
  riskSettings: null,
  lastMetrics: null
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const root = () => document.getElementById(ROOT);

function n(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function pct(v, fallback = 0) {
  const x = n(v, fallback);
  return Math.abs(x) > 1 ? x : x * 100;
}

function money(v) {
  const x = n(v);
  const sign = x > 0 ? "+" : x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function plainMoney(v) {
  return `$${Math.abs(n(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function number(v, digits = 2) {
  return n(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signedClass(v) { return n(v) >= 0 ? "ch-pos" : "ch-neg"; }

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (v instanceof Timestamp) return v.toDate();
  if (typeof v?.toDate === "function") return v.toDate();
  if (typeof v === "object" && v.seconds) return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDay(v) {
  const d = toDate(v) || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d) { const x = new Date(d); x.setHours(23,59,59,999); return x; }
function startOfWeek(d) { const x = startOfDay(d); const day = x.getDay(); x.setDate(x.getDate() - day); return x; }
function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x; }
function endOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth() + 1, 0); return endOfDay(x); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
function endOfYear(d) { return new Date(d.getFullYear(), 11, 31, 23,59,59,999); }

function getByAliases(obj, aliases, fallback = undefined) {
  for (const key of aliases) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return fallback;
}

function accountStartingBalance(a) {
  return n(getByAliases(a, ["startingBalance", "startBalance", "initialBalance", "accountBalance", "balance"]));
}

function accountCurrentBalance(a) {
  const direct = getByAliases(a, ["currentBalance", "liveBalance"]);
  return direct === undefined ? null : n(direct);
}

function tradePL(t) {
  return n(getByAliases(t, ["profitLoss", "pnl", "pL", "netProfit", "profit", "resultAmount"], 0));
}

function tradeRiskAmount(t) {
  return Math.abs(n(getByAliases(t, ["riskAmount", "risk", "riskMoney", "plannedRisk"], 0)));
}

function tradeRiskPct(t, balance) {
  const direct = getByAliases(t, ["riskPercentage", "riskPercent", "riskPct"]);
  if (direct !== undefined) return Math.abs(pct(direct));
  return balance > 0 ? (tradeRiskAmount(t) / balance) * 100 : 0;
}

function tradeDate(t) {
  return toDate(getByAliases(t, ["tradeDate", "date", "createdAt", "timestamp", "entryTime"]));
}

function tradeResult(t) {
  const raw = String(getByAliases(t, ["result", "status"], "")).toLowerCase();
  if (["win","profit","profitable","winner"].includes(raw)) return "win";
  if (["loss","lose","losing","loser"].includes(raw)) return "loss";
  if (["breakeven","break-even","break_even","be","even"].includes(raw)) return "breakeven";
  const p = tradePL(t);
  return p > 0 ? "win" : p < 0 ? "loss" : "breakeven";
}

function accountRule(a, names, fallback = null) {
  const v = getByAliases(a, names);
  return v === undefined ? fallback : v;
}

function currentPhase(a) {
  return n(getByAliases(a, ["currentPhase", "phase", "activePhase", "currentPhaseNumber"], 1), 1);
}

function challengeType(a) {
  return String(getByAliases(a, ["challengeType", "type", "accountType", "programType"], "Funded Challenge"));
}

function phaseRulesFromAccount(a) {
  const phase = currentPhase(a);
  const phases = a?.phaseRules || a?.phases || {};
  const direct = phases?.[`phase${phase}`] || phases?.[String(phase)] || phases?.[`Phase ${phase}`];
  return direct && typeof direct === "object" ? direct : {};
}

function normalizedRules(a) {
  const p = phaseRulesFromAccount(a);
  const r = a?.rules || {};
  const source = { ...r, ...p, ...a };
  return {
    profitTargetPct: pct(getByAliases(source, ["profitTargetPct", "profitTargetPercent", "targetPercent", "profitTarget"], 0)),
    profitTargetAmount: n(getByAliases(source, ["profitTargetAmount", "targetAmount"], 0)),
    dailyDdPct: pct(getByAliases(source, ["dailyDrawdownPct", "dailyDrawdownPercent", "dailyDDPct", "maxDailyDrawdownPct"], 0)),
    dailyDdAmount: n(getByAliases(source, ["dailyDrawdownAmount", "dailyDD", "maxDailyDrawdown"], 0)),
    overallDdPct: pct(getByAliases(source, ["overallDrawdownPct", "overallDrawdownPercent", "maxOverallDrawdownPct"], 0)),
    overallDdAmount: n(getByAliases(source, ["overallDrawdownAmount", "overallDD", "maxOverallDrawdown"], 0)),
    trailingDdPct: pct(getByAliases(source, ["trailingDrawdownPct", "trailingDrawdownPercent"], 0)),
    trailingDdAmount: n(getByAliases(source, ["trailingDrawdownAmount", "trailingDD"], 0)),
    minTradingDays: n(getByAliases(source, ["minimumTradingDays", "minTradingDays"], 0)),
    maxTradingDays: n(getByAliases(source, ["maximumTradingDays", "maxTradingDays"], 0)),
    maxTradesDay: n(getByAliases(source, ["maxTradesPerDay", "maximumTradesPerDay", "maxTrades"], 0)),
    maxLossesDay: n(getByAliases(source, ["maxLossesPerDay", "maximumLossesPerDay", "stopAfterLosses", "maxConsecutiveLosses"], 0)),
    riskPerTradePct: pct(getByAliases(source, ["riskPerTradePct", "plannedRiskPerTradePct", "defaultRiskPct"], 0)),
    riskPerDayPct: pct(getByAliases(source, ["riskPerDayPct", "plannedRiskPerDayPct", "dailyRiskPct"], 0)),
    consistencyPct: pct(getByAliases(source, ["consistencyPct", "consistencyPercent", "maxProfitDayPct"], 0)),
    payoutSplit: getByAliases(source, ["payoutSplit", "profitSplit"], "80/20"),
    deadline: toDate(getByAliases(source, ["challengeDeadline", "deadline", "endDate"])),
    newsAllowed: Boolean(getByAliases(source, ["newsTradingAllowed", "newsTrading", "allowNews"], true)),
    weekendHolding: Boolean(getByAliases(source, ["weekendHolding", "allowWeekendHolding"], false)),
    hedgingAllowed: Boolean(getByAliases(source, ["hedgingAllowed", "hedging"], false))
  };
}

function calcMetrics(account, trades) {
  const start = accountStartingBalance(account);
  const rules = normalizedRules(account);
  const sorted = [...trades].sort((a,b) => (tradeDate(a)?.getTime() || 0) - (tradeDate(b)?.getTime() || 0));
  const totalPL = sorted.reduce((s,t) => s + tradePL(t), 0);
  const directBalance = accountCurrentBalance(account);
  const balance = directBalance === null ? start + totalPL : directBalance;

  let equity = start;
  let peak = start;
  let maxDdMoney = 0;
  let maxDdPct = 0;
  let wins = 0, losses = 0, be = 0, grossWin = 0, grossLoss = 0;
  let bestWin = 0, worstLoss = 0, riskTotal = 0;
  let currentWinStreak = 0, currentLossStreak = 0, bestWinStreak = 0, bestLossStreak = 0;

  const equityPoints = [{ date: new Date(account?.createdAt ? toDate(account.createdAt) : new Date(0)), balance: start, pl: 0 }];
  for (const t of sorted) {
    const pl = tradePL(t);
    equity += pl;
    peak = Math.max(peak, equity);
    const dd = Math.max(0, peak - equity);
    maxDdMoney = Math.max(maxDdMoney, dd);
    maxDdPct = Math.max(maxDdPct, peak > 0 ? dd / peak * 100 : 0);
    const result = tradeResult(t);
    if (result === "win") { wins++; grossWin += pl; bestWin = Math.max(bestWin, pl); currentWinStreak++; currentLossStreak = 0; bestWinStreak = Math.max(bestWinStreak, currentWinStreak); }
    else if (result === "loss") { losses++; grossLoss += Math.abs(pl); worstLoss = Math.min(worstLoss, pl); currentLossStreak++; currentWinStreak = 0; bestLossStreak = Math.max(bestLossStreak, currentLossStreak); }
    else { be++; currentWinStreak = 0; currentLossStreak = 0; }
    riskTotal += tradeRiskAmount(t);
    const d = tradeDate(t) || new Date();
    equityPoints.push({ date: d, balance: equity, pl });
  }

  const today = new Date();
  const todayKey = isoDay(today);
  const todayTrades = sorted.filter(t => isoDay(tradeDate(t)) === todayKey);
  const todayPL = todayTrades.reduce((s,t) => s + tradePL(t), 0);
  const todayLoss = Math.max(0, -todayPL);
  const todayRisk = todayTrades.reduce((s,t) => s + tradeRiskAmount(t), 0);
  const todayLosses = todayTrades.filter(t => tradeResult(t) === "loss").length;
  const todayRiskPct = start > 0 ? todayRisk / balance * 100 : 0;
  const tradingDays = new Set(sorted.map(t => isoDay(tradeDate(t)))).size;

  const dailyLimit = rules.dailyDdAmount > 0 ? rules.dailyDdAmount : (rules.dailyDdPct > 0 ? start * rules.dailyDdPct / 100 : Infinity);
  const overallLimit = rules.overallDdAmount > 0 ? rules.overallDdAmount : (rules.overallDdPct > 0 ? start * rules.overallDdPct / 100 : Infinity);
  const dailyRemaining = Math.max(0, dailyLimit - todayLoss);
  const overallRemaining = Math.max(0, overallLimit - maxDdMoney);
  const targetAmount = rules.profitTargetAmount > 0 ? rules.profitTargetAmount : (rules.profitTargetPct > 0 ? start * rules.profitTargetPct / 100 : 0);
  const targetProgress = targetAmount > 0 ? Math.max(0, Math.min(100, totalPL / targetAmount * 100)) : 0;
  const dangerOverall = Number.isFinite(overallLimit) && overallLimit > 0 ? Math.min(100, maxDdMoney / overallLimit * 100) : 0;
  const dangerDaily = Number.isFinite(dailyLimit) && dailyLimit > 0 ? Math.min(100, todayLoss / dailyLimit * 100) : 0;
  const danger = Math.max(dangerOverall, dangerDaily);
  const winRate = (wins + losses) ? wins / (wins + losses) * 100 : 0;
  const avgWin = wins ? grossWin / wins : 0;
  const avgLoss = losses ? grossLoss / losses : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const avgRiskPct = trades.length ? trades.reduce((s,t) => s + tradeRiskPct(t, balance), 0) / trades.length : 0;
  const avgR = riskTotal > 0 ? totalPL / riskTotal : 0;

  let consistency = null;
  if (rules.consistencyPct > 0 && totalPL > 0) {
    const byDay = aggregateByDay(sorted);
    const bestDay = Math.max(0, ...Object.values(byDay).map(x => x.pl));
    consistency = bestDay / totalPL * 100;
  }

  const consecutiveLossStop = rules.maxLossesDay > 0 && todayLosses >= rules.maxLossesDay;
  const maxTradesStop = rules.maxTradesDay > 0 && todayTrades.length >= rules.maxTradesDay;
  const dailyDdStop = todayLoss >= dailyLimit && Number.isFinite(dailyLimit);
  const overallDdStop = maxDdMoney >= overallLimit && Number.isFinite(overallLimit);
  const targetReached = targetAmount > 0 && totalPL >= targetAmount;
  const stopTrading = dailyDdStop || overallDdStop || consecutiveLossStop || maxTradesStop;

  const recommendedRisk = calculateRecommendedRisk({ balance, rules, dailyRemaining, overallRemaining, todayRisk, todayTrades: todayTrades.length, todayLosses, targetRemaining: Math.max(0, targetAmount - totalPL), danger });
  const maximumRisk = Math.max(0, Math.min(
    Number.isFinite(dailyRemaining) ? dailyRemaining : Infinity,
    Number.isFinite(overallRemaining) ? overallRemaining : Infinity,
    rules.riskPerTradePct > 0 ? balance * rules.riskPerTradePct / 100 : Infinity
  ));

  return {
    start, balance, totalPL, todayPL, todayLoss, todayRisk, todayRiskPct, todayTrades: todayTrades.length, todayLosses,
    tradingDays, wins, losses, be, totalTrades: sorted.length, winRate, avgWin, avgLoss, bestWin, worstLoss,
    grossWin, grossLoss, profitFactor, avgRiskPct, avgR, maxDdMoney, maxDdPct, bestWinStreak, bestLossStreak,
    dailyLimit, dailyRemaining, overallLimit, overallRemaining, targetAmount, targetProgress, danger, dangerDaily,
    dangerOverall, recommendedRisk, maximumRisk, stopTrading, dailyDdStop, overallDdStop, consecutiveLossStop,
    maxTradesStop, targetReached, consistency, equityPoints, rules, sorted
  };
}

function calculateRecommendedRisk({ balance, rules, dailyRemaining, overallRemaining, todayRisk, todayTrades, todayLosses, targetRemaining, danger }) {
  if (balance <= 0) return 0;
  if (danger >= 90 || dailyRemaining <= 0 || overallRemaining <= 0) return 0;
  if (rules.maxTradesDay > 0 && todayTrades >= rules.maxTradesDay) return 0;
  if (rules.maxLossesDay > 0 && todayLosses >= rules.maxLossesDay) return 0;

  let base = rules.riskPerTradePct > 0 ? balance * rules.riskPerTradePct / 100 : balance * 0.005;
  if (Number.isFinite(dailyRemaining)) base = Math.min(base, dailyRemaining);
  if (Number.isFinite(overallRemaining)) base = Math.min(base, overallRemaining);
  if (rules.riskPerDayPct > 0) {
    const dayBudget = balance * rules.riskPerDayPct / 100;
    base = Math.min(base, Math.max(0, dayBudget - todayRisk));
  }
  if (danger >= 75) base *= 0.5;
  else if (danger >= 60) base *= 0.75;
  if (targetRemaining > 0 && rules.riskPerTradePct === 0 && targetRemaining < base) base = targetRemaining;
  return Math.max(0, base);
}

function aggregateByDay(trades) {
  const out = {};
  for (const t of trades) {
    const key = isoDay(tradeDate(t));
    if (!out[key]) out[key] = { pl: 0, trades: [] };
    out[key].pl += tradePL(t);
    out[key].trades.push(t);
  }
  return out;
}

function aggregateByWeek(trades) {
  const out = {};
  for (const t of trades) {
    const d = startOfWeek(tradeDate(t) || new Date());
    const key = isoDay(d);
    if (!out[key]) out[key] = { start: d, pl: 0, trades: [] };
    out[key].pl += tradePL(t); out[key].trades.push(t);
  }
  return out;
}

function aggregateByMonth(trades) {
  const out = {};
  for (const t of trades) {
    const d = tradeDate(t) || new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    if (!out[key]) out[key] = { start: new Date(d.getFullYear(), d.getMonth(), 1), pl: 0, trades: [] };
    out[key].pl += tradePL(t); out[key].trades.push(t);
  }
  return out;
}

function aggregateByYear(trades) {
  const out = {};
  for (const t of trades) {
    const d = tradeDate(t) || new Date();
    const key = String(d.getFullYear());
    if (!out[key]) out[key] = { start: new Date(d.getFullYear(),0,1), pl: 0, trades: [] };
    out[key].pl += tradePL(t); out[key].trades.push(t);
  }
  return out;
}

function periodFilter(trades, period, custom = null) {
  const now = new Date();
  let start, end;
  if (period === "day") { start = startOfDay(now); end = endOfDay(now); }
  else if (period === "week") { start = startOfWeek(now); end = new Date(start); end.setDate(end.getDate()+6); end = endOfDay(end); }
  else if (period === "year") { start = startOfYear(now); end = endOfYear(now); }
  else if (period === "custom" && custom?.start && custom?.end) { start = startOfDay(custom.start); end = endOfDay(custom.end); }
  else { start = startOfMonth(now); end = endOfMonth(now); }
  return trades.filter(t => { const d = tradeDate(t); return d && d >= start && d <= end; });
}

function showToast(message, kind = "info") {
  let host = document.getElementById("ch-toast-host");
  if (!host) {
    host = document.createElement("div"); host.id = "ch-toast-host";
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:min(420px,calc(100vw - 36px));";
    document.body.appendChild(host);
  }
  const colors = { success: "#16a34a", error: "#dc2626", warning: "#d97706", info: "#4f46e5" };
  const el = document.createElement("div");
  el.textContent = message;
  el.style.cssText = `pointer-events:auto;background:${colors[kind] || colors.info};color:#fff;padding:11px 16px;border-radius:12px;font-size:.82rem;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,.25);`;
  host.appendChild(el);
  setTimeout(() => { el.style.transition = "opacity .25s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 250); }, 3500);
}

function friendlyError(err) {
  const code = err?.code || "";
  console.error("EVA Challenge Firebase error", err);
  if (code.includes("permission-denied")) return "Firebase rejected this action by your Firestore security rules.";
  if (code.includes("unauthenticated")) return "You are not signed in. Please sign in again.";
  if (code.includes("unavailable")) return "Firebase is temporarily unavailable. Check your connection and try again.";
  if (code.includes("failed-precondition")) return "Firebase needs an index or configuration change for this query.";
  return err?.message || "Something went wrong.";
}

function accountRef(accountId) { return doc(db, "users", state.uid, ACCOUNTS, accountId); }
function tradesRef(accountId) { return collection(db, "users", state.uid, ACCOUNTS, accountId, TRADES); }
function optionalRef(accountId, name) { return collection(db, "users", state.uid, ACCOUNTS, accountId, name); }

async function loadAccounts() {
  const snap = await getDocs(collection(db, "users", state.uid, ACCOUNTS));
  state.accounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  state.accounts.sort((a,b) => String(a.name || a.accountName || a.id).localeCompare(String(b.name || b.accountName || b.id), undefined, { numeric: true }));
  if (!state.accounts.length) {
    state.activeAccountId = null;
    state.account = null;
    state.trades = [];
    renderAll();
    showEmptyAccountState();
    return;
  }
  const requested = root()?.dataset.accountId || state.activeAccountId;
  state.activeAccountId = state.accounts.some(a => a.id === requested) ? requested : state.accounts[0].id;
  await switchAccount(state.activeAccountId, false);
}

function subscribeAccount(accountId) {
  if (state.unsubscribeAccount) state.unsubscribeAccount();
  state.unsubscribeAccount = onSnapshot(accountRef(accountId), snap => {
    if (!snap.exists()) return;
    state.account = { id: snap.id, ...snap.data() };
    renderAll();
  }, err => showToast(friendlyError(err), "error"));
}

function subscribeTrades(accountId) {
  if (state.unsubscribeTrades) state.unsubscribeTrades();
  // The query is intentionally simple to avoid requiring a composite index.
  state.unsubscribeTrades = onSnapshot(tradesRef(accountId), snap => {
    state.trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.trades.sort((a,b) => (tradeDate(b)?.getTime() || 0) - (tradeDate(a)?.getTime() || 0));
    renderAll();
  }, err => {
    showToast(friendlyError(err), "error");
    state.trades = [];
    renderAll();
  });
}

async function loadOptionalCollections(accountId) {
  state.optional = {};
  await Promise.all(OPTIONAL.map(async name => {
    try {
      const snap = await getDocs(optionalRef(accountId, name));
      state.optional[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      // Expected with the currently supplied rules. Do not break the dashboard.
      state.optional[name] = [];
    }
  }));
  renderAll();
}

async function switchAccount(accountId, toast = true) {
  if (!state.accounts.some(a => a.id === accountId)) return;
  state.activeAccountId = accountId;
  state.account = state.accounts.find(a => a.id === accountId) || null;
  const el = root(); if (el) el.dataset.accountId = accountId;
  renderAccountList();
  subscribeAccount(accountId);
  subscribeTrades(accountId);
  await loadOptionalCollections(accountId);
  if (toast) showToast("Account switched.", "success");
}

function renderAccountList() {
  const list = document.getElementById("account-list");
  if (!list) return;
  list.innerHTML = "";
  for (const a of state.accounts) {
    const b = accountCurrentBalance(a);
    const start = accountStartingBalance(a);
    const phase = currentPhase(a);
    const btn = document.createElement("button");
    btn.className = `ch-account-item${a.id === state.activeAccountId ? " ch-active" : ""}`;
    btn.dataset.accountId = a.id;
    btn.type = "button";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(a.id === state.activeAccountId));
    btn.innerHTML = `<span class="ch-account-item-info"><span class="ch-account-item-name"></span><span class="ch-account-item-meta"></span></span><span class="ch-pill ${a.status === "failed" || a.status === "breached" ? "ch-pill-warn" : "ch-pill-safe"}"><span class="ch-pill-dot"></span>${escapeHtml(String(a.status || (phase > 1 ? `Phase ${phase}` : "Active")))}</span>`;
    $(".ch-account-item-name", btn).textContent = a.name || a.accountName || a.id;
    $(".ch-account-item-meta", btn).textContent = `${plainMoney(b ?? start)} · ${challengeType(a)} · Phase ${phase}`;
    list.appendChild(btn);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c])); }

function renderHeader(metrics) {
  const a = state.account; if (!a) return;
  const trigger = document.getElementById("ch-account-trigger");
  if (trigger) {
    const name = $(".ch-account-trigger-name", trigger);
    const meta = $(".ch-account-trigger-meta", trigger);
    if (name) name.textContent = a.name || a.accountName || state.activeAccountId;
    if (meta) meta.textContent = `${plainMoney(metrics.start)} ${challengeType(a)} · Phase ${currentPhase(a)}`;
    trigger.setAttribute("aria-expanded", "false");
  }
  const status = document.getElementById("challenge-status");
  const title = document.getElementById("challenge-status-title");
  const desc = document.getElementById("challenge-status-desc");
  const phaseStatus = document.getElementById("phase-status");
  const phasePct = document.getElementById("phase-progress-pct");
  const phase = currentPhase(a);
  let statusTitle = "On Track";
  let statusDesc = `Phase ${phase} · ${metrics.tradingDays} trading days · rules within calculated limits`;
  let stateName = "on-track";
  if (metrics.overallDdStop) { statusTitle = "Account Breached"; statusDesc = "Overall drawdown limit has been reached."; stateName = "danger"; }
  else if (metrics.dailyDdStop) { statusTitle = "Stop Trading"; statusDesc = "Today's daily drawdown limit has been reached."; stateName = "danger"; }
  else if (metrics.stopTrading) { statusTitle = "Trading Paused"; statusDesc = "Your configured trading-stop rule has been triggered."; stateName = "warning"; }
  else if (metrics.targetReached) { statusTitle = `Phase ${phase} Target Reached`; statusDesc = "Profit target reached. Review your firm requirements before marking the phase passed."; stateName = "safe"; }
  else if (metrics.danger >= 75) { statusTitle = "Caution — Drawdown Risk"; statusDesc = `${number(100 - metrics.danger,1)}% drawdown headroom remains before the calculated danger threshold.`; stateName = "warning"; }
  if (status) { status.dataset.state = stateName; status.classList.toggle("ch-status-safe", stateName === "safe" || stateName === "on-track"); status.classList.toggle("ch-glow-safe", stateName === "safe" || stateName === "on-track"); }
  if (title) title.textContent = statusTitle;
  if (desc) desc.textContent = statusDesc;
  if (phaseStatus) phaseStatus.textContent = `Phase ${phase}`;
  if (phasePct) phasePct.textContent = `${number(metrics.targetProgress,0)}%`;
}

function setText(id, value, cls = null) {
  const el = document.getElementById(id); if (!el) return;
  el.textContent = value;
  if (cls) { el.classList.remove("ch-pos","ch-neg"); el.classList.add(cls); }
}

function renderOverview(metrics) {
  setText("current-balance", plainMoney(metrics.balance));
  setText("starting-balance", plainMoney(metrics.start));
  setText("current-profit", money(metrics.totalPL), signedClass(metrics.totalPL));
  setText("today-pl", `Today: ${money(metrics.todayPL)}`, signedClass(metrics.todayPL));
  setText("profit-progress", `${number(metrics.targetProgress,0)}%`);
  const bar = document.getElementById("profit-progress-bar"); if (bar) bar.style.width = `${Math.max(0,Math.min(100,metrics.targetProgress))}%`;
  setText("profit-target", `${plainMoney(metrics.targetAmount)} (${number(metrics.rules.profitTargetPct,0)}%)`);
  setText("today-risk", `${number(metrics.todayRiskPct)}%`);
  const riskBar = document.querySelector("#account-overview .ch-metric-card:nth-child(4) .ch-bar-fill");
  if (riskBar) riskBar.style.width = `${Math.min(100, metrics.rules.riskPerDayPct ? metrics.todayRiskPct / metrics.rules.riskPerDayPct * 100 : metrics.todayRiskPct)}%`;
}

function renderPhase(metrics) {
  const phase = currentPhase(state.account);
  const nodes = $$(".ch-phase-node");
  nodes.forEach(node => {
    const p = n(node.dataset.phase, 0);
    node.classList.remove("ch-phase-active","ch-phase-passed","ch-phase-locked");
    if (p < phase) node.classList.add("ch-phase-passed");
    else if (p === phase) node.classList.add("ch-phase-active");
    else node.classList.add("ch-phase-locked");
    const pctEl = $(".ch-phase-node-stat:nth-of-type(1) b", node);
    if (p === phase && pctEl) pctEl.textContent = `${number(metrics.targetProgress,0)}%`;
  });
}

function renderDrawdown(metrics) {
  const dailyUsedPct = metrics.dailyLimit > 0 && Number.isFinite(metrics.dailyLimit) ? Math.min(100, metrics.todayLoss / metrics.dailyLimit * 100) : 0;
  const overallUsedPct = metrics.overallLimit > 0 && Number.isFinite(metrics.overallLimit) ? Math.min(100, metrics.maxDdMoney / metrics.overallLimit * 100) : 0;
  const danger = Math.max(dailyUsedPct, overallUsedPct);
  setText("daily-dd-used", `${plainMoney(metrics.todayLoss)} / ${plainMoney(metrics.dailyLimit)}`);
  setText("daily-dd-remaining", plainMoney(metrics.dailyRemaining));
  setText("overall-dd-used", `${plainMoney(metrics.maxDdMoney)} / ${plainMoney(metrics.overallLimit)}`);
  setText("overall-dd-remaining", plainMoney(metrics.overallRemaining));
  setText("danger-percentage", `${number(danger,0)}%`);
  const ring = document.getElementById("danger-ring-fill");
  if (ring) {
    const radius = 68; const circumference = 2 * Math.PI * radius;
    ring.style.strokeDasharray = `${circumference}`;
    ring.style.strokeDashoffset = `${circumference * (1 - danger / 100)}`;
    ring.style.stroke = danger >= 90 ? "var(--ch-danger)" : danger >= 70 ? "var(--ch-warn)" : "var(--ch-safe)";
  }
  const pill = document.getElementById("danger-level-pill");
  if (pill) {
    const label = danger >= 90 ? "Danger" : danger >= 70 ? "Warning" : "Safe";
    pill.className = `ch-pill ${danger >= 90 ? "ch-pill-warn" : danger >= 70 ? "ch-pill-warn" : "ch-pill-safe"}`;
    pill.innerHTML = `<span class="ch-pill-dot"></span>${label}`;
  }
  const items = document.querySelectorAll("#danger-zone .ch-danger-breach-item .ch-num");
  if (items[0]) items[0].textContent = plainMoney(metrics.dailyRemaining);
  if (items[1]) items[1].textContent = plainMoney(metrics.overallRemaining);
  const stop = document.getElementById("stop-trading-banner");
  if (stop) stop.classList.toggle("ch-visible", metrics.stopTrading);
}

function renderRisk(metrics) {
  const card = document.getElementById("risk-management"); if (!card) return;
  const rows = $$(".ch-risk-row", card);
  const values = [plainMoney(metrics.balance), plainMoney(metrics.dailyRemaining), plainMoney(metrics.overallRemaining), `${number(metrics.todayRiskPct)}%`, `${number(metrics.rules.riskPerTradePct)}%`, `${number(metrics.rules.riskPerDayPct)}%`, `${metrics.todayTrades} / ${metrics.rules.maxTradesDay || "—"}`, `${metrics.todayLosses} / ${metrics.rules.maxLossesDay || "—"}`];
  rows.forEach((r,i) => { const num = $(".ch-num",r); if (num && values[i] !== undefined) num.textContent = values[i]; });

  setText("recommended-risk", plainMoney(metrics.recommendedRisk));
  setText("maximum-risk", plainMoney(metrics.maximumRisk));
  const foot = document.querySelector("#next-trade .ch-next-trade-stat:first-of-type .ch-metric-foot");
  if (foot) foot.textContent = `${number(metrics.balance > 0 ? metrics.recommendedRisk / metrics.balance * 100 : 0)}% of balance`;
  const status = document.getElementById("next-trade-status");
  if (status) {
    const blocked = metrics.stopTrading || metrics.recommendedRisk <= 0;
    const caution = !blocked && metrics.danger >= 60;
    status.dataset.state = blocked ? "danger" : caution ? "warning" : "safe";
    status.className = `ch-next-trade-status ${blocked ? "ch-pill-danger" : caution ? "ch-pill-warn" : "ch-pill-safe"}`;
    status.innerHTML = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2.4;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>${blocked ? "STOP — Do Not Trade" : caution ? "Caution — Reduced Risk" : "Safe to Trade"}`;
  }
  $$("#trade-slot-tabs .ch-next-trade-tab").forEach(tab => tab.classList.toggle("ch-active", n(tab.dataset.trade) === state.activeTradeSlot));
}

function renderRuleMonitor(metrics) {
  const grid = document.querySelector("#rule-monitor .ch-rule-grid"); if (!grid) return;
  const defs = [
    ["daily-drawdown", "Daily Drawdown", `${plainMoney(metrics.todayLoss)} / ${plainMoney(metrics.dailyLimit)}`, metrics.dailyDdStop ? "danger" : metrics.dangerDaily >= 70 ? "warn" : "safe"],
    ["overall-drawdown", "Overall Drawdown", `${plainMoney(metrics.maxDdMoney)} / ${plainMoney(metrics.overallLimit)}`, metrics.overallDdStop ? "danger" : metrics.dangerOverall >= 70 ? "warn" : "safe"],
    ["profit-target", "Profit Target", `${number(metrics.targetProgress,0)}%`, metrics.targetReached ? "safe" : "progress"],
    ["min-trading-days", "Minimum Trading Days", `${metrics.tradingDays} / ${metrics.rules.minTradingDays || "—"}`, metrics.rules.minTradingDays && metrics.tradingDays < metrics.rules.minTradingDays ? "progress" : "safe"],
    ["max-trades", "Maximum Trades", `${metrics.todayTrades} / ${metrics.rules.maxTradesDay || "—"}`, metrics.maxTradesStop ? "danger" : "safe"],
    ["risk-per-trade", "Risk Per Trade", `${number(metrics.rules.riskPerTradePct)}% · ${metrics.recommendedRisk > 0 ? "Safe" : "Blocked"}`, metrics.recommendedRisk > 0 ? "safe" : "danger"],
    ["daily-risk", "Daily Risk", `${number(metrics.todayRiskPct)}% / ${number(metrics.rules.riskPerDayPct)}%`, metrics.rules.riskPerDayPct && metrics.todayRiskPct >= metrics.rules.riskPerDayPct ? "danger" : "safe"],
    ["consistency", "Consistency", metrics.consistency === null ? "Not enough data" : `${number(metrics.consistency,1)}% of total profit`, metrics.consistency !== null && metrics.rules.consistencyPct > 0 && metrics.consistency > metrics.rules.consistencyPct ? "danger" : "safe"],
    ["news-trading", "News Trading", metrics.rules.newsAllowed ? "Enabled" : "Disabled", metrics.rules.newsAllowed ? "enabled" : "disabled"],
    ["weekend-holding", "Weekend Holding", metrics.rules.weekendHolding ? "Enabled" : "Disabled", metrics.rules.weekendHolding ? "enabled" : "disabled"],
    ["position-size", "Position Size", getByAliases(state.account, ["maxPositionSize","maximumPositionSize","maxLotSize"], "Not configured"), "safe"],
    ["max-losses", "Maximum Losses", `${metrics.todayLosses} / ${metrics.rules.maxLossesDay || "—"}`, metrics.consecutiveLossStop ? "danger" : "safe"]
  ];
  grid.innerHTML = defs.map(([key,name,value,status]) => `<div class="ch-rule-row" data-rule="${key}" data-status="${status}"><span class="ch-rule-name"><span class="ch-rule-dot ${status === "danger" ? "ch-danger" : status === "warn" || status === "progress" ? "ch-warn" : status === "safe" ? "ch-safe" : "ch-neutral"}"></span>${escapeHtml(name)}</span><span class="ch-rule-value">${escapeHtml(String(value))}</span></div>`).join("");
}

function svgPath(points, width, height, padding = 8) {
  if (!points.length) return "";
  const vals = points.map(p => n(p.balance));
  const min = Math.min(...vals); const max = Math.max(...vals); const span = max - min || 1;
  return points.map((p,i) => {
    const x = padding + (width - padding*2) * (i / Math.max(1, points.length-1));
    const y = height - padding - (height - padding*2) * ((n(p.balance)-min)/span);
    return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function filteredEquityPoints(metrics, period) {
  const trades = periodFilter(metrics.sorted, period, state.customRange);
  let balanceBefore = metrics.start;
  const allBefore = metrics.sorted.filter(t => !trades.includes(t));
  if (trades.length) {
    const firstTime = tradeDate(trades[trades.length-1])?.getTime() || Infinity;
    balanceBefore = metrics.start + metrics.sorted.filter(t => (tradeDate(t)?.getTime() || Infinity) < firstTime).reduce((s,t)=>s+tradePL(t),0);
  }
  const points = [{date: trades.length ? (tradeDate(trades[trades.length-1]) || new Date()) : new Date(), balance: balanceBefore, pl:0}];
  let running = balanceBefore;
  [...trades].sort((a,b)=>(tradeDate(a)?.getTime()||0)-(tradeDate(b)?.getTime()||0)).forEach(t=>{running += tradePL(t); points.push({date:tradeDate(t)||new Date(),balance:running,pl:tradePL(t)});});
  return points;
}

function renderChart(id, points, height = 220) {
  const mount = document.getElementById(id); if (!mount) return;
  const svg = $("svg", mount); if (!svg) return;
  const width = 600;
  const path = svgPath(points, width, height, 10);
  const vals = points.map(p=>p.balance); const min = vals.length ? Math.min(...vals) : 0; const max = vals.length ? Math.max(...vals) : 1;
  const span = max-min || 1;
  const area = points.length ? `${path} L ${width-10},${height-10} L 10,${height-10} Z` : "";
  svg.innerHTML = `<defs><linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--eva-accent-1)" stop-opacity=".35"/><stop offset="100%" stop-color="var(--eva-accent-1)" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#${id}-fill)"/><path d="${path}" fill="none" stroke="var(--eva-accent-1)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  mount.dataset.min = min; mount.dataset.max = max; mount.dataset.span = span;
}

function renderCharts(metrics) {
  renderChart("equity-chart", filteredEquityPoints(metrics, state.performancePeriod), 220);
  renderChart("growth-chart", filteredEquityPoints(metrics, state.growthPeriod), 150);
  renderChart("performance-chart", filteredEquityPoints(metrics, state.performancePeriod), 220);
  renderChart("drawdown-chart", metrics.equityPoints.map(p => ({ date:p.date, balance: Math.max(0, metrics.start - (Math.max(...metrics.equityPoints.map(x=>x.balance)) - p.balance)) })), 220);
  renderChart("challenge-progress-chart", filteredEquityPoints(metrics, state.performancePeriod), 220);
}

function renderStatistics(metrics) {
  const section = document.getElementById("performance-statistics"); if (!section) return;
  const items = $$(".ch-stat-item", section);
  const vals = [
    metrics.totalTrades, metrics.wins, metrics.losses, metrics.be, `${number(metrics.winRate,1)}%`, money(metrics.avgWin), `-${plainMoney(metrics.avgLoss)}`, money(metrics.bestWin), `-${plainMoney(Math.abs(metrics.worstLoss))}`,
    Number.isFinite(metrics.profitFactor) ? number(metrics.profitFactor,2) : "∞", `${number(metrics.avgR,2)}R`, money(metrics.totalPL), money(Math.max(0,...Object.values(aggregateByDay(metrics.sorted)).map(x=>x.pl))), money(Math.min(0,...Object.values(aggregateByDay(metrics.sorted)).map(x=>x.pl))), `${number(metrics.maxDdPct,2)}%`, metrics.maxDdMoney > 0 && metrics.totalPL >= 0 ? "Recovery" : "Not recovered", `${number(metrics.avgRiskPct,2)}%`, `${number(metrics.totalTrades ? metrics.avgRiskPct * metrics.totalTrades : 0,2)}%`, metrics.tradingDays
  ];
  items.forEach((item,i)=>{const num=$(".ch-num",item);if(num&&vals[i]!==undefined){num.textContent=vals[i];num.classList.remove("ch-pos","ch-neg");if(i===1||i===4||i===5||i===7||i===11||i===12)num.classList.add("ch-pos");if(i===2||i===6||i===8||i===13)num.classList.add("ch-neg");}});
}

function renderGrowth(metrics) {
  const section = document.getElementById("account-growth"); if (!section) return;
  const values = [metrics.start, metrics.balance, metrics.totalPL, metrics.start > 0 ? metrics.totalPL / metrics.start * 100 : 0];
  const blocks = $$(".ch-grid-4 > div", section).slice(0,4);
  if (blocks[0]) $(".ch-num",blocks[0]).textContent = plainMoney(values[0]);
  if (blocks[1]) $(".ch-num",blocks[1]).textContent = plainMoney(values[1]);
  if (blocks[2]) $(".ch-num",blocks[2]).textContent = money(values[2]);
  if (blocks[3]) $(".ch-num",blocks[3]).textContent = `${number(values[3],2)}%`;
}

function renderTradingDays(metrics) {
  const section = document.getElementById("trading-day-control"); if (!section) return;
  const card = section.querySelector(".ch-grid-2 > .ch-card"); if (!card) return;
  const rows = $$(".ch-risk-row", card);
  const vals = [metrics.tradingDays, metrics.rules.minTradingDays || "—", metrics.rules.maxTradingDays || "—", metrics.rules.deadline ? metrics.rules.deadline.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}) : "—"];
  rows.forEach((r,i)=>{const num=$(".ch-num",r);if(num&&vals[i]!==undefined)num.textContent=vals[i];});
  const dots = $(".ch-trading-days-row",card);
  if (dots) {
    const count = Math.max(metrics.tradingDays, metrics.rules.minTradingDays || 0, 1);
    dots.innerHTML = Array.from({length:Math.min(Math.max(count,12),30)},(_,i)=>`<span class="ch-td-dot ${i < metrics.tradingDays ? "ch-td-done" : ""}">${i+1}</span>`).join("");
  }
}

function renderPayout(metrics) {
  const card = document.getElementById("payout-progress"); if (!card) return;
  const withdraw = n(getByAliases(state.account,["withdrawableProfit","withdrawable","payoutAmount"], Math.max(0,metrics.totalPL)));
  const split = String(metrics.rules.payoutSplit || "80/20");
  const nums = $$(".ch-payout-hero .ch-num",card); if(nums[0])nums[0].textContent=plainMoney(withdraw);
  const rows = $$(".ch-payout-split-row b",card);
  if(rows[0])rows[0].textContent=split;
  if(rows[1])rows[1].textContent=metrics.targetReached?"Review firm payout requirements":"Available after funding";
  if(rows[2])rows[2].textContent=metrics.targetReached?"Potentially Eligible":"Not Eligible";
  const bar=$(".ch-bar-fill",card);if(bar){const target=metrics.targetAmount||1;bar.style.width=`${Math.max(0,Math.min(100,metrics.totalPL/target*100))}%`;}
}

function renderHealth(metrics) {
  const section = document.getElementById("account-health"); if (!section) return;
  const score = Math.round(Math.max(0, Math.min(100, 100 - metrics.danger * 0.65 + (metrics.winRate - 50) * 0.25 - (metrics.todayLosses > 0 ? metrics.todayLosses * 4 : 0))));
  setText("account-health-score", `${score}`);
  const ring = $(".ch-health-ring-fill",section);
  if(ring){const r=48,c=2*Math.PI*r;ring.style.strokeDasharray=`${c}`;ring.style.strokeDashoffset=`${c*(1-score/100)}`;}
  const bars = $$(".ch-health-factor .ch-bar-fill",section);
  bars.forEach((bar,i)=>{const vals=[Math.max(0,100-metrics.danger),Math.min(100,metrics.winRate),Math.max(0,100-(metrics.todayLosses*25)),Math.min(100,metrics.targetProgress)];bar.style.width=`${vals[i] ?? 50}%`;});
}

function renderRulesConfig(metrics) {
  const section = document.getElementById("account-rules-configuration"); if (!section) return;
  const rows = $$(".ch-config-row",section);
  const defs = [
    ["Daily Drawdown", metrics.rules.dailyDdPct ? `Maximum ${number(metrics.rules.dailyDdPct,2)}% of balance` : plainMoney(metrics.dailyLimit), metrics.rules.dailyDdPct > 0 || metrics.rules.dailyDdAmount > 0],
    ["Overall Drawdown", metrics.rules.overallDdPct ? `Maximum ${number(metrics.rules.overallDdPct,2)}% of balance` : plainMoney(metrics.overallLimit), metrics.rules.overallDdPct > 0 || metrics.rules.overallDdAmount > 0],
    ["Trailing Drawdown", metrics.rules.trailingDdPct ? `Maximum ${number(metrics.rules.trailingDdPct,2)}%` : "Not configured", metrics.rules.trailingDdPct > 0 || metrics.rules.trailingDdAmount > 0],
    ["Consistency Rule", metrics.rules.consistencyPct ? `No single day > ${number(metrics.rules.consistencyPct,1)}% of total profit` : "Not configured", metrics.rules.consistencyPct > 0],
    ["Minimum Trading Days", `${metrics.rules.minTradingDays || 0} days required`, metrics.rules.minTradingDays > 0],
    ["Maximum Trades / Day", `${metrics.rules.maxTradesDay || 0} trades`, metrics.rules.maxTradesDay > 0],
    ["News Trading", metrics.rules.newsAllowed ? "Allowed" : "Restricted", metrics.rules.newsAllowed],
    ["Weekend Holding", metrics.rules.weekendHolding ? "Allowed" : "Restricted", metrics.rules.weekendHolding],
    ["Hedging", metrics.rules.hedgingAllowed ? "Permitted" : "Not permitted", metrics.rules.hedgingAllowed],
    ["Stop After Losses", `${metrics.rules.maxLossesDay || 0} losses`, metrics.rules.maxLossesDay > 0]
  ];
  rows.forEach((row,i)=>{if(!defs[i])return;const [name,desc,on]=defs[i];const nameEl=$(".ch-config-name",row);const sw=$(".ch-switch",row);if(nameEl){const span=$("span",nameEl);if(span)span.textContent=desc;nameEl.childNodes[0].nodeValue=name+" ";}if(sw)sw.classList.toggle("ch-on",!!on);});
}

function renderTimeline(metrics) {
  const section = document.getElementById("challenge-timeline"); if (!section) return;
  const phase = currentPhase(state.account);
  const items = $$(".ch-timeline-item",section);
  const statuses = [true, true, true, phase > 1, phase > 1 && metrics.targetReached, String(state.account?.status || "").toLowerCase()==="funded", false];
  items.forEach((item,i)=>{item.classList.toggle("ch-tl-done",!!statuses[i]&&i<phase+1);item.classList.toggle("ch-tl-active",i===phase+1&&!statuses[i]);});
}

function renderAlerts(metrics) {
  const list = $("#account-alert-center .ch-alert-list"); if (!list) return;
  const alerts=[];
  if(metrics.overallDdStop) alerts.push(["danger","Account breached","Overall drawdown limit reached."]);
  else if(metrics.dangerOverall>=75) alerts.push(["warning","Overall drawdown approaching",`${number(metrics.overallRemaining / Math.max(1,metrics.overallLimit)*100,1)}% of overall drawdown remains.`]);
  if(metrics.dailyDdStop) alerts.push(["danger","Daily drawdown reached","Trading should be stopped for today."]);
  else if(metrics.dangerDaily>=70) alerts.push(["warning","Daily drawdown approaching",`${number(metrics.dangerDaily,1)}% of today's limit has been used.`]);
  if(metrics.targetReached) alerts.push(["success","Profit target reached","Review the firm's exact pass conditions before advancing the phase."]);
  if(metrics.consecutiveLossStop) alerts.push(["danger","Loss limit reached",`You've reached ${metrics.todayLosses} losses today.`]);
  if(metrics.maxTradesStop) alerts.push(["danger","Maximum trades reached",`You've reached ${metrics.todayTrades} trades today.`]);
  if(!alerts.length) alerts.push(["success","Account healthy","No calculated risk-control alerts are active."]);
  list.innerHTML=alerts.slice(0,8).map(([kind,title,desc])=>`<div class="ch-alert ch-alert-${kind}"><span class="ch-alert-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></span><div><div class="ch-alert-title">${escapeHtml(title)}</div><div class="ch-alert-desc">${escapeHtml(desc)}</div></div><span class="ch-alert-time">Now</span></div>`).join("");
}

function renderCalendar(metrics) {
  const grid = $("#performance-calendar .ch-cal-grid"); if (!grid) return;
  const d = state.calendarDate;
  const first = new Date(d.getFullYear(),d.getMonth(),1);
  const last = new Date(d.getFullYear(),d.getMonth()+1,0);
  const leading = first.getDay();
  const daily = aggregateByDay(metrics.sorted);
  const cells=[];
  for(let i=0;i<leading;i++) cells.push(`<div class="ch-cal-day ch-cal-empty"></div>`);
  for(let day=1;day<=last.getDate();day++){
    const date=new Date(d.getFullYear(),d.getMonth(),day);const key=isoDay(date);const item=daily[key];const pl=item?.pl||0;
    const cls=pl>0?"ch-cal-profit":pl<0?"ch-cal-loss":"";const today=isoDay(new Date())===key?" ch-cal-today":"";
    cells.push(`<button type="button" class="ch-cal-day ${cls}${today}" data-date="${key}"><span class="ch-cal-date">${day}</span>${item?`<span class="ch-cal-pl">${money(pl)}</span>`:""}</button>`);
  }
  grid.innerHTML=cells.join("");
  const title=$("#performance-calendar .ch-cal-title");if(title)title.textContent=d.toLocaleDateString(undefined,{month:"long",year:"numeric"});
}

function renderExplorer(metrics) {
  const grid=document.getElementById("explorer-grid");if(!grid)return;
  const level=state.explorerLevel;const data=level==="year"?aggregateByYear(metrics.sorted):level==="month"?aggregateByMonth(metrics.sorted):aggregateByDay(metrics.sorted);
  const keys=Object.keys(data).sort();
  grid.innerHTML=keys.length?keys.map(k=>{const x=data[k];const label=level==="month"?new Date(x.start).toLocaleDateString(undefined,{month:"short"}):level==="year"?k:new Date(k+"T00:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric"});return `<button type="button" class="ch-explorer-cell ${x.pl>=0?"ch-pos":"ch-neg"}" data-level="${level==="year"?"month":level==="month"?"week":"day"}" data-value="${escapeHtml(k)}"><span class="ch-explorer-cell-label">${escapeHtml(label)}</span><span class="ch-explorer-cell-value">${money(x.pl)}</span></button>`;}).join(""):`<div class="ch-empty"><strong>No trades yet.</strong><span>Trades will appear here once logged.</span></div>`;
}

function renderAll() {
  if (!state.account) return;
  hideEmptyAccountState();
  const metrics=calcMetrics(state.account,state.trades);state.lastMetrics=metrics;
  renderHeader(metrics);renderOverview(metrics);renderPhase(metrics);renderDrawdown(metrics);renderRisk(metrics);renderRuleMonitor(metrics);renderCharts(metrics);renderStatistics(metrics);renderGrowth(metrics);renderTradingDays(metrics);renderPayout(metrics);renderHealth(metrics);renderRulesConfig(metrics);renderTimeline(metrics);renderAlerts(metrics);renderCalendar(metrics);renderExplorer(metrics);
}

function showEmptyAccountState() {
  const trigger=document.getElementById("ch-account-trigger");if(trigger){$(".ch-account-trigger-name",trigger).textContent="No accounts yet";$(".ch-account-trigger-meta",trigger).textContent="Create an account to begin";}
  ["current-balance","starting-balance","current-profit","today-pl","profit-progress","today-risk","danger-percentage","recommended-risk","maximum-risk"].forEach(id=>setText(id,"—"));
  const overview=document.getElementById("account-overview");if(!overview)return;
  const grid=overview.querySelector(".ch-grid");if(grid)grid.style.display="none";
  if(!document.getElementById("ch-empty-account-cta")){
    const wrap=document.createElement("div");wrap.id="ch-empty-account-cta";wrap.className="ch-card ch-empty";
    wrap.innerHTML=`<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg><strong>No accounts yet.</strong><span>Create a challenge account to start tracking it.</span><button type="button" class="ch-btn ch-btn-primary" id="ch-empty-create-account-btn" style="margin-top:10px;">+ Create Account</button>`;
    overview.appendChild(wrap);
    document.getElementById("ch-empty-create-account-btn")?.addEventListener("click",openCreateAccountModal);
  }
}
function hideEmptyAccountState(){
  const overview=document.getElementById("account-overview");if(!overview)return;
  const grid=overview.querySelector(".ch-grid");if(grid)grid.style.display="";
  document.getElementById("ch-empty-account-cta")?.remove();
}

/* ---------------------------------------------------------------
   ADD TRADE — wires the single real modal already defined in
   challenge.html (#addTradeModalOverlay / #addTradeForm). There is
   intentionally no second button and no second modal created here.
   --------------------------------------------------------------- */
function openTradeModal() {
  if (!state.uid) { showToast("Please sign in first.","warning"); return; }
  if (!state.activeAccountId) { showToast("Create or select a challenge account first.","warning"); return; }
  const overlay=document.getElementById("addTradeModalOverlay");const form=document.getElementById("addTradeForm");
  if(!overlay||!form)return;
  form.reset();
  const dateField=form.elements["date"];if(dateField)dateField.value=new Date().toISOString().slice(0,10);
  const timeField=form.elements["entryTime"];if(timeField){const now=new Date();timeField.value=`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;}
  overlay.classList.add("ch-modal-open");overlay.setAttribute("aria-hidden","false");
  updateModalRiskPreview();
  setTimeout(()=>document.getElementById("instrument")?.focus(),50);
}
function closeTradeModal(){
  const overlay=document.getElementById("addTradeModalOverlay");if(!overlay)return;
  overlay.classList.remove("ch-modal-open");overlay.setAttribute("aria-hidden","true");
  document.getElementById("add-trade-btn")?.focus();
}
function updateModalRiskPreview(){
  const m=state.lastMetrics;const form=document.getElementById("addTradeForm");if(!form)return;
  const risk=n(form.elements["riskAmount"]?.value);const max=m?m.maximumRisk:Infinity;
  const preview=document.getElementById("ch-trade-risk-preview");
  if(!preview){
    const foot=$(".ch-modal-foot",form);
    if(foot){const div=document.createElement("div");div.id="ch-trade-risk-preview";div.className="ch-form-group-full";div.style.cssText="padding:12px 14px;border-radius:12px;background:var(--eva-surface-2);border:1px solid var(--eva-border);font-size:.8rem;line-height:1.5;margin-bottom:14px;";foot.parentElement.insertBefore(div,foot);}
    return;
  }
  if(!m){preview.innerHTML="Risk check: select an account first.";return;}
  const over=Number.isFinite(max)&&max>0&&risk>max;
  preview.innerHTML=over
    ?`<strong style="color:var(--ch-danger)">Risk too high.</strong> Planned ${plainMoney(risk)} vs calculated maximum ${plainMoney(max)}.`
    :`<strong style="color:var(--ch-safe)">${risk>0?"Risk within calculated limit.":"Risk check: enter a risk amount."}</strong> Recommended ${plainMoney(m.recommendedRisk)} · Maximum ${Number.isFinite(max)?plainMoney(max):"—"}.`;
}

async function saveTradeFromModal(e){
  e.preventDefault();
  if (!state.uid || !state.activeAccountId) { showToast("Create or select a challenge account first.","warning"); return; }
  const form=e.currentTarget;const data=Object.fromEntries(new FormData(form).entries());
  const risk=Math.abs(n(data.riskAmount));const max=state.lastMetrics?.maximumRisk ?? Infinity;
  if(Number.isFinite(max)&&max>0&&risk>max){showToast(`Trade risk is above the calculated maximum of ${plainMoney(max)}.`,"warning");return;}
  if(state.lastMetrics?.stopTrading){showToast("Trading is currently blocked by your configured risk rules.","error");return;}
  const instrument=String(data.instrument||"").trim();
  if(!instrument){showToast("Instrument is required.","error");return;}
  if(!data.date){showToast("Trade date is required.","error");return;}
  const dateTimeStr=data.entryTime?`${data.date}T${data.entryTime}`:`${data.date}T00:00`;
  const tradeDateValue=new Date(dateTimeStr);
  if(Number.isNaN(tradeDateValue.getTime())){showToast("Invalid trade date.","error");return;}
  const balance=state.lastMetrics?.balance||0;
  const trade={
    userID:state.uid, accountID:state.activeAccountId,
    tradeNumber:data.tradeNumber?n(data.tradeNumber):null,
    tradeDate:Timestamp.fromDate(tradeDateValue), date:data.date, entryTime:data.entryTime||null,
    symbol:instrument, instrument, direction:data.direction||"long",
    entryPrice:n(data.entryPrice), stopLoss:n(data.stopLoss), takeProfit:n(data.takeProfit),
    riskAmount:risk, riskPercentage:n(data.riskPercentage)||(balance>0?risk/balance*100:0),
    result:data.result||"breakeven", profitLoss:n(data.plAmount),
    notes:String(data.notes||"").trim(), createdAt:serverTimestamp(), updatedAt:serverTimestamp()
  };
  try{
    const ref=await addDoc(tradesRef(state.activeAccountId),trade);
    // Keep an optional last-trade pointer on the account document. This uses the
    // already-authorized account update rule and does not require new subcollection rules.
    await updateDoc(accountRef(state.activeAccountId),{lastTradeId:ref.id,lastTradeAt:serverTimestamp()}).catch(()=>{});
    closeTradeModal();showToast("Trade added.","success");
  }catch(err){showToast(friendlyError(err),"error");}
}

function wireAddTrade(){
  document.getElementById("add-trade-btn")?.addEventListener("click",openTradeModal);
  document.getElementById("addTradeForm")?.addEventListener("submit",saveTradeFromModal);
  document.getElementById("addTradeForm")?.elements["riskAmount"]?.addEventListener("input",updateModalRiskPreview);
  document.addEventListener("click",e=>{
    if(e.target.closest && e.target.closest('[data-modal-close="addTradeModal"]'))closeTradeModal();
    if(e.target.id==="addTradeModalOverlay")closeTradeModal();
  });
}

/* ---------------------------------------------------------------
   CREATE ACCOUNT — writes a brand new document to
   users/{uid}/accounts/{auto-id}. Only fields the user actually
   filled in are stored as enforced rules; blank/zero fields are
   read by normalizedRules() as "not configured" so calcMetrics()
   never flags a rule the trader didn't ask to be monitored.
   --------------------------------------------------------------- */
function openCreateAccountModal(){
  if(!state.uid){showToast("Please sign in first.","warning");return;}
  const overlay=document.getElementById("createAccountModalOverlay");const form=document.getElementById("createAccountForm");
  if(!overlay||!form)return;
  form.reset();
  const startDateField=form.elements["startDate"];if(startDateField)startDateField.value=new Date().toISOString().slice(0,10);
  overlay.classList.add("ch-modal-open");overlay.setAttribute("aria-hidden","false");
  document.getElementById("account-selector")?.querySelector(".ch-account-panel")?.classList.remove("ch-open");
  document.getElementById("ch-account-trigger")?.classList.remove("ch-open");
  setTimeout(()=>document.getElementById("ca-name")?.focus(),50);
}
function closeCreateAccountModal(){
  const overlay=document.getElementById("createAccountModalOverlay");if(!overlay)return;
  overlay.classList.remove("ch-modal-open");overlay.setAttribute("aria-hidden","true");
  document.getElementById("create-account-btn")?.focus();
}

async function saveAccountFromModal(e){
  e.preventDefault();
  if(!state.uid){showToast("Please sign in first.","warning");return;}
  const form=e.currentTarget;const data=Object.fromEntries(new FormData(form).entries());
  const name=String(data.accountName||"").trim();
  const size=n(data.accountSize);
  if(!name){showToast("Account name is required.","error");return;}
  if(!(size>0)){showToast("Account size must be greater than zero.","error");return;}
  const startingBalance=data.startingBalance!==""&&data.startingBalance!==undefined?n(data.startingBalance):size;

  const account={
    name, accountName:name, firmName:String(data.firmName||"").trim(),
    accountType:data.accountType||"Custom", status:data.status||"active",
    accountSize:size, startingBalance,
    currentPhase:n(data.currentPhase,1),
    startDate:data.startDate?Timestamp.fromDate(new Date(`${data.startDate}T00:00:00`)):serverTimestamp(),
    deadline:data.deadline?Timestamp.fromDate(new Date(`${data.deadline}T23:59:59`)):null,
    phasesEnabled:{
      phase1: form.elements["phase1Enabled"]?.checked ?? true,
      phase2: form.elements["phase2Enabled"]?.checked ?? false,
      phase3: form.elements["phase3Enabled"]?.checked ?? false
    },
    rules:{
      profitTargetPct: n(data.profitTargetPct,0),
      dailyDrawdownPct: n(data.dailyDrawdownPct,0),
      overallDrawdownPct: n(data.overallDrawdownPct,0),
      trailingDrawdownPct: n(data.trailingDrawdownPct,0),
      consistencyPct: n(data.consistencyPct,0),
      minimumTradingDays: n(data.minimumTradingDays,0),
      maximumTradingDays: n(data.maximumTradingDays,0),
      maxTradesPerDay: n(data.maxTradesPerDay,0),
      maxLossesPerDay: n(data.maxLossesPerDay,0),
      riskPerTradePct: n(data.riskPerTradePct,0),
      riskPerDayPct: n(data.riskPerDayPct,0),
      payoutSplit: String(data.payoutSplit||"").trim() || null,
      customRuleNote: String(data.customRuleNote||"").trim() || null
    },
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  };

  try{
    const ref=await addDoc(collection(db,"users",state.uid,ACCOUNTS),account);
    closeCreateAccountModal();
    showToast("Account created.","success");
    await loadAccounts();
    await switchAccount(ref.id,false);
  }catch(err){showToast(friendlyError(err),"error");}
}

function wireCreateAccount(){
  document.getElementById("create-account-btn")?.addEventListener("click",openCreateAccountModal);
  document.getElementById("createAccountForm")?.addEventListener("submit",saveAccountFromModal);
  document.addEventListener("click",e=>{
    if(e.target.closest && e.target.closest('[data-modal-close="createAccountModal"]'))closeCreateAccountModal();
    if(e.target.id==="createAccountModalOverlay")closeCreateAccountModal();
  });
}

document.addEventListener("keydown",e=>{
  if(e.key!=="Escape")return;
  const trade=document.getElementById("addTradeModalOverlay");
  const acct=document.getElementById("createAccountModalOverlay");
  if(trade&&trade.classList.contains("ch-modal-open"))closeTradeModal();
  if(acct&&acct.classList.contains("ch-modal-open"))closeCreateAccountModal();
});

function wireAccountSelector(){
  const trigger=document.getElementById("ch-account-trigger");const panel=document.getElementById("ch-account-panel");if(!trigger||!panel)return;
  trigger.addEventListener("click",e=>{
    e.stopPropagation();
    const open=panel.classList.toggle("ch-open");
    trigger.classList.toggle("ch-open",open);
    trigger.setAttribute("aria-expanded",String(open));
  });
  document.addEventListener("click",e=>{
    if(!$("#account-selector")?.contains(e.target)){
      panel.classList.remove("ch-open");trigger.classList.remove("ch-open");trigger.setAttribute("aria-expanded","false");
    }
  });
  document.getElementById("account-list")?.addEventListener("click",e=>{
    const item=e.target.closest("[data-account-id]");
    if(item){switchAccount(item.dataset.accountId);panel.classList.remove("ch-open");trigger.classList.remove("ch-open");trigger.setAttribute("aria-expanded","false");}
  });
}

function wirePeriodSwitches(){
  $$(".ch-period-switch").forEach(sw=>sw.addEventListener("click",e=>{const btn=e.target.closest(".ch-period-btn");if(!btn)return;const p=btn.dataset.period;$$(".ch-period-btn",sw).forEach(x=>x.classList.toggle("ch-active",x===btn));const target=sw.dataset.target;if(target==="growth-chart")state.growthPeriod=p;else state.performancePeriod=p;renderAll();}));
  $$(".ch-cal-view-switch button").forEach(btn=>btn.addEventListener("click",()=>{$$(".ch-cal-view-switch button").forEach(x=>x.classList.remove("ch-active"));btn.classList.add("ch-active");state.calendarView=btn.dataset.view||"month";renderAll();}));
}

function wireCalendar(){
  const section=document.getElementById("performance-calendar");if(!section)return;
  const buttons=$$("button",section);buttons.forEach(btn=>{const label=btn.getAttribute("aria-label");if(label==="Previous month")btn.addEventListener("click",()=>{state.calendarDate.setMonth(state.calendarDate.getMonth()-1);renderAll();});if(label==="Next month")btn.addEventListener("click",()=>{state.calendarDate.setMonth(state.calendarDate.getMonth()+1);renderAll();});});
  $(".ch-cal-grid",section)?.addEventListener("click",e=>{const cell=e.target.closest(".ch-cal-day[data-date]");if(!cell)return;showDayModal(cell.dataset.date);});
}

function showDayModal(key){
  const trades=state.trades.filter(t=>isoDay(tradeDate(t))===key);if(!trades.length){showToast(`No trades on ${key}.`,"info");return;}
  const pl=trades.reduce((s,t)=>s+tradePL(t),0);const details=trades.map((t,i)=>`${i+1}. ${t.symbol||"Trade"} · ${tradeResult(t)} · ${money(tradePL(t))}`).join("\n");
  window.alert(`${key}\nP/L: ${money(pl)}\nTrades: ${trades.length}\n\n${details}`);
}

function wireExplorer(){
  const sec=document.getElementById("performance-explorer");if(!sec)return;
  sec.addEventListener("click",e=>{const btn=e.target.closest(".ch-explorer-cell");if(!btn)return;const next=btn.dataset.level;if(next==="month"){state.explorerLevel="month";state.explorerValue=btn.dataset.value;}else if(next==="week"){state.explorerLevel="week";state.explorerValue=btn.dataset.value;}else{state.explorerLevel="day";state.explorerValue=btn.dataset.value;}renderAll();});
  $$(".ch-explorer-crumbs button",sec).forEach(btn=>btn.addEventListener("click",()=>{state.explorerLevel=btn.dataset.level||"year";renderAll();}));
}

function wireNextTrade(){
  $("#trade-slot-tabs")?.addEventListener("click",e=>{const btn=e.target.closest(".ch-next-trade-tab");if(!btn)return;state.activeTradeSlot=n(btn.dataset.trade,1);renderRisk(state.lastMetrics||calcMetrics(state.account,state.trades));});
  $("#next-trade .ch-btn-icon")?.addEventListener("click",()=>showRiskSettingsModal());
}

function showRiskSettingsModal(){
  const m=state.lastMetrics;if(!m)return;
  const current={riskPerTradePct:m.rules.riskPerTradePct,riskPerDayPct:m.rules.riskPerDayPct,maxTradesDay:m.rules.maxTradesDay,maxLossesDay:m.rules.maxLossesDay};
  const risk=prompt(`Risk per trade % (current ${current.riskPerTradePct})`,String(current.riskPerTradePct));if(risk===null)return;
  const day=prompt(`Daily risk % (current ${current.riskPerDayPct})`,String(current.riskPerDayPct));if(day===null)return;
  const trades=prompt(`Maximum trades/day (current ${current.maxTradesDay})`,String(current.maxTradesDay));if(trades===null)return;
  const losses=prompt(`Stop after losses (current ${current.maxLossesDay})`,String(current.maxLossesDay));if(losses===null)return;
  state.account={...state.account,riskPerTradePct:n(risk),riskPerDayPct:n(day),maxTradesPerDay:n(trades),maxLossesPerDay:n(losses)};
  updateDoc(accountRef(state.activeAccountId),{riskPerTradePct:n(risk),riskPerDayPct:n(day),maxTradesPerDay:n(trades),maxLossesPerDay:n(losses),updatedAt:serverTimestamp()}).then(()=>showToast("Risk settings saved.","success")).catch(err=>showToast(friendlyError(err),"error"));
  renderAll();
}

function exposeAPI(){
  window.EVAChallenge={
    getState:()=>({...state,trades:[...state.trades],accounts:[...state.accounts]}),
    getMetrics:()=>state.lastMetrics,
    refresh:()=>renderAll(),
    openAddTrade:openTradeModal,
    switchAccount:(id)=>switchAccount(id),
    addTrade:(trade)=>addDoc(tradesRef(state.activeAccountId),{...trade,userID:state.uid,accountID:state.activeAccountId,createdAt:serverTimestamp(),updatedAt:serverTimestamp()}),
    deleteTrade:(id)=>deleteDoc(doc(db,"users",state.uid,ACCOUNTS,state.activeAccountId,TRADES,id))
  };
}

async function boot(){
  wireAddTrade();wireCreateAccount();wireAccountSelector();wirePeriodSwitches();wireCalendar();wireExplorer();wireNextTrade();exposeAPI();
  onAuthStateChanged(auth,async user=>{
    if(!user){state.uid=null;state.user=null;showToast("Please sign in to use the Funded Challenge page.","warning");return;}
    state.uid=user.uid;state.user=user;
    try{await loadAccounts();}catch(err){showToast(friendlyError(err),"error");showEmptyAccountState();}
  });
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
