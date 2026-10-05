// Busca GRÁTIS de empresas no OpenStreetMap (Nominatim + Overpass). Sem chave, sem cartão.
// Limite: o mapa livre tem bem menos empresas/telefones que o Google, principalmente em cidades pequenas.
const UA = 'DEV-PAY-Radar/1.0 (prospeccao de leads)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const SOCIAL = /(facebook|fb\.com|fb\.me|instagram|linktr\.ee|linktree|wa\.me|whatsapp|bio\.link|beacons\.ai|tiktok|youtube|youtu\.be|google\.[a-z.]+\/|goo\.gl|maps\.app|ifood|booking\.com|tripadvisor|olx\.com|mercadolivre)/i;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// nicho digitado -> filtros do Overpass (a ordem importa: o primeiro que casar vence)
const CATS = [
  [/barb/, ['["shop"="hairdresser"]["name"~"barb",i]', '["shop"="hairdresser"]["hairdresser"="barber"]']],
  [/cabeleir|salao|beleza|estetic|manicure|nail/, ['["shop"~"^(hairdresser|beauty)$"]']],
  [/academia|fitness|musculacao|crossfit|pilates/, ['["leisure"="fitness_centre"]', '["leisure"]["name"~"academia|crossfit|pilates",i]']],
  [/pousada|hotel|hostel|hospedagem|motel/, ['["tourism"~"^(hotel|guest_house|hostel|motel|apartment|chalet)$"]']],
  [/lava ?jato|lavagem/, ['["amenity"="car_wash"]']],
  [/oficina|mecanic|auto ?center|centro automotivo|funilaria/, ['["shop"="car_repair"]']],
  [/concession|veiculo|automove|^carro/, ['["shop"="car"]']],
  [/pizzaria/, ['["cuisine"="pizza"]']],
  [/lanchonete|hamburguer|fast ?food/, ['["amenity"="fast_food"]']],
  [/restaurante/, ['["amenity"="restaurant"]']],
  [/padaria|confeitaria/, ['["shop"~"^(bakery|pastry)$"]']],
  [/cafe/, ['["amenity"="cafe"]']],
  [/^bar$|pub|choperia|boteco/, ['["amenity"~"^(bar|pub)$"]']],
  [/farmacia|drogaria/, ['["amenity"="pharmacy"]']],
  [/dentista|odonto/, ['["amenity"="dentist"]']],
  [/clinica|medico|consultorio/, ['["amenity"~"^(clinic|doctors)$"]']],
  [/veterin/, ['["amenity"="veterinary"]']],
  [/pet/, ['["shop"="pet"]']],
  [/imobiliaria|corretor/, ['["office"="estate_agent"]']],
  [/advoga/, ['["office"="lawyer"]']],
  [/contab/, ['["office"="accountant"]']],
  [/autoescola/, ['["amenity"="driving_school"]']],
  [/escola|colegio|creche/, ['["amenity"~"^(school|kindergarten)$"]']],
  [/floricultura|flor/, ['["shop"="florist"]']],
  [/roupa|moda|boutique|confeccao/, ['["shop"="clothes"]']],
  [/calcado|sapato/, ['["shop"="shoes"]']],
  [/supermercado|mercado|mercearia/, ['["shop"~"^(supermarket|convenience|greengrocer)$"]']],
  [/otica/, ['["shop"="optician"]']],
  [/joalheria|joia/, ['["shop"="jewelry"]']],
  [/perfumaria|cosmetico/, ['["shop"~"^(perfumery|cosmetics)$"]']],
  [/papelaria/, ['["shop"="stationery"]']],
  [/construcao|ferragem/, ['["shop"~"^(doityourself|hardware|trade)$"]']],
  [/fotograf/, ['["craft"="photographer"]', '["shop"="photo"]']],
  [/tatuag/, ['["shop"="tattoo"]']],
];

