-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 8 · Cumpleaños para marketing
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

-- 1. Ajustes generales (textos de los mensajes)
create table if not exists ajustes (
  clave       text primary key,
  valor       text not null,
  updated_at  timestamptz not null default now()
);
alter table ajustes enable row level security;

insert into ajustes (clave, valor) values
  ('plantilla_cumple_nino',
   '¡Hola {tutor}! 🎈 Desde Restaurante Brooklyn os recordamos que el {fecha}, {nino} cumple {edad} años. ¿Lo celebramos aquí? Tenemos precios especiales para cumpleaños infantiles y la ludoteca para que se lo pasen en grande.{socio} Escríbenos por aquí y os preparamos la fiesta. 🎂'),
  ('plantilla_cumple_adulto',
   '¡Hola {nombre}! 🎉 En Restaurante Brooklyn sabemos que el {fecha} es tu cumpleaños. ¿Te apetece celebrarlo con nosotros? Tenemos precios especiales para celebraciones. Escríbenos por aquí y te lo preparamos todo. ¡Felicidades!'),
  ('texto_cumple_socio',
   ' Como socio del Brooklyn Kids Club, tiene un 5 % de descuento en su cumpleaños.')
on conflict (clave) do nothing;

-- 2. Registro de invitaciones enviadas (una por persona y año)
create table if not exists invitaciones_cumple (
  id          bigint generated always as identity primary key,
  tipo        text not null check (tipo in ('NINO', 'TUTOR')),
  persona_id  bigint not null,
  anio        int not null,
  tutor_id    bigint references tutores(id) on delete set null,
  usuario_id  bigint references usuarios(id),
  enviado_at  timestamptz not null default now(),
  unique (tipo, persona_id, anio)
);
alter table invitaciones_cumple enable row level security;

-- 3. Próximo cumpleaños a partir de una fecha (el 29/02 se celebra el 28/02 en años no bisiestos)
create or replace function proximo_cumple(p_nac date, p_desde date)
returns date language sql immutable as $$
  select case when c >= p_desde then c
              else (p_nac + make_interval(years => extract(year from p_desde)::int + 1 - extract(year from p_nac)::int))::date
         end
  from (select (p_nac + make_interval(years => extract(year from p_desde)::int - extract(year from p_nac)::int))::date as c) x;
$$;

-- 4. Cumpleaños entre dos fechas, SOLO de quien aceptó recibir promociones.
--    Niños: se usa el adulto que aceptó (el principal primero).
create or replace function cumpleanos(p_desde date, p_hasta date)
returns table (
  tipo text, persona_id bigint, nombre text, apellidos text, fecha_nacimiento date,
  cumple date, edad int, es_socio boolean,
  tutor_id bigint, tutor_nombre text, tutor_telefono text, parentesco text,
  invitado_at timestamptz
) language sql stable as $$
  with ninos_c as (
    select distinct on (n.id)
           'NINO'::text as tipo, n.id, n.nombre, n.apellidos, n.fecha_nacimiento,
           t.id as tid, t.nombre as tnombre, t.telefono as ttel, nt.parentesco
    from ninos n
    join nino_tutor nt on nt.nino_id = n.id
    join tutores t     on t.id = nt.tutor_id
    where n.activo and t.consentimiento_marketing
    order by n.id, nt.principal desc, t.id
  ), tutores_c as (
    select 'TUTOR'::text, t.id, t.nombre, t.apellidos, t.fecha_nacimiento,
           t.id, t.nombre, t.telefono, null::text
    from tutores t
    where t.consentimiento_marketing and t.fecha_nacimiento is not null
  ), todos as (
    select * from ninos_c union all select * from tutores_c
  )
  select x.tipo, x.id, x.nombre, x.apellidos, x.fecha_nacimiento,
         pc.c,
         (extract(year from pc.c) - extract(year from x.fecha_nacimiento))::int,
         case when x.tipo = 'NINO' then es_socio(x.id, pc.c) else false end,
         x.tid, x.tnombre, x.ttel, x.parentesco,
         (select max(i.enviado_at) from invitaciones_cumple i
           where i.tipo = x.tipo and i.persona_id = x.id and i.anio = extract(year from pc.c)::int)
  from todos x
  cross join lateral (select proximo_cumple(x.fecha_nacimiento, p_desde) as c) pc
  where pc.c <= p_hasta
  order by pc.c, x.nombre;
$$;

-- Solo el servidor (service_role) puede ejecutar funciones
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
