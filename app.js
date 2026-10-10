require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { buscarLeads } = require('./leads');
const { gerarSite } = require('./sitegen');
const IA_KEYS = ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'ANTHROPIC_API_KEY'];

const {
  ASAAS_API_KEY, ASAAS_ENV, ASAAS_WEBHOOK_TOKEN,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGIN,
  PIX_TTL_MINUTES = 30,
} = process.env;
const missing = ['ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);

const ASAAS = ASAAS_ENV === 'production' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
const admin = missing.length ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Preços SEMPRE no servidor (o front só diz qual plano/período). Anual = cobrança do ano inteiro.
// Tokens por mês de cada plano (1 token = 1 busca no radar de leads). Renovam todo dia 1º.
const TOKENS = { Starter: 30, Pro: 150, Agency: 400 };
const DONOS = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); // sem limite (para você testar)
const PLANS = { Starter: { m: 97, a: 79 }, Pro: { m: 247, a: 197 }, Agency: { m: 597, a: 497 } };

const app = express();
const keyRole = (() => { try { return JSON.parse(Buffer.from(String(SUPABASE_SERVICE_ROLE_KEY).split('.')[1], 'base64url').toString()).role; } catch { return 'desconhecido'; } })();
app.get('/api/health', (req, res) => res.json({ ok: !missing.length && keyRole !== 'anon', missing, ia: IA_KEYS.some((k) => process.env[k]), google: !!process.env.GOOGLE_MAPS_API_KEY, key_role: keyRole, aviso: keyRole === 'anon' ? 'SUPABASE_SERVICE_ROLE_KEY está com a chave ANON. Troque pela service_role.' : undefined }));
if (missing.length) app.use((req, res) => res.status(500).send('Faltam variáveis de ambiente: ' + missing.join(', ')));
if (ALLOWED_ORIGIN) app.use('/api', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  req.method === 'OPTIONS' ? res.sendStatus(204) : next();
});
app.use(express.static(path.join(__dirname, 'public')));

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const safeEq = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const todayBRT = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

