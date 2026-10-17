-- ===== Radar OpenStreetMap: colunas extras dos leads (rode UMA vez no SQL Editor; pode rodar de novo sem apagar nada) =====
-- Sem isto o app continua funcionando (salva sem categoria/fonte), mas perde esses campos ao recarregar.
alter table public.leads
  add column if not exists categoria text,    -- categoria do estabelecimento segundo o OSM
  add column if not exists fonte text,        -- 'osm' quando o lead veio do OpenStreetMap
  add column if not exists cidade_osm text;   -- addr:city, só se existir no OSM
