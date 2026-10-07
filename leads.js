// Busca de leads: OpenStreetMap/Overpass (100% grátis, sem chave)

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

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function overpass(query) {
  let err;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', signal: timeout(22000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'devpay-radar' }, body: 'data=' + encodeURIComponent(query) });
      if (r.ok) return await r.json();
      err = new Error('Overpass ' + r.status);
    } catch (e) { err = e; }
  }
  throw err;
}

async function osmSearch(terms, local) {
  const { cidade, uf } = parseLocal(local);
  if (!cidade) return [];
  const esc = (s) => s.replace(/["\\]/g, '');
  const state = uf ? `area["ISO3166-2"="BR-${uf}"]->.s;` : '';
  const city = uf ? `area["name"="${esc(cidade)}"]["boundary"="administrative"](area.s)->.a;` : `area["name"="${esc(cidade)}"]["boundary"="administrative"]["admin_level"="8"]->.a;`;
  const parts = [];
  for (const t of terms) {
    const k = norm(t);
    for (const tag of OSM_TAGS[k] || OSM_TAGS[k.replace(/s$/, '')] || []) {
      const [a, b] = tag.split('=');
      parts.push(`nwr(area.a)["${a}"="${b}"];`);
    }
    parts.push(`nwr(area.a)["name"~"${esc(t)}",i];`); // pega "Barbearia do Zé", "Studio X Academia", etc.
  }
  const q = `[out:json][timeout:25];${state}${city}(${parts.join('')});out center tags 300;`;
  const j = await overpass(q);
  return (j.elements || []).filter((e) => e.tags?.name).map((e) => {
    const t = e.tags;
    const end = [t['addr:street'], t['addr:housenumber'], t['addr:suburb'], t['addr:city']].filter(Boolean).join(', ');
    return {
      id: 'o' + e.type[0] + e.id, nome: t.name, telefone: phoneBR(t['contact:whatsapp'] || t.mobile || t.phone || t['contact:phone'] || t['contact:mobile']),
      endereco: end, site: t.website || t['contact:website'] || '', nota: 0, avaliacoes: 0, fonte: 'osm',
    };
  });
}

/* ---------- Junta e remove duplicados ---------- */
function merge(lists) {
  const seen = new Map();
  for (const l of lists.flat()) {
    const key = l.telefone || norm(l.nome) + '|' + norm(l.endereco).slice(0, 20);
    const old = seen.get(key);
    // Completa campos vazios do registro já existente
    if (!old) seen.set(key, l);
    else seen.set(key, { ...l, ...old, telefone: old.telefone || l.telefone, site: old.site || l.site });
  }
  return [...seen.values()];
}

async function buscarLeads({ nicho, cidade, sinonimos = [], semSite = false }) {
  const terms = [nicho, ...sinonimos].map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4);
  if (!terms.length || !cidade) throw Object.assign(new Error('Informe nicho e cidade'), { status: 400, code: 'bad_request' });

  const jobs = [osmSearch(terms, cidade)];
  const res = await Promise.allSettled(jobs);
  const erros = res.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.some((l) => l.length) && erros.length === res.length) throw Object.assign(new Error('Nenhuma fonte respondeu: ' + erros[0]), { status: 502, code: 'sources_down' });

  let leads = merge(ok);
  if (semSite) leads = leads.filter((l) => !l.site);
  // Quem tem telefone primeiro
  leads.sort((a, b) => !!b.telefone - !!a.telefone);
  return {
    leads: leads.slice(0, 300), total: leads.length,
    fontes: { google: false, osm: true }, avisos: erros,
  };
}

module.exports = { buscarLeads, parseLocal };
