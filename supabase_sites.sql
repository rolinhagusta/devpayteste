-- ===== Sites gerados (rode UMA vez no SQL Editor do Supabase; pode rodar de novo sem apagar nada) =====
-- 1 site por lead: gerar de novo ou editar substitui o anterior. As imagens anexadas já vão dentro do HTML.
create table if not exists public.sites (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id    text not null,
  nome       text,
  prompt     text,
  html       text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, lead_id)
);

alter table public.sites enable row level security;
drop policy if exists "sites_dono" on public.sites;
create policy "sites_dono" on public.sites
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
