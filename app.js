/* Caderneta — PWA de património pessoal.
 * Os dados pessoais vivem só neste dispositivo (localStorage). O repositório só tem código e cotações públicas.
 */
"use strict";

const KEY = "caderneta-v1";
const PRICE_CACHE = "caderneta-prices";
const $ = (s, el = document) => el.querySelector(s);

/* ---------- Formatação ---------- */
const eur = (v, d = 2) =>
  (v ?? 0).toLocaleString("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: d, maximumFractionDigits: d });
const eur0 = (v) => eur(v, 0);
const pct = (v) => (v >= 0 ? "+" : "") + (v * 100).toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
const signed = (v) => (v >= 0 ? "+" : "−") + eur(Math.abs(v));
const num = (v, d = 4) => (v ?? 0).toLocaleString("pt-PT", { maximumFractionDigits: d });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const fmtDay = (iso) => { const [y, m, d] = iso.split("-"); return `${+d} ${MESES[+m - 1]}`; };
const fmtDate = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };

/* ---------- Datas ---------- */
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
function businessOnOrAfter(y, m, day) {          // m: 0-11
  const d = new Date(y, m, day);
  while (isWeekend(d)) d.setDate(d.getDate() + 1);
  return d;
}
function businessAfter(y, m, day) {
  const d = new Date(y, m, day + 1);
  while (isWeekend(d)) d.setDate(d.getDate() + 1);
  return d;
}
const lastDayOfMonth = (y, m) => new Date(y, m + 1, 0);
function monthsBetween(fromIso, toDate) {       // meses (y, m) desde o mês de fromIso até toDate, inclusive
  const out = [];
  const f = parse(fromIso);
  let y = f.getFullYear(), m = f.getMonth();
  while (y < toDate.getFullYear() || (y === toDate.getFullYear() && m <= toDate.getMonth())) {
    out.push([y, m]);
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

/* ---------- Estado ---------- */
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}
function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { toast("Não consegui guardar: " + e.message); }
}
let state = load();
let prices = (() => { try { return JSON.parse(localStorage.getItem(PRICE_CACHE)) || { assets: {} }; } catch { return { assets: {} }; } })();
let live = {};          // cotações em tempo real (cripto)
let view = (() => { try { return localStorage.getItem("caderneta-view") || "liquido"; } catch { return "liquido"; } })();

function validate(s) {
  if (!s || typeof s !== "object" || !s.positions || !s.rules) throw new Error("Ficheiro sem 'positions' ou 'rules'.");
  s.movements ||= [];
  return s;
}

/* ---------- Preços ---------- */
function priceOf(key) {
  if (live[key]) return live[key];
  return prices.assets?.[key]?.price ?? state?.positions?.[key]?.lastPrice ?? null;
}
function closeOn(key, dateIso) {            // fecho no dia (ou no último dia anterior com fecho)
  const h = prices.assets?.[key]?.history;
  if (!h) return null;
  const days = Object.keys(h).filter((d) => d <= dateIso).sort();
  return days.length ? h[days[days.length - 1]] : null;
}

async function refreshPrices() {
  try {
    const r = await fetch("prices.json?t=" + Date.now(), { cache: "no-store" });
    if (r.ok) {
      const p = await r.json();
      if (p && p.assets) { prices = p; try { localStorage.setItem(PRICE_CACHE, JSON.stringify(p)); } catch {} }
    }
  } catch {}
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,cardano&vs_currencies=eur", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      if (j.bitcoin?.eur) live.btc = j.bitcoin.eur;
      if (j.cardano?.eur) live.ada = j.cardano.eur;
      live.at = new Date().toISOString();
    }
  } catch {}
}

/* ---------- Regras automáticas ---------- */
function addMove(s, m) { s.movements.unshift(m); }