function filtros(termos) {
  const out = new Set();
  for (const t of termos) {
    const n = norm(t);
    const hit = CATS.find(([re]) => re.test(n));
    if (hit) hit[1].forEach((f) => out.add(f));
    else out.add(`["name"~"${String(t).trim().replace(/[^\p{L}\p{N} ]/gu, '.').slice(0, 60)}",i]`); // nicho sem categoria: procura no nome
  }
  return [...out];
}

function montarConsulta(termos, area) {
  const decl = area.id ? `area(${area.id})->.a;` : '';
  const ref = area.id ? '(area.a)' : `(${area.bbox.join(',')})`;
  return `[out:json][timeout:25];${decl}(${filtros(termos).map((f) => `nwr${f}${ref};`).join('')});out center tags 400;`;
}

async function geocode(cidade, fetchFn) {
  const q = /brasil|brazil/i.test(cidade) ? cidade : `${cidade}, Brasil`;
  const r = await fetchFn('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'br' }), {
    headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' },
  });
  if (!r.ok) throw fail(502, 'osm_error', 'Mapa livre (OpenStreetMap) indisponível agora. Tente de novo em instantes.');
  const g = (await r.json())[0];
  if (!g) throw fail(404, 'city_not_found', 'Não encontrei essa cidade no mapa. Tente "Cidade, UF" (ex: Campinas, SP).');
  const id = Number(g.osm_id);
  if (g.osm_type === 'relation') return { id: 3600000000 + id };
  if (g.osm_type === 'way') return { id: 2400000000 + id };
  const [s, n, w, e] = g.boundingbox.map(Number);
  return { bbox: [s, w, n, e] };
}

async function overpass(query, fetchFn) {
  for (const url of OVERPASS) {
    try {
      const r = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'data=' + encodeURIComponent(query) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { console.error('overpass', url, e.message); }
  }
  throw fail(502, 'osm_error', 'Mapa livre (OpenStreetMap) indisponível agora. Tente de novo em instantes.');
}

function fone(tags) {
  const nums = [tags['contact:mobile'], tags.mobile, tags.phone, tags['contact:phone'], tags['contact:whatsapp']]
    .filter(Boolean).flatMap((v) => String(v).split(/[;,/]/))
    .map((v) => { let d = v.replace(/\D/g, ''); if (d.startsWith('55') && d.length >= 12) d = d.slice(2); return d.replace(/^0+/, ''); })
    .filter((d) => d.length === 10 || d.length === 11);
  return nums.find((d) => d.length === 11) || nums[0] || '';
}

async function buscarLeadsOSM({ nicho, cidade, sinonimos = [], semSite = false }, { fetchFn = fetch } = {}) {
  nicho = String(nicho || '').trim().slice(0, 80);
  cidade = String(cidade || '').trim().slice(0, 80);
  if (!nicho || !cidade) throw fail(400, 'bad_request', 'Informe nicho e cidade');
  const termos = [nicho, ...(Array.isArray(sinonimos) ? sinonimos : [])].map((s) => String(s || '').trim().slice(0, 60)).filter(Boolean).slice(0, 5);

  const area = await geocode(cidade, fetchFn);
  const j = await overpass(montarConsulta(termos, area), fetchFn);

  const seen = new Set();
  const score = (l) => (!l.site ? 4 : 0) + (l.telefone.length === 11 ? 2 : 0) + (l.telefone ? 1 : 0) + (l.endereco ? 0.5 : 0);
  const leads = (j.elements || [])
    .filter((el) => el.tags && el.tags.name)
    .map((el) => {
      const t = el.tags, site = t.website || t['contact:website'] || '';
      return {
        id: `osm-${el.type}-${el.id}`,
        nome: t.name,
        telefone: fone(t),
        nota: 0,
        avaliacoes: 0,
        endereco: [t['addr:street'], t['addr:housenumber'], t['addr:suburb'], t['addr:city']].filter(Boolean).join(', '),
        site: site && !SOCIAL.test(site) ? site : '',
      };
    })
    .filter((l) => !seen.has(l.id) && seen.add(l.id))
    .filter((l) => !semSite || !l.site)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 300);
  return { total: leads.length, leads, fonte: 'osm' };
}

module.exports = { buscarLeadsOSM, montarConsulta, fone };
