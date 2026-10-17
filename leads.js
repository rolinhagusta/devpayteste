// Radar de leads — fonte única: OpenStreetMap (Overpass API). Nominatim é usado SÓ para geocodificar a cidade (1 consulta por cidade, com cache).
// Dados © contribuidores do OpenStreetMap, licença ODbL (https://www.openstreetmap.org/copyright).
// Nada é inventado nem completado: só aparece o que está nas tags do OSM. Cobertura é parcial.

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const phoneBR = (s) => {
  let d = String(s || '').split(/[;,\/]/)[0].replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : '';
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Tijucas, SC" | "Tijucas - SC" | "Tijucas"
function parseLocal(lo) {
  const m = String(lo).trim().match(/^(.*?)[,\-\/]\s*([A-Za-z]{2})$/);
  return m ? { cidade: m[1].trim(), uf: m[2].toUpperCase() } : { cidade: String(lo).trim(), uf: '' };
}

const UA = `DEVPAY-Radar/1.0 (${process.env.OSM_CONTACT || 'https://devpay.vercel.app'})`; // as políticas do OSM exigem User-Agent identificado
const TTL = (Number(process.env.OSM_CACHE_TTL_MIN) || 360) * 60000;   // cache de resultados (padrão 6 h)
const GEO_TTL = 30 * 24 * 3600 * 1000;                                  // cache de geocodificação (30 dias)
const MAX_RESULTS = 300;

/* ---------- Boas maneiras com servidores públicos: 1 pedido por vez, com intervalo mínimo ---------- */
function limiter(gap) {
  let last = 0, chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(async () => {
      const w = last + gap - Date.now();
      if (w > 0) await sleep(w);
      try { return await fn(); } finally { last = Date.now(); }
    });
    chain = run.catch(() => {});
    return run;
  };
}
const nominatimQ = limiter(1100); // política do Nominatim: no máximo 1 pedido/segundo
const overpassQ = limiter(1000);

/* ---------- Cache em memória (vale por instância; o navegador também guarda cache) ---------- */
const cache = new Map(), geoCache = new Map(), inflight = new Map();
const cget = (m, k, ttl) => { const v = m.get(k); if (v && Date.now() - v.t < ttl) return v; m.delete(k); return null; };
const cset = (m, k, data, max = 200) => { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, { t: Date.now(), data }); };

