-- ===== Tokens do radar de leads (rode UMA vez no SQL Editor do Supabase) =====
-- Data da assinatura: os tokens renovam todo mês nessa data.
alter table public.subscriptions add column if not exists anchor timestamptz;

-- 1 token = 1 busca no radar. O limite por plano fica no backend (app.js, constante TOKENS).
create table if not exists public.token_usage (
  user_id uuid not null references auth.users on delete cascade,
  month text not null,                 -- chave do ciclo (cAAAA-MM-DD = início do ciclo)
  used int not null default 0,
  primary key (user_id, month)
);
alter table public.token_usage enable row level security;
drop policy if exists "tokens_select_own" on public.token_usage;
create policy "tokens_select_own" on public.token_usage for select using (auth.uid() = user_id);
-- escrita só pelo backend (service role)

-- Consome (ou devolve, com delta negativo) tokens de forma atômica.
-- Retorna os tokens restantes, ou -1 se não houver saldo.
create or replace function public.use_tokens(p_user uuid, p_month text, p_delta int, p_limit int)
returns int language plpgsql security definer set search_path = public as $$
declare v_used int;
begin
  insert into public.token_usage(user_id, month, used) values (p_user, p_month, 0) on conflict do nothing;
  select used into v_used from public.token_usage where user_id = p_user and month = p_month for update;
  if p_delta > 0 and v_used + p_delta > p_limit then return -1; end if;
  update public.token_usage set used = greatest(0, v_used + p_delta) where user_id = p_user and month = p_month;
  return p_limit - greatest(0, v_used + p_delta);
end $$;
revoke all on function public.use_tokens(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.use_tokens(uuid, text, int, int) to service_role;
