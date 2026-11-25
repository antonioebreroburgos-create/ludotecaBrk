-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 12 · Alta con QR (cartel fijo y QR en pantalla)
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

-- 1. Dos tipos nuevos de enlace, que pueden usar varias familias:
--    CARTEL   = el QR impreso del cartel (no caduca; el administrador puede cambiarlo)
--    PANTALLA = el QR que enseña el camarero en su móvil (caduca a los 10 minutos)
alter table enlaces drop constraint if exists enlaces_tipo_check;
alter table enlaces add constraint enlaces_tipo_check
  check (tipo in ('REGISTRO', 'FIESTA', 'CARTEL', 'PANTALLA'));

-- El código del cartel va impreso en un papel público, así que se guarda también
-- en claro para poder volver a imprimir el cartel. Los demás siguen guardando solo la huella.
alter table enlaces add column if not exists token_visible text;

-- 2. De dónde viene cada llegada (para avisar al personal de que compruebe el teléfono)
alter table llegadas add column if not exists origen text not null default 'ENLACE';
alter table llegadas drop constraint if exists llegadas_origen_check;
alter table llegadas add constraint llegadas_origen_check check (origen in ('ENLACE', 'CARTEL', 'PANTALLA'));

-- 3. Registro de altas hechas con QR, para limitar abusos (por móvil y por día)
create table if not exists altas_publicas (
  id          bigint generated always as identity primary key,
  enlace_id   bigint not null references enlaces(id) on delete cascade,
  ip          text not null,
  created_at  timestamptz not null default now()
);
create index if not exists altas_publicas_enlace_idx on altas_publicas (enlace_id, created_at);
create index if not exists altas_publicas_ip_idx on altas_publicas (ip, created_at);
alter table altas_publicas enable row level security;