function processRules(s, today = new Date()) {
  const todayIso = iso(today);
  const R = s.rules, P = s.positions;
  const applied = [];

  // VUAA: compra no dia 4 (dia útil seguinte se calhar ao fim de semana)
  if (P.vuaa && R.vuaa) {
    for (const [y, m] of monthsBetween(P.vuaa.lastBuy, today)) {
      const d = iso(businessOnOrAfter(y, m, R.vuaa.buyDay));
      if (d <= P.vuaa.lastBuy || d > todayIso) continue;
      const px = closeOn("vuaa", d) ?? priceOf("vuaa");
      if (!px) break;                                // sem cotação: tenta na próxima abertura
      const units = R.vuaa.amount / px;
      P.vuaa.units += units; P.vuaa.cost += R.vuaa.amount + R.vuaa.fee; P.vuaa.lastBuy = d;
      addMove(s, { date: d, asset: "vuaa", text: `Compra VUAA ${num(units)} un. a ${eur(px)}`, amount: -(R.vuaa.amount + R.vuaa.fee), est: true });
      applied.push("VUAA");
    }
  }
  // BTC: plano no dia 1, executa no dia útil seguinte
  if (P.btc && R.btc) {
    for (const [y, m] of monthsBetween(P.btc.lastBuy, today)) {
      const d = iso(businessAfter(y, m, R.btc.planDay));
      if (d <= P.btc.lastBuy || d > todayIso) continue;
      const px = closeOn("btc", d) ?? priceOf("btc");
      if (!px) break;
      const units = R.btc.amount / px;
      P.btc.units += units; P.btc.cost += R.btc.amount; P.btc.lastBuy = d;
      addMove(s, { date: d, asset: "btc", text: `Compra BTC ${num(units, 7)} a ${eur0(px)}`, amount: -R.btc.amount, est: true });
      applied.push("BTC");
    }
  }
  // Série F: subscrição mensal reservada + juros estimados + entregas
  const F = P.serieF;
  if (F && R.serieF) {
    for (const [y, m] of monthsBetween(F.asOf, today)) {
      // juros estimados do mês anterior, creditados no dia 1
      const first = iso(new Date(y, m, 1));
      if (first > F.lastAccrual && first <= todayIso) {
        const j = F.total * (R.serieF.grossRate / 100) * (1 - R.serieF.tax) / 12;
        F.total += j; F.interestEst = (F.interestEst || 0) + j; F.lastAccrual = first;
      }
      const sub = iso(new Date(y, m, R.serieF.subDay));
      if (sub > F.lastSub && sub <= todayIso) {
        const yr = String(y);
        F.reserved.irs[yr] = (F.reserved.irs[yr] || 0) + R.serieF.monthlyIrs;
        F.reserved.avo[yr] = (F.reserved.avo[yr] || 0) + R.serieF.monthlyAvo;
        F.total += R.serieF.monthlyIrs + R.serieF.monthlyAvo; F.lastSub = sub;
        addMove(s, { date: sub, asset: "serieF", text: `Subscrição Série F (IRS ${eur0(R.serieF.monthlyIrs)} + Avô ${eur0(R.serieF.monthlyAvo)})`, amount: R.serieF.monthlyIrs + R.serieF.monthlyAvo });
        applied.push("Série F");
      }
      // Entregas: IRS do ano anterior a 31/08, Avô do próprio ano a 31/12
      const irsDay = `${y}-${R.payouts.irs}`, avoDay = `${y}-${R.payouts.avo}`;
      const prevY = String(y - 1);
      if (m === +R.payouts.irs.slice(0, 2) - 1 && irsDay > F.lastPayoutCheck && irsDay <= todayIso && F.reserved.irs[prevY]) {
        const v = F.reserved.irs[prevY]; F.total -= v; delete F.reserved.irs[prevY];
        addMove(s, { date: irsDay, asset: "serieF", text: `Resgate para IRS ${prevY} — confirma o valor real`, amount: -v, check: true });
        applied.push("IRS");
      }
      if (m === +R.payouts.avo.slice(0, 2) - 1 && avoDay > F.lastPayoutCheck && avoDay <= todayIso && F.reserved.avo[String(y)]) {
        const v = F.reserved.avo[String(y)]; F.total -= v; delete F.reserved.avo[String(y)];
        addMove(s, { date: avoDay, asset: "serieF", text: `Resgate para Crédito Avô ${y} — confirma o valor real`, amount: -v, check: true });
        applied.push("Avô");
      }
    }
    F.lastPayoutCheck = todayIso > F.lastPayoutCheck ? todayIso : F.lastPayoutCheck;
  }
  // Casa: amortização no fim de cada mês
  const C = P.casa;
  if (C && C.debt > 0) {
    for (const [y, m] of monthsBetween(C.debtAsOf, today)) {
      const d = iso(lastDayOfMonth(y, m));
      if (d <= C.debtAsOf || d > todayIso) continue;
      const juros = C.debt * C.tan / 1200;
      const capital = Math.min(C.debt, C.payment - juros);
      C.debt -= capital; C.debtAsOf = d;
      addMove(s, { date: d, asset: "casa", text: `Prestação: ${eur(capital)} de capital, ${eur(juros)} de juros`, amount: -C.payment });
    }
  }
  s.movements.sort((a, b) => (a.date < b.date ? 1 : -1));
  s.movements = s.movements.slice(0, 200);
  return applied;
}

