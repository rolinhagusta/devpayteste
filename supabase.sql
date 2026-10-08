-- Rode no SQL Editor do Supabase

create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users on delete cascade,
  asaas_customer_id text not null,
  cpf_cnpj text
);
alter table public.billing_customers enable row level security; -- sem policies: só o service role acessa

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  gateway_payment_id text unique not null,
  kind text not null check (kind in ('plan','sale')),
  ref_id text not null,                       -- id da venda ou "Pro:m"
  amount numeric(12,2) not null,
  method text not null default 'pix',         -- pix | card
  status text not null default 'pendente',    -- pendente | pago | expirado
  invoice_url text,
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.payments enable row level security;
drop policy if exists "payments_select_own" on public.payments;
create policy "payments_select_own" on public.payments for select using (auth.uid() = user_id);
-- escrita só pelo backend (service role ignora RLS)

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users on delete cascade,
  plan text not null,
  period text not null,                       -- m | a
  status text not null default 'ativo',
  current_period_end timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
drop policy if exists "subs_select_own" on public.subscriptions;
create policy "subs_select_own" on public.subscriptions for select using (auth.uid() = user_id);

-- Realtime para o modal detectar o pagamento
alter publication supabase_realtime add table public.payments;

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