async function asaas(method, p, body) {
  const r = await fetch(ASAAS + p, {
    method,
    headers: { 'Content-Type': 'application/json', access_token: ASAAS_API_KEY, 'User-Agent': 'devpay' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Asaas', method, p, r.status, JSON.stringify(j)); throw fail(502, 'gateway_error', j.errors?.[0]?.description || 'Erro no gateway de pagamento'); }
  return j;
}

async function authUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /i, '');
  if (!token) throw fail(401, 'unauthorized', 'Sessão ausente');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw fail(401, 'unauthorized', 'Sessão inválida');
  return data.user;
}

/* ---------- Plano + tokens ---------- */
// Soma meses sem estourar o dia (31/jan + 1 mês = 28 ou 29/fev)
function addMeses(d, n) {
  const x = new Date(d), dia = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  x.setUTCDate(Math.min(dia, new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()));
  return x;
}
// Ciclo de tokens: começa no dia da assinatura e vira todo mês nessa mesma data.
function cicloTokens(anchor, agora = new Date()) {
  const a = new Date(anchor);
  let k = (agora.getUTCFullYear() - a.getUTCFullYear()) * 12 + (agora.getUTCMonth() - a.getUTCMonth());
  if (k < 0) k = 0;
  if (addMeses(a, k) > agora) k = Math.max(0, k - 1);
  return { chave: 'c' + addMeses(a, k).toISOString().slice(0, 10), proximo: addMeses(a, k + 1) };
}

async function acesso(user) {
  if (DONOS.includes(String(user.email || '').toLowerCase())) return { ativo: true, dono: true };
  const { data: s } = await admin.from('subscriptions').select('*').eq('user_id', user.id).maybeSingle();
  if (!s || s.status !== 'ativo' || new Date(s.current_period_end) <= new Date() || !TOKENS[s.plan]) return { ativo: false };
  const fim = new Date(s.current_period_end);
  const anchor = s.anchor || addMeses(fim, -(s.period === 'a' ? 12 : 1)); // assinaturas antigas: estima o início
  const { chave, proximo } = cicloTokens(anchor);
  return { ativo: true, plan: s.plan, total: TOKENS[s.plan], ciclo: chave, renova: proximo < fim ? proximo : null, vence: fim };
}

// delta > 0 consome, delta < 0 devolve. Retorna tokens restantes (ou -1 se não houver saldo).
async function mexerTokens(user, ac, delta) {
  const { data, error } = await admin.rpc('use_tokens', { p_user: user.id, p_month: ac.ciclo, p_delta: delta, p_limit: ac.total });
  if (error) { console.error('tokens', error); throw fail(500, 'tokens_not_configured', 'Falta rodar o supabase_tokens.sql no Supabase.'); }
  return data;
}

async function ensureCustomer(user, cpfCnpj) {
  const { data } = await admin.from('billing_customers').select('asaas_customer_id').eq('user_id', user.id).maybeSingle();
  if (data) return data.asaas_customer_id;
  if (!cpfCnpj) throw fail(422, 'cpf_required', 'CPF/CNPJ necessário');
  if (![11, 14].includes(cpfCnpj.length)) throw fail(400, 'invalid_doc', 'CPF/CNPJ inválido');
  const c = await asaas('POST', '/customers', {
    name: user.user_metadata?.full_name || user.email, email: user.email, cpfCnpj, externalReference: user.id,
  });
  await admin.from('billing_customers').upsert({ user_id: user.id, asaas_customer_id: c.id, cpf_cnpj: cpfCnpj });
  return c.id;
}

const pixPayload = async (gatewayId) => {
  const q = await asaas('GET', `/payments/${gatewayId}/pixQrCode`);
  return { qr_code_base64: q.encodedImage, pix_copia_e_cola: q.payload };
};

const FEE = Number(process.env.PLATFORM_FEE_PERCENT || 0); // % retida pela plataforma (0 = repassa tudo)

// Repassa o valor recebido para a chave Pix do vendedor (só Pix: saldo entra na hora; cartão só libera depois)
async function payoutSeller(p, payment) {
  if (p.method !== 'pix') return;
  const { data: k } = await admin.from('seller_pix').select('*').eq('user_id', p.user_id).maybeSingle();
  if (!k) { await admin.from('payments').update({ payout_status: 'sem_chave' }).eq('id', p.id).is('payout_status', null); return; }
  const { data: c } = await admin.from('payments').update({ payout_status: 'enviando' }).eq('id', p.id).is('payout_status', null).select('id').maybeSingle();
  if (!c) return; // outro processo já cuidou do repasse
  const cents = Math.round(Number(payment.netValue ?? payment.value) * 100);
  const amount = Math.floor(cents * (100 - FEE) / 100) / 100;
  try {
    const t = await asaas('POST', '/transfers', {
      value: amount, pixAddressKey: k.pix_key, pixAddressKeyType: k.pix_key_type,
      description: 'Repasse DEV PAY', externalReference: p.id,
    });
    await admin.from('payments').update({ payout_status: 'enviado', payout_id: t.id, payout_amount: amount }).eq('id', p.id);
  } catch (e) {
    console.error('payout', p.id, e.message);
    await admin.from('payments').update({ payout_status: 'falhou', payout_error: String(e.message).slice(0, 300) }).eq('id', p.id);
  }
}

/* ========== POST /api/pix/create ========== */
app.post('/api/pix/create', express.json(), async (req, res) => {
  try {
    const user = await authUser(req);
    const { kind, plan, period, sale_id, method = 'pix' } = req.body || {};
    const cpf = String(req.body?.cpf_cnpj || '').replace(/\D/g, '');
    if (!['pix', 'card'].includes(method)) throw fail(400, 'bad_request', 'Método inválido');

    let amount, description, ref;
    if (kind === 'plan') {
      if (!PLANS[plan] || !['m', 'a'].includes(period)) throw fail(400, 'bad_request', 'Plano inválido');
      amount = period === 'a' ? PLANS[plan].a * 12 : PLANS[plan].m;
      description = `DEV PAY ${plan} ${period === 'a' ? 'Anual' : 'Mensal'}`;
      ref = `${plan}:${period}`;
    } else if (kind === 'sale') {
      const sid = String(sale_id);
      const { data: found, error: selErr } = await admin.from('sales').select('*').eq('user_id', user.id).eq('id', sid).maybeSingle();
      if (selErr) console.error('sales select', selErr.message);
      let s = found;
      if (!s) {
        // Venda existe no front mas não chegou ao banco: grava a partir dos dados enviados (é o próprio vendedor cobrando o cliente dele)
        const c = req.body?.sale;
        if (c && Number(c.valor) > 0) {
          const row = { user_id: user.id, id: sid, lead: c.lead ?? null, nome: String(c.nome || 'Venda').slice(0, 200), nicho: c.nicho ?? null, valor: Number(c.valor), status: 'pendente', t: Number(c.t) || Date.now() };
          const { data: ins, error: insErr } = await admin.from('sales').upsert(row, { onConflict: 'user_id,id' }).select().maybeSingle();
          if (insErr) { console.error('sales upsert', insErr.message); throw fail(500, 'db_error', 'Erro ao salvar a venda: ' + insErr.message); }
          s = ins;
        }
      }
      if (!s) throw fail(404, 'not_found', 'Venda não encontrada');
      if (s.status === 'pago') throw fail(409, 'already_paid', 'Venda já está paga');
      amount = Number(s.valor);
      description = `Venda DEV PAY - ${s.nome}`.slice(0, 500);
      ref = String(s.id);
    } else throw fail(400, 'bad_request', 'kind deve ser plan ou sale');
    if (!(amount > 0)) throw fail(400, 'bad_request', 'Valor inválido');

    // Reaproveita cobrança pendente ainda válida; cancela as vencidas
    const { data: olds } = await admin.from('payments').select('*').eq('user_id', user.id).eq('kind', kind)
      .eq('ref_id', ref).eq('method', method).eq('status', 'pendente').order('created_at', { ascending: false });
    let reuse = null;
    for (const o of olds || []) {
      if (!reuse && new Date(o.expires_at) > new Date() && Number(o.amount) === amount) { reuse = o; continue; }
      await admin.from('payments').update({ status: 'expirado' }).eq('id', o.id);
      asaas('DELETE', `/payments/${o.gateway_payment_id}`).catch(() => {});
    }
    if (reuse) {
      const extra = method === 'pix' ? await pixPayload(reuse.gateway_payment_id) : {};
      return res.json({ payment_id: reuse.id, gateway_payment_id: reuse.gateway_payment_id, expires_at: reuse.expires_at, invoice_url: reuse.invoice_url, ...extra });
    }

    const customer = await ensureCustomer(user, cpf);
    const gw = await asaas('POST', '/payments', {
      customer, billingType: method === 'card' ? 'CREDIT_CARD' : 'PIX', value: amount, dueDate: todayBRT(),
      description, externalReference: `${user.id}|${kind}|${ref}`,
    });
    // Asaas expira o Pix 12 meses após o vencimento; o prazo curto é controlado aqui (expires_at)
    const expires_at = new Date(Date.now() + Number(PIX_TTL_MINUTES) * 60e3).toISOString();
    const { data: row, error } = await admin.from('payments').insert({
      user_id: user.id, gateway_payment_id: gw.id, kind, ref_id: ref, amount, method, invoice_url: gw.invoiceUrl, expires_at,
    }).select().single();
    if (error) throw fail(500, 'db_error', 'Erro ao registrar cobrança');

    const extra = method === 'pix' ? await pixPayload(gw.id) : {};
    res.json({ payment_id: row.id, gateway_payment_id: gw.id, expires_at, invoice_url: gw.invoiceUrl, ...extra });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'server_error', message: e.status ? e.message : 'Erro interno' });
    if (!e.status) console.error(e);
  }
});

