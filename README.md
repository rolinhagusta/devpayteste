# DEV PAY – Pix automático (Asaas + Supabase) no Vercel

App instalável (PWA): no celular, use o botão "Baixar app" no menu.

## Estrutura
```
api/index.js          entrada do Express no Vercel
app.js                backend (Pix, webhook, repasse, rota /api/leads)
leads.js              busca de leads no OpenStreetMap (grátis, sem chave)
server.js             só para rodar local (npm start)
public/               front (index.html, manifest.json, sw.js, ícones)
vercel.json · package.json · .env.example
supabase.sql · supabase_sales.sql · supabase_chave_pix.sql · dev-pay-banco.sql
```

## 1. Supabase
SQL Editor > rode `supabase.sql`, `supabase_sales.sql` e `dev-pay-banco.sql` (pode rodar mais de uma vez).

## 2. Vercel > Settings > Environment Variables (Production)
SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · ASAAS_API_KEY · ASAAS_WEBHOOK_TOKEN · ASAAS_ENV=sandbox
GEMINI_API_KEY (botão "Gerar site", GRÁTIS: aistudio.google.com/apikey) ou ANTHROPIC_API_KEY (pago). ADMIN_EMAILS (seu e-mail: busca sem limite de tokens, para testar), GOOGLE_MAPS_API_KEY (opcional: radar usa Google Places; exige conta de faturamento no Google Cloud; GOOGLE_MAX_PAGES=1-3). Opcionais: GEMINI_MODEL (padrão gemini-3.8-flash), ANTHROPIC_MODEL, SITE_MAX_TOKENS
Depois: Deployments > Redeploy.

## 3. Teste
/api/health deve mostrar {"ok":true,"missing":[]}. Abra o site no MESMO domínio do projeto.

## 4. Asaas > Integrações > Webhooks
URL: https://SEU-DOMINIO.vercel.app/api/webhooks/payment
Token: o mesmo de ASAAS_WEBHOOK_TOKEN · Eventos: PAYMENT_RECEIVED e PAYMENT_CONFIRMED

## Rodar local
`cp .env.example .env` (preencha) · `npm install` · `npm start`

## Radar de leads
Usa OpenStreetMap (grátis, sem chave). Busque no formato "Cidade, UF" e use sinônimos nos nichos (ex.: barbearia, barber, cabeleireiro).

## Gerar site (IA)
No Radar, abra um lead e toque em "✦ Gerar site": cole o prompt e a IA cria o site da empresa (usa nome, nicho, cidade, telefone). Depois é só baixar o HTML.
Backend: `sitegen.js` + rota `/api/site/generate` (streaming). Usa `GEMINI_API_KEY` (grátis) se existir; senão `ANTHROPIC_API_KEY`. Limite da função: 60 s (vercel.json).
Se a IA cortar o site (limite de tokens ou de tempo), o front pede a continuação em novas requisições (até 4) e só aceita o site se o HTML estiver completo e válido; senão mostra o erro. Variáveis opcionais: `SITE_MAX_TOKENS` (padrão 16000) e `SITE_BUDGET_MS` (padrão 50000; se aumentar `maxDuration` no vercel.json, aumente este também). Teste: `node test_sitegen.js`.

## Planos e tokens
O radar só busca com plano ativo. 1 token = 1 busca. Por mês (renova na data da assinatura): Starter 30, Pro 150, Agency 400 (constante `TOKENS` no `app.js`). Rode `supabase_tokens.sql` no Supabase uma vez.
