# DEV PAY – Pix automático (Asaas + Supabase) no Vercel

## Estrutura (tudo na raiz do projeto)
public/index.html · app.js · server.js · package.json · vercel.json · supabase.sql

## 1. Supabase
SQL Editor > cole o conteúdo de `supabase.sql` > Run.

## 2. Vercel > Settings > Environment Variables (Production)
SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · ASAAS_API_KEY · ASAAS_WEBHOOK_TOKEN · ASAAS_ENV=sandbox
Depois: Deployments > Redeploy.

## 3. Teste
/api/health deve mostrar {"ok":true,"missing":[]}. Abra o site no MESMO domínio do projeto.

## 4. Asaas > Integrações > Webhooks
URL: https://SEU-DOMINIO.vercel.app/api/webhooks/payment
Token: o mesmo de ASAAS_WEBHOOK_TOKEN · Eventos: PAYMENT_RECEIVED e PAYMENT_CONFIRMED