/* ========== GET /api/tokens (plano e saldo do usuário) ========== */
app.get('/api/tokens', async (req, res) => {
  try {
    const user = await authUser(req);
    const ac = await acesso(user);
    if (!ac.ativo) return res.json({ ativo: false });
    if (ac.dono) return res.json({ ativo: true, plano: 'Admin', ilimitado: true });
    const { data } = await admin.from('token_usage').select('used').eq('user_id', user.id).eq('month', ac.ciclo).maybeSingle();
    res.json({ ativo: true, plano: ac.plan, total: ac.total, restantes: Math.max(0, ac.total - (data?.used || 0)), renova: ac.renova, vence: ac.vence });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'server_error', message: e.status ? e.message : 'Erro interno' });
    if (!e.status) console.error(e);
  }
});

/* ========== POST /api/leads (radar: Google Places + OpenStreetMap) ========== */
app.post('/api/leads', express.json(), async (req, res) => {
  try {
    const user = await authUser(req);
    const ac = await acesso(user);
    if (!ac.ativo) throw fail(402, 'plan_required', 'Para buscar leads, assine um plano.');
    let restantes = null;
    if (!ac.dono) {
      restantes = await mexerTokens(user, ac, 1);
      if (restantes < 0) throw fail(402, 'no_tokens', `Seus ${ac.total} tokens deste mês acabaram. Eles renovam em ${ac.renova ? ac.renova.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'a próxima assinatura'}, ou faça upgrade do plano.`);
    }
    let out;
    try { out = await buscarLeads(req.body || {}); }
    catch (e) { if (!ac.dono) await mexerTokens(user, ac, -1).catch(() => {}); throw e; } // busca falhou: devolve o token
    res.json({ ...out, tokens: ac.dono ? { ilimitado: true } : { restantes, total: ac.total } });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'server_error', message: e.status ? e.message : 'Erro interno' });
    if (!e.status) console.error(e);
  }
});

