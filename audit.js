// Auditor SEO + GEO (portado do GEO-SEO Radar, MIT). Lê o HTML inicial da página: sites muito dependentes de JS podem pontuar pior que o real.
const dns = require('dns').promises;
const net = require('net');

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const stripTags = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
const visibleText = (html) => html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const first = (re, s) => { const m = s.match(re); return m ? decode(m[1]) : null; };
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);

const PHONE_RE = /(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}/;
const ADDR_RE = /\b(rua|r\.|av\.?|avenida|travessa|rodovia|estrada|praça|praca|alameda|bairro|centro|cep)\b/i;

const normalizeUrl = (u) => { u = String(u || '').trim(); if (!u) return ''; return /^https?:\/\//i.test(u) ? u : 'https://' + u; };

// Bloqueia IPs internos (SSRF): o servidor só pode buscar sites públicos.
function privateIp(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || /^::ffff:(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertPublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('protocolo inválido');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(privateIp)) throw new Error('endereço não permitido');
}

async function fetchHtml(url) {
  let cur = url;
  for (let i = 0; i < 4; i++) { // segue redirecionamentos validando cada salto
    await assertPublic(cur);
    const r = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (DEVPAY-auditor)' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { cur = new URL(r.headers.get('location'), cur).href; continue; }
    const html = (await r.text()).slice(0, 1_500_000);
    return { status: r.status, html, finalUrl: cur };
  }
  throw new Error('redirecionamentos demais');
}

async function auditWebsite(url) {
  const res = { url, alcanzavel: false, https: url.startsWith('https://'), fallos_seo: [], fallos_geo: [], puntos_fuertes: [], seo: {}, geo: {} };
  let page;
  try { page = await fetchHtml(url); } catch (e) { res.error = 'não foi possível acessar (' + (e.name === 'TimeoutError' ? 'tempo esgotado' : e.message) + ')'; return res; }
  if (page.status >= 400 || !page.html) { res.error = 'a web responde com erro HTTP ' + page.status; return res; }
  const { html } = page;
  res.alcanzavel = true; res.https = page.finalUrl.startsWith('https://');

  const text = visibleText(html), words = text ? text.split(' ').length : 0;
  const title = first(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  const desc = first(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i, html) || first(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i, html);
  const h1s = all(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, html);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const og = /property=["']og:/i.test(html);
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const semAlt = imgs.filter((i) => !/\balt=["'][^"']+["']/i.test(i)).length;
  res.seo = { title, desc, h1: h1s.length, viewport, og, imgs: imgs.length, semAlt, palavras: words };

  const f = res.fallos_seo;
  if (!res.https) f.push("O site não usa HTTPS (cadeado); o Google penaliza e o navegador mostra 'não seguro'.");
  if (!title) f.push('Não tem a tag <title> (o título azul que aparece no Google).');
  else if (title.length < 15 || title.length > 65) f.push(`O título SEO tem ${title.length} caracteres (o ideal é 30-60, com cidade e serviço).`);
  if (!desc) f.push('Sem meta descrição: o Google inventa o texto que aparece embaixo do seu link.');
  else if (desc.length < 70 || desc.length > 165) f.push(`A meta descrição tem ${desc.length} caracteres (o ideal é 120-155).`);
  if (!h1s.length) f.push('Não há um título H1 claro dizendo ao Google do que se trata a página.');
  else if (h1s.length > 1) f.push(`Há ${h1s.length} títulos H1 (deveria haver só um principal).`);
  if (!viewport) f.push('Não está otimizado para celular (falta a tag viewport). A maioria das buscas locais vem do celular.');
  if (!og) f.push('Sem Open Graph: ao compartilhar no WhatsApp/redes não aparece foto nem título bonito.');
  if (imgs.length && semAlt / imgs.length > 0.5) f.push(`${semAlt} de ${imgs.length} imagens sem texto ALT (o Google não as entende).`);
  if (words < 250) f.push(`Pouco texto (${words} palavras): o Google quase não tem conteúdo para posicionar.`);
  if (res.https) res.puntos_fuertes.push('Tem HTTPS');
  if (viewport) res.puntos_fuertes.push('É responsivo/mobile');

  const types = [];
  for (const b of all(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, html)) {
    try { const d = JSON.parse(b); for (const it of (Array.isArray(d) ? d : [d])) { const t = it && it['@type']; if (t) types.push(...(Array.isArray(t) ? t : [t])); } }
    catch { types.push(...all(/"@type"\s*:\s*"([^"]+)"/g, b)); }
  }
  const LB = ['localbusiness', 'restaurant', 'store', 'hotel', 'cafeorcoffeeshop', 'bakery', 'barorpub', 'hairsalon', 'beautysalon', 'dentist', 'professionalservice', 'organization', 'autorepair', 'gym', 'healthandbeautybusiness', 'realestateagent'];
  const hasLB = types.some((s) => LB.includes(String(s).toLowerCase()));
  const hasFaq = types.some((s) => /faq|question/i.test(s));
  const phone = PHONE_RE.test(text), addr = ADDR_RE.test(text);
  const faqH = all(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi, html).filter((h) => { h = stripTags(h); return h.includes('?') || /\b(como|qual|quais|quando|onde|por que|quanto)\b/i.test(h); }).length;
  res.geo = { schema: [...new Set(types)], localbusiness: hasLB, faq: hasFaq, telefone: phone, endereco: addr, faqH };

  const g = res.fallos_geo;
  if (!types.length) g.push('Sem dados estruturados (schema.org): as IAs e o Google não sabem que é um negócio, nem horário e endereço. É o ponto-chave para ChatGPT/Gemini recomendarem.');
  else if (!hasLB) g.push('Tem algum schema, mas falta o tipo LocalBusiness (nome, endereço, telefone, horário) que as IAs usam para recomendar negócios locais.');
  if (!(phone && addr)) g.push('Telefone e/ou endereço não aparecem claros em texto; as IAs não conseguem citar seus dados de contato.');
  if (!hasFaq && faqH < 2) g.push('Sem seção de perguntas frequentes: as IAs respondem perguntas e, sem respostas prontas, não citam você.');
  if (words < 300) g.push('Pouco conteúdo em texto: as IAs precisam de texto para entender e citar o negócio (não leem bem imagens nem PDFs).');
  if (hasLB) res.puntos_fuertes.push('Tem schema LocalBusiness (bom para IA)');
  if (hasFaq) res.puntos_fuertes.push('Tem FAQ estruturada');
  return res;
}

function mensagens({ nome, cidade, res, semWeb, remetente }) {
  const n = nome || 'seu negócio', c = cidade || 'sua cidade';
  const eu = remetente?.nome || '[SEU NOME]', tel = remetente?.telefone || '';
  const ass = `— ${eu}${tel ? ', ' + tel : ''}`;
  if (semWeb) return `Olá 👋 sou ${eu}, ajudo negócios de ${c} a serem encontrados no Google e nas IAs (ChatGPT, Gemini...). Procurei por ${n} e não achei site próprio: hoje, quando alguém pergunta ao ChatGPT "onde ir em ${c} para [serviço]?", ele não consegue indicar você porque não há informação sua para citar. Posso te preparar GRÁTIS um mini-diagnóstico de como você aparece hoje e o que falta? ${ass}`;
  if (!res.alcanzavel) return `Olá 👋 sou ${eu}, ajudo negócios de ${c} com Google e IA. Tentei abrir o site de ${n} e ${res.error}. Isso faz você perder clientes que te procuram online. Te mando GRÁTIS um diagnóstico rápido do que está acontecendo? ${ass}`;
  const top = [...res.fallos_geo.slice(0, 2), ...res.fallos_seo.slice(0, 2)].slice(0, 3);
  const bullets = top.length ? top.map((x) => '• ' + x).join('\n') : '• Pequenos ajustes para posicionar melhor.';
  return `Olá 👋 sou ${eu}, ajudo negócios de ${c} a aparecer melhor no Google e nas IAs (ChatGPT, Gemini...). Dei uma olhada no site de ${n} e achei coisas fáceis de melhorar:\n${bullets}\nNada grave, mas está custando visitas. Te mando GRÁTIS um mini-relatório completo? ${ass}`;
}

async function auditar({ nome, cidade, site, remetente }) {
  const url = normalizeUrl(site);
  let res;
  if (!url) res = { semWeb: true, alcanzavel: false, fallos_seo: [], fallos_geo: [], puntos_fuertes: [], seo_pct: 0, geo_pct: 0, total_pct: 0 };
  else {
    res = await auditWebsite(url);
    const seo = 8 - Math.min(res.fallos_seo.length, 8), geo = 6 - Math.min(res.fallos_geo.length, 6);
    res.seo_pct = res.alcanzavel ? Math.round(100 * seo / 8) : 0;
    res.geo_pct = res.alcanzavel ? Math.round(100 * geo / 6) : 0;
    res.total_pct = Math.round((res.seo_pct + res.geo_pct) / 2);
  }
  res.mensagem = mensagens({ nome, cidade, res, semWeb: !url, remetente });
  return res;
}

module.exports = { auditar };
