// Busca de leads: Google Places API (New) quando GOOGLE_MAPS_API_KEY existe + OpenStreetMap/Overpass (grátis)

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const phoneBR = (s) => {
  let d = String(s || '').split(/[;,\/]/)[0].replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : '';
};
const timeout = (ms) => AbortSignal.timeout(ms);

// "Tijucas, SC" | "Tijucas - SC" | "Tijucas"
function parseLocal(lo) {
  const m = String(lo).trim().match(/^(.*?)[,\-\/]\s*([A-Za-z]{2})$/);
  return m ? { cidade: m[1].trim(), uf: m[2].toUpperCase() } : { cidade: String(lo).trim(), uf: '' };
}

/* ---------- OpenStreetMap (Overpass) ---------- */
// Nicho -> tags do OSM (o filtro por nome cobre o que não estiver aqui)
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

// Servidores públicos: falhas e limites são possíveis. Evite consultas excessivas.
const OVERPASS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];
const ALIASES = {
  barbearias:'barbearia', barbeiros:'barbeiro', cabeleireiros:'cabeleireiro',
  academias:'academia', restaurantes:'restaurante', padarias:'padaria',
  farmacias:'farmacia', mercados:'mercado', oficinas:'oficina',
  hoteis:'hotel', saloes:'salao', dentistas:'dentista',
  clinicas:'clinica', petshops:'petshop', lavanderias:'lavanderia'
};
const escapeOverpass = (v) => String(v).replace(/["\\]/g, '').slice(0, 90);
const timeoutFetch = (url, options, ms = 9000) => fetch(url, { ...options, signal: AbortSignal.timeout(ms) });

async function overpass(query) {
  const errors = [];
  for (const url of OVERPASS) {
    try {
      const r = await timeoutFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const json = await r.json();
      if (!Array.isArray(json.elements)) throw new Error('Resposta inválida');
      return json;
    } catch (e) {
      errors.push(new URL(url).hostname + ': ' + e.message);
    }
  }
  throw new Error('Servidores Overpass indisponíveis (' + errors.join('; ') + ')');
}

async function osmSearch(terms, local) {
  const { cidade, uf } = parseLocal(local);
  if (!cidade) return [];
  const city = escapeOverpass(cidade);
  const state = uf ? `area["ISO3166-2"="BR-${uf}"][admin_level="4"]->.estado;` : '';
  // Restringe a cidade por área, evitando uma busca nacional muito pesada.
  const area = uf
    ? `area["name"="${city}"]["boundary"="administrative"](area.estado)->.cidade;`
    : `area["name"="${city}"]["boundary"="administrative"]["admin_level"~"^(7|8)$"]->.cidade;`;
  const clauses = new Set();
  for (const term of terms.slice(0, 3)) {
    const normalized = norm(term);
    const singular = ALIASES[normalized] || normalized.replace(/s$/, '');
    const tags = OSM_TAGS[singular] || OSM_TAGS[normalized] || [];
    for (const tag of tags) {
      const [key, value] = tag.split('=');
      clauses.add(`nwr(area.cidade)["${key}"="${value}"]["name"];`);
    }
    // Para nichos conhecidos, tags são mais confiáveis que nomes.
    if (!tags.length) clauses.add(`nwr(area.cidade)["name"~"${escapeOverpass(term)}",i];`);
  }
  const query = `[out:json][timeout:15];${state}${area}(${[...clauses].join('')});out center tags 200;`;
  const json = await overpass(query);
  return json.elements.filter(e => e.tags?.name).map(e => {
    const t = e.tags;
    return {
      id: 'o' + e.type[0] + e.id,
      nome: t.name,
      telefone: phoneBR(t['contact:whatsapp'] || t['contact:phone'] || t.phone || t.mobile || t['contact:mobile']),
      endereco: [t['addr:street'], t['addr:housenumber'], t['addr:suburb'], t['addr:city']].filter(Boolean).join(', '),
      site: t.website || t['contact:website'] || '',
      nota: 0, avaliacoes: 0, fonte: 'osm'
    };
  });
}

/* ---------- Google Places API (New) - Text Search ---------- */
// Pedir telefone/site/nota usa o SKU "Text Search Enterprise" (1.000 buscas grátis por mês, depois cobrado).
// Cada página (até 20 resultados) conta como 1 busca. Limite por pesquisa: 2 termos x GOOGLE_MAX_PAGES (padrão 2).
const GFIELDS = 'nextPageToken,places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus';

async function googleSearch(terms, local) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];
  const { cidade, uf } = parseLocal(local);
  const onde = cidade + (uf ? ', ' + uf : '') + ', Brasil';
  const maxPages = Math.min(Math.max(Number(process.env.GOOGLE_MAX_PAGES) || 2, 1), 3);
  const out = [];
  for (const t of terms.slice(0, 2)) {
    let token = '';
    for (let p = 0; p < maxPages; p++) {
      const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST', signal: timeout(15000),
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': GFIELDS },
        body: JSON.stringify({ textQuery: `${t} em ${onde}`, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 20, ...(token ? { pageToken: token } : {}) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('Google ' + r.status + ': ' + (j.error?.message || 'erro').slice(0, 160));
      for (const x of j.places || []) {
        if (x.businessStatus === 'CLOSED_PERMANENTLY' || !x.displayName?.text) continue;
        out.push({
          id: 'g' + x.id, nome: x.displayName.text, telefone: phoneBR(x.nationalPhoneNumber || x.internationalPhoneNumber),
          endereco: x.formattedAddress || '', site: x.websiteUri || '', nota: x.rating || 0, avaliacoes: x.userRatingCount || 0, fonte: 'google',
        });
      }
      token = j.nextPageToken || '';
      if (!token) break;
    }
  }
  return out;
}

/* ---------- Junta e remove duplicados ---------- */
function merge(lists) {
  const seen = new Map();
  for (const l of lists.flat()) {
    const key = l.telefone || norm(l.nome);
    const old = seen.get(key);
    // Completa campos vazios do registro já existente
    if (!old) seen.set(key, l);
    else seen.set(key, { ...l, ...old, telefone: old.telefone || l.telefone, site: old.site || l.site, nota: old.nota || l.nota, avaliacoes: old.avaliacoes || l.avaliacoes });
  }
  return [...seen.values()];
}

async function buscarLeads({ nicho, cidade, sinonimos = [], semSite = false }) {
  const terms = [nicho, ...sinonimos].map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4);
  if (!terms.length || !cidade) throw Object.assign(new Error('Informe nicho e cidade'), { status: 400, code: 'bad_request' });

  const usaGoogle = !!process.env.GOOGLE_MAPS_API_KEY;
  const jobs = [...(usaGoogle ? [googleSearch(terms, cidade)] : []), osmSearch(terms, cidade)]; // Google primeiro: seus dados vencem no merge
  const res = await Promise.allSettled(jobs);
  const erros = res.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const googleOk = usaGoogle && res[0].status === 'fulfilled';
  if (!ok.some((l) => l.length) && erros.length === res.length) throw Object.assign(new Error('Nenhuma fonte respondeu: ' + erros[0]), { status: 502, code: 'sources_down' });

  let leads = merge(ok);
  if (semSite) leads = leads.filter((l) => !l.site);
  // Quem tem telefone primeiro
  leads.sort((a, b) => !!b.telefone - !!a.telefone);
  return {
    leads: leads.slice(0, 300), total: leads.length,
    fontes: { google: googleOk, osm: res[usaGoogle ? 1 : 0]?.status === 'fulfilled' }, avisos: erros,
  };
}

module.exports = { buscarLeads, parseLocal };