/* ---------- Cálculos ---------- */
const META = {
  vuaa: { name: "VUAA", sub: "Vanguard S&P 500 · IBKR", mono: "V", color: "var(--c-vuaa)" },
  btc: { name: "Bitcoin", sub: "Trade Republic", mono: "₿", color: "var(--c-btc)" },
  ada: { name: "Cardano", sub: "Longo prazo", mono: "₳", color: "var(--c-ada)" },
  cs2: { name: "Inventário CS2", sub: "Valor manual", mono: "✛", color: "var(--c-cs2)" },
  fundo: { name: "Fundo de emergência", sub: "Certificados Série F", mono: "★", color: "var(--c-serief)" },
  casa: { name: "Casa", sub: "Capital próprio", mono: "⌂", color: "var(--c-casa)" },
};

function compute(s) {
  const P = s.positions, items = [];
  for (const k of ["vuaa", "btc", "ada"]) {
    const p = P[k]; if (!p) continue;
    const px = priceOf(k);
    const value = px != null ? p.units * px : null;
    items.push({ key: k, value, cost: p.cost, units: p.units, price: px });
  }
  if (P.cs2) items.push({ key: "cs2", value: P.cs2.value, cost: P.cs2.cost });
  const F = P.serieF;
  let fundo = null, reserved = 0, resIrs = 0, resAvo = 0;
  if (F) {
    resIrs = Object.values(F.reserved.irs).reduce((a, b) => a + b, 0);
    resAvo = Object.values(F.reserved.avo).reduce((a, b) => a + b, 0);
    reserved = resIrs + resAvo;
    fundo = F.total - reserved;
    items.push({ key: "fundo", value: fundo, cost: F.fundoBase, juros: fundo - F.fundoBase });
  }
  const market = items.filter((i) => ["vuaa", "btc", "ada", "cs2"].includes(i.key));
  const mValue = market.reduce((a, i) => a + (i.value ?? 0), 0);
  const mCost = market.reduce((a, i) => a + i.cost, 0);
  const liquido = items.reduce((a, i) => a + (i.value ?? 0), 0);
  let casa = null;
  if (P.casa) {
    const eq = (P.casa.value - P.casa.debt) * P.casa.share;
    casa = { key: "casa", value: eq, gross: P.casa.value * P.casa.share, debt: P.casa.debt * P.casa.share };
  }
  return { items, mValue, mCost, liquido, total: liquido + (casa?.value ?? 0), casa, F, fundo, reserved, resIrs, resAvo };
}

