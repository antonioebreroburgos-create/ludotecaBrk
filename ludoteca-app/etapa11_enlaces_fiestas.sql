-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 11 · Enlaces para clientes, llegadas,
--  fiestas de cumpleaños y rol Camarero
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

-- 1. Nuevo rol CAMARERO (enviar enlaces, ver llegadas, cobrar; sin caja ni marketing)
alter table usuarios drop constraint if exists usuarios_rol_check;
alter table usuarios add constraint usuarios_rol_check check (rol in ('ADMIN', 'MONITORA', 'CAMARERO'));

-- 2. Fiestas de cumpleaños
create table if not exists fiestas (
  id                    bigint generated always as identity primary key,
  fecha                 date not null,
  hora                  text,                         -- '17:30'
  cumpleanero           text not null,                -- nombre del niño que cumple
  organizador_nombre    text not null,
  organizador_telefono  text not null,
  ninos_previstos       int,
  observaciones         text,
  anulada               boolean not null default false,
  creado_por            bigint references usuarios(id),
  created_at            timestamptz not null default now()
);
create index if not exists fiestas_fecha_idx on fiestas (fecha);
alter table fiestas enable row level security;

-- Invitados: solo lo necesario para el día (sin teléfonos de otras familias).
-- Se borran solos 30 días después de la fiesta.
create table if not exists fiesta_invitados (
  id              bigint generated always as identity primary key,
  fiesta_id       bigint not null references fiestas(id) on delete cascade,
  nombre          text not null,
  edad            int check (edad between 0 and 17),
  avisos          text,                               -- alergias, etc.
  es_cumpleanero  boolean not null default false,
  ha_llegado      boolean not null default false,
  orden           int not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists fiesta_invitados_fiesta_idx on fiesta_invitados (fiesta_id, orden);
alter table fiesta_invitados enable row level security;

-- 3. Enlaces que se envían a los clientes por WhatsApp
--    Se guarda solo la "huella" (hash) del código, nunca el código en claro.
create table if not exists enlaces (
  id           bigint generated always as identity primary key,
  token_hash   text not null unique,
  tipo         text not null check (tipo in ('REGISTRO', 'FIESTA')),
  telefono     text,                                  -- REGISTRO: teléfono al que se envió
  fiesta_id    bigint references fiestas(id) on delete cascade,
  creado_por   bigint references usuarios(id),
  created_at   timestamptz not null default now(),
  caduca_at    timestamptz not null,
  usado_at     timestamptz,                           -- REGISTRO: un solo uso
  anulado      boolean not null default false
);
create index if not exists enlaces_fiesta_idx on enlaces (fiesta_id);
alter table enlaces enable row level security;

-- 4. Llegadas: familias que se han registrado con el enlace y esperan a que se les cobre
create table if not exists llegadas (
  id          bigint generated always as identity primary key,
  fecha       date not null default hoy(),
  tutor_id    bigint not null references tutores(id) on delete cascade,
  nino_ids    bigint[] not null,
  enlace_id   bigint references enlaces(id) on delete set null,
  estado      text not null default 'PENDIENTE' check (estado in ('PENDIENTE', 'COBRADA', 'DESCARTADA')),
  ticket_id   bigint references tickets(id) on delete set null,
  created_at  timestamptz not null default now(),
  resuelta_at timestamptz,
  resuelta_por bigint references usuarios(id)
);
create index if not exists llegadas_fecha_idx on llegadas (fecha, estado);
alter table llegadas enable row level security;

-- 5. Fecha y hora en que termina la jornada de un día (las 6:00 del día siguiente, hora de España)
create or replace function fin_jornada(p_fecha date)
returns timestamptz language sql immutable as $$
  select ((p_fecha + 1)::timestamp + interval '6 hours') at time zone 'Europe/Madrid';
$$;

-- 6. Privacidad: borra los invitados de las fiestas de hace más de 30 días
create or replace function limpiar_invitados_antiguos()
returns int language sql as $$
  with b as (
    delete from fiesta_invitados i using fiestas f
    where f.id = i.fiesta_id and f.fecha < hoy() - 30
    returning i.id
  )
  select count(*)::int from b;
$$;

-- Solo el servidor (service_role) puede ejecutar funciones
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
