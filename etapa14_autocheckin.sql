-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 14 · Autocheck-in de clientes habituales
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

-- 1. Nuevo origen de llegada: el cliente habitual se apunta solo escaneando el QR
alter table llegadas drop constraint if exists llegadas_origen_check;
alter table llegadas add constraint llegadas_origen_check
  check (origen in ('ENLACE', 'CARTEL', 'PANTALLA', 'AUTOCHECKIN'));

-- 2. Móviles recordados: cada familia puede tener su móvil "recordado" para no identificarse cada vez.
--    Se guarda solo la huella (hash) del código que queda en su móvil. Vale un año.
create table if not exists dispositivos_familia (
  id          bigint generated always as identity primary key,
  token_hash  text not null unique,
  tutor_id    bigint not null references tutores(id) on delete cascade,
  created_at  timestamptz not null default now(),
  ultimo_uso  timestamptz,
  anulado     boolean not null default false
);
create index if not exists dispositivos_familia_tutor_idx on dispositivos_familia (tutor_id);
alter table dispositivos_familia enable row level security;

-- 3. Intentos de identificación (teléfono + fecha de nacimiento), para frenar a quien pruebe números
create table if not exists identificacion_intentos (
  id          bigint generated always as identity primary key,
  ip          text not null,
  ok          boolean not null,
  created_at  timestamptz not null default now()
);
create index if not exists identificacion_intentos_ip_idx on identificacion_intentos (ip, created_at);
alter table identificacion_intentos enable row level security;