/* ---------- Nicho -> tags do OSM (o filtro por nome cobre o que não estiver aqui) ---------- */
const OSM_TAGS = {
  barbearia: ['shop=hairdresser'], barbeiro: ['shop=hairdresser'], salao: ['shop=hairdresser', 'shop=beauty'], cabeleireiro: ['shop=hairdresser'],
  academia: ['leisure=fitness_centre'], pousada: ['tourism=guest_house', 'tourism=hotel'], hotel: ['tourism=hotel'],
  oficina: ['shop=car_repair'], mecanica: ['shop=car_repair'], restaurante: ['amenity=restaurant'], lanchonete: ['amenity=fast_food'],
  padaria: ['shop=bakery'], mercado: ['shop=supermarket', 'shop=convenience'], farmacia: ['amenity=pharmacy'], dentista: ['amenity=dentist'],
  clinica: ['amenity=clinic', 'amenity=doctors'], pet: ['shop=pet'], petshop: ['shop=pet'], imobiliaria: ['office=estate_agent'],
  advogado: ['office=lawyer'], contabilidade: ['office=accountant'], escola: ['amenity=school'], lavanderia: ['shop=laundry'],
  floricultura: ['shop=florist'], papelaria: ['shop=stationery'], otica: ['shop=optician'], autopecas: ['shop=car_parts'],
  borracharia: ['shop=tyres'], construcao: ['shop=doityourself', 'shop=hardware'], estetica: ['shop=beauty'], tatuagem: ['shop=tattoo'],
};
const ALIASES = {
  barbearias: 'barbearia', barbeiros: 'barbeiro', cabeleireiros: 'cabeleireiro', academias: 'academia', restaurantes: 'restaurante',
  padarias: 'padaria', farmacias: 'farmacia', mercados: 'mercado', oficinas: 'oficina', hoteis: 'hotel', saloes: 'salao',
  dentistas: 'dentista', clinicas: 'clinica', petshops: 'petshop', lavanderias: 'lavanderia',
};
// Rótulo em português da categoria; se não houver tradução, mostra a tag crua do OSM (nunca um rótulo inventado).
const CAT = {
  'shop=hairdresser': 'Cabeleireiro / barbearia', 'shop=beauty': 'Estética / beleza', 'leisure=fitness_centre': 'Academia',
  'tourism=guest_house': 'Pousada', 'tourism=hotel': 'Hotel', 'shop=car_repair': 'Oficina mecânica', 'amenity=restaurant': 'Restaurante',
  'amenity=fast_food': 'Lanchonete', 'shop=bakery': 'Padaria', 'shop=supermarket': 'Supermercado', 'shop=convenience': 'Loja de conveniência',
  'amenity=pharmacy': 'Farmácia', 'amenity=dentist': 'Dentista', 'amenity=clinic': 'Clínica', 'amenity=doctors': 'Consultório médico',
  'shop=pet': 'Pet shop', 'office=estate_agent': 'Imobiliária', 'office=lawyer': 'Advocacia', 'office=accountant': 'Contabilidade',
  'amenity=school': 'Escola', 'shop=laundry': 'Lavanderia', 'shop=florist': 'Floricultura', 'shop=stationery': 'Papelaria',
  'shop=optician': 'Ótica', 'shop=car_parts': 'Autopeças', 'shop=tyres': 'Borracharia', 'shop=doityourself': 'Construção / ferragens',
  'shop=hardware': 'Ferragens', 'shop=tattoo': 'Estúdio de tatuagem',
};
const categoria = (t) => { for (const k of ['amenity', 'shop', 'leisure', 'tourism', 'office', 'craft']) if (t[k]) return CAT[k + '=' + t[k]] || k + '=' + t[k]; return ''; };
const escapeOverpass = (v) => String(v).replace(/["\\]/g, '').slice(0, 90);
const normSite = (u) => {
  u = String(u || '').trim();
  if (!u || /\s/.test(u)) return '';
  if (!/^https?:\/\//i.test(u)) { if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return ''; u = 'http://' + u; } // bloqueia javascript:, mailto: etc.
  return u;
};

/* ---------- Geocodificação (Nominatim): só para achar o centro da cidade ---------- */
async function geocodificar(cidade, uf) {
  const key = norm(cidade) + '|' + uf;
  const hit = cget(geoCache, key, GEO_TTL);
  if (hit) return hit.data;
  try {
    const q = new URLSearchParams({ q: [cidade, uf, 'Brasil'].filter(Boolean).join(', '), format: 'json', limit: '1', countrycodes: 'br' });
    const r = await nominatimQ(() => fetch('https://nominatim.openstreetmap.org/search?' + q, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }));
    if (!r.ok) return null;                        // falha do serviço: tentamos o plano B por área
    const d = (await r.json())[0];
    if (!d) return { vazio: true };                // o serviço respondeu e a cidade não existe
    const [s, n, w, e] = (d.boundingbox || []).map(Number), lat = Number(d.lat), lon = Number(d.lon);
    const meia = Number.isFinite(s) ? Math.max(n - s, (e - w) * Math.cos(lat * Math.PI / 180)) * 111000 / 2 : 6000;
    const raio = Number(process.env.OSM_RADIUS_M) || Math.round(Math.min(12000, Math.max(3000, meia)));
    const geo = { lat, lon, raio };
    cset(geoCache, key, geo);
    return geo;
  } catch { return null; }
}

/* ---------- Overpass: tenta os servidores um por vez, com prazo total ---------- */
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function indisponivel(erros) {
  const limite = erros.some((e) => e.http === 429), lento = erros.some((e) => e.msg === 'tempo esgotado');
  const msg = limite ? 'Os servidores públicos do OpenStreetMap atingiram o limite de uso. Aguarde alguns minutos e tente de novo.'
    : lento ? 'Os servidores do OpenStreetMap estão lentos agora. Tente novamente em instantes.'
    : 'Os servidores do OpenStreetMap estão indisponíveis no momento. Tente novamente em instantes.';
  return Object.assign(new Error(msg), { status: 502, code: 'sources_down', detalhes: erros.map((e) => `${e.host}: ${e.msg}`) });
}

async function overpass(query, deadline) {
  const erros = [];
  for (const url of OVERPASS) {
    if (Date.now() > deadline - 2000) break;
    try {
      const ms = Math.min(12000, deadline - Date.now());
      const r = await overpassQ(() => fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(ms),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(query),
      }));
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { http: r.status });
      const j = await r.json();
      if (!Array.isArray(j.elements)) throw new Error('resposta inválida');
      if (!j.elements.length && /runtime error|timed out|out of memory/i.test(j.remark || '')) throw new Error('consulta abortada pelo servidor');
      return j;
    } catch (e) {
      erros.push({ host: new URL(url).hostname, msg: e.name === 'TimeoutError' ? 'tempo esgotado' : e.message, http: e.http });
    }
  }
  throw indisponivel(erros);
}

