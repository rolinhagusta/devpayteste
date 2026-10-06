-- DEV PAY: tabelas e regras de segurança (RLS) para o Supabase
-- Cole tudo no SQL Editor do Supabase e clique em Run.

create table if not exists public.leads (
  id         text not null,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome       text,
  tel        text,
  nicho      text,
  cidade     text,
  uf         text,
  nota       numeric default 0,
  aval       integer default 0,
  t          bigint,
  contatado  boolean default false,
  endereco   text,
  site       text,
  primary key (user_id, id)
);

create table if not exists public.sales (
  id       text not null,
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead     text,
  nome     text,
  nicho    text,
  valor    numeric,
  status   text default 'pendente',
  t        bigint,
  pago     bigint,
  primary key (user_id, id)
);

alter table public.leads enable row level security;
alter table public.sales enable row level security;

drop policy if exists "leads_dono" on public.leads;
create policy "leads_dono" on public.leads
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "sales_dono" on public.sales;
create policy "sales_dono" on public.sales
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
