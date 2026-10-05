-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 5 · Socios Kids Club y fichas
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

-- 1. La pulsera pasa a ser del niño (sobrevive a las renovaciones)
alter table ninos add column if not exists numero_pulsera text;
create unique index if not exists ninos_pulsera_unica on ninos (numero_pulsera) where numero_pulsera is not null;

-- Si se puso alguna pulsera a mano en membresias durante las pruebas, se traslada
update ninos n set numero_pulsera = m.numero_pulsera
from membresias m
where m.nino_id = n.id and m.activo and m.numero_pulsera is not null and n.numero_pulsera is null;

-- 2. Membresías = periodos pagados. Puede haber varias (histórico y renovaciones anticipadas)
drop index if exists membresia_activa_unica;
drop index if exists pulsera_activa_unica;
alter table membresias drop column if exists numero_pulsera;
create index if not exists membresias_nino_idx on membresias (nino_id, fecha_caducidad);

-- 3. Periodo que cubriría una cuota pagada hoy:
--    desde hoy, o desde el día siguiente al fin de la cuota vigente (renovación anticipada sin perder días)
create or replace function periodo_cuota(p_nino_id bigint)
returns table (desde date, hasta date) language sql stable as $$
  with u as (
    select max(fecha_caducidad) as ultima
    from membresias where nino_id = p_nino_id and activo
  ), d as (
    select greatest(hoy(), coalesce(ultima + 1, hoy())) as desde from u
  )
  select desde, (desde + interval '1 year' - interval '1 day')::date from d;
$$;

-- 4. Búsqueda: ahora también por número de pulsera
create or replace function buscar_ninos(p_q text)
returns setof bigint language sql stable as $$
  with q as (
    select lower(extensions.unaccent(trim(p_q))) as t,
           regexp_replace(p_q, '\D', '', 'g')     as d,
           trim(p_q)                               as exacto
  )
  select distinct n.id
  from ninos n
  left join nino_tutor nt on nt.nino_id = n.id
  left join tutores t     on t.id = nt.tutor_id
  cross join q
  where n.activo and (
       lower(extensions.unaccent(n.nombre || ' ' || coalesce(n.apellidos, ''))) like '%' || q.t || '%'
    or lower(extensions.unaccent(t.nombre || ' ' || coalesce(t.apellidos, ''))) like '%' || q.t || '%'
    or (length(q.d) >= 3 and regexp_replace(t.telefono, '\D', '', 'g') like '%' || q.d || '%')
    or lower(n.numero_pulsera) = lower(q.exacto)
  )
  limit 30;
$$;

-- 5. Info del día: se añade pulsera y fecha hasta la que es socio
drop function if exists info_entrada_hoy(bigint[]);
create function info_entrada_hoy(p_ids bigint[])
returns table (
  nino_id bigint, es_socio boolean,
  tarifa_codigo text, tarifa_nombre text, precio numeric,
  entrada_hoy timestamptz,
  numero_pulsera text, socio_hasta date
) language sql stable as $$
  select n.id,
         es_socio(n.id, hoy()),
         tf.codigo, tf.nombre, tf.precio,
         (select max(tk.creado_at)
            from ticket_lineas l
            join tickets tk on tk.id = l.ticket_id
            join tarifas ta on ta.codigo = l.tarifa_codigo and ta.tipo = 'ENTRADA'
           where l.nino_id = n.id and tk.fecha = hoy() and not tk.anulado),
         n.numero_pulsera,
         (select max(m.fecha_caducidad) from membresias m
           where m.nino_id = n.id and m.activo and m.fecha_caducidad >= hoy())
  from ninos n
  cross join lateral tarifa_entrada(n.id, hoy()) tf
  where n.id = any(p_ids);
$$;

-- 6. Cobro de cuota de socio o reposición de pulsera (todo o nada)
create or replace function cobrar_servicio(
  p_nino_id bigint, p_tutor_id bigint, p_codigo text,
  p_metodo text, p_usuario_id bigint, p_pulsera text
) returns bigint language plpgsql as $$
declare
  v_ticket  bigint;
  r         tarifas%rowtype;
  v_pulsera text := nullif(trim(coalesce(p_pulsera, '')), '');
  v_periodo record;
begin
  if p_codigo not in ('CUOTA_SOCIO', 'REPOSICION_PULSERA') then raise exception 'CONCEPTO_NO_VALIDO'; end if;

  select * into r from tarifas where codigo = p_codigo;
  if not found then raise exception 'TARIFA_NO_ENCONTRADA'; end if;
  if r.precio > 0 and coalesce(p_metodo, '') not in ('EFECTIVO', 'TARJETA') then raise exception 'METODO_NO_VALIDO'; end if;

  perform 1 from ninos where id = p_nino_id for update;
  if not found then raise exception 'NINO_NO_EXISTE'; end if;

  if p_codigo = 'REPOSICION_PULSERA' and v_pulsera is null then raise exception 'FALTA_PULSERA'; end if;
  if v_pulsera is not null then
    if exists (select 1 from ninos where lower(numero_pulsera) = lower(v_pulsera) and id <> p_nino_id) then
      raise exception 'PULSERA_EN_USO';
    end if;
    update ninos set numero_pulsera = v_pulsera where id = p_nino_id;
  end if;
  if p_codigo = 'CUOTA_SOCIO' and (select numero_pulsera from ninos where id = p_nino_id) is null then
    raise exception 'FALTA_PULSERA';
  end if;

  insert into tickets (fecha, tutor_id, metodo_pago, usuario_id, total)
  values (hoy(), p_tutor_id, case when r.precio = 0 then 'SIN_COSTE' else p_metodo end, p_usuario_id, r.precio)
  returning id into v_ticket;

  insert into ticket_lineas (ticket_id, nino_id, tarifa_codigo, descripcion, precio)
  values (v_ticket, p_nino_id, r.codigo, r.nombre, r.precio);

  if p_codigo = 'CUOTA_SOCIO' then
    select * into v_periodo from periodo_cuota(p_nino_id);
    insert into membresias (nino_id, fecha_alta, fecha_caducidad, ticket_id)
    values (p_nino_id, v_periodo.desde, v_periodo.hasta, v_ticket);
  end if;

  return v_ticket;
end;
$$;

-- Solo el servidor (service_role) puede ejecutar funciones
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