/* ---------- Próximos eventos ---------- */
function upcoming(s, today = new Date()) {
  const R = s.rules, ev = [], todayIso = iso(today);
  for (let i = 0; i < 3; i++) {
    const y = today.getFullYear(), m = today.getMonth() + i;
    const yy = y + Math.floor(m / 12), mm = m % 12;
    if (R.vuaa) ev.push({ date: iso(businessOnOrAfter(yy, mm, R.vuaa.buyDay)), text: `Compra VUAA ${eur0(R.vuaa.amount)}` });
    if (R.btc) ev.push({ date: iso(businessAfter(yy, mm, R.btc.planDay)), text: `Compra BTC ${eur0(R.btc.amount)}` });
    if (R.serieF) ev.push({ date: iso(new Date(yy, mm, R.serieF.subDay)), text: `Subscrição Série F ${eur0(R.serieF.monthlyIrs + R.serieF.monthlyAvo)}` });
    if (R.vuaa) ev.push({ date: iso(new Date(yy, mm, R.vuaa.transferDay || 28)), text: "Transferir Montepio → IBKR e Trade Republic", muted: true });
  }
  if (R.payouts) {
    for (const y of [today.getFullYear(), today.getFullYear() + 1]) {
      ev.push({ date: `${y}-08-20`, text: "Resgatar Série F para o IRS (pagar até 31/08)", warn: true });
      ev.push({ date: `${y}-12-20`, text: "Resgatar Série F para o Crédito Avô (entregar a 31/12)", warn: true });
    }
  }
  return ev.filter((e) => e.date > todayIso).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 6);
}

/* ---------- Render ---------- */
const ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/></svg>';

