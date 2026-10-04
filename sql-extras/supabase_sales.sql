-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez, não apaga dados)

create table if not exists public.sales (
  user_id uuid not null references auth.users on delete cascade,
  id text not null,
  lead text,
  nome text,
  nicho text,
  valor numeric(12,2),
  status text default 'pendente',
  t bigint,
  pago bigint,
  primary key (user_id, id)
);

-- Se a tabela já existia, garante as colunas e o índice que o upsert usa
alter table public.sales
  add column if not exists lead text,
  add column if not exists nome text,
  add column if not exists nicho text,
  add column if not exists valor numeric(12,2),
  add column if not exists status text default 'pendente',
  add column if not exists t bigint,
  add column if not exists pago bigint;
create unique index if not exists sales_user_id_id_key on public.sales (user_id, id);

alter table public.sales enable row level security;
drop policy if exists "sales_select" on public.sales;
drop policy if exists "sales_insert" on public.sales;
drop policy if exists "sales_update" on public.sales;
drop policy if exists "sales_delete" on public.sales;
create policy "sales_select" on public.sales for select using (auth.uid() = user_id);
create policy "sales_insert" on public.sales for insert with check (auth.uid() = user_id);
create policy "sales_update" on public.sales for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "sales_delete" on public.sales for delete using (auth.uid() = user_id);
