# DEV PAY – Pix automático (Asaas + Supabase) no Vercel

App instalável (PWA): no celular, use o botão "Baixar app" no menu.

## Estrutura
```
api/index.js          entrada do Express no Vercel
app.js                backend (Pix, webhook, repasse, rota /api/leads)
leads.js              radar de leads: OpenStreetMap/Overpass (grátis, sem chave), com cache
audit.js              auditoria SEO/GEO do site do lead (rota /api/audit)
server.js             só para rodar local (npm start)
public/               front (index.html, manifest.json, sw.js, ícones)
vercel.json · package.json · .env.example
supabase.sql · supabase_sales.sql · supabase_chave_pix.sql · dev-pay-banco.sql · supabase_osm.sql
```

## 1. Supabase
SQL Editor > rode `supabase.sql`, `supabase_sales.sql`, `dev-pay-banco.sql`, `supabase_tokens.sql`, `supabase_sites.sql` e `supabase_osm.sql` (pode rodar mais de uma vez).

## 2. Vercel > Settings > Environment Variables (Production)
SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · ASAAS_API_KEY · ASAAS_WEBHOOK_TOKEN · ASAAS_ENV=sandbox
GEMINI_API_KEY (botão "Gerar site", GRÁTIS: aistudio.google.com/apikey) ou ANTHROPIC_API_KEY (pago). ADMIN_EMAILS (seu e-mail: busca sem limite de tokens, para testar). Opcionais do radar: OSM_CONTACT (e-mail ou site seu, vai no User-Agent exigido pelo OSM), OSM_RADIUS_M (raio da busca; padrão automático de 3 a 12 km), OSM_CACHE_TTL_MIN (padrão 360). Opcionais: GEMINI_MODEL (padrão gemini-3.8-flash), ANTHROPIC_MODEL, SITE_MAX_TOKENS
Depois: Deployments > Redeploy.

## 3. Teste
/api/health deve mostrar {"ok":true,"missing":[]}. Abra o site no MESMO domínio do projeto.

## 4. Asaas > Integrações > Webhooks
URL: https://SEU-DOMINIO.vercel.app/api/webhooks/payment
Token: o mesmo de ASAAS_WEBHOOK_TOKEN · Eventos: PAYMENT_RECEIVED e PAYMENT_CONFIRMED

## Rodar local
`cp .env.example .env` (preencha) · `npm install` · `npm start`

## Radar de leads
Fonte única: OpenStreetMap (Overpass API; o Nominatim só geocodifica a cidade, 1 consulta por cidade, com cache). Não precisa de chave. Busque no formato "Cidade, UF" e use sinônimos nos nichos (ex.: barbearia, barber).
- Mostra só o que existe no OSM (nome, categoria, endereço, cidade, telefone, site). Campo ausente fica vazio; nada é inventado.
- Cache de 6 h no servidor e no navegador; 1 busca por vez, com intervalo mínimo. Se o servidor for bloqueado pelo Overpass, a busca é refeita direto do navegador.
- Resultados novos ficam "não salvos" até o botão "Salvar no CRM" (ou "Salvar todos"). `supabase_osm.sql` guarda categoria/fonte; sem ele, o app salva sem esses campos.
- Cobertura parcial: depende do que a comunidade mapeou; telefone e site podem estar desatualizados. Atribuição exibida na tela: © contribuidores do OpenStreetMap (ODbL).

## Gerar site (IA)
No Radar, abra um lead e toque em "✦ Gerar site": cole o prompt e a IA cria o site da empresa (usa nome, nicho, cidade, telefone). Depois é só baixar o HTML.
Backend: `sitegen.js` + rota `/api/site/generate` (streaming). Usa `GEMINI_API_KEY` (grátis) se existir; senão `ANTHROPIC_API_KEY`. Limite da função: 60 s (vercel.json).
Se a IA cortar o site (limite de tokens ou de tempo), o front pede a continuação em novas requisições (até 4) e só aceita o site se o HTML estiver completo e válido; senão mostra o erro. Variáveis opcionais: `SITE_MAX_TOKENS` (padrão 16000) e `SITE_BUDGET_MS` (padrão 50000; se aumentar `maxDuration` no vercel.json, aumente este também). Teste: `node test_sitegen.js`.

## Planos e tokens
O radar só busca com plano ativo. 1 token = 1 busca. Por mês (renova na data da assinatura): Starter 30, Pro 150, Agency 400 (constante `TOKENS` no `app.js`). Rode `supabase_tokens.sql` no Supabase uma vez.

## Sites salvos
Cada site gerado (ou editado no modo edição) é salvo na tabela `sites` do Supabase, 1 por lead, com o prompt usado e as imagens anexadas já dentro do HTML. Ao reabrir o lead, o site salvo abre direto; o botão do lead passa a dizer "Ver site". Gerar de novo substitui o anterior. Limite: 6 MB por site. Rode `supabase_sites.sql` uma vez.