function ago(isoTs) {
  if (!isoTs) return "nunca";
  const min = Math.round((Date.now() - new Date(isoTs).getTime()) / 60000);
  if (min < 2) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

function render() {
  const app = $("#app");
  if (!state) {
    app.innerHTML = `
      <div class="empty">
        <h1>Caderneta</h1>
        <p class="muted">Os teus valores ficam só neste iPhone. Importa o ficheiro de dados para começar.</p>
        <button class="btn" data-act="import">Importar dados</button>
      </div>`;
    return;
  }
  const c = compute(state);
  const showTotal = view === "total" && c.casa;
  const headline = showTotal ? c.total : c.liquido;
  const pl = c.mValue - c.mCost;
  const parts = [...c.items.filter((i) => i.value > 0), ...(showTotal && c.casa.value > 0 ? [c.casa] : [])];
  const sum = parts.reduce((a, i) => a + i.value, 0) || 1;
  const pricesUpd = prices.updated;
  const stale = !pricesUpd || Date.now() - new Date(pricesUpd).getTime() > 36 * 3600e3;

  app.innerHTML = `
    <div class="top">
      <div class="brand">Caderneta</div>
      <div style="display:flex;gap:8px">
        <button class="icon-btn" data-act="refresh" aria-label="Atualizar cotações">${ICON_REFRESH}</button>
        <button class="icon-btn" data-act="settings" aria-label="Definições">${ICON_GEAR}</button>
      </div>
    </div>
    <div class="hero-label">${showTotal ? "Património total (com casa)" : "Património líquido"}</div>
    <div class="hero-value num">${eur(headline)}</div>
    <div class="hero-sub num ${pl >= 0 ? "up" : "down"}">${signed(pl)} (${pct(c.mCost ? pl / c.mCost : 0)}) <span class="muted" style="font-weight:500">em investimentos</span></div>
    ${c.casa ? `<div class="seg" role="group">
      <button data-view="liquido" aria-pressed="${!showTotal}">Líquido</button>
      <button data-view="total" aria-pressed="${!!showTotal}">Com casa</button>
    </div>` : ""}
    <div class="alloc">${parts.map((i) => `<span style="width:${(i.value / sum) * 100}%;background:${META[i.key].color}"></span>`).join("")}</div>
    <div class="legend">${parts.map((i) => `<span><i style="background:${META[i.key].color}"></i>${META[i.key].name} ${Math.round((i.value / sum) * 100)}%</span>`).join("")}</div>
    <div class="status"><span class="dot ${stale ? "stale" : ""}"></span>Cotações ${ago(live.at || pricesUpd)}${stale ? " · a aguardar atualização" : ""}</div>

    <h2>Posições</h2>
    ${c.items.map((i) => rowHtml(i)).join("")}
    ${c.casa ? rowHtml(c.casa) : `<button class="row" data-edit="casa"><div class="mono" style="background:var(--c-res)">⌂</div><div class="row-main"><div class="row-title">Adicionar casa</div><div class="row-sub">Valor de mercado e crédito em dívida</div></div></button>`}

    ${c.F ? serieFCard(c) : ""}

    <h2>Próximos</h2>
    <div>${upcoming(state).map((e) => `
      <div class="event"><div class="event-date num">${fmtDay(e.date)}</div>
      <div class="event-main ${e.muted ? "muted" : ""}">${esc(e.text)}${e.warn ? '<span class="tag warn">lembrete</span>' : ""}</div></div>`).join("")}</div>

    <h2>Movimentos</h2>
    <div>${state.movements.slice(0, 12).map((m) => `
      <div class="event"><div class="event-date num">${fmtDay(m.date)}</div>
      <div class="event-main">${esc(m.text)}${m.est ? '<span class="tag">estimado</span>' : ""}${m.check ? '<span class="tag warn">confirmar</span>' : ""}</div>
      <div class="num ${m.amount >= 0 ? "" : "muted"}">${m.amount != null ? signed(m.amount) : ""}</div></div>`).join("") || '<p class="muted small">Ainda sem movimentos automáticos.</p>'}</div>
  `;
}

function rowHtml(i) {
  const m = META[i.key];
  let sub = m.sub, right2 = "";
  if (["vuaa", "btc", "ada"].includes(i.key)) {
    sub = `${num(i.units, i.key === "btc" ? 7 : 4)} un. · ${i.price != null ? eur(i.price, i.key === "ada" ? 4 : 2) : "sem cotação"}`;
  }
  if (i.cost != null && i.key !== "fundo" && i.value != null) {
    const pl = i.value - i.cost;
    right2 = `<div class="small num ${pl >= 0 ? "up" : "down"}">${signed(pl)}</div>`;
  }
  if (i.key === "fundo") right2 = `<div class="small num up">+${eur(i.juros)} juros</div>`;
  if (i.key === "casa") { sub = `Capital próprio · dívida ${eur0(i.debt)}`; right2 = `<div class="small muted num">valor ${eur0(i.gross)}</div>`; }
  return `<button class="row" data-edit="${i.key}">
    <div class="mono" style="background:${m.color}">${m.mono}</div>
    <div class="row-main"><div class="row-title">${m.name}</div><div class="row-sub num">${sub}</div></div>
    <div class="row-right"><div class="row-value num">${i.value != null ? eur(i.value) : "—"}</div>${right2}</div>
  </button>`;
}

function serieFCard(c) {
  const F = c.F, t = F.total || 1;
  return `
    <h2>Série F</h2>
    <div class="card">
      <div class="split"><span class="muted">Saldo no AforroNet${F.interestEst ? " (estimado)" : ""}</span><b class="num">${eur(F.total)}</b></div>
      <div class="bar2">
        <span style="width:${(c.fundo / t) * 100}%;background:var(--c-serief)"></span>
        <span style="width:${(c.resIrs / t) * 100}%;background:var(--c-res)"></span>
        <span style="width:${(c.resAvo / t) * 100}%;background:var(--c-res);opacity:.6"></span>
      </div>
      <div class="split"><span>Fundo de emergência</span><span class="num">${eur(c.fundo)}</span></div>
      <div class="split muted"><span>Reservado IRS · sai a 31/08</span><span class="num">${eur(c.resIrs)}</span></div>
      <div class="split muted"><span>Reservado Avô · sai a 31/12</span><span class="num">${eur(c.resAvo)}</span></div>
      <div class="small muted" style="margin-top:6px">Sincronizado a ${fmtDate(F.syncedAt)}. O reservado não conta para o património.</div>
      <button class="btn ghost" data-edit="serieF">Sincronizar com o AforroNet</button>
    </div>`;
}

/* ---------- Folhas (edição) ---------- */
function openSheet(html, onSubmit) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  const form = $("#sheet-body form");
  if (form && onSubmit) form.onsubmit = (e) => { e.preventDefault(); onSubmit(new FormData(form)); };
}
function closeSheet() { $("#sheet").hidden = true; $("#sheet-body").innerHTML = ""; }
const f = (label, name, value, step = "any", type = "number") =>
  `<label class="field">${label}<input name="${name}" type="${type}" inputmode="decimal" step="${step}" value="${value ?? ""}"></label>`;
const n = (fd, k) => { const v = String(fd.get(k) ?? "").replace(",", "."); return v === "" ? null : Number(v); };

