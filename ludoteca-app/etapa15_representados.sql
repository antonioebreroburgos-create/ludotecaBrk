-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 15 · Hijos y niños representados
--  Un adulto puede traer a sus hijos y a otros niños que no son suyos.
--  Los que no son suyos van "representados" por él SOLO esa visita
--  (no pasa a ser familia del niño), y entonces tiene que dar nombre y apellidos.
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

-- 1. Cada línea del ticket guarda si el niño iba representado (no es de la familia de quien lo trae)
alter table ticket_lineas add column if not exists representado boolean not null default false;

-- 2. Fiestas: apellidos del organizador y, por invitado, si es su hijo o lo representa
alter table fiestas add column if not exists organizador_apellidos text;
alter table fiesta_invitados add column if not exists relacion text not null default 'REPRESENTADO';
alter table fiesta_invitados drop constraint if exists fiesta_invitados_relacion_check;
alter table fiesta_invitados add constraint fiesta_invitados_relacion_check check (relacion in ('HIJO', 'REPRESENTADO'));
update fiesta_invitados set relacion = 'HIJO' where es_cumpleanero and relacion <> 'HIJO';
--    Si el invitado ya es cliente de la ludoteca, se enlaza con su ficha (para ver sus alergias)
alter table fiesta_invitados add column if not exists nino_id bigint references ninos(id) on delete set null;

-- 3. Búsquedas de niños desde el móvil del cliente: se apuntan para frenar a quien pruebe datos
alter table identificacion_intentos add column if not exists tipo text not null default 'IDENTIFICAR';

-- 4. Buscar un niño que ya es cliente: mismo nombre y misma fecha de nacimiento.
--    Si hay varios, desempatan los apellidos. Si no queda uno solo, no devuelve nada.
create or replace function buscar_nino_exacto(p_nombre text, p_apellidos text, p_fecha date)
returns bigint language plpgsql stable as $$
declare
  v_nom text := lower(extensions.unaccent(trim(coalesce(p_nombre, ''))));
  v_ap  text := split_part(lower(extensions.unaccent(trim(coalesce(p_apellidos, '')))), ' ', 1);
  v_ids bigint[];
begin
  if v_nom = '' or p_fecha is null then return null; end if;

  select array_agg(n.id) into v_ids
    from ninos n
   where n.activo and n.fecha_nacimiento = p_fecha
     and (lower(extensions.unaccent(trim(n.nombre))) = v_nom
          or split_part(lower(extensions.unaccent(trim(n.nombre))), ' ', 1) = split_part(v_nom, ' ', 1))
     -- si los dos tienen apellidos, el primero tiene que coincidir
     and (v_ap = '' or coalesce(trim(n.apellidos), '') = ''
          or split_part(lower(extensions.unaccent(trim(n.apellidos))), ' ', 1) = v_ap);

  if v_ids is null or array_length(v_ids, 1) <> 1 then return null; end if;
  return v_ids[1];
end;
$$;

-- 5. Cobro de entradas (igual que en la etapa 13, más):
--    · cada niño que no es de la familia de quien lo trae queda como "representado"
--    · si hay alguno, el adulto tiene que tener apellidos guardados
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
  v_rep    boolean;
  v_nota   text := nullif(trim(coalesce(p_nota, '')), '');
  r        record;
  e        record;
begin
  if p_ninos is null or array_length(p_ninos, 1) is null then
    raise exception 'SIN_NINOS';
  end if;

  -- Antes de crear nada: si trae a niños que no son suyos, necesitamos sus apellidos
  if exists (select 1 from unnest(p_ninos) x(id)
              where not exists (select 1 from nino_tutor nt where nt.nino_id = x.id and nt.tutor_id = p_tutor_id))
     and (select length(trim(coalesce(apellidos, ''))) from tutores where id = p_tutor_id) < 2 then
    raise exception 'APELLIDOS_OBLIGATORIOS';
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

    v_rep := not exists (select 1 from nino_tutor nt where nt.nino_id = v_nino and nt.tutor_id = p_tutor_id);

    insert into ticket_lineas (ticket_id, nino_id, tarifa_codigo, descripcion, precio, tarifa_manual, representado)
    values (v_ticket, v_nino, e.codigo, e.nombre, e.precio, v_manual, v_rep);
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
