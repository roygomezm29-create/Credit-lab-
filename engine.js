/* Credit 2.0 — núcleo financiero de PRUEBAS v0.1.
   Sin dependencias, sin red y sin datos personales.
   Importes internos en CENTAVOS enteros; fechas ISO YYYY-MM-DD.
   Este módulo NO es todavía el motor de recomendación definitivo. */
(function (root) {
  'use strict';

  const fail = (message) => { throw new Error(message); };
  const money = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) fail('El importe debe ser un entero de centavos.');
    return value;
  };
  const positive = (value) => { money(value); if (value <= 0) fail('El importe debe ser mayor que cero.'); return value; };
  const ymd = (date) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('Fecha inválida: ' + date);
    const d = new Date(date + 'T12:00:00Z');
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== date) fail('Fecha imposible: ' + date);
    return date;
  };
  const toDate = (date) => { ymd(date); return new Date(date + 'T12:00:00Z'); };
  const iso = (d) => d.toISOString().slice(0, 10);
  const monthDate = (year, monthIndex, day) => {
    const first = new Date(Date.UTC(year, monthIndex, 1, 12));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12)).getUTCDate();
    return iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last), 12)));
  };
  const addMonths = (date, count) => {
    const d = toDate(date);
    return monthDate(d.getUTCFullYear(), d.getUTCMonth() + count, d.getUTCDate());
  };
  const addDays = (date, days) => {
    const d = toDate(date); d.setUTCDate(d.getUTCDate() + days); return iso(d);
  };
  const stable = (value) => JSON.stringify(value, function (key, item) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.keys(item).sort().reduce((o, k) => { o[k] = item[k]; return o; }, {});
    }
    return item;
  });
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const same = (a, b) => stable(a) === stable(b);
  const isDay = (n) => Number.isInteger(n) && n >= 1 && n <= 31;
  const requireCard = (state, cardId) => {
    const card = state.cards.find(c => c.id === cardId);
    if (!card) fail('Tarjeta no encontrada: ' + cardId);
    return card;
  };

  function createState({ openingCashCents = 0, cards = [] } = {}) {
    money(openingCashCents);
    if (openingCashCents < 0) fail('Saldo inicial negativo: debe registrarse como ajuste.');
    const ids = new Set();
    const validated = cards.map(card => {
      if (!card.id || ids.has(card.id)) fail('ID de tarjeta vacío o duplicado.');
      ids.add(card.id);
      money(card.limitCents); money(card.openingDebtCents ?? 0);
      if (card.limitCents < 0 || (card.openingDebtCents ?? 0) < 0) fail('Límite o deuda inicial inválidos.');
      if (!isDay(card.cutoffDay) || !isDay(card.dueDay)) fail('Día de corte o pago inválido.');
      return { ...card, openingDebtCents: card.openingDebtCents ?? 0 };
    });
    return { openingCashCents, cards: validated, operations: [], plans: [], statements: [], subscriptions: [] };
  }

  function balances(state) {
    let cashCents = state.openingCashCents;
    const debtCents = Object.fromEntries(state.cards.map(c => [c.id, c.openingDebtCents]));
    let consumptionCents = 0;
    let incomeCents = 0;
    for (const op of state.operations) {
      switch (op.type) {
        case 'income': cashCents += op.amountCents; incomeCents += op.amountCents; break;
        case 'cash_expense': cashCents -= op.amountCents; consumptionCents += op.amountCents; break;
        case 'card_purchase': debtCents[op.cardId] += op.amountCents; consumptionCents += op.amountCents; break;
        case 'msi_purchase': debtCents[op.cardId] += op.amountCents + (op.feeCents || 0); consumptionCents += op.amountCents; break;
        case 'card_payment': cashCents -= op.amountCents; debtCents[op.cardId] -= op.amountCents; break;
        case 'card_adjustment': debtCents[op.cardId] += op.deltaCents; break;
        case 'cash_adjustment': cashCents += op.deltaCents; break;
        case 'debt_transfer': debtCents[op.fromCardId] -= op.amountCents; debtCents[op.toCardId] += op.amountCents; break;
        default: fail('Tipo de operación desconocido: ' + op.type);
      }
      for (const [id, amount] of Object.entries(debtCents)) if (amount < 0) fail('Una operación produciría deuda negativa en ' + id);
    }
    const totalDebtCents = Object.values(debtCents).reduce((a, b) => a + b, 0);
    return { cashCents, debtCents, totalDebtCents, consumptionCents, incomeCents };
  }

  function recordOperation(state, input) {
    const op = copy(input);
    if (!op.id || typeof op.id !== 'string') fail('Cada operación necesita un ID único.');
    ymd(op.date);
    const exists = state.operations.find(o => o.id === op.id);
    if (exists) {
      if (!same(exists, op)) fail('Conflicto: el mismo ID se utilizó con otro contenido.');
      return state; // idempotencia: reintentar NO duplica
    }
    if (['income', 'cash_expense', 'card_purchase', 'card_payment', 'msi_purchase', 'debt_transfer'].includes(op.type)) positive(op.amountCents);
    if (['card_adjustment', 'cash_adjustment'].includes(op.type)) money(op.deltaCents);
    if (['card_purchase', 'card_payment', 'msi_purchase', 'card_adjustment'].includes(op.type)) requireCard(state, op.cardId);
    if (op.type === 'debt_transfer') {
      requireCard(state, op.fromCardId); requireCard(state, op.toCardId);
      if (op.fromCardId === op.toCardId) fail('No se puede transferir deuda a la misma tarjeta.');
    }
    if (op.type === 'card_payment' && op.coveredOperationIds) {
      for (const targetId of op.coveredOperationIds) {
        const target = state.operations.find(x => x.id === targetId);
        if (!target || target.cardId !== op.cardId || !['card_purchase','msi_purchase'].includes(target.type)) fail('Referencia de pago incompatible.');
      }
    }
    if (op.type === 'msi_purchase') {
      if (!Number.isInteger(op.months) || op.months < 2 || op.months > 60) fail('Plazo MSI inválido.');
      ymd(op.firstDueDate);
      money(op.feeCents || 0);
      if ((op.feeCents || 0) < 0) fail('Comisión negativa no permitida.');
    }
    const result = { ...state, operations: [...state.operations, op] };
    balances(result); // validación previa a la confirmación; sin cambios parciales
    return result;
  }

  function addPlan(state, input) {
    const p = copy(input);
    if (!p.id || typeof p.id !== 'string') fail('Plan sin ID.');
    ymd(p.date); positive(p.amountCents);
    if (!['income', 'cash_expense', 'card_purchase'].includes(p.type)) fail('Tipo de plan no soportado.');
    if (p.type === 'card_purchase') requireCard(state, p.cardId);
    const found = state.plans.find(x => x.id === p.id);
    if (found) { const { status, operationId, ...original } = found; if (!same(original, p)) fail('Plan con ID en conflicto.'); return state; }
    return { ...state, plans: [...state.plans, { ...p, status: 'planned' }] };
  }

  function confirmPlan(state, planId, operationId, date) {
    const p = state.plans.find(x => x.id === planId);
    if (!p) fail('Plan inexistente.');
    if (p.status === 'confirmed') {
      if (p.operationId !== operationId) fail('El plan ya está vinculado a otra operación.');
      return state;
    }
    if (p.status !== 'planned') fail('El plan fue cancelado.');
    const next = recordOperation(state, { id: operationId, type: p.type, cardId: p.cardId, amountCents: p.amountCents, date: ymd(date), sourcePlanId: planId });
    return { ...next, plans: next.plans.map(x => x.id === planId ? { ...x, status: 'confirmed', operationId } : x) };
  }

  function cancelPlan(state, planId) {
    const p = state.plans.find(x => x.id === planId);
    if (!p || p.status === 'confirmed') fail('No es posible cancelar ese plan.');
    if (p.status === 'canceled') return state;
    return { ...state, plans: state.plans.map(x => x.id === planId ? { ...x, status: 'canceled' } : x) };
  }

  function addStatement(state, input) {
    const statement = { coveredOperationIds: [], includedInstallmentIds: [], ...copy(input) };
    if (!statement.id) fail('Estado de cuenta sin ID.');
    requireCard(state, statement.cardId); ymd(statement.dueDate); positive(statement.amountCents);
    const found = state.statements.find(x => x.id === statement.id);
    if (found) { if (!same(found, statement)) fail('Estado de cuenta con ID en conflicto.'); return state; }
    return { ...state, statements: [...state.statements, statement] };
  }

  function addSubscription(state, input) {
    const sub = copy(input);
    if (!sub.id) fail('Suscripción sin ID.');
    if (!['cash', 'card'].includes(sub.method)) fail('Método de suscripción inválido.');
    if (sub.method === 'card') requireCard(state, sub.cardId);
    ymd(sub.firstDate); positive(sub.amountCents);
    const found = state.subscriptions.find(x => x.id === sub.id);
    if (found) { if (!same(found, sub)) fail('Suscripción con ID en conflicto.'); return state; }
    return { ...state, subscriptions: [...state.subscriptions, sub] };
  }

  function installmentSchedule(operation) {
    if (operation.type !== 'msi_purchase') return [];
    const total = operation.amountCents + (operation.feeCents || 0);
    const base = Math.floor(total / operation.months);
    const rem = total % operation.months;
    return Array.from({ length: operation.months }, (_, index) => ({
      id: `${operation.id}:m${index + 1}`, cardId: operation.cardId,
      sourceOperationId: operation.id, date: addMonths(operation.firstDueDate, index),
      amountCents: base + (index < rem ? 1 : 0)
    }));
  }

  function estimatedDueDate(purchaseDate, card) {
    const d = toDate(purchaseDate);
    // Una compra el propio día de corte requiere verificación del movimiento bancario.
    // Para esta estimación, se asigna al ciclo posterior.
    const cutoffMonthOffset = d.getUTCDate() >= card.cutoffDay ? 1 : 0;
    const cutoff = monthDate(d.getUTCFullYear(), d.getUTCMonth() + cutoffMonthOffset, card.cutoffDay);
    const c = toDate(cutoff);
    return monthDate(c.getUTCFullYear(), c.getUTCMonth() + (card.dueDay <= card.cutoffDay ? 1 : 0), card.dueDay);
  }

  function subscriptionOccurrences(state, start, end) {
    const occurrences = [];
    const confirmed = new Set(state.operations.map(o => o.sourceOccurrenceId).filter(Boolean));
    for (const sub of state.subscriptions) {
      for (let index = 0; index < 240; index++) {
        const date = addMonths(sub.firstDate, index);
        if (date > end) break;
        if (date < start) continue;
        const id = `${sub.id}:occ${index + 1}`;
        if (!confirmed.has(id)) occurrences.push({ ...sub, date, occurrenceId: id });
      }
    }
    return occurrences;
  }

  // Compromisos monetarios futuros. Las salidas no se duplican con el estado de cuenta.
  function plannedCashFlows(state, start, end, { includeExpectedIncome = false, simulatedPurchase = null } = {}) {
    ymd(start); ymd(end);
    const events = [];
    const covered = new Set(state.statements.flatMap(s => s.coveredOperationIds || []));
    const includedInstallments = new Set(state.statements.flatMap(s => s.includedInstallmentIds || []));
    const paidStatements = new Set(state.operations.map(o => o.type === 'card_payment' ? o.statementId : null).filter(Boolean));
    const paidPurchases = new Set(state.operations.flatMap(o => o.type === 'card_payment' || o.type === 'card_adjustment' ? (o.coveredOperationIds || []) : []));
    const paidInstallments = new Set(state.operations.flatMap(o => o.type === 'card_payment' ? (o.paidInstallmentIds || []) : []));
    const added = new Set();
    const put = (event) => {
      if (event.date >= start && event.date <= end && !added.has(event.id)) { events.push(event); added.add(event.id); }
    };
    const dueCardPurchase = (id, cardId, amountCents, purchaseDate) => {
      const date = estimatedDueDate(purchaseDate, requireCard(state, cardId));
      put({ id, date, amountCents: -amountCents, kind: 'card_due' });
    };
    for (const s of state.statements) if (!paidStatements.has(s.id)) {
      put({ id: `statement:${s.id}`, date: s.dueDate, amountCents: -s.amountCents, kind: 'statement' });
    }
    for (const op of state.operations) {
      if (op.type === 'card_purchase' && !covered.has(op.id) && !paidPurchases.has(op.id)) dueCardPurchase(`purchase:${op.id}`, op.cardId, op.amountCents, op.date);
      if (op.type === 'card_payment' && op.coveredOperationIds) {
      for (const targetId of op.coveredOperationIds) {
        const target = state.operations.find(x => x.id === targetId);
        if (!target || target.cardId !== op.cardId || !['card_purchase','msi_purchase'].includes(target.type)) fail('Referencia de pago incompatible.');
      }
    }
    if (op.type === 'msi_purchase') {
        for (const i of installmentSchedule(op)) if (!includedInstallments.has(i.id) && !paidInstallments.has(i.id)) {
          put({ id: `msi:${i.id}`, date: i.date, amountCents: -i.amountCents, kind: 'installment' });
        }
      }
    }
    for (const p of state.plans) {
      if (p.status !== 'planned') continue;
      if (p.type === 'income') {
        if (p.certainty === 'confirmed' || includeExpectedIncome) put({ id:`plan:${p.id}`,date:p.date,amountCents:p.amountCents,kind:'planned_income' });
      }
      if (p.type === 'cash_expense') put({ id:`plan:${p.id}`,date:p.date,amountCents:-p.amountCents,kind:'planned_cash_expense' });
      if (p.type === 'card_purchase') dueCardPurchase(`plan:${p.id}`,p.cardId,p.amountCents,p.date);
    }
    for (const sub of subscriptionOccurrences(state, start, end)) {
      if (sub.method === 'cash') put({ id: `sub:${sub.occurrenceId}`,date:sub.date,amountCents:-sub.amountCents,kind:'subscription' });
      else dueCardPurchase(`sub:${sub.occurrenceId}`,sub.cardId,sub.amountCents,sub.date);
    }
    if (simulatedPurchase) {
      const s = simulatedPurchase;
      if (s.months) {
        const firstDueDate = estimatedDueDate(s.date,requireCard(state,s.cardId));
        for (const m of installmentSchedule({type:'msi_purchase',id:'hypothetical',cardId:s.cardId,amountCents:s.amountCents,feeCents:s.feeCents||0,months:s.months,firstDueDate})) {
          put({id:`simulation:${m.id}`,date:m.date,amountCents:-m.amountCents,kind:'simulation'});
        }
      } else dueCardPurchase('simulation:purchase',s.cardId,s.amountCents,s.date);
    }
    return events.sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }

  function forecast(state, start, end, options = {}) {
    const startCash = balances(state).cashCents;
    const flows = plannedCashFlows(state,start,end,options);
    let cashCents = startCash;
    let minCashCents = startCash;
    let minDate = start;
    const timeline = [{ date: start, cashCents: startCash, type: 'initial' }];
    const dates = [...new Set(flows.map(e => e.date))];
    for (const date of dates) {
      cashCents += flows.filter(e => e.date === date).reduce((s,e)=>s+e.amountCents,0);
      timeline.push({ date, cashCents, type:'projected' });
      if (cashCents < minCashCents) { minCashCents = cashCents; minDate = date; }
    }
    const warnings = [];
    for (const card of state.cards) {
      if (card.openingDebtCents > 0 && !state.statements.some(s => s.cardId === card.id)) warnings.push(`Falta vencimiento bancario verificado para deuda inicial de ${card.bank || card.id}.`);
    }
    for (const op of state.operations) {
      if ((op.type === 'card_payment' || op.type === 'card_adjustment') && !op.statementId && !(op.coveredOperationIds || []).length && !(op.paidInstallmentIds || []).length) {
        warnings.push(`Pago o ajuste ${op.id} sin asignación: las proyecciones de deuda podrían requerir conciliación.`);
      }
    }
    return { startCashCents: startCash, endingCashCents: cashCents, minCashCents, minDate, timeline, flows, warnings };
  }

  function usableMoney(state, today, { days = 30, safetyCents = 0 } = {}) {
    ymd(today); money(safetyCents);
    const end = addDays(today, days);
    const b = balances(state);
    let newCommitmentCents = 0;
    for (const p of state.plans) if (p.status === 'planned' && p.date >= today && p.date <= end && p.type !== 'income') newCommitmentCents += p.amountCents;
    for (const s of subscriptionOccurrences(state,today,end)) newCommitmentCents += s.amountCents;
    // Deuda existente incluye MSI: NO restar mensualidades ni pagos de tarjeta otra vez.
    // Ingresos futuros NO aumentan el dinero utilizable actual.
    const rawCents = b.cashCents - b.totalDebtCents - newCommitmentCents - safetyCents;
    return { usableCents: Math.max(0,rawCents), rawCents, reservedDebtCents:b.totalDebtCents, reservedNewCommitmentsCents:newCommitmentCents, safetyCents };
  }

  const api = { createState, balances, recordOperation, addPlan, confirmPlan, cancelPlan, addStatement, addSubscription, installmentSchedule, estimatedDueDate, subscriptionOccurrences, plannedCashFlows, forecast, usableMoney, addDays, addMonths, money };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CreditCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
