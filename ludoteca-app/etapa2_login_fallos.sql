-- LUDOTECA BROOKLYN · ETAPA 2 · Protección contra adivinar PINs
-- Ejecutar en Supabase > SQL Editor
create table login_fallos (
  id          bigint generated always as identity primary key,
  ip          text not null,
  created_at  timestamptz not null default now()
);
create index login_fallos_ip_idx on login_fallos (ip, created_at);
alter table login_fallos enable row level security;