function editPosition(key) {
  const P = state.positions;
  if (["vuaa", "btc", "ada"].includes(key)) {
    const p = P[key];
    openSheet(`<form><h3>${META[key].name}</h3><p class="muted small">Confirma as unidades na app da corretora.</p>
      ${f("Unidades", "units", p.units)}${f("Total investido (com comissões), €", "cost", p.cost)}
      <button class="btn">Guardar</button><button type="button" class="btn ghost" data-close>Cancelar</button></form>`,
      (fd) => { p.units = n(fd, "units") ?? p.units; p.cost = n(fd, "cost") ?? p.cost; commit("Guardado"); });
  } else if (key === "cs2") {
    const p = P.cs2;
    openSheet(`<form><h3>Inventário CS2</h3>${f("Valor atual, €", "value", p.value)}${f("Total investido, €", "cost", p.cost)}
      <button class="btn">Guardar</button><button type="button" class="btn ghost" data-close>Cancelar</button></form>`,
      (fd) => { p.value = n(fd, "value") ?? p.value; p.cost = n(fd, "cost") ?? p.cost; commit("Guardado"); });
  } else if (key === "serieF" || key === "fundo") {
    const F = P.serieF;
    const yr = String(new Date().getFullYear());
    const irsYears = [...new Set([...Object.keys(F.reserved.irs), yr])].sort();
    const avoYears = [...new Set([...Object.keys(F.reserved.avo), yr])].sort();
    openSheet(`<form><h3>Sincronizar Série F</h3><p class="muted small">Copia o saldo total do extrato do AforroNet. O fundo de emergência é o saldo menos o reservado.</p>
      ${f("Saldo total no AforroNet, €", "total", +F.total.toFixed(2))}
      ${irsYears.map((y) => f(`Reservado IRS ${y} (sai a 31/08/${+y + 1}), €`, "irs-" + y, +(F.reserved.irs[y] ?? 0).toFixed(2))).join("")}
      ${avoYears.map((y) => f(`Reservado Avô ${y} (sai a 31/12/${y}), €`, "avo-" + y, +(F.reserved.avo[y] ?? 0).toFixed(2))).join("")}
      <button class="btn">Guardar</button><button type="button" class="btn ghost" data-close>Cancelar</button></form>`,
      (fd) => {
        F.total = n(fd, "total") ?? F.total;
        F.reserved.irs = {}; F.reserved.avo = {};
        for (const y of irsYears) { const v = n(fd, "irs-" + y); if (v) F.reserved.irs[y] = v; }
        for (const y of avoYears) { const v = n(fd, "avo-" + y); if (v) F.reserved.avo[y] = v; }
        F.interestEst = 0; F.syncedAt = iso(new Date()); F.lastAccrual = iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
        commit("Série F sincronizada");
      });
  } else if (key === "casa") {
    const C = P.casa || { value: "", debt: "", share: 1, tan: "", payment: "" };
    openSheet(`<form><h3>Casa</h3><p class="muted small">A dívida desce sozinha no fim de cada mês com a prestação.</p>
      ${f("Valor de mercado estimado, €", "value", C.value)}
      ${f("Capital em dívida hoje (total do crédito), €", "debt", C.debt ? +C.debt.toFixed(2) : "")}
      <div class="grid2">${f("Quota a contar, %", "share", C.share * 100)}${f("TAN, %", "tan", C.tan)}</div>
      ${f("Prestação mensal, €", "payment", C.payment)}
      <button class="btn">Guardar</button><button type="button" class="btn ghost" data-close>Cancelar</button>
      ${P.casa ? '<button type="button" class="btn danger" data-act="remove-casa">Remover casa</button>' : ""}</form>`,
      (fd) => {
        const v = n(fd, "value"), d = n(fd, "debt");
        if (v == null || d == null) return toast("Preenche o valor e a dívida");
        P.casa = { value: v, debt: d, debtAsOf: iso(new Date()), share: (n(fd, "share") ?? 100) / 100, tan: n(fd, "tan") ?? 0, payment: n(fd, "payment") ?? 0 };
        commit("Casa guardada");
      });
  }
}

