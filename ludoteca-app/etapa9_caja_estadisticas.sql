-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 9 · Fondo fijo, caja bloqueada y estadísticas
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

-- 1. Fondo de cambio fijo (lo cambia el administrador en Precios y festivos)
insert into ajustes (clave, valor) values ('fondo_caja', '30.00')
on conflict (clave) do nothing;

-- 2. Historial de la caja: cada cierre, corrección y reapertura queda registrado
create table if not exists caja_auditoria (
  id          bigint generated always as identity primary key,
  fecha       date not null,                                   -- día de la caja
  accion      text not null check (accion in ('CIERRE', 'CORRECCION', 'REAPERTURA')),
  usuario_id  bigint references usuarios(id),
  motivo      text,
  antes       jsonb,                                           -- cómo estaba el cierre
  despues     jsonb,                                           -- cómo quedó
  created_at  timestamptz not null default now()
);
create index if not exists caja_auditoria_fecha_idx on caja_auditoria (fecha, created_at);
alter table caja_auditoria enable row level security;

-- 3. Con la caja cerrada no se puede cobrar ni anular nada de ese día
create or replace function bloquear_caja_cerrada()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from cierres_caja where fecha = new.fecha) then
      raise exception 'CAJA_CERRADA';
    end if;
  elsif tg_op = 'UPDATE' and new.anulado and not old.anulado then
    if exists (select 1 from cierres_caja where fecha = old.fecha) then
      raise exception 'CAJA_CERRADA';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_caja_cerrada on tickets;
create trigger tickets_caja_cerrada
  before insert or update on tickets
  for each row execute function bloquear_caja_cerrada();

-- 4. Estadísticas de un periodo (solo tickets no anulados)
create or replace function estadisticas(p_desde date, p_hasta date)
returns json language sql stable as $$
  with t as (
    select * from tickets where not anulado and fecha between p_desde and p_hasta
  ), l as (
    select li.id, li.ticket_id, li.nino_id, li.tarifa_codigo, li.descripcion, li.precio,
           t.fecha, t.metodo_pago, ta.tipo
    from ticket_lineas li
    join t on t.id = li.ticket_id
    left join tarifas ta on ta.codigo = li.tarifa_codigo
  ), e as (                                   -- entradas (una por niño y visita)
    select * from l where tipo = 'ENTRADA' and nino_id is not null
  ), primera as (                             -- primera visita de cada niño en toda la historia
    select l2.nino_id, min(t2.fecha) as f
    from ticket_lineas l2
    join tickets t2  on t2.id = l2.ticket_id and not t2.anulado
    join tarifas ta2 on ta2.codigo = l2.tarifa_codigo and ta2.tipo = 'ENTRADA'
    where l2.nino_id is not null
    group by l2.nino_id
  ), dias as (
    select fecha, count(*) as visitas from e group by fecha
  )
  select json_build_object(
    'desde', p_desde,
    'hasta', p_hasta,
    'visitas',         (select count(*) from e),
    'ninos',           (select count(distinct nino_id) from e),
    'ninos_nuevos',    (select count(*) from primera where f between p_desde and p_hasta),
    'dias_con_visitas',(select count(*) from dias),
    'efectivo',        coalesce((select sum(total) from t where metodo_pago = 'EFECTIVO'), 0),
    'tarjeta',         coalesce((select sum(total) from t where metodo_pago = 'TARJETA'), 0),
    'familias_nuevas', (select count(*) from tutores
                         where (created_at at time zone 'Europe/Madrid')::date between p_desde and p_hasta),
    'cuotas',          (select count(*) from l where tarifa_codigo = 'CUOTA_SOCIO'),
    'socios_activos',  (select count(distinct nino_id) from membresias
                         where activo and hoy() between fecha_alta and fecha_caducidad),
    'por_tarifa', coalesce((
        select json_agg(x order by x.orden, x.nombre) from (
          select l.tarifa_codigo as codigo, coalesce(ta.nombre, max(l.descripcion)) as nombre,
                 coalesce(ta.orden, 99) as orden, count(*) as cantidad, sum(l.precio) as importe
          from l left join tarifas ta on ta.codigo = l.tarifa_codigo
          group by l.tarifa_codigo, ta.nombre, ta.orden) x), '[]'::json),
    'por_dia_semana', (
        select json_agg(json_build_object('dow', d, 'visitas', coalesce(s.v, 0), 'dias', coalesce(s.n, 0)) order by d)
        from generate_series(1, 7) d
        left join (select extract(isodow from fecha)::int as dw, sum(visitas) as v, count(*) as n
                   from dias group by 1) s on s.dw = d),
    'por_dia', coalesce((
        select json_agg(json_build_object('fecha', fecha, 'visitas', visitas) order by fecha) from dias), '[]'::json),
    'edades', (
        select json_agg(json_build_object('tramo', b.tramo, 'ninos', z.c) order by b.o)
        from (values (1, '0 a 2', 0, 2), (2, '3 a 5', 3, 5), (3, '6 a 8', 6, 8),
                     (4, '9 a 12', 9, 12), (5, '13 o más', 13, 200)) b(o, tramo, mn, mx)
        cross join lateral (
          select count(*) as c
          from (select distinct nino_id from e) d
          join ninos n on n.id = d.nino_id
          where extract(year from age(p_hasta, n.fecha_nacimiento)) between b.mn and b.mx) z),
    'top_ninos', coalesce((
        select json_agg(x) from (
          select n.id, n.nombre, n.apellidos, count(*) as visitas, max(e.fecha) as ultima
          from e join ninos n on n.id = e.nino_id
          group by n.id order by count(*) desc, max(e.fecha) desc
          limit 10) x), '[]'::json)
  );
$$;

-- Solo el servidor (service_role) puede ejecutar funciones
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
