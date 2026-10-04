-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 3 · Búsqueda, precio del día y cobro
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

-- Para buscar "Jose" y encontrar "José"
create extension if not exists unaccent with schema extensions;

-- Fecha de hoy en España
create or replace function hoy()
returns date language sql stable as $$
  select (now() at time zone 'Europe/Madrid')::date;
$$;

-- Busca niños por su nombre, por el nombre de un tutor o por teléfono
create or replace function buscar_ninos(p_q text)
returns setof bigint language sql stable as $$
  with q as (
    select lower(extensions.unaccent(trim(p_q)))     as t,
           regexp_replace(p_q, '\D', '', 'g')         as d
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
  )
  limit 30;
$$;

-- Para cada niño: si es socio hoy, qué tarifa le toca y si ya ha entrado hoy
create or replace function info_entrada_hoy(p_ids bigint[])
returns table (
  nino_id bigint, es_socio boolean,
  tarifa_codigo text, tarifa_nombre text, precio numeric,
  entrada_hoy timestamptz
) language sql stable as $$
  select n.id,
         es_socio(n.id, hoy()),
         tf.codigo, tf.nombre, tf.precio,
         (select max(tk.creado_at)
            from ticket_lineas l
            join tickets tk on tk.id = l.ticket_id
            join tarifas ta on ta.codigo = l.tarifa_codigo and ta.tipo = 'ENTRADA'
           where l.nino_id = n.id and tk.fecha = hoy() and not tk.anulado)
  from ninos n
  cross join lateral tarifa_entrada(n.id, hoy()) tf
  where n.id = any(p_ids);
$$;

-- Crea el ticket y sus líneas en una sola operación (o todo o nada).
-- El precio lo calcula la base de datos, nunca el móvil.
create or replace function crear_ticket_entrada(
  p_tutor_id bigint, p_ninos bigint[], p_metodo text, p_usuario_id bigint
) returns bigint language plpgsql as $$
declare
  v_ticket bigint;
  v_total  numeric := 0;
  v_nino   bigint;
  r        record;
begin
  if p_ninos is null or array_length(p_ninos, 1) is null then
    raise exception 'SIN_NINOS';
  end if;

  insert into tickets (fecha, tutor_id, metodo_pago, usuario_id, total)
  values (hoy(), p_tutor_id, 'SIN_COSTE', p_usuario_id, 0)
  returning id into v_ticket;

  foreach v_nino in array p_ninos loop
    select * into r from tarifa_entrada(v_nino, hoy());
    if r.codigo is null then raise exception 'TARIFA_NO_ENCONTRADA'; end if;
    insert into ticket_lineas (ticket_id, nino_id, tarifa_codigo, descripcion, precio)
    values (v_ticket, v_nino, r.codigo, r.nombre, r.precio);
    v_total := v_total + r.precio;
  end loop;

  if v_total > 0 and coalesce(p_metodo, '') not in ('EFECTIVO', 'TARJETA') then
    raise exception 'METODO_NO_VALIDO';
  end if;

  update tickets
     set total = v_total,
         metodo_pago = case when v_total = 0 then 'SIN_COSTE' else p_metodo end
   where id = v_ticket;

  return v_ticket;
end;
$$;

-- Solo el servidor (service_role) puede ejecutar funciones
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