function montarQuery(terms, geo, cidade, uf) {
  let prefix = '', scope;
  if (geo) scope = `around:${geo.raio},${geo.lat},${geo.lon}`;
  else { // sem coordenadas: busca por área administrativa
    const city = escapeOverpass(cidade);
    prefix = uf ? `area["ISO3166-2"="BR-${uf}"][admin_level="4"]->.estado;area["name"="${city}"]["boundary"="administrative"](area.estado)->.cidade;`
      : `area["name"="${city}"]["boundary"="administrative"]["admin_level"~"^(7|8)$"]->.cidade;`;
    scope = 'area.cidade';
  }
  const clauses = new Set();
  for (const term of terms.slice(0, 3)) {
    const n = norm(term), sing = ALIASES[n] || n.replace(/s$/, ''), tags = OSM_TAGS[sing] || OSM_TAGS[n] || [];
    for (const tag of tags) { const [k, v] = tag.split('='); clauses.add(`nwr(${scope})["${k}"="${v}"]["name"];`); }
    if (!tags.length) clauses.add(`nwr(${scope})["name"~"${escapeOverpass(term)}",i];`);
  }
  return `[out:json][timeout:25];${prefix}(${[...clauses].join('')});out center tags ${MAX_RESULTS};`;
}

/* ---------- Converte elementos do OSM em leads (somente campos presentes na fonte) ---------- */
function converter(elementos) {
  const vistos = new Set(), out = [];
  for (const e of elementos) {
    const t = e.tags || {};
    if (!t.name) continue;
    const telefone = phoneBR(t['contact:whatsapp'] || t['contact:phone'] || t.phone || t.mobile || t['contact:mobile']);
    const c = e.center || e, lat = Number(c.lat), lon = Number(c.lon);
    // mesmo nome no mesmo ponto (~110 m) = mesmo estabelecimento (ex.: mapeado como ponto e como prédio); filiais em outro endereço são mantidas
    const kGeo = norm(t.name) + '|' + (Number.isFinite(lat) ? lat.toFixed(3) + ',' + lon.toFixed(3) : e.type + e.id);
    const kTel = telefone ? 'tel:' + telefone + '|' + norm(t.name) : '';
    if (vistos.has(kGeo) || (kTel && vistos.has(kTel))) continue;
    vistos.add(kGeo); if (kTel) vistos.add(kTel);
    out.push({
      id: 'o' + e.type[0] + e.id, nome: t.name, categoria: categoria(t),
      endereco: [t['addr:street'], t['addr:housenumber'], t['addr:suburb']].filter(Boolean).join(', '),
      cidade: t['addr:city'] || '', telefone, site: normSite(t.website || t['contact:website']), fonte: 'osm',
    });
  }
  out.sort((a, b) => !!b.telefone - !!a.telefone || a.nome.localeCompare(b.nome, 'pt-BR'));
  return out;
}

async function consultar(terms, cidade, uf) {
  const deadline = Date.now() + 48000; // a função do Vercel tem 60 s
  let geo = await geocodificar(cidade, uf);
  if (geo?.vazio) throw Object.assign(new Error('Não encontrei essa cidade no OpenStreetMap. Use o formato "Cidade, UF".'), { status: 404, code: 'not_found' });
  const json = await overpass(montarQuery(terms, geo, cidade, uf), deadline);
  return { leads: converter(json.elements), truncado: json.elements.length >= MAX_RESULTS };
}

async function buscarLeads({ nicho, cidade, sinonimos = [], semSite = false }) {
  const terms = [nicho, ...sinonimos].map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4);
  if (!terms.length || !cidade) throw Object.assign(new Error('Informe nicho e cidade'), { status: 400, code: 'bad_request' });
  const { cidade: c, uf } = parseLocal(cidade);
  if (!c) throw Object.assign(new Error('Informe nicho e cidade'), { status: 400, code: 'bad_request' });

  const key = terms.map(norm).sort().join(',') + '|' + norm(c) + '|' + uf;
  let entry = cget(cache, key, TTL), hit = !!entry, data = entry?.data, t0 = entry?.t;
  if (!entry) {
    let p = inflight.get(key); // buscas idênticas simultâneas dividem a mesma consulta
    if (!p) { p = consultar(terms, c, uf); inflight.set(key, p); p.finally(() => inflight.delete(key)).catch(() => {}); }
    data = await p; t0 = Date.now();
    cset(cache, key, data);
  }
  let leads = data.leads;
  if (semSite) leads = leads.filter((l) => !l.site);
  return {
    leads, total: leads.length, truncado: data.truncado, fontes: { osm: true },
    cache: { hit, idade_min: Math.round((Date.now() - t0) / 60000) },
    aviso: leads.length ? undefined : 'Nenhuma empresa desse tipo está mapeada no OpenStreetMap nessa região. O OSM não tem todos os negócios; tente outro termo ou uma cidade vizinha.',
    atribuicao: '© contribuidores do OpenStreetMap (ODbL)',
  };
}

module.exports = { buscarLeads, parseLocal, _test: { converter, montarQuery, categoria, normSite } };
