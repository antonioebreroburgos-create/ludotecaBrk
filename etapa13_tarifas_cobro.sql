-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 13 · Elegir la tarifa al cobrar e Invitación
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

-- 1. Las 6 tarifas de siempre son "base": no se pueden desactivar.
--    El administrador puede crear otras entradas (Invitación, media entrada...) y desactivarlas.
alter table tarifas add column if not exists base boolean not null default false;
update tarifas set base = true
 where codigo in ('ENTRADA_LJ', 'ENTRADA_FINDE', 'SOCIO_LJ', 'SOCIO_FINDE', 'CUOTA_SOCIO', 'REPOSICION_PULSERA');

insert into tarifas (codigo, nombre, tipo, precio, orden)
values ('INVITACION', 'Invitación', 'ENTRADA', 0, 10)
on conflict (codigo) do nothing;

-- 2. Cada línea guarda si la tarifa se cambió a mano, y el ticket el motivo
alter table ticket_lineas add column if not exists tarifa_manual boolean not null default false;
alter table tickets       add column if not exists nota text;

-- 3. Cobro de entradas: la tarifa sale sola, pero se puede elegir otra por niño.
--    Si el total queda por debajo de lo que correspondía, el motivo es obligatorio.
drop function if exists crear_ticket_entrada(bigint, bigint[], text, bigint);
create or replace function crear_ticket_entrada(
  p_tutor_id bigint, p_ninos bigint[], p_metodo text, p_usuario_id bigint,
  p_tarifas text[] default null,      -- una por niño, en el mismo orden; null = la que toca
  p_nota text default null
) returns bigint language plpgsql as $$
declare
  v_ticket bigint;
  v_total  numeric := 0;
  v_auto   numeric := 0;
  v_nino   bigint;
  v_i      int := 0;
  v_cod    text;
  v_manual boolean;
  v_nota   text := nullif(trim(coalesce(p_nota, '')), '');
  r        record;
  e        record;
begin
  if p_ninos is null or array_length(p_ninos, 1) is null then
    raise exception 'SIN_NINOS';
  end if;

  insert into tickets (fecha, tutor_id, metodo_pago, usuario_id, total, nota)
  values (hoy(), p_tutor_id, 'SIN_COSTE', p_usuario_id, 0, v_nota)
  returning id into v_ticket;

  foreach v_nino in array p_ninos loop
    v_i := v_i + 1;
    select * into r from tarifa_entrada(v_nino, hoy());
    if r.codigo is null then raise exception 'TARIFA_NO_ENCONTRADA'; end if;
    v_auto := v_auto + r.precio;

    v_cod := nullif(p_tarifas[v_i], '');
    v_manual := v_cod is not null and v_cod <> r.codigo;
    if v_manual then
      select codigo, nombre, precio into e from tarifas where codigo = v_cod and tipo = 'ENTRADA' and activo;
      if not found then raise exception 'TARIFA_NO_VALIDA'; end if;
    else
      select r.codigo as codigo, r.nombre as nombre, r.precio as precio into e;
    end if;

    insert into ticket_lineas (ticket_id, nino_id, tarifa_codigo, descripcion, precio, tarifa_manual)
    values (v_ticket, v_nino, e.codigo, e.nombre, e.precio, v_manual);
    v_total := v_total + e.precio;
  end loop;

  if v_total < v_auto and v_nota is null then
    raise exception 'NOTA_OBLIGATORIA';
  end if;
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
