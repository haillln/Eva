/* =====================================================================
   EVA DASHBOARD — Phase 2 data engine
   =====================================================================
   ASSUMED FIRESTORE SCHEMA (see note below):
     users/{uid}/accounts/{accountId}
       name, startingBalance, status, createdAt,
       accountType/source/journalAccount marker identifying a JOURNAL account
     users/{uid}/accounts/{accountId}/trades/{tradeId}
       symbol, direction, entry, exit, stopLoss, takeProfit, lotSize,
       risk, pnl (or profitLoss/pl), result ('win'|'loss'|'be'),
       rMultiple, openTime/closeTime (or date), session, strategy, notes

   Dashboard is JOURNAL-ONLY. Challenge accounts must never appear here.
   Journal accounts are identified by an explicit journal marker on the
   Firestore account document; this avoids guessing from names/status/type.
   The existing users/{uid}/accounts/{accountId}/trades/{tradeId} paths remain unchanged.
   ===================================================================== */
(function () {
  const wrap = document.getElementById('eva-dashboard');
  if (!wrap) return;

  const COLLECTION_PATHS = {
    accounts: (uid) => ['users', uid, 'accounts'],
    trades: (uid, accountId) => ['users', uid, 'accounts', accountId, 'trades'],
  };

  /* ================= STATE — single source of truth ================= */
  const state = {
    uid: null,
    accounts: [],          // [{id, name, startingBalance, status, rules}]
    selectedAccountId: null,
    trades: [],             // normalized trades for selected account
    filteredTrades: [],
    dateRange: { type: 'today', start: null, end: null },
    filters: { strategy: '', session: '', result: '', symbol: '' },
    calendarCursor: (() => { const d = new Date(); d.setDate(1); return d; })(),
    dashboardMetrics: null,
    unsubscribeTrades: null,
    unsubscribeAccounts: null,
  };

  /* ============================ DOM refs ============================ */
  const el = {
    acctTrigger: document.getElementById('db-account-trigger'),
    acctPanel: document.getElementById('db-account-panel'),
    acctList: document.getElementById('db-account-list'),
    acctName: wrap.querySelector('[data-value="account-name"]'),
    acctBalance: wrap.querySelector('[data-value="account-balance"]'),
    refreshBtn: document.getElementById('db-refresh-btn'),
    equityChangeAmount: wrap.querySelector('[data-value="equity-change-amount"]'),
    filterRange: document.getElementById('filter-range'),
    filterAccount: document.getElementById('filter-account'),
    filterStrategy: document.getElementById('filter-strategy'),
    filterSession: document.getElementById('filter-session'),
    filterResult: document.getElementById('filter-result'),
    filterSymbol: document.getElementById('filter-symbol'),
    calTitle: document.getElementById('calendar-title'),
    calGrid: document.getElementById('calendar-grid'),
    dayModal: document.getElementById('calendar-day-modal'),
    dayModalDate: document.getElementById('calendar-day-modal-date'),
    dayTradesList: document.getElementById('calendar-day-trades'),
    dayTradeTemplate: document.getElementById('calendar-day-trade-template'),
  };

  function fmtMoney(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const sign = n > 0 ? '+' : n < 0 ? '−' : '';
    return sign + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return n.toFixed(1) + '%';
  }
  function setVal(field, text, cls) {
    wrap.querySelectorAll(`[data-value="${field}"]`).forEach((node) => {
      node.textContent = text;
      node.classList.remove('db-pos', 'db-neg');
      if (cls) node.classList.add(cls);
    });
  }
  function plClass(n) { return n > 0 ? 'db-pos' : n < 0 ? 'db-neg' : ''; }

  /* ===================== 1. TRADE NORMALIZATION ===================== */
  function toMillis(v) {
    if (!v) return null;
    if (typeof v.toMillis === 'function') return v.toMillis(); // Firestore Timestamp
    if (v instanceof Date) return v.getTime();
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }

  function normalizeTrade(id, raw, accountId) {
    // P/L: accept several possible field names, then enforce sign from `result`.
    let pnl = raw.pnl ?? raw.profitLoss ?? raw.pl ?? raw.profit ?? 0;
    pnl = Number(pnl) || 0;

    let result = (raw.result || '').toString().toLowerCase();
    if (!result) {
      if (raw.profit === false || raw.win === false) result = 'loss';
      else if (raw.profit === true || raw.win === true) result = 'win';
      else result = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'be';
    }
    if (result === 'breakeven' || result === 'break-even') result = 'be';

    // Enforce the sign rule: a loss can never be stored/displayed positive.
    if (result === 'loss') pnl = -Math.abs(pnl);
    else if (result === 'win') pnl = Math.abs(pnl);
    else pnl = 0; // break-even

    const closeMs = toMillis(raw.closeTime) ?? toMillis(raw.date) ?? toMillis(raw.openTime);

    return {
      id,
      accountId,
      symbol: raw.symbol ?? '—',
      direction: raw.direction ?? '—',
      entry: raw.entry ?? null,
      exit: raw.exit ?? null,
      stopLoss: raw.stopLoss ?? null,
      takeProfit: raw.takeProfit ?? null,
      lotSize: raw.lotSize ?? null,
      risk: raw.risk ?? null,
      pnl,
      result,
      status: raw.status ?? 'closed',
      rMultiple: raw.rMultiple ?? raw.R ?? null,
      openTimeMs: toMillis(raw.openTime),
      closeTimeMs: closeMs,
      session: raw.session ?? '',
      strategy: raw.strategy ?? '',
      notes: raw.notes ?? '',
    };
  }

  /* ===================== 2. CALCULATIONS (pure) ===================== */
  function computeMetrics(trades, startingBalance) {
    const closed = trades.filter((t) => t.status !== 'open');
    const wins = closed.filter((t) => t.result === 'win');
    const losses = closed.filter((t) => t.result === 'loss');
    const be = closed.filter((t) => t.result === 'be');

    const totalPL = closed.reduce((s, t) => s + t.pnl, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    const balance = (Number(startingBalance) || 0) + totalPL;
    const winRate = closed.length ? (wins.length / closed.length) * 100 : null;
    const avgWin = wins.length ? grossWin / wins.length : null;
    const avgLoss = losses.length ? -grossLoss / losses.length : null;
    const largestWin = wins.length ? Math.max(...wins.map((t) => t.pnl)) : null;
    const largestLoss = losses.length ? Math.min(...losses.map((t) => t.pnl)) : null;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null);
    const rValues = closed.map((t) => t.rMultiple).filter((r) => typeof r === 'number');
    const avgR = rValues.length ? rValues.reduce((a, b) => a + b, 0) / rValues.length : null;

    const { equityCurve, drawdownCurve, maxDrawdown, maxDrawdownPct } = computeEquityAndDrawdown(closed, Number(startingBalance) || 0);
    const dailyPL = computeDailyPL(closed);
    const dailyEntries = Object.entries(dailyPL);
    const bestDay = dailyEntries.length ? dailyEntries.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
    const worstDay = dailyEntries.length ? dailyEntries.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
    const recoveryFactor = maxDrawdown > 0 ? totalPL / maxDrawdown : null;
    const growthPct = startingBalance ? (totalPL / startingBalance) * 100 : null;

    return {
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      breakEven: be.length,
      winRate,
      lossRate: closed.length ? (losses.length / closed.length) * 100 : null,
      totalPL,
      avgWin,
      avgLoss,
      largestWin,
      largestLoss,
      profitFactor,
      avgR,
      balance,
      startingBalance: Number(startingBalance) || 0,
      growthPct,
      maxDrawdown,
      maxDrawdownPct,
      recoveryFactor,
      bestDay,
      worstDay,
      tradingDays: dailyEntries.length,
      equityCurve,
      drawdownCurve,
      dailyPL,
    };
  }

  // Chronological equity curve + RUNNING-PEAK drawdown (never a future max).
  function computeEquityAndDrawdown(closedTrades, startingBalance) {
    const sorted = [...closedTrades].sort((a, b) => (a.closeTimeMs ?? 0) - (b.closeTimeMs ?? 0));
    let equity = startingBalance;
    let runningPeak = startingBalance;
    const equityCurve = [{ timestamp: sorted.length ? sorted[0].closeTimeMs : Date.now(), equity, tradeId: null, pnl: 0 }];
    const drawdownCurve = [];
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;

    for (const t of sorted) {
      equity += t.pnl;
      runningPeak = Math.max(runningPeak, equity);
      const ddMoney = runningPeak - equity;
      const ddPct = runningPeak > 0 ? (ddMoney / runningPeak) * 100 : 0;
      maxDrawdown = Math.max(maxDrawdown, ddMoney);
      maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);
      equityCurve.push({ timestamp: t.closeTimeMs, equity, tradeId: t.id, pnl: t.pnl });
      drawdownCurve.push({ timestamp: t.closeTimeMs, drawdownMoney: ddMoney, drawdownPct: ddPct });
    }
    return { equityCurve, drawdownCurve, maxDrawdown, maxDrawdownPct };
  }

  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function computeDailyPL(closedTrades) {
    const out = {};
    for (const t of closedTrades) {
      if (t.closeTimeMs == null) continue;
      const k = dayKey(t.closeTimeMs);
      out[k] = (out[k] || 0) + t.pnl;
    }
    return out;
  }

  /* ============================ 3. TESTS ============================
     Lightweight runtime self-check of the non-negotiable rules (sign,
     balance, running-peak drawdown). Runs once, logs to console only —
     never shown in the UI. */
  (function selfTest() {
    const trades = [
      normalizeTrade('t1', { pnl: 100, result: 'loss' }, 'x'),   // must become -100
      normalizeTrade('t2', { pnl: 150, result: 'win' }, 'x'),    // +150
      normalizeTrade('t3', { pnl: 0, result: 'be' }, 'x'),       // 0
    ].map((t, i) => ({ ...t, closeTimeMs: i + 1 }));
    const m = computeMetrics(trades, 5000);
    console.assert(trades[0].pnl === -100, 'FAIL: loss sign', trades[0].pnl);
    console.assert(trades[1].pnl === 150, 'FAIL: win sign', trades[1].pnl);
    console.assert(m.balance === 5050, 'FAIL: balance', m.balance);
    console.assert(m.totalPL === 50, 'FAIL: total P/L', m.totalPL);
    console.assert(m.wins === 1 && m.losses === 1 && m.breakEven === 1, 'FAIL: win/loss/be counts');

    const ddTrades = [10200, 10000, 10500, 10300].map((eq, i) => {
      const prev = i === 0 ? 10000 : [10200, 10000, 10500, 10300][i - 1];
      return { id: 'd' + i, pnl: eq - prev, result: (eq - prev) >= 0 ? 'win' : 'loss', status: 'closed', closeTimeMs: i + 1 };
    });
    const dd = computeEquityAndDrawdown(ddTrades, 10000).drawdownCurve.map((d) => Math.round(d.drawdownMoney));
    console.assert(JSON.stringify(dd) === JSON.stringify([0, 200, 0, 200]), 'FAIL: running-peak drawdown', dd);
  })();

  /* ===================== 4. FIRESTORE (dynamic import) =============== */
  let fb = null; // { app, auth, db, fns }
  async function initFirebase() {
    const [{ initializeApp, getApps, getApp }, { getAuth, onAuthStateChanged }, fs] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js'),
    ]);
    const firebaseConfig = {
      apiKey: 'AIzaSyDGh-M9Ps_fy1k8u-r0H899U0L-LQQBKZI',
      authDomain: 'eval-61cd9.firebaseapp.com',
      projectId: 'eval-61cd9',
      storageBucket: 'eval-61cd9.firebasestorage.app',
      messagingSenderId: '843373749164',
      appId: '1:843373749164:web:cc93d5513895ca10065009',
    };
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = fs.getFirestore(app);
    fb = { app, auth, db, fs, onAuthStateChanged };
    return new Promise((resolve) => {
      onAuthStateChanged(auth, (user) => resolve(user));
    });
  }

  function isJournalAccount(acc) {
    if (!acc || typeof acc !== 'object') return false;
    // Explicit journal markers are preferred. Legacy journal accounts are
    // accepted only when they do NOT carry challenge-only fields.
    if (acc.journalAccount === true) return true;
    const type = String(acc.accountType || '').toLowerCase();
    const source = String(acc.source || acc.accountSource || '').toLowerCase();
    if (type === 'journal' || type === 'trading journal' || source === 'journal') return true;
    const challengeFields = ['phaseRules', 'phasesEnabled', 'currentPhase', 'deadline', 'firmName'];
    return !challengeFields.some((key) => Object.prototype.hasOwnProperty.call(acc, key));
  }

  function subscribeAccounts(uid) {
    if (state.unsubscribeAccounts) state.unsubscribeAccounts();
    const { fs, db } = fb;
    const ref = fs.collection(db, ...COLLECTION_PATHS.accounts(uid));
    state.unsubscribeAccounts = fs.onSnapshot(
      ref,
      (snap) => {
        state.accounts = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(isJournalAccount);
        renderAccountSelector();
        if (state.selectedAccountId && !state.accounts.some(a => a.id === state.selectedAccountId)) {
          if (state.unsubscribeTrades) { state.unsubscribeTrades(); state.unsubscribeTrades = null; }
          state.selectedAccountId = null; state.trades = []; state.filteredTrades = [];
        }
        if (!state.selectedAccountId && state.accounts.length) {
          selectAccount(state.accounts[0].id);
        } else if (state.selectedAccountId) {
          renderAccountHeader();
        } else {
          renderEmptyDashboard();
        }
      },
      (err) => console.error('accounts listener failed:', err)
    );
  }

  function subscribeTrades(uid, accountId) {
    if (state.unsubscribeTrades) state.unsubscribeTrades();
    const { fs, db } = fb;
    const ref = fs.collection(db, ...COLLECTION_PATHS.trades(uid, accountId));
    state.unsubscribeTrades = fs.onSnapshot(
      ref,
      (snap) => {
        state.trades = snap.docs.map((d) => normalizeTrade(d.id, d.data(), accountId));
        rebuildDerivedAndRender();
      },
      (err) => console.error('trades listener failed:', err)
    );
  }

  function selectAccount(accountId) {
    state.selectedAccountId = accountId;
    wrap.setAttribute('data-account-id', accountId);
    setAccountPanel(false);
    renderAccountHeader();
    if (fb && state.uid) subscribeTrades(state.uid, accountId);
  }

  /* ===================== 5. ACCOUNT SELECTOR UI ===================== */
  function renderAccountSelector() {
    if (!el.acctList) return;
    if (!state.accounts.length) {
      el.acctList.innerHTML = `<div class="db-empty" style="padding:18px 10px;">
        <svg viewBox="0 0 24 24"><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/></svg>
        <span>No journal accounts yet</span></div>`;
    } else {
      el.acctList.innerHTML = '';
      state.accounts.forEach((acc) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'db-btn';
        btn.style.cssText = 'width:100%; justify-content:space-between; margin-bottom:6px;';
        btn.innerHTML = `<span>${escapeHtml(acc.name || 'Account')}</span><span class="db-label">${escapeHtml(acc.status || '')}</span>`;
        btn.addEventListener('click', () => selectAccount(acc.id));
        el.acctList.appendChild(btn);
      });
    }
    // keep the Account filter <select> in sync
    if (el.filterAccount) {
      const current = el.filterAccount.value;
      el.filterAccount.innerHTML = '<option value="">All accounts</option>' +
        state.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name || a.id)}</option>`).join('');
      el.filterAccount.value = state.accounts.some((a) => a.id === current) ? current : '';
    }
  }

  function renderAccountHeader() {
    const acc = state.accounts.find((a) => a.id === state.selectedAccountId);
    if (el.acctName) el.acctName.textContent = acc ? (acc.name || 'Account') : 'Select account';
    if (el.acctBalance && acc) el.acctBalance.textContent = `Starting ${fmtMoney(Number(acc.startingBalance) || 0)}`;
  }

  function renderEmptyDashboard() {
    ['balance', 'total-pl', 'equity-card', 'win-rate', 'total-trades', 'profit-factor', 'avg-win', 'avg-loss', 'drawdown', 'recovery-factor', 'best-day', 'worst-day', 'equity']
      .forEach((f) => setVal(f, '—'));
    setVal('equity-change-amount', 'No account selected');
  }

  function setAccountPanel(open) {
    el.acctTrigger?.classList.toggle('db-open', open);
    el.acctPanel?.classList.toggle('db-open', open);
    el.acctTrigger?.setAttribute('aria-expanded', String(open));
  }
  el.acctTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    setAccountPanel(!el.acctPanel.classList.contains('db-open'));
  });
  document.addEventListener('click', (e) => {
    if (el.acctPanel && !el.acctPanel.contains(e.target) && e.target !== el.acctTrigger) setAccountPanel(false);
  });

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ========================= 6. FILTERS ============================= */
  function rangeToDates(type) {
    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    if (type === 'today') {
      start.setHours(0, 0, 0, 0);
    } else if (type === 'week') {
      const dow = start.getDay();
      start.setDate(start.getDate() - dow);
      start.setHours(0, 0, 0, 0);
    } else if (type === 'month') {
      start.setDate(1); start.setHours(0, 0, 0, 0);
    } else if (type === 'year') {
      start.setMonth(0, 1); start.setHours(0, 0, 0, 0);
    } else {
      return null; // custom handled separately
    }
    return { start: start.getTime(), end: end.getTime() };
  }

  function applyFilters() {
    let list = state.trades;
    const { type, start, end } = state.dateRange;
    if (type !== 'all') {
      const range = type === 'custom' ? { start: state.dateRange.start, end: state.dateRange.end } : rangeToDates(type);
      if (range && range.start != null && range.end != null) {
        list = list.filter((t) => t.closeTimeMs != null && t.closeTimeMs >= range.start && t.closeTimeMs <= range.end);
      }
    }
    const f = state.filters;
    if (f.strategy) list = list.filter((t) => t.strategy === f.strategy);
    if (f.session) list = list.filter((t) => t.session === f.session);
    if (f.result) list = list.filter((t) => t.result === f.result);
    if (f.symbol) list = list.filter((t) => t.symbol.toLowerCase().includes(f.symbol.toLowerCase()));
    state.filteredTrades = list;
  }

  function populateFilterOptions() {
    const strategies = [...new Set(state.trades.map((t) => t.strategy).filter(Boolean))];
    const sessions = [...new Set(state.trades.map((t) => t.session).filter(Boolean))];
    fillSelect(el.filterStrategy, strategies, 'All strategies');
    fillSelect(el.filterSession, sessions, 'All sessions');
  }
  function fillSelect(select, values, placeholder) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">${placeholder}</option>` + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    select.value = values.includes(current) ? current : '';
  }

  el.filterRange?.querySelectorAll('.db-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.filterRange.querySelectorAll('.db-range-btn').forEach((b) => b.classList.remove('db-active'));
      btn.classList.add('db-active');
      const range = btn.getAttribute('data-range');
      if (range === 'custom') {
        openCustomRangeModal();
      } else {
        state.dateRange = { type: range };
        rebuildDerivedAndRender();
      }
    });
  });
  [el.filterAccount, el.filterStrategy, el.filterSession, el.filterResult].forEach((sel) => {
    sel?.addEventListener('change', () => {
      if (sel === el.filterAccount) {
        if (sel.value && sel.value !== state.selectedAccountId) selectAccount(sel.value);
        return;
      }
      state.filters.strategy = el.filterStrategy?.value || '';
      state.filters.session = el.filterSession?.value || '';
      state.filters.result = el.filterResult?.value || '';
      rebuildDerivedAndRender();
    });
  });
  let symbolDebounce;
  el.filterSymbol?.addEventListener('input', () => {
    clearTimeout(symbolDebounce);
    symbolDebounce = setTimeout(() => {
      state.filters.symbol = el.filterSymbol.value.trim();
      rebuildDerivedAndRender();
    }, 250);
  });

  /* ---- custom date range modal (built in-page; none existed) ---- */
  function ensureCustomRangeModal() {
    if (document.getElementById('custom-range-modal')) return;
    const overlay = document.createElement('div');
    overlay.className = 'db-modal-overlay';
    overlay.id = 'custom-range-modal';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="db-modal" role="dialog" aria-modal="true" aria-labelledby="custom-range-title">
        <div class="db-modal-head">
          <h2 class="db-modal-title" id="custom-range-title">Custom date range</h2>
          <button type="button" class="db-modal-close" data-modal-close aria-label="Close">
            <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="db-modal-body">
          <div class="db-field"><label for="custom-range-start">Start date</label><input type="date" id="custom-range-start"></div>
          <div class="db-field"><label for="custom-range-end">End date</label><input type="date" id="custom-range-end"></div>
        </div>
        <div class="db-modal-foot">
          <button type="button" class="db-btn" data-modal-close>Cancel</button>
          <button type="button" class="db-btn db-btn-primary" id="custom-range-apply">Apply</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', () => closeCustomRangeModal()));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCustomRangeModal(); });
    document.getElementById('custom-range-apply').addEventListener('click', () => {
      const s = document.getElementById('custom-range-start').value;
      const e2 = document.getElementById('custom-range-end').value;
      if (!s || !e2) return;
      const start = new Date(s); start.setHours(0, 0, 0, 0);
      const end = new Date(e2); end.setHours(23, 59, 59, 999);
      state.dateRange = { type: 'custom', start: start.getTime(), end: end.getTime() };
      closeCustomRangeModal();
      rebuildDerivedAndRender();
    });
  }
  function openCustomRangeModal() { ensureCustomRangeModal(); document.getElementById('custom-range-modal').classList.add('db-modal-open'); }
  function closeCustomRangeModal() { document.getElementById('custom-range-modal')?.classList.remove('db-modal-open'); }

  /* ======================= 7. CARDS RENDER =========================== */
  function renderCards(m) {
    setVal('balance', fmtMoney(m.balance));
    setVal('total-pl', fmtMoney(m.totalPL), plClass(m.totalPL));
    setVal('equity-card', fmtMoney(m.balance));
    setVal('equity', fmtMoney(m.balance));
    setVal('win-rate', fmtPct(m.winRate));
    setVal('total-trades', String(m.totalTrades));
    setVal('profit-factor', m.profitFactor == null ? '—' : (m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)));
    setVal('avg-win', fmtMoney(m.avgWin), 'db-pos');
    setVal('avg-loss', fmtMoney(m.avgLoss), 'db-neg');
    setVal('drawdown', fmtMoney(-m.maxDrawdown));
    setVal('recovery-factor', m.recoveryFactor == null ? '—' : m.recoveryFactor.toFixed(2));
    setVal('best-day', m.bestDay ? `${m.bestDay[0]} (${fmtMoney(m.bestDay[1])})` : '—');
    setVal('worst-day', m.worstDay ? `${m.worstDay[0]} (${fmtMoney(m.worstDay[1])})` : '—');

    if (el.equityChangeAmount) {
      el.equityChangeAmount.textContent = m.totalTrades ? `${fmtMoney(m.totalPL)} (${fmtPct(m.growthPct)})` : 'No data yet';
    }
  }

  /* ========================= 8. ECHARTS ============================== */
  const charts = {};
  function themeColors() {
    const cs = getComputedStyle(wrap);
    return {
      text: cs.getPropertyValue('--eva-text').trim() || '#e5e7eb',
      dim: cs.getPropertyValue('--eva-text-dim').trim() || '#94a3b8',
      border: cs.getPropertyValue('--eva-border').trim() || '#334155',
      pos: cs.getPropertyValue('--db-pos').trim() || '#22c55e',
      neg: cs.getPropertyValue('--db-neg').trim() || '#ef4444',
      accent: cs.getPropertyValue('--eva-accent-1').trim() || '#6366f1',
    };
  }

  function getOrInitChart(id) {
    const container = document.getElementById(id);
    if (!container || typeof echarts === 'undefined') return null;
    if (!charts[id]) {
      const empty = container.querySelector('.db-chart-empty');
      let mount = container.querySelector('.db-echart-mount');
      if (!mount) {
        mount = document.createElement('div');
        mount.className = 'db-echart-mount';
        container.appendChild(mount);
      }
      charts[id] = echarts.init(mount);
      charts[id]._container = container;
      charts[id]._emptyEl = empty;
      const ro = new ResizeObserver(() => charts[id].resize());
      ro.observe(container);
      charts[id]._ro = ro;
    }
    return charts[id];
  }
  function toggleChartEmpty(id, isEmpty) {
    const c = charts[id];
    if (!c) return;
    if (c._emptyEl) c._emptyEl.style.display = isEmpty ? 'flex' : 'none';
    c.getDom().style.display = isEmpty ? 'none' : 'block';
  }

  function baseGrid(colors) {
    return { left: 44, right: 16, top: 16, bottom: 28, textStyle: { color: colors.dim } };
  }

  function renderEquityChart(m) {
    const chart = getOrInitChart('equity-chart');
    if (!chart) return;
    if (!m.equityCurve.length || m.totalTrades === 0) { toggleChartEmpty('equity-chart', true); return; }
    toggleChartEmpty('equity-chart', false);
    const colors = themeColors();
    chart.setOption({
      grid: baseGrid(colors),
      tooltip: { trigger: 'axis', valueFormatter: (v) => fmtMoney(v) },
      xAxis: { type: 'time', axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.dim } },
      yAxis: { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: colors.border, opacity: 0.4 } }, axisLabel: { color: colors.dim, formatter: (v) => '$' + v } },
      series: [{
        type: 'line', showSymbol: false, smooth: 0.2, lineStyle: { color: colors.accent, width: 2 },
        areaStyle: { color: colors.accent, opacity: 0.12 },
        data: m.equityCurve.map((p) => [p.timestamp, Math.round(p.equity * 100) / 100]),
      }],
    }, true);
  }

  function renderDailyPLChart(m) {
    const chart = getOrInitChart('daily-pl-chart');
    if (!chart) return;
    const entries = Object.entries(m.dailyPL).sort((a, b) => a[0].localeCompare(b[0]));
    if (!entries.length) { toggleChartEmpty('daily-pl-chart', true); return; }
    toggleChartEmpty('daily-pl-chart', false);
    const colors = themeColors();
    chart.setOption({
      grid: baseGrid(colors),
      tooltip: { trigger: 'axis', valueFormatter: (v) => fmtMoney(v) },
      xAxis: { type: 'category', data: entries.map((e) => e[0]), axisLabel: { color: colors.dim, rotate: 45 }, axisLine: { lineStyle: { color: colors.border } } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: colors.border, opacity: 0.4 } }, axisLabel: { color: colors.dim, formatter: (v) => '$' + v } },
      series: [{
        type: 'bar',
        data: entries.map((e) => ({ value: Math.round(e[1] * 100) / 100, itemStyle: { color: e[1] >= 0 ? colors.pos : colors.neg } })),
      }],
    }, true);
  }

  function renderDrawdownChart(m) {
    const chart = getOrInitChart('drawdown-chart');
    if (!chart) return;
    if (!m.drawdownCurve.length) { toggleChartEmpty('drawdown-chart', true); return; }
    toggleChartEmpty('drawdown-chart', false);
    const colors = themeColors();
    chart.setOption({
      grid: baseGrid(colors),
      tooltip: { trigger: 'axis', valueFormatter: (v) => '-' + fmtMoney(v).replace(/^[+\-]/, '') },
      xAxis: { type: 'time', axisLabel: { color: colors.dim }, axisLine: { lineStyle: { color: colors.border } } },
      yAxis: { type: 'value', inverse: true, splitLine: { lineStyle: { color: colors.border, opacity: 0.4 } }, axisLabel: { color: colors.dim, formatter: (v) => '$' + v } },
      series: [{
        type: 'line', showSymbol: false, lineStyle: { color: colors.neg, width: 2 }, areaStyle: { color: colors.neg, opacity: 0.15 },
        data: m.drawdownCurve.map((p) => [p.timestamp, Math.round(p.drawdownMoney * 100) / 100]),
      }],
    }, true);
  }

  function renderGrowthChart(m) {
    const chart = getOrInitChart('growth-chart');
    if (!chart) return;
    if (!m.equityCurve.length || m.totalTrades === 0) { toggleChartEmpty('growth-chart', true); return; }
    toggleChartEmpty('growth-chart', false);
    const colors = themeColors();
    const data = m.equityCurve.map((p) => [p.timestamp, Math.round((p.equity - m.startingBalance) * 100) / 100]);
    chart.setOption({
      grid: baseGrid(colors),
      tooltip: { trigger: 'axis', valueFormatter: (v) => fmtMoney(v) },
      xAxis: { type: 'time', axisLabel: { color: colors.dim }, axisLine: { lineStyle: { color: colors.border } } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: colors.border, opacity: 0.4 } }, axisLabel: { color: colors.dim, formatter: (v) => '$' + v } },
      series: [{ type: 'line', showSymbol: false, lineStyle: { color: colors.pos, width: 2 }, areaStyle: { color: colors.pos, opacity: 0.12 }, data }],
    }, true);
  }

  function renderChallengeChart(m) {
    const chart = getOrInitChart('challenge-progress-chart');
    if (!chart) return;
    const acc = state.accounts.find((a) => a.id === state.selectedAccountId);
    const target = acc?.rules?.target;
    if (!acc || !target) { toggleChartEmpty('challenge-progress-chart', true); return; }
    toggleChartEmpty('challenge-progress-chart', false);
    const colors = themeColors();
    const progressPct = Math.max(0, Math.min(100, (m.totalPL / Number(target)) * 100));
    chart.setOption({
      series: [{
        type: 'gauge', startAngle: 90, endAngle: -270, radius: '85%',
        pointer: { show: false },
        progress: { show: true, overlap: false, roundCap: true, clip: false, itemStyle: { color: colors.accent } },
        axisLine: { lineStyle: { width: 12, color: [[1, colors.border]] } },
        splitLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false },
        detail: { valueAnimation: true, formatter: () => `${progressPct.toFixed(0)}%`, color: colors.text, fontSize: 22, offsetCenter: [0, 0] },
        data: [{ value: progressPct }],
      }],
    }, true);
  }

  function renderAllCharts(m) {
    renderEquityChart(m);
    renderDailyPLChart(m);
    renderDrawdownChart(m);
    renderGrowthChart(m);
    renderChallengeChart(m);
  }

  // Re-render charts (theme colors) on dark/light toggle — reuses existing theme system.
  new MutationObserver(() => { if (state.dashboardMetrics) renderAllCharts(state.dashboardMetrics); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-eva-theme'] });
  window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));

  /* ========================== 9. CALENDAR ============================ */
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  function pad(n) { return String(n).padStart(2, '0'); }

  function renderCalendar() {
    if (!el.calGrid) return;
    el.calTitle.textContent = monthFmt.format(state.calendarCursor);
    el.calGrid.innerHTML = '';

    const year = state.calendarCursor.getFullYear();
    const month = state.calendarCursor.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
    const dailyPL = state.dashboardMetrics?.dailyPL || {};
    const tradesByDay = {};
    for (const t of state.filteredTrades) {
      if (t.closeTimeMs == null) continue;
      const k = dayKey(t.closeTimeMs);
      (tradesByDay[k] = tradesByDay[k] || []).push(t);
    }

    for (let i = 0; i < firstDow; i++) {
      const empty = document.createElement('div');
      empty.className = 'db-cal-day db-cal-empty';
      el.calGrid.appendChild(empty);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement('div');
      cell.className = 'db-cal-day';
      const isoDate = `${year}-${pad(month + 1)}-${pad(d)}`;
      const pl = dailyPL[isoDate];
      const dayTrades = tradesByDay[isoDate] || [];
      cell.setAttribute('data-date', isoDate);
      cell.setAttribute('data-pl', pl ?? '');
      cell.setAttribute('data-trades', String(dayTrades.length));
      if (isCurrentMonth && d === today.getDate()) cell.classList.add('db-cal-today');
      if (pl != null) cell.classList.add(pl > 0 ? 'db-cal-profit' : pl < 0 ? 'db-cal-loss' : '');

      const dateEl = document.createElement('span');
      dateEl.className = 'db-cal-date';
      dateEl.textContent = String(d);
      cell.appendChild(dateEl);

      if (pl != null) {
        const plEl = document.createElement('span');
        plEl.className = 'db-cal-pl';
        plEl.textContent = fmtMoney(pl);
        cell.appendChild(plEl);
        const countEl = document.createElement('span');
        countEl.className = 'db-cal-trades';
        countEl.textContent = `${dayTrades.length} trade${dayTrades.length === 1 ? '' : 's'}`;
        cell.appendChild(countEl);
      }

      cell.addEventListener('click', () => openDayModal(new Date(year, month, d), isoDate, dayTrades));
      el.calGrid.appendChild(cell);
    }
  }

  document.getElementById('calendar-prev-btn')?.addEventListener('click', () => {
    state.calendarCursor.setMonth(state.calendarCursor.getMonth() - 1);
    renderCalendar();
  });
  document.getElementById('calendar-next-btn')?.addEventListener('click', () => {
    state.calendarCursor.setMonth(state.calendarCursor.getMonth() + 1);
    renderCalendar();
  });
  document.getElementById('calendar-today-btn')?.addEventListener('click', () => {
    state.calendarCursor = new Date(); state.calendarCursor.setDate(1);
    renderCalendar();
  });

  /* ------------------------ Day detail modal ------------------------- */
  function openDayModal(dateObj, isoDate, dayTrades) {
    el.dayModalDate.textContent = dayFmt.format(dateObj);
    const wins = dayTrades.filter((t) => t.result === 'win').length;
    const losses = dayTrades.filter((t) => t.result === 'loss').length;
    const be = dayTrades.filter((t) => t.result === 'be').length;
    const pl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    setVal('day-pl', dayTrades.length ? fmtMoney(pl) : '—', plClass(pl));
    setVal('day-trades', String(dayTrades.length));
    setVal('day-wins', String(wins));
    setVal('day-losses', String(losses));
    setVal('day-be', String(be));

    el.dayTradesList.innerHTML = '';
    if (!dayTrades.length) {
      el.dayTradesList.innerHTML = `<div class="db-empty">
        <svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/></svg>
        <strong>No trades for this day</strong><span>Trades you log for this date will show up here.</span></div>`;
    } else {
      dayTrades.forEach((t) => {
        const frag = el.dayTradeTemplate.content.cloneNode(true);
        frag.querySelector('[data-field="symbol"]').textContent = t.symbol;
        frag.querySelector('[data-field="direction"]').textContent = t.direction;
        frag.querySelector('[data-field="strategy"]').textContent = t.strategy || '—';
        frag.querySelector('[data-field="session"]').textContent = t.session || '—';
        frag.querySelector('[data-field="time"]').textContent = t.closeTimeMs ? new Date(t.closeTimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
        frag.querySelector('[data-field="entry"]').textContent = t.entry ?? '—';
        frag.querySelector('[data-field="exit"]').textContent = t.exit ?? '—';
        frag.querySelector('[data-field="risk"]').textContent = t.risk ?? '—';
        frag.querySelector('[data-field="r-multiple"]').textContent = t.rMultiple ?? '—';
        const plEl = frag.querySelector('[data-field="pl"]');
        plEl.textContent = fmtMoney(t.pnl);
        plEl.classList.add(plClass(t.pnl));
        el.dayTradesList.appendChild(frag);
      });
    }

    el.dayModal.classList.add('db-modal-open');
    el.dayModal.setAttribute('aria-hidden', 'false');
  }
  function closeDayModal() {
    el.dayModal.classList.remove('db-modal-open');
    el.dayModal.setAttribute('aria-hidden', 'true');
  }
  el.dayModal?.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', closeDayModal));
  el.dayModal?.addEventListener('click', (e) => { if (e.target === el.dayModal) closeDayModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDayModal(); });

  /* ==================== 10. REBUILD PIPELINE ========================= */
  function rebuildDerivedAndRender() {
    applyFilters();
    populateFilterOptions();
    const acc = state.accounts.find((a) => a.id === state.selectedAccountId);
    const startingBalance = acc ? Number(acc.startingBalance) || 0 : 0;
    const m = computeMetrics(state.filteredTrades, startingBalance);
    state.dashboardMetrics = m;
    renderCards(m);
    renderAllCharts(m);
    renderCalendar();
    if (el.acctBalance && acc) el.acctBalance.textContent = fmtMoney(m.balance);
  }

  el.refreshBtn?.addEventListener('click', () => {
    if (state.uid && state.selectedAccountId) subscribeTrades(state.uid, state.selectedAccountId);
  });

  /* ============================= BOOT ================================ */
  (async function boot() {
    try {
      const user = await initFirebase();
      if (!user) return; // layout.html's own auth guard redirects to login
      state.uid = user.uid;
      subscribeAccounts(user.uid);
    } catch (err) {
      console.error('Dashboard failed to initialize:', err);
    }
  })();
})();