function openSettings() {
  const R = state?.rules;
  openSheet(`<h3>Definições</h3>
    ${state ? `<form id="rates">${f("Taxa bruta estimada da Série F, %", "rate", R.serieF.grossRate)}
      <p class="muted small">Só serve para estimar juros entre sincronizações.</p>
      <button class="btn ghost">Guardar taxa</button></form>` : ""}
    <button class="btn" data-act="export">Exportar cópia de segurança</button>
    <button class="btn ghost" data-act="import">Importar dados</button>
    <p class="muted small" style="margin-top:14px">Regras: VUAA ${R ? eur(R.vuaa.amount + R.vuaa.fee) : ""} a dia ${R?.vuaa.buyDay} (dia útil) · BTC ${R ? eur0(R.btc.amount) : ""} no dia útil a seguir ao dia ${R?.btc.planDay} · Série F a dia ${R?.serieF.subDay}.
    Os dados estão só neste dispositivo. Exporta uma cópia de vez em quando para o OneDrive.</p>
    ${state ? '<button class="btn danger" data-act="reset">Apagar dados deste dispositivo</button>' : ""}
    <button class="btn ghost" data-close>Fechar</button>`);
  const rf = $("#rates");
  if (rf) rf.onsubmit = (e) => { e.preventDefault(); const v = n(new FormData(rf), "rate"); if (v != null) { R.serieF.grossRate = v; commit("Taxa guardada"); } };
}

function openImport() {
  openSheet(`<h3>Importar dados</h3>
    <p class="muted small">Escolhe o ficheiro <b>caderneta-dados.json</b> (está no OneDrive, em Vida/Organização) ou cola o conteúdo.</p>
    <label class="btn ghost" style="display:block">Escolher ficheiro<input id="file" type="file" accept=".json,application/json" hidden></label>
    <textarea id="paste" placeholder='{"positions": …}'></textarea>
    <button class="btn" data-act="do-import">Importar</button>
    <button class="btn ghost" data-close>Cancelar</button>`);
  $("#file").onchange = async (e) => { const fl = e.target.files[0]; if (fl) doImport(await fl.text()); };
}
function doImport(text) {
  try {
    const s = validate(JSON.parse(text));
    if (state && !confirmReplace()) return;
    state = s; processRules(state); save(state); closeSheet(); render(); toast("Dados importados");
  } catch (e) { toast("Ficheiro inválido: " + e.message); }
}
function confirmReplace() { return window.confirm("Substituir os dados atuais deste dispositivo?"); }

async function doExport() {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
  const name = `caderneta-dados-${iso(new Date())}.json`;
  const file = new File([blob], name, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function commit(msg) { save(state); closeSheet(); render(); if (msg) toast(msg); }

let toastTimer;
function toast(msg) {
  let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.append(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ---------- Eventos ---------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act],[data-edit],[data-view],[data-close]");
  if (!el) return;
  if (el.dataset.close !== undefined) return closeSheet();
  if (el.dataset.edit) return editPosition(el.dataset.edit);
  if (el.dataset.view) { view = el.dataset.view; try { localStorage.setItem("caderneta-view", view); } catch {} return render(); }
  const act = el.dataset.act;
  if (act === "settings") openSettings();
  else if (act === "import") openImport();
  else if (act === "do-import") doImport($("#paste").value);
  else if (act === "export") doExport();
  else if (act === "refresh") { toast("A atualizar…"); await boot(); toast("Atualizado"); }
  else if (act === "remove-casa") { delete state.positions.casa; commit("Casa removida"); }
  else if (act === "reset") { if (window.confirm("Apagar todos os dados deste dispositivo?")) { localStorage.removeItem(KEY); state = null; closeSheet(); render(); } }
});

async function boot() {
  render();
  await refreshPrices();
  if (state) {
    for (const k of ["vuaa", "btc", "ada"]) { const px = priceOf(k); if (px && state.positions[k]) state.positions[k].lastPrice = px; }
    const applied = processRules(state);
    save(state);
    if (applied.length) toast("Lançado: " + [...new Set(applied)].join(", "));
  }
  render();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") boot(); });
boot();

// Para testes
if (typeof window !== "undefined") window.__caderneta = { processRules, compute, upcoming, businessOnOrAfter, businessAfter, iso };