/* ========== POST /api/site/generate (IA cria o site da empresa; resposta em streaming) ========== */
app.post('/api/site/generate', express.json({ limit: '100kb' }), async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); }); // cliente fechou: para de gastar IA
  try {
    await authUser(req);
    if (!IA_KEYS.some((k) => process.env[k])) throw fail(503, 'ai_not_configured', 'Falta configurar uma chave de IA (ex.: GEMINI_API_KEY) no Vercel.');
    await gerarSite(req.body || {}, res, ac.signal);
  } catch (e) {
    if (!e.status) console.error(e);
    const msg = e.status ? e.message : 'Erro interno';
    if (res.headersSent) { try { res.write('\u0000ERRO:' + msg); } catch {} return res.end(); }
    res.status(e.status || 500).json({ error: e.code || 'server_error', message: msg });
  }
});

/* ========== POST /api/webhooks/payment ========== */
app.post('/api/webhooks/payment', express.json(), async (req, res) => {
  if (!safeEq(req.get('asaas-access-token'), ASAAS_WEBHOOK_TOKEN)) return res.sendStatus(401);
  const { event, payment } = req.body || {};
  // PIX → PAYMENT_RECEIVED | Cartão → PAYMENT_CONFIRMED (captura aprovada)
  if (!payment?.id || !['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)) return res.sendStatus(200);
  try {
    const { data: p } = await admin.from('payments').select('*').eq('gateway_payment_id', payment.id).maybeSingle();
    if (!p || p.status === 'pago') return res.sendStatus(200);
    if (Number(payment.value) < Number(p.amount)) { console.warn('Valor divergente', payment.id); return res.sendStatus(200); }

    // "Claim" atômico: só um webhook (ou retry) prossegue
    const { data: claimed } = await admin.from('payments').update({ status: 'pago', paid_at: new Date().toISOString() })
      .eq('id', p.id).neq('status', 'pago').select().maybeSingle();
    if (!claimed) return res.sendStatus(200);

    try {
      if (p.kind === 'sale') {
        const { error } = await admin.from('sales').update({ status: 'pago', pago: Date.now() }).eq('user_id', p.user_id).eq('id', p.ref_id);
        if (error) throw error;
      } else {
        const [plan, period] = p.ref_id.split(':');
        const { data: cur } = await admin.from('subscriptions').select('*').eq('user_id', p.user_id).maybeSingle();
        const ativa = !!cur && cur.status === 'ativo' && new Date(cur.current_period_end) > new Date();
        const base = ativa ? new Date(cur.current_period_end) : new Date();
        // Data da assinatura (início do ciclo de tokens): mantém ao renovar com plano ativo; recomeça se estava vencido
        const anchor = ativa ? (cur.anchor || addMeses(cur.current_period_end, -(cur.period === 'a' ? 12 : 1))).toISOString?.() || cur.anchor : new Date().toISOString();
        base.setMonth(base.getMonth() + (period === 'a' ? 12 : 1));
        const linha = { user_id: p.user_id, plan, period, status: 'ativo', current_period_end: base.toISOString(), updated_at: new Date().toISOString() };
        let { error } = await admin.from('subscriptions').upsert({ ...linha, anchor });
        if (error) ({ error } = await admin.from('subscriptions').upsert(linha)); // coluna anchor ainda não criada: não trava a ativação
        if (error) throw error;
      }
    } catch (e) {
      await admin.from('payments').update({ status: 'pendente', paid_at: null }).eq('id', p.id); // libera para o retry do Asaas
      throw e;
    }
    if (p.kind === 'sale') await payoutSeller(p, payment).catch((e) => console.error('payout', e));
    res.sendStatus(200);
  } catch (e) { console.error('webhook', e); res.sendStatus(500); }
});

module.exports = app;
