-- ===== Chave Pix do vendedor + controle de repasse =====
create table if not exists public.seller_pix (
  user_id uuid primary key references auth.users on delete cascade,
  pix_key text not null,
  pix_key_type text not null check (pix_key_type in ('CPF','CNPJ','EMAIL','PHONE','EVP')),
  updated_at timestamptz not null default now()
);
alter table public.seller_pix enable row level security;
drop policy if exists "seller_pix_select" on public.seller_pix;
drop policy if exists "seller_pix_insert" on public.seller_pix;
drop policy if exists "seller_pix_update" on public.seller_pix;
drop policy if exists "seller_pix_delete" on public.seller_pix;
create policy "seller_pix_select" on public.seller_pix for select using (auth.uid() = user_id);
create policy "seller_pix_insert" on public.seller_pix for insert with check (auth.uid() = user_id);
create policy "seller_pix_update" on public.seller_pix for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "seller_pix_delete" on public.seller_pix for delete using (auth.uid() = user_id);

alter table public.payments
  add column if not exists payout_status text,      -- enviando | enviado | falhou | sem_chave
  add column if not exists payout_id text,
  add column if not exists payout_amount numeric(12,2),
  add column if not exists payout_error text;
