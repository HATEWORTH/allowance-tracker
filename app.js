/* ===== Allowance Tracker (multi-child + admin + cloud sync) ===== */
(() => {
  const STORE_KEY = "allowance-tracker.v1";

  /* ---------- Helpers (early) ---------- */
  const uuid = () =>
    crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const fmt = (n) => "$" + n.toFixed(2).replace(/\.00$/, "");
  const fmtFull = (n) => "$" + n.toFixed(2);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const ordinal = (d) => { const s = ["th","st","nd","rd"], v = d % 100; return d + (s[(v-20)%10] || s[v] || s[0]); };
  const dayName = (d) => ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getDay()];
  const monthName = (d) => ["January","February","March","April","May","June","July","August","September","October","November","December"][d.getMonth()];
  const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const MONTH_INIT = ["J","F","M","A","M","J","J","A","S","O","N","D"];
  const DOW_INIT = ["S","M","T","W","T","F","S"];
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateStamp = (d) => `${pad2(d.getMonth()+1)}.${pad2(d.getDate())}`;
  const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;

  /* ---------- Default state + migration ---------- */
  const defaultChild = () => ({
    id: uuid(),
    name: "Kid",
    emoji: "🧒",
    pinHash: null,
    locked: false,
    weekly: 10,
    payday: 1,
    lastPaydayISO: null,
    goal: { name: "Savings goal", total: 80 },
  });

  const defaultState = () => ({
    children: [defaultChild()],
    txns: [],
    activity: [],
    auth: { parentPin: null, activeRole: null, activeChildId: null },
    familyCode: null,
    syncSkipped: false,
  });

  const migrate = (parsed) => {
    const out = { ...defaultState(), ...parsed };
    out.auth = { ...defaultState().auth, ...(parsed.auth || {}) };
    if (!Array.isArray(parsed.children) || parsed.children.length === 0) {
      const child = {
        ...defaultChild(),
        weekly: parsed.weekly ?? 10,
        payday: parsed.payday ?? 1,
        lastPaydayISO: parsed.lastPaydayISO || null,
        goal: parsed.goal || { name: "Savings goal", total: 80 },
        pinHash: parsed.auth?.childPin || null,
      };
      out.children = [child];
      out.txns = (parsed.txns || []).map(t => ({
        childId: child.id,
        status: "approved",
        submittedBy: "parent",
        ...t,
      }));
    } else {
      out.children = parsed.children.map(c => ({ ...defaultChild(), ...c, goal: { ...defaultChild().goal, ...(c.goal || {}) } }));
      const firstId = out.children[0].id;
      out.txns = (parsed.txns || []).map(t => ({
        status: "approved",
        submittedBy: "parent",
        childId: firstId,
        ...t,
      }));
    }
    out.activity = parsed.activity || [];
    out.familyCode = parsed.familyCode || null;
    out.syncSkipped = !!parsed.syncSkipped;
    delete out.weekly; delete out.payday; delete out.lastPaydayISO; delete out.goal;
    if (out.auth.childPin !== undefined) delete out.auth.childPin;
    return out;
  };

  const load = () => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      return migrate(JSON.parse(raw));
    } catch { return defaultState(); }
  };
  const save = () => localStorage.setItem(STORE_KEY, JSON.stringify(state));
  let state = load();

  /* ---------- Child + txn helpers ---------- */
  const getActiveChild = () => state.children.find(c => c.id === state.auth.activeChildId) || null;
  const ensureActiveChild = () => {
    if (state.auth.activeRole === "child") return;
    if (!getActiveChild() && state.children.length > 0) {
      state.auth.activeChildId = state.children[0].id;
      save();
    }
  };
  const childTxns = (cid) => state.txns.filter(t => t.childId === cid);
  const approvedFor = (cid) => childTxns(cid).filter(t => t.status === "approved");
  const pendingFor = (cid) => childTxns(cid).filter(t => t.status === "pending");
  const balanceFor = (cid) => approvedFor(cid).reduce((b, t) => b + (t.type === "earn" ? t.amount : -t.amount), 0);
  const earnedFor = (cid) => approvedFor(cid).filter(t => t.type === "earn").reduce((a, t) => a + t.amount, 0);
  const spentFor = (cid) => approvedFor(cid).filter(t => t.type === "spend").reduce((a, t) => a + t.amount, 0);
  const savedFor = (cid) => approvedFor(cid).filter(t => t.type === "earn" && t.category === "savings").reduce((a, t) => a + t.amount, 0);
  const goalSavedFor = (c) => Math.min(savedFor(c.id), c.goal.total);
  const nextPaydayFor = (c) => {
    const d = new Date(); let delta = (c.payday - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    const nd = new Date(d); nd.setDate(d.getDate() + delta); return nd;
  };
  const daysSinceLastPaydayFor = (c) => {
    if (!c.lastPaydayISO) return 7;
    const diff = Math.floor((Date.now() - new Date(c.lastPaydayISO).getTime()) / 86400000);
    return Math.max(0, Math.min(7, diff));
  };

  /* ---------- Activity log ---------- */
  const logActivity = (action, details = {}) => {
    const role = state.auth.activeRole;
    let actor = "system";
    if (role === "parent") actor = "Parent";
    else if (role === "child") {
      const c = state.children.find(cc => cc.id === state.auth.activeChildId);
      actor = c ? c.name : "Kid";
    }
    const entry = { id: uuid(), ts: Date.now(), actor, actorRole: role, action, ...details };
    state.activity.push(entry);
    if (state.activity.length > 500) state.activity = state.activity.slice(-500);
    syncActivity(entry);
  };

  /* ---------- PIN hashing ---------- */
  const hashPin = async (pin) => {
    const txt = "allowance-salt-2026::" + pin;
    if (typeof crypto !== "undefined" && crypto.subtle) {
      try {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
        return "sha:" + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      } catch {}
    }
    let h = 0xdeadbeef;
    for (let i = 0; i < txt.length; i++) {
      h = Math.imul(h ^ txt.charCodeAt(i), 0x85ebca6b);
      h = (h ^ (h >>> 13)) >>> 0;
    }
    return "h:" + h.toString(16).padStart(8, "0");
  };

  /* ===========================================================
     SUPABASE SYNC LAYER
     =========================================================== */
  const SB_READY = () => !!(window.sb && state.familyCode);
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const generateFamilyCode = () => {
    let s = ""; for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return s;
  };

  // Convert local in-memory shapes to/from DB rows
  const childToRow = (c) => ({
    id: c.id,
    family_code: state.familyCode,
    name: c.name,
    emoji: c.emoji,
    pin_hash: c.pinHash,
    locked: !!c.locked,
    weekly: c.weekly,
    payday: c.payday,
    last_payday_iso: c.lastPaydayISO,
    goal_name: c.goal?.name || "Savings goal",
    goal_total: c.goal?.total || 0,
    updated_at: new Date().toISOString(),
  });
  const rowToChild = (r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    pinHash: r.pin_hash,
    locked: !!r.locked,
    weekly: parseFloat(r.weekly) || 0,
    payday: r.payday,
    lastPaydayISO: r.last_payday_iso,
    goal: { name: r.goal_name, total: parseFloat(r.goal_total) || 0 },
  });
  const txnToRow = (t) => ({
    id: t.id,
    family_code: state.familyCode,
    child_id: t.childId,
    ts: t.ts,
    type: t.type,
    amount: t.amount,
    category: t.category,
    note: t.note,
    status: t.status,
    submitted_by: t.submittedBy,
    updated_at: new Date().toISOString(),
  });
  const rowToTxn = (r) => ({
    id: r.id,
    childId: r.child_id,
    ts: Number(r.ts),
    type: r.type,
    amount: parseFloat(r.amount) || 0,
    category: r.category,
    note: r.note,
    status: r.status,
    submittedBy: r.submitted_by,
  });
  const activityToRow = (a) => ({
    id: a.id,
    family_code: state.familyCode,
    ts: a.ts,
    actor: a.actor,
    actor_role: a.actorRole,
    action: a.action,
    child_id: a.childId || null,
    txn_id: a.txnId || null,
    summary: a.summary || null,
  });
  const rowToActivity = (r) => ({
    id: r.id,
    ts: Number(r.ts),
    actor: r.actor,
    actorRole: r.actor_role,
    action: r.action,
    childId: r.child_id,
    txnId: r.txn_id,
    summary: r.summary,
  });

  const setSyncIndicator = (status) => {
    // status: "ok" | "syncing" | "error" | "off"
    document.body.dataset.sync = status;
  };

  const syncFamily = async () => {
    if (!SB_READY()) return;
    try {
      setSyncIndicator("syncing");
      await window.sb.from("families").upsert({
        code: state.familyCode,
        parent_pin_hash: state.auth.parentPin,
        updated_at: new Date().toISOString(),
      });
      setSyncIndicator("ok");
    } catch (e) { console.error("sync family", e); setSyncIndicator("error"); }
  };
  const syncChild = async (c) => {
    if (!SB_READY()) return;
    try {
      setSyncIndicator("syncing");
      await window.sb.from("children").upsert(childToRow(c));
      setSyncIndicator("ok");
    } catch (e) { console.error("sync child", e); setSyncIndicator("error"); }
  };
  const syncDeleteChild = async (id) => {
    if (!SB_READY()) return;
    try { await window.sb.from("children").delete().eq("id", id); }
    catch (e) { console.error("delete child", e); }
  };
  const syncTxn = async (t) => {
    if (!SB_READY()) return;
    try {
      setSyncIndicator("syncing");
      await window.sb.from("transactions").upsert(txnToRow(t));
      setSyncIndicator("ok");
    } catch (e) { console.error("sync txn", e); setSyncIndicator("error"); }
  };
  const syncTxnBatch = async (ts) => {
    if (!SB_READY() || !ts.length) return;
    try {
      setSyncIndicator("syncing");
      await window.sb.from("transactions").upsert(ts.map(txnToRow));
      setSyncIndicator("ok");
    } catch (e) { console.error("sync txn batch", e); setSyncIndicator("error"); }
  };
  const syncDeleteTxn = async (id) => {
    if (!SB_READY()) return;
    try { await window.sb.from("transactions").delete().eq("id", id); }
    catch (e) { console.error("delete txn", e); }
  };
  const syncActivity = async (a) => {
    if (!SB_READY()) return;
    try { await window.sb.from("activity").insert(activityToRow(a)); }
    catch (e) { console.error("sync activity", e); }
  };
  const syncClearActivity = async () => {
    if (!SB_READY()) return;
    try { await window.sb.from("activity").delete().eq("family_code", state.familyCode); }
    catch (e) { console.error("clear activity", e); }
  };
  const syncClearAllTxns = async () => {
    if (!SB_READY()) return;
    try { await window.sb.from("transactions").delete().eq("family_code", state.familyCode); }
    catch (e) { console.error("clear txns", e); }
  };

  const hydrateFromSupabase = async () => {
    if (!SB_READY()) return false;
    try {
      setSyncIndicator("syncing");
      const [fam, kids, txns, acts] = await Promise.all([
        window.sb.from("families").select().eq("code", state.familyCode).maybeSingle(),
        window.sb.from("children").select().eq("family_code", state.familyCode),
        window.sb.from("transactions").select().eq("family_code", state.familyCode),
        window.sb.from("activity").select().eq("family_code", state.familyCode).order("ts", { ascending: false }).limit(500),
      ]);
      if (fam.error || kids.error || txns.error || acts.error) {
        console.error("hydrate errors", fam.error, kids.error, txns.error, acts.error);
        setSyncIndicator("error");
        return false;
      }
      if (fam.data && fam.data.parent_pin_hash) state.auth.parentPin = fam.data.parent_pin_hash;
      if (kids.data && kids.data.length) state.children = kids.data.map(rowToChild);
      state.txns = (txns.data || []).map(rowToTxn);
      state.activity = ((acts.data || []).map(rowToActivity)).sort((a, b) => a.ts - b.ts);
      save();
      setSyncIndicator("ok");
      return true;
    } catch (e) {
      console.error("hydrate failed", e); setSyncIndicator("error"); return false;
    }
  };


  /* ===========================================================
     RENDER: DASHBOARD
     =========================================================== */
  const renderDay = () => {
    const d = new Date();
    $("#dayName").textContent = dayName(d);
    $("#dayDate").textContent = `${monthName(d)} ${ordinal(d.getDate())}`;
  };
  const renderBalance = () => {
    const c = getActiveChild(); if (!c) return;
    $("#balanceDisplay").textContent = fmtFull(balanceFor(c.id));
    $("#earnedTotal").textContent = fmt(earnedFor(c.id));
    $("#spentTotal").textContent = fmt(spentFor(c.id));
    $("#savedTotal").textContent = fmt(savedFor(c.id));
  };
  const renderWeek = () => {
    const c = getActiveChild(); if (!c) return;
    $("#weekAmount").textContent = fmt(c.weekly);
    const days = daysSinceLastPaydayFor(c);
    $("#weekFill").style.width = Math.round(days / 7 * 100) + "%";
    $("#weekProgressLabel").textContent = `${days} / 7 days`;
    const np = nextPaydayFor(c);
    $("#nextPaydayLabel").textContent = `Next: ${dayName(np).slice(0,3)} ${np.getDate()}`;
  };
  const renderGoal = () => {
    const c = getActiveChild(); if (!c) return;
    $("#goalName").textContent = c.goal.name;
    const saved = goalSavedFor(c);
    $("#goalSaved").textContent = fmt(saved);
    $("#goalTotal").textContent = `/ ${fmt(c.goal.total)}`;
    const pct = c.goal.total > 0 ? Math.min(100, saved / c.goal.total * 100) : 0;
    $("#goalFill").style.width = pct + "%";
    $("#goalPercent").textContent = Math.round(pct) + "%";
    const remaining = Math.max(0, c.goal.total - saved);
    const weeks = c.weekly > 0 ? Math.ceil(remaining / c.weekly) : 0;
    $("#goalEta").textContent = remaining === 0 ? "Goal reached!" : `~ ${weeks} weeks to go`;
  };
  const renderCatsList = (listEl, totals) => {
    listEl.innerHTML = "";
    const entries = Object.entries(totals);
    if (!entries.length) { listEl.innerHTML = `<li class="cats-empty">No data for this view.</li>`; return; }
    const max = Math.max(...entries.map(e => e[1]));
    entries.sort((a, b) => b[1] - a[1]).forEach(([cat, amt]) => {
      const li = document.createElement("li");
      li.className = "cat";
      li.innerHTML = `<span class="cat-name">${escapeHtml(cat)}</span><span class="cat-bar"><span class="cat-bar-fill" style="width:${(amt/max)*100}%"></span></span><span class="cat-amount">${fmt(amt)}</span>`;
      listEl.appendChild(li);
    });
  };
  const renderCats = () => {
    const c = getActiveChild(); if (!c) return;
    const totals = {};
    approvedFor(c.id).filter(t => t.type === "spend").forEach(t => { totals[t.category] = (totals[t.category] || 0) + t.amount; });
    renderCatsList($("#catsList"), totals);
  };
  const renderCalendar = () => {
    const c = getActiveChild();
    const d = new Date(), year = d.getFullYear(), month = d.getMonth();
    $("#calMonth").textContent = monthName(d);
    $("#calYear").textContent = year;
    const firstCol = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const grid = $("#calGrid"); grid.innerHTML = "";
    for (let i = 0; i < firstCol; i++) { const e = document.createElement("div"); e.className = "cal-cell is-blank"; grid.appendChild(e); }
    for (let day = 1; day <= daysInMonth; day++) {
      const dd = new Date(year, month, day);
      const cell = document.createElement("div");
      cell.className = "cal-cell";
      if (dd.toDateString() === d.toDateString()) cell.classList.add("is-today");
      if (c && dd.getDay() === c.payday) cell.classList.add("is-pay");
      cell.textContent = day;
      grid.appendChild(cell);
    }
  };
  const renderLog = () => {
    const c = getActiveChild();
    const list = $("#logList"); list.innerHTML = "";
    if (!c) return;
    const txns = childTxns(c.id);
    if (!txns.length) { list.innerHTML = `<li class="log-empty">Nothing logged yet.</li>`; return; }
    const isChild = state.auth.activeRole === "child";
    const isParent = state.auth.activeRole === "parent";
    [...txns].sort((a, b) => b.ts - a.ts).forEach(t => {
      const status = t.status || "approved";
      const d = new Date(t.ts);
      const li = document.createElement("li");
      li.className = `log-item log-item--${status}` + (isParent ? " log-item--editable" : "");
      const sign = t.type === "earn" ? "+" : "−";
      const amtClass = t.type === "earn" ? "log-amt--plus" : "log-amt--minus";
      const badge =
        status === "pending" ? `<span class="status-badge status-badge--pending">Pending</span>` :
        status === "rejected" ? `<span class="status-badge status-badge--rejected">Rejected</span>` : "";
      const canWithdraw = status === "pending" && t.submittedBy === "child" && isChild;
      const withdraw = canWithdraw ? ` <button class="pill pill--withdraw" data-withdraw="${t.id}" type="button">Withdraw</button>` : "";
      const editAttr = isParent ? ` data-edit-txn="${t.id}"` : "";
      li.innerHTML = `
        <span class="log-date">${dateStamp(d)}</span>
        <span class="log-label"${editAttr}>${escapeHtml(t.note || (t.type === "earn" ? "Earned" : "Spent"))}${badge}${withdraw}</span>
        <span class="log-cat">${escapeHtml(t.category)}</span>
        <span class="log-amt ${amtClass}"${editAttr}>${sign}${fmt(t.amount)}</span>`;
      list.appendChild(li);
    });
  };

  /* ---------- Approvals + pending ---------- */
  const renderApprovals = () => {
    const c = getActiveChild();
    const card = $("#approvalsCard"), list = $("#approvalsList"),
          count = $("#approvalsCount"), all = $("#approveAllBtn"), rej = $("#rejectAllBtn");
    if (state.auth.activeRole !== "parent" || !c) { card.hidden = true; return; }
    const pending = pendingFor(c.id);
    if (!pending.length) { card.hidden = true; return; }
    card.hidden = false;
    count.textContent = `${pending.length} pending · ${c.emoji} ${c.name}`;
    all.hidden = rej.hidden = pending.length < 2;
    list.innerHTML = "";
    pending.slice().sort((a, b) => b.ts - a.ts).forEach(t => {
      const d = new Date(t.ts);
      const sign = t.type === "earn" ? "+" : "−";
      const li = document.createElement("li"); li.className = "approval";
      li.innerHTML = `
        <span class="approval-date">${dateStamp(d)}</span>
        <span class="approval-label">${escapeHtml(t.note || (t.type === "earn" ? "Earned" : "Spent"))}<span class="approval-cat">${escapeHtml(t.category)} · by ${escapeHtml(t.submittedBy)}</span></span>
        <span class="approval-amt approval-amt--${t.type}">${sign}${fmt(t.amount)}</span>
        <div class="approval-actions">
          <button class="pill pill--approve" data-approve="${t.id}" type="button">Approve</button>
          <button class="pill pill--reject" data-reject="${t.id}" type="button">Reject</button>
          <button class="pill pill--withdraw" data-edit-txn="${t.id}" type="button">Edit</button>
        </div>`;
      list.appendChild(li);
    });
  };
  const renderPending = () => {
    const c = getActiveChild();
    const card = $("#pendingCard"), list = $("#pendingList"), count = $("#pendingCount");
    if (state.auth.activeRole !== "child" || !c) { card.hidden = true; return; }
    const mine = pendingFor(c.id).filter(t => t.submittedBy === "child");
    if (!mine.length) { card.hidden = true; return; }
    card.hidden = false;
    count.textContent = `${mine.length} waiting`;
    list.innerHTML = "";
    mine.slice().sort((a, b) => b.ts - a.ts).forEach(t => {
      const d = new Date(t.ts);
      const sign = t.type === "earn" ? "+" : "−";
      const li = document.createElement("li"); li.className = "approval";
      li.innerHTML = `
        <span class="approval-date">${dateStamp(d)}</span>
        <span class="approval-label">${escapeHtml(t.note || (t.type === "earn" ? "Earned" : "Spent"))}<span class="approval-cat">${escapeHtml(t.category)}</span></span>
        <span class="approval-amt approval-amt--${t.type}">${sign}${fmt(t.amount)}</span>
        <div class="approval-actions"><button class="pill pill--withdraw" data-withdraw="${t.id}" type="button">Withdraw</button></div>`;
      list.appendChild(li);
    });
  };

  /* ---------- Insights ---------- */
  let currentPeriod = "week";
  const aggregateBuckets = (period, cid) => {
    const buckets = []; const now = new Date();
    if (period === "week") {
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0,0,0,0);
        const end = new Date(d); end.setHours(23,59,59,999);
        buckets.push({ label: DOW_INIT[d.getDay()], start: d.getTime(), end: end.getTime() });
      }
    } else if (period === "month") {
      const y = now.getFullYear(), m = now.getMonth(), last = new Date(y, m+1, 0).getDate();
      for (let day = 1; day <= last; day++) {
        const d = new Date(y, m, day, 0,0,0,0);
        const end = new Date(y, m, day, 23,59,59,999);
        buckets.push({ label: String(day), start: d.getTime(), end: end.getTime() });
      }
    } else {
      const y = now.getFullYear();
      for (let m = 0; m < 12; m++) {
        const d = new Date(y, m, 1);
        const end = new Date(y, m+1, 0, 23,59,59,999);
        buckets.push({ label: MONTH_INIT[m], start: d.getTime(), end: end.getTime() });
      }
    }
    const approved = approvedFor(cid);
    buckets.forEach(b => {
      b.earned = 0; b.spent = 0;
      approved.forEach(t => {
        if (t.ts >= b.start && t.ts <= b.end) {
          if (t.type === "earn") b.earned += t.amount; else b.spent += t.amount;
        }
      });
    });
    return buckets;
  };
  const runningBalanceForBuckets = (buckets, cid) => {
    const sorted = [...approvedFor(cid)].sort((a,b) => a.ts - b.ts);
    return buckets.map(b => {
      let bal = 0;
      for (const t of sorted) { if (t.ts <= b.end) bal += t.type === "earn" ? t.amount : -t.amount; else break; }
      return { label: b.label, balance: bal };
    });
  };
  const renderBarChart = (svgEl, data) => {
    const W = 600, H = 220, P = 28, PB = 28, PT = 14;
    const innerW = W - P*2, innerH = H - PB - PT;
    const max = Math.max(0.01, ...data.flatMap(d => [d.earned, d.spent]));
    const group = innerW / data.length;
    const barW = Math.max(2, Math.min(18, (group - 4) / 2));
    let svg = `<g transform="translate(${P},${PT})">`;
    for (let i = 1; i <= 3; i++) { const y = innerH * (i/4); svg += `<line class="grid-line" x1="0" y1="${y}" x2="${innerW}" y2="${y}"/>`; }
    const labelStep = Math.max(1, Math.ceil(data.length / 16));
    data.forEach((d, i) => {
      const cx = group * (i + 0.5);
      const eh = (d.earned / max) * innerH;
      const sh = (d.spent / max) * innerH;
      svg += `<rect x="${cx-barW-1}" y="${innerH-eh}" width="${barW}" height="${eh}" fill="#0a6b2e" rx="2"/>`;
      svg += `<rect x="${cx+1}" y="${innerH-sh}" width="${barW}" height="${sh}" fill="#a01818" rx="2"/>`;
      if (i % labelStep === 0 || i === data.length - 1)
        svg += `<text class="axis-label" x="${cx}" y="${innerH+16}" text-anchor="middle">${d.label}</text>`;
    });
    svg += `</g>`;
    svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svgEl.innerHTML = svg;
  };
  const renderLineChart = (svgEl, data) => {
    const W = 600, H = 220, P = 28, PB = 28, PT = 14;
    const innerW = W - P*2, innerH = H - PB - PT;
    const vals = data.map(d => d.balance);
    let min = Math.min(0, ...vals), max = Math.max(1, ...vals);
    if (max === min) max = min + 1;
    const xStep = data.length > 1 ? innerW / (data.length - 1) : 0;
    const x = (i) => i * xStep;
    const y = (v) => innerH - ((v - min) / (max - min)) * innerH;
    let svg = `<g transform="translate(${P},${PT})">`;
    for (let i = 1; i <= 3; i++) { const yy = innerH * (i/4); svg += `<line class="grid-line" x1="0" y1="${yy}" x2="${innerW}" y2="${yy}"/>`; }
    const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.balance).toFixed(1)}`).join(" ");
    const area = `0,${innerH} ${pts} ${x(data.length-1).toFixed(1)},${innerH}`;
    svg += `<polygon points="${area}" fill="currentColor" fill-opacity="0.18"/>`;
    svg += `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    data.forEach((d, i) => svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(d.balance).toFixed(1)}" r="3" fill="currentColor"/>`);
    const labelStep = Math.max(1, Math.ceil(data.length / 8));
    data.forEach((d, i) => {
      if (i % labelStep === 0 || i === data.length - 1)
        svg += `<text class="axis-label" x="${x(i).toFixed(1)}" y="${innerH+16}" text-anchor="middle">${d.label}</text>`;
    });
    svg += `</g>`;
    svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svgEl.innerHTML = svg;
  };
  const renderInsights = () => {
    const c = getActiveChild(); if (!c) return;
    const buckets = aggregateBuckets(currentPeriod, c.id);
    const totalE = buckets.reduce((a, b) => a + b.earned, 0);
    const totalS = buckets.reduce((a, b) => a + b.spent, 0);
    const net = totalE - totalS;
    $("#periodLabel").textContent = currentPeriod;
    $("#iEarned").textContent = fmt(totalE);
    $("#iSpent").textContent = fmt(totalS);
    $("#iNet").textContent = (net >= 0 ? "+" : "−") + fmt(Math.abs(net));
    const first = buckets[0], last = buckets[buckets.length-1];
    const fd = new Date(first.start), ld = new Date(last.end);
    $("#iRangeLabel").textContent = `${c.emoji} ${c.name} · ${MONTHS_SHORT[fd.getMonth()]} ${fd.getDate()} → ${MONTHS_SHORT[ld.getMonth()]} ${ld.getDate()}, ${ld.getFullYear()}`;
    renderBarChart($("#chartBars"), buckets);
    renderLineChart($("#chartLine"), runningBalanceForBuckets(buckets, c.id));
    const catTotals = {};
    approvedFor(c.id).forEach(t => {
      if (t.type === "spend" && t.ts >= first.start && t.ts <= last.end) {
        catTotals[t.category] = (catTotals[t.category] || 0) + t.amount;
      }
    });
    renderCatsList($("#iCats"), catTotals);
    const all = approvedFor(c.id);
    $("#atTxns").textContent = all.length;
    $("#atEarned").textContent = fmt(earnedFor(c.id));
    $("#atSpent").textContent = fmt(spentFor(c.id));
    $("#atSaved").textContent = fmt(savedFor(c.id));
    if (all.length > 0) {
      const minTs = Math.min(...all.map(t => t.ts));
      const maxTs = Math.max(...all.map(t => t.ts));
      const f = new Date(minTs);
      $("#atFirst").textContent = `${MONTHS_SHORT[f.getMonth()]} ${f.getDate()}, ${f.getFullYear()}`;
      $("#atDays").textContent = Math.max(1, Math.ceil((maxTs - minTs) / 86400000) + 1);
    } else {
      $("#atFirst").textContent = "—"; $("#atDays").textContent = 0;
    }
  };

  /* ---------- Family tab ---------- */
  const renderChildren = () => {
    const list = $("#childrenList"); list.innerHTML = "";
    state.children.forEach(c => {
      const pending = pendingFor(c.id).length;
      const isActive = state.auth.activeChildId === c.id;
      const li = document.createElement("li");
      li.className = "kid-card" + (isActive ? " is-active" : "");
      li.innerHTML = `
        <div class="kid-head">
          <span class="kid-emoji">${escapeHtml(c.emoji)}</span>
          <div class="kid-titles">
            <div class="kid-name">${escapeHtml(c.name)}${c.locked ? ` <span class="kid-locked">LOCKED</span>` : ""}</div>
            <div class="kid-meta">${c.pinHash ? "PIN set" : "No PIN"} · weekly ${fmt(c.weekly)} · goal ${escapeHtml(c.goal.name)} ${fmt(c.goal.total)}</div>
          </div>
          <div class="kid-bal">${fmt(balanceFor(c.id))}</div>
        </div>
        <div class="kid-stats">
          <span>${pending} pending</span>
          <span>${childTxns(c.id).length} txns</span>
          <span>earned ${fmt(earnedFor(c.id))}</span>
          <span>spent ${fmt(spentFor(c.id))}</span>
        </div>
        <div class="kid-actions">
          <button class="pill" data-view-kid="${c.id}" type="button">${isActive ? "Viewing" : "View"}</button>
          <button class="pill" data-edit-kid="${c.id}" type="button">Edit</button>
          <button class="pill" data-toggle-lock="${c.id}" type="button">${c.locked ? "Unlock" : "Lock"}</button>
          <button class="pill" data-export-kid="${c.id}" type="button">Export</button>
        </div>`;
      list.appendChild(li);
    });
  };
  const renderActivity = () => {
    const list = $("#activityList"); list.innerHTML = "";
    if (!state.activity.length) { list.innerHTML = `<li class="log-empty">No activity yet.</li>`; return; }
    [...state.activity].reverse().slice(0, 100).forEach(a => {
      const d = new Date(a.ts);
      const li = document.createElement("li"); li.className = "activity-item";
      li.innerHTML = `
        <span class="activity-time">${dateStamp(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}</span>
        <span class="activity-actor">${escapeHtml(a.actor || "—")}</span>
        <span class="activity-action">${escapeHtml(a.action)}</span>
        <span class="activity-summary">${escapeHtml(a.summary || "")}</span>`;
      list.appendChild(li);
    });
  };
  const renderFamilyBar = () => {
    const bar = $("#familyBar"); if (!bar) return;
    const codeEl = $("#familyBarCode"), copyBtn = $("#familyCopyBtn"), enableBtn = $("#familyEnableBtn");
    if (state.familyCode) {
      codeEl.textContent = state.familyCode;
      copyBtn.hidden = false;
      enableBtn.hidden = true;
    } else {
      codeEl.textContent = "Not synced (this phone only)";
      copyBtn.hidden = true;
      enableBtn.hidden = false;
    }
  };
  const renderFamily = () => { renderChildren(); renderActivity(); renderFamilyBar(); };

  const renderChildSelector = () => {
    const pill = $("#childSelector"); if (!pill) return;
    const c = getActiveChild();
    if (state.auth.activeRole !== "parent" || state.children.length < 2 || !c) { pill.hidden = true; return; }
    pill.hidden = false;
    $("#childSelEmoji").textContent = c.emoji;
    $("#childSelName").textContent = c.name;
  };

  const renderAll = () => {
    ensureActiveChild();
    renderDay(); renderBalance(); renderWeek(); renderGoal();
    renderCats(); renderCalendar(); renderLog();
    renderApprovals(); renderPending();
    renderInsights();
    renderFamily();
    renderChildSelector();
  };

  /* ===========================================================
     MUTATIONS (with sync calls)
     =========================================================== */
  const addTxnFor = (childId, type, amount, category, note, ts = Date.now()) => {
    if (!amount || amount <= 0) return null;
    const role = state.auth.activeRole || "parent";
    const t = {
      id: uuid(), childId, ts,
      type, amount, category,
      note: (note || "").trim(),
      status: role === "parent" ? "approved" : "pending",
      submittedBy: role,
    };
    state.txns.push(t);
    const c = state.children.find(x => x.id === childId);
    const summary = `${type === "earn" ? "+" : "−"}${fmt(amount)} ${category}${note ? " · " + note : ""}${c ? " · " + c.name : ""}`;
    logActivity(role === "parent" ? "added" : "requested", { childId, txnId: t.id, summary });
    save(); syncTxn(t); renderAll();
    return t;
  };
  const setStatus = (id, status) => {
    const t = state.txns.find(x => x.id === id); if (!t) return;
    t.status = status;
    const c = state.children.find(x => x.id === t.childId);
    logActivity(status, { childId: t.childId, txnId: t.id, summary: `${t.type === "earn" ? "+" : "−"}${fmt(t.amount)} ${t.category}${c ? " · " + c.name : ""}` });
    save(); syncTxn(t); renderAll();
  };
  const withdrawTxn = (id) => {
    const t = state.txns.find(x => x.id === id);
    if (!t || t.status !== "pending") return;
    state.txns = state.txns.filter(x => x.id !== id);
    const c = state.children.find(x => x.id === t.childId);
    logActivity("withdrew", { childId: t.childId, summary: `${t.type === "earn" ? "+" : "−"}${fmt(t.amount)} ${t.category}${c ? " · " + c.name : ""}` });
    save(); syncDeleteTxn(id); renderAll();
  };
  const updateTxn = (id, patch) => {
    const t = state.txns.find(x => x.id === id); if (!t) return;
    Object.assign(t, patch);
    const c = state.children.find(x => x.id === t.childId);
    logActivity("edited", { childId: t.childId, txnId: t.id, summary: `${t.type === "earn" ? "+" : "−"}${fmt(t.amount)} ${t.category}${c ? " · " + c.name : ""}` });
    save(); syncTxn(t); renderAll();
  };
  const deleteTxn = (id) => {
    const t = state.txns.find(x => x.id === id); if (!t) return;
    state.txns = state.txns.filter(x => x.id !== id);
    const c = state.children.find(x => x.id === t.childId);
    logActivity("deleted", { childId: t.childId, summary: `${t.type === "earn" ? "+" : "−"}${fmt(t.amount)} ${t.category}${c ? " · " + c.name : ""}` });
    save(); syncDeleteTxn(id); renderAll();
  };
  const approveAllFor = (cid) => {
    const changed = [];
    pendingFor(cid).forEach(t => { t.status = "approved"; changed.push(t); });
    if (changed.length) {
      const c = state.children.find(x => x.id === cid);
      logActivity("approved-all", { childId: cid, summary: `${changed.length} items${c ? " · " + c.name : ""}` });
    }
    save(); syncTxnBatch(changed); renderAll();
  };
  const rejectAllFor = (cid) => {
    const changed = [];
    pendingFor(cid).forEach(t => { t.status = "rejected"; changed.push(t); });
    if (changed.length) {
      const c = state.children.find(x => x.id === cid);
      logActivity("rejected-all", { childId: cid, summary: `${changed.length} items${c ? " · " + c.name : ""}` });
    }
    save(); syncTxnBatch(changed); renderAll();
  };
  const adjustBalance = (cid, amount, note) => {
    const type = amount >= 0 ? "earn" : "spend";
    addTxnFor(cid, type, Math.abs(amount), "adjustment", note || "Manual adjustment");
  };
  const doPaydayFor = (cid) => {
    if (state.auth.activeRole !== "parent") return;
    const c = state.children.find(x => x.id === cid);
    if (!c || c.weekly <= 0) return;
    addTxnFor(cid, "earn", c.weekly, "bonus", "Weekly allowance");
    c.lastPaydayISO = new Date().toISOString();
    logActivity("payday", { childId: cid, summary: `${fmt(c.weekly)} · ${c.name}` });
    save(); syncChild(c); renderAll();
  };

  const addChild = (data) => {
    const c = { ...defaultChild(), ...data };
    state.children.push(c);
    logActivity("added kid", { childId: c.id, summary: `${c.emoji} ${c.name}` });
    save(); syncChild(c); renderAll();
    return c;
  };
  const updateChild = (id, patch) => {
    const c = state.children.find(x => x.id === id); if (!c) return;
    if (patch.goal) patch.goal = { ...c.goal, ...patch.goal };
    Object.assign(c, patch);
    logActivity("edited kid", { childId: id, summary: `${c.emoji} ${c.name}` });
    save(); syncChild(c); renderAll();
  };
  const deleteChild = (id) => {
    const c = state.children.find(x => x.id === id); if (!c) return;
    state.children = state.children.filter(x => x.id !== id);
    state.txns = state.txns.filter(t => t.childId !== id);
    if (state.auth.activeChildId === id) state.auth.activeChildId = state.children[0]?.id || null;
    logActivity("deleted kid", { summary: `${c.emoji} ${c.name}` });
    save(); syncDeleteChild(id); renderAll();
  };
  const toggleLockChild = (id) => {
    const c = state.children.find(x => x.id === id); if (!c) return;
    c.locked = !c.locked;
    logActivity(c.locked ? "locked kid" : "unlocked kid", { childId: id, summary: `${c.emoji} ${c.name}` });
    save(); syncChild(c); renderAll();
  };
  const exportChild = (id) => {
    const c = state.children.find(x => x.id === id); if (!c) return;
    const payload = { child: c, txns: childTxns(id), _exportedAt: new Date().toISOString(), _schema: 2 };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${c.name.toLowerCase().replace(/\s+/g,"-")}-allowance-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  /* ===========================================================
     QUICK ADD + CALCULATOR
     =========================================================== */
  let addType = "earn";
  const earnCats = ["chore","gift","bonus","savings","other"];
  const spendCats = ["toys","snacks","games","other"];
  const updateAddCategories = () => {
    const cats = addType === "earn" ? earnCats : spendCats;
    $("#addCategory").innerHTML = cats.map(c => `<option value="${c}">${c[0].toUpperCase()+c.slice(1)}</option>`).join("");
  };
  $$(".card--add .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".card--add .seg-btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      addType = btn.dataset.type;
      updateAddCategories();
    });
  });
  $("#addSubmit").addEventListener("click", () => {
    const c = getActiveChild(); if (!c) return;
    const amt = parseFloat($("#addAmount").value);
    const cat = $("#addCategory").value;
    const note = $("#addNote").value;
    let ts = Date.now();
    const dateEl = $("#addDate");
    if (dateEl && dateEl.value) {
      const dd = new Date(dateEl.value + "T12:00:00");
      if (!isNaN(dd)) ts = dd.getTime();
    }
    addTxnFor(c.id, addType, amt, cat, note, ts);
    $("#addAmount").value = ""; $("#addNote").value = "";
    if (dateEl) dateEl.value = "";
  });

  const updateCalc = () => {
    const ch = parseFloat($("#calcChores").value) || 0;
    const rate = parseFloat($("#calcRate").value) || 0;
    $("#calcResult").textContent = fmtFull(ch * rate);
  };
  $("#calcChores").addEventListener("input", updateCalc);
  $("#calcRate").addEventListener("input", updateCalc);
  $("#calcLog").addEventListener("click", () => {
    const c = getActiveChild(); if (!c) return;
    const ch = parseFloat($("#calcChores").value) || 0;
    const rate = parseFloat($("#calcRate").value) || 0;
    addTxnFor(c.id, "earn", ch * rate, "chore", `${ch} chores @ ${fmtFull(rate)}`);
  });

  /* ===========================================================
     EVENT DELEGATION
     =========================================================== */
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const c = getActiveChild();
    if (action === "payday" && c) doPaydayFor(c.id);
    else if (action === "reset") {
      if (confirm("Wipe all transactions and reset to defaults?\n(PINs, kids, and family link are kept)")) {
        const auth = state.auth, children = state.children.map(c => ({ ...c, lastPaydayISO: null }));
        const fam = state.familyCode, sk = state.syncSkipped;
        state = defaultState();
        state.auth = auth; state.children = children;
        state.familyCode = fam; state.syncSkipped = sk;
        save();
        syncClearAllTxns().then(() => state.children.forEach(syncChild));
        renderAll();
      }
    }
    else if (action === "open-settings") openSettings();
    else if (action === "edit-goal" && c) openKidEdit(c.id);
    else if (action === "stash" && c) addTxnFor(c.id, "earn", 1, "savings", "Stashed $1");
    else if (action === "clear-log") {
      if (confirm("Clear ALL transactions across ALL kids?")) {
        state.txns = []; save(); syncClearAllTxns(); renderAll();
      }
    }
    else if (action === "export") doExport();
    else if (action === "import") $("#importFile").click();
    else if (action === "logout") doLogout();
    else if (action === "approve-all" && c) { if (confirm(`Approve all ${pendingFor(c.id).length}?`)) approveAllFor(c.id); }
    else if (action === "reject-all" && c) { if (confirm(`Reject all ${pendingFor(c.id).length}?`)) rejectAllFor(c.id); }
    else if (action === "add-kid") openKidEdit(null);
    else if (action === "adjust-balance") openAdjust();
    else if (action === "switch-child") openChildPicker();
    else if (action === "clear-activity") {
      if (confirm("Clear the activity log?")) { state.activity = []; save(); syncClearActivity(); renderAll(); }
    }
    // Family-link actions
    else if (action === "family-new") doCreateNewFamily();
    else if (action === "family-join-open") showAuth("family-join");
    else if (action === "family-skip") doSkipSync();
    else if (action === "family-show-copy") copyFamilyCode($("#familyCodeShow").textContent);
    else if (action === "family-show-done") postFamilySetup();
    else if (action === "family-join-submit") doJoinFamily();
    else if (action === "family-back") showAuth("family-choice");
    else if (action === "family-copy") copyFamilyCode(state.familyCode);
    else if (action === "family-enable") {
      state.syncSkipped = false; save(); startFamilyChoice();
    }
  });

  document.addEventListener("click", (e) => {
    const ek = e.target.closest("[data-edit-kid]");
    const vk = e.target.closest("[data-view-kid]");
    const tl = e.target.closest("[data-toggle-lock]");
    const exk = e.target.closest("[data-export-kid]");
    if (ek) openKidEdit(ek.dataset.editKid);
    else if (vk) { state.auth.activeChildId = vk.dataset.viewKid; save(); switchPage("dashboard"); renderAll(); }
    else if (tl) toggleLockChild(tl.dataset.toggleLock);
    else if (exk) exportChild(exk.dataset.exportKid);
  });

  document.addEventListener("click", (e) => {
    const ap = e.target.closest("[data-approve]");
    const rj = e.target.closest("[data-reject]");
    const wd = e.target.closest("[data-withdraw]");
    const et = e.target.closest("[data-edit-txn]");
    if (ap) setStatus(ap.dataset.approve, "approved");
    else if (rj) setStatus(rj.dataset.reject, "rejected");
    else if (wd) withdrawTxn(wd.dataset.withdraw);
    else if (et && state.auth.activeRole === "parent") openTxnEdit(et.dataset.editTxn);
  });

  /* ===========================================================
     PAGE TABS + PERIOD
     =========================================================== */
  const switchPage = (page) => {
    $$(".tab").forEach(b => b.classList.toggle("is-active", b.dataset.page === page));
    $$(".page").forEach(p => p.classList.toggle("is-hidden", p.dataset.page !== page));
    if (page === "insights") renderInsights();
    if (page === "family") renderFamily();
  };
  $$(".tab").forEach(btn => btn.addEventListener("click", () => switchPage(btn.dataset.page)));
  $$("[data-period]").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("[data-period]").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      currentPeriod = btn.dataset.period;
      renderInsights();
    });
  });

  /* ---------- Export / import ---------- */
  const doExport = () => {
    const payload = { ...state, _exportedAt: new Date().toISOString(), _schema: 2 };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `allowance-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.child && Array.isArray(data.txns)) {
        if (!confirm(`Import ${data.txns.length} transactions for ${data.child.name}?`)) { e.target.value = ""; return; }
        const ex = state.children.find(c => c.id === data.child.id);
        if (ex) Object.assign(ex, data.child); else state.children.push(data.child);
        state.txns = state.txns.filter(t => t.childId !== data.child.id).concat(data.txns);
        save();
        syncChild(data.child); syncTxnBatch(data.txns);
        renderAll();
      } else if (Array.isArray(data?.txns) || Array.isArray(data?.children)) {
        if (!confirm("Replace ALL data with this file?")) { e.target.value = ""; return; }
        state = migrate(data); save();
        if (SB_READY()) {
          await syncFamily();
          state.children.forEach(syncChild);
          syncTxnBatch(state.txns);
        }
        renderAll();
      } else { throw new Error("Unknown file format"); }
    } catch (err) { alert("Couldn't import: " + err.message); }
    e.target.value = "";
  });

  /* ---------- Settings modal ---------- */
  const modal = $("#settingsModal");
  const openSettings = () => {
    if (state.auth.activeRole !== "parent") return;
    $("#setParentPin").value = "";
    modal.showModal();
  };
  $("#saveSettings").addEventListener("click", async (e) => {
    e.preventDefault();
    const np = $("#setParentPin").value.trim();
    if (np && !/^\d{4}$/.test(np)) { alert("Parent PIN must be 4 digits."); return; }
    if (np) {
      state.auth.parentPin = await hashPin(np);
      logActivity("changed parent PIN", { summary: "" });
      syncFamily();
    }
    save(); renderAll(); modal.close();
  });
  $("#settingsCancel").addEventListener("click", (e) => { e.preventDefault(); modal.close(); });

  /* ---------- Kid edit modal ---------- */
  const kidModal = $("#kidModal");
  let editingKidId = null;
  const openKidEdit = (id) => {
    if (state.auth.activeRole !== "parent") return;
    editingKidId = id;
    const isNew = !id;
    const c = isNew ? defaultChild() : state.children.find(x => x.id === id);
    if (!c) return;
    $("#kidModalTitle").textContent = isNew ? "Add a kid" : `Edit ${c.name}`;
    $("#kidName").value = c.name; $("#kidEmoji").value = c.emoji;
    $("#kidWeekly").value = c.weekly; $("#kidPayday").value = c.payday;
    $("#kidGoalName").value = c.goal.name; $("#kidGoalTotal").value = c.goal.total;
    $("#kidPin").value = "";
    $("#kidPin").placeholder = c.pinHash ? "(set — type 'clear' to remove)" : "(none)";
    $("#kidLocked").checked = !!c.locked;
    $("#kidDelete").hidden = isNew || state.children.length <= 1;
    kidModal.showModal();
  };
  $("#kidSave").addEventListener("click", async (e) => {
    e.preventDefault();
    const name = $("#kidName").value.trim() || "Kid";
    const emoji = $("#kidEmoji").value.trim() || "🧒";
    const weekly = Math.max(0, parseFloat($("#kidWeekly").value) || 0);
    const payday = parseInt($("#kidPayday").value, 10);
    const goalName = $("#kidGoalName").value.trim() || "Savings goal";
    const goalTotal = Math.max(0, parseFloat($("#kidGoalTotal").value) || 0);
    const pinRaw = $("#kidPin").value.trim();
    const locked = $("#kidLocked").checked;
    if (pinRaw && pinRaw !== "clear" && !/^\d{4}$/.test(pinRaw)) {
      alert("PIN must be 4 digits, blank to keep, or 'clear' to remove."); return;
    }
    const patch = { name, emoji, weekly, payday, locked, goal: { name: goalName, total: goalTotal } };
    if (pinRaw === "clear") patch.pinHash = null;
    else if (/^\d{4}$/.test(pinRaw)) patch.pinHash = await hashPin(pinRaw);
    if (editingKidId) updateChild(editingKidId, patch);
    else addChild(patch);
    kidModal.close();
  });
  $("#kidCancel").addEventListener("click", (e) => { e.preventDefault(); kidModal.close(); });
  $("#kidDelete").addEventListener("click", (e) => {
    e.preventDefault();
    if (!editingKidId) return;
    if (state.children.length <= 1) { alert("Can't delete the last kid."); return; }
    const c = state.children.find(x => x.id === editingKidId); if (!c) return;
    if (confirm(`Delete ${c.name}? This wipes their balance, transactions, and goal forever.`)) {
      deleteChild(editingKidId); kidModal.close();
    }
  });

  /* ---------- Txn edit modal ---------- */
  const txnModal = $("#txnModal");
  let editingTxnId = null;
  const openTxnEdit = (id) => {
    if (state.auth.activeRole !== "parent") return;
    const t = state.txns.find(x => x.id === id); if (!t) return;
    editingTxnId = id;
    $("#txnType").value = t.type; $("#txnAmount").value = t.amount;
    $("#txnCategory").value = t.category; $("#txnNote").value = t.note || "";
    $("#txnDate").value = isoDate(new Date(t.ts));
    $("#txnStatus").value = t.status || "approved";
    txnModal.showModal();
  };
  $("#txnSave").addEventListener("click", (e) => {
    e.preventDefault();
    if (!editingTxnId) return;
    const type = $("#txnType").value;
    const amount = Math.max(0, parseFloat($("#txnAmount").value) || 0);
    const category = $("#txnCategory").value.trim() || "other";
    const note = $("#txnNote").value.trim();
    const status = $("#txnStatus").value;
    let ts = Date.now();
    const dv = $("#txnDate").value;
    if (dv) { const dd = new Date(dv + "T12:00:00"); if (!isNaN(dd)) ts = dd.getTime(); }
    updateTxn(editingTxnId, { type, amount, category, note, ts, status });
    txnModal.close();
  });
  $("#txnCancel").addEventListener("click", (e) => { e.preventDefault(); txnModal.close(); });
  $("#txnDelete").addEventListener("click", (e) => {
    e.preventDefault();
    if (!editingTxnId) return;
    if (confirm("Delete this transaction?")) { deleteTxn(editingTxnId); txnModal.close(); }
  });

  /* ---------- Adjust balance modal ---------- */
  const adjustModal = $("#adjustModal");
  const openAdjust = () => {
    const c = getActiveChild();
    if (!c || state.auth.activeRole !== "parent") return;
    $("#adjustChildName").textContent = `${c.emoji} ${c.name}`;
    $("#adjustAmount").value = ""; $("#adjustNote").value = "";
    adjustModal.showModal();
  };
  $("#adjustSave").addEventListener("click", (e) => {
    e.preventDefault();
    const c = getActiveChild(); if (!c) return;
    const amt = parseFloat($("#adjustAmount").value);
    if (isNaN(amt) || amt === 0) { alert("Enter a non-zero amount (use a leading - to deduct)."); return; }
    const note = $("#adjustNote").value.trim() || "Manual adjustment";
    adjustBalance(c.id, amt, note); adjustModal.close();
  });
  $("#adjustCancel").addEventListener("click", (e) => { e.preventDefault(); adjustModal.close(); });

  /* ---------- Child picker modal ---------- */
  const pickerModal = $("#pickerModal");
  const openChildPicker = () => {
    if (state.auth.activeRole !== "parent") return;
    const list = $("#pickerList"); list.innerHTML = "";
    state.children.forEach(c => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker-btn" + (c.id === state.auth.activeChildId ? " is-active" : "");
      btn.innerHTML = `<span class="picker-emoji">${escapeHtml(c.emoji)}</span><span class="picker-name">${escapeHtml(c.name)}</span><span class="picker-bal">${fmt(balanceFor(c.id))}</span>`;
      btn.addEventListener("click", () => { state.auth.activeChildId = c.id; save(); pickerModal.close(); renderAll(); });
      list.appendChild(btn);
    });
    pickerModal.showModal();
  };
  $("#pickerCancel")?.addEventListener("click", (e) => { e.preventDefault(); pickerModal.close(); });

  /* ===========================================================
     AUTH: role gating, PIN pad, overlay
     =========================================================== */
  const applyRole = () => {
    document.body.classList.remove("role-parent", "role-child");
    const role = state.auth.activeRole;
    if (role) document.body.classList.add(`role-${role}`);
    if (role === "parent") {
      $("#roleEmoji").textContent = "🧑"; $("#roleName").textContent = "Parent";
    } else if (role === "child") {
      const c = getActiveChild();
      $("#roleEmoji").textContent = c ? c.emoji : "🧒";
      $("#roleName").textContent = c ? c.name : "Kid";
    }
  };
  const renderPinPad = (padEl, handlers) => {
    padEl.innerHTML = "";
    ["1","2","3","4","5","6","7","8","9","clear","0","back"].forEach(b => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pin-btn" + (b === "clear" || b === "back" ? " pin-btn--util" : "");
      btn.textContent = b === "clear" ? "C" : (b === "back" ? "←" : b);
      btn.addEventListener("click", () => {
        if (b === "clear") handlers.clear();
        else if (b === "back") handlers.back();
        else handlers.digit(b);
      });
      padEl.appendChild(btn);
    });
  };
  const setDots = (el, len) => [...el.children].forEach((d, i) => d.classList.toggle("is-filled", i < len));
  const shakeDots = (el) => { el.classList.remove("is-wrong"); void el.offsetWidth; el.classList.add("is-wrong"); };
  const authOverlay = $("#authOverlay");
  const showAuth = (view) => {
    document.body.classList.add("is-auth");
    authOverlay.hidden = false;
    $$("[data-auth-view]").forEach(el => el.hidden = el.dataset.authView !== view);
  };
  const hideAuth = () => { document.body.classList.remove("is-auth"); authOverlay.hidden = true; };

  /* ---------- Setup ---------- */
  let setupStep = "new", setupPending = "", setupBuffer = "";
  const startSetup = () => {
    setupStep = "new"; setupPending = ""; setupBuffer = "";
    $("#setupSub").textContent = "Pick a 4-digit Parent PIN.";
    setDots($("#setupDots"), 0);
    renderPinPad($("#setupPad"), {
      digit: (d) => { if (setupBuffer.length >= 4) return; setupBuffer += d; setDots($("#setupDots"), setupBuffer.length); if (setupBuffer.length === 4) setTimeout(advanceSetup, 120); },
      clear: () => { setupBuffer = ""; setDots($("#setupDots"), 0); },
      back:  () => { setupBuffer = setupBuffer.slice(0,-1); setDots($("#setupDots"), setupBuffer.length); },
    });
    showAuth("setup");
  };
  const advanceSetup = async () => {
    if (setupStep === "new") {
      setupPending = setupBuffer; setupBuffer = ""; setupStep = "confirm";
      $("#setupSub").textContent = "Confirm the Parent PIN.";
      setDots($("#setupDots"), 0);
    } else {
      if (setupBuffer === setupPending) {
        state.auth.parentPin = await hashPin(setupBuffer);
        state.auth.activeRole = "parent";
        ensureActiveChild();
        save();
        applyRole();
        startFamilyChoice();
      } else {
        shakeDots($("#setupDots"));
        setupStep = "new"; setupPending = ""; setupBuffer = "";
        $("#setupSub").textContent = "Didn't match. Pick a 4-digit Parent PIN.";
        setTimeout(() => setDots($("#setupDots"), 0), 360);
      }
    }
  };

  /* ---------- Family choice ---------- */
  const startFamilyChoice = () => { showAuth("family-choice"); };

  const doCreateNewFamily = async () => {
    if (!window.sb) { alert("Cloud sync isn't available right now."); return; }
    const code = generateFamilyCode();
    state.familyCode = code;
    state.syncSkipped = false;
    save();
    try {
      await window.sb.from("families").upsert({ code, parent_pin_hash: state.auth.parentPin });
      for (const c of state.children) await syncChild(c);
      if (state.txns.length) await syncTxnBatch(state.txns);
      $("#familyCodeShow").textContent = code;
      showAuth("family-show");
    } catch (e) {
      alert("Couldn't reach cloud: " + e.message + "\nYou can try again from Family → Enable cloud sync.");
      state.familyCode = null; save();
      postFamilySetup();
    }
  };

  const doJoinFamily = async () => {
    if (!window.sb) { alert("Cloud sync isn't available right now."); return; }
    const code = ($("#familyJoinCode").value || "").toUpperCase().trim();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) { alert("Invalid code — should be 4-12 letters/digits."); return; }
    try {
      const { data, error } = await window.sb.from("families").select().eq("code", code).maybeSingle();
      if (error) throw error;
      if (!data) { alert("No family with that code. Double-check it on the other phone."); return; }
      state.familyCode = code;
      state.syncSkipped = false;
      if (data.parent_pin_hash) state.auth.parentPin = data.parent_pin_hash;
      const ok = await hydrateFromSupabase();
      if (!ok) { alert("Couldn't load family data."); return; }
      save();
      postFamilySetup();
    } catch (e) {
      alert("Couldn't join: " + e.message);
    }
  };

  const doSkipSync = () => {
    state.syncSkipped = true;
    state.familyCode = null;
    save();
    postFamilySetup();
  };

  const postFamilySetup = () => {
    ensureActiveChild();
    if (state.auth.activeRole) { hideAuth(); applyRole(); renderAll(); }
    else startLogin();
  };

  const copyFamilyCode = async (code) => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      const btn = event?.target;
      if (btn) { const orig = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => btn.textContent = orig, 1200); }
    } catch {
      prompt("Copy this code:", code);
    }
  };

  /* ---------- Login (multi-account) ---------- */
  let loginBuffer = "", loginTarget = null;
  const renderLoginAccounts = () => {
    const list = $("#loginAccounts"); list.innerHTML = "";
    const p = document.createElement("button");
    p.type = "button"; p.className = "role-btn";
    p.innerHTML = `<span class="role-emoji">🧑</span><span class="role-label">Parent</span>`;
    p.addEventListener("click", () => pickAccount("parent"));
    list.appendChild(p);
    state.children.forEach(c => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "role-btn role-btn--child" + (c.locked ? " is-locked" : "");
      btn.innerHTML = `<span class="role-emoji">${escapeHtml(c.emoji)}</span><span class="role-label">${escapeHtml(c.name)}</span>${c.locked ? `<span class="role-locked-tag">LOCKED</span>` : ""}`;
      btn.addEventListener("click", () => pickAccount(c.id));
      list.appendChild(btn);
    });
  };
  const startLogin = () => {
    loginBuffer = ""; loginTarget = null;
    $("#loginPinSection").hidden = true;
    setDots($("#loginDots"), 0);
    renderLoginAccounts();
    showAuth("login");
  };
  const pickAccount = (target) => {
    loginTarget = target;
    if (target === "parent") {
      if (!state.auth.parentPin) { alert("No parent PIN set."); return; }
      promptPin("Enter Parent PIN"); return;
    }
    const c = state.children.find(x => x.id === target);
    if (!c) return;
    if (c.locked) { alert(`${c.name} is locked. Parent must unlock first.`); return; }
    if (!c.pinHash) {
      state.auth.activeRole = "child";
      state.auth.activeChildId = c.id;
      logActivity("logged in", { childId: c.id, summary: c.name });
      save(); applyRole(); hideAuth(); renderAll();
      return;
    }
    promptPin(`Enter ${c.name}'s PIN`);
  };
  const promptPin = (label) => {
    loginBuffer = ""; setDots($("#loginDots"), 0);
    $("#loginSub").textContent = label;
    $("#loginPinSection").hidden = false;
    renderPinPad($("#loginPad"), {
      digit: (d) => { if (loginBuffer.length >= 4) return; loginBuffer += d; setDots($("#loginDots"), loginBuffer.length); if (loginBuffer.length === 4) setTimeout(tryLogin, 120); },
      clear: () => { loginBuffer = ""; setDots($("#loginDots"), 0); },
      back:  () => { loginBuffer = loginBuffer.slice(0,-1); setDots($("#loginDots"), loginBuffer.length); },
    });
  };
  const tryLogin = async () => {
    const expected = loginTarget === "parent"
      ? state.auth.parentPin
      : state.children.find(c => c.id === loginTarget)?.pinHash;
    const hashed = await hashPin(loginBuffer);
    if (hashed === expected) {
      if (loginTarget === "parent") {
        state.auth.activeRole = "parent"; ensureActiveChild();
        logActivity("logged in", { summary: "Parent" });
      } else {
        state.auth.activeRole = "child"; state.auth.activeChildId = loginTarget;
        const c = state.children.find(x => x.id === loginTarget);
        logActivity("logged in", { childId: loginTarget, summary: c?.name });
      }
      save(); applyRole(); hideAuth(); renderAll();
    } else {
      shakeDots($("#loginDots"));
      setTimeout(() => { loginBuffer = ""; setDots($("#loginDots"), 0); }, 360);
    }
  };
  $("#loginBack").addEventListener("click", () => {
    $("#loginPinSection").hidden = true; loginBuffer = ""; loginTarget = null;
  });

  /* ---------- Logout ---------- */
  const doLogout = () => {
    const role = state.auth.activeRole;
    logActivity("logged out", { summary: role === "parent" ? "Parent" : (getActiveChild()?.name || "Kid") });
    state.auth.activeRole = null;
    save(); applyRole(); startLogin();
  };

  /* ===========================================================
     BOOT
     =========================================================== */
  const bootAuth = async () => {
    setSyncIndicator(state.familyCode ? "syncing" : "off");
    if (!state.auth.parentPin) { startSetup(); return; }
    if (!state.familyCode && !state.syncSkipped) { startFamilyChoice(); return; }
    if (state.familyCode) {
      await hydrateFromSupabase();
    }
    if (!state.auth.activeRole) startLogin();
    else { ensureActiveChild(); applyRole(); hideAuth(); renderAll(); }
  };
  updateAddCategories();
  updateCalc();
  bootAuth();
})();
