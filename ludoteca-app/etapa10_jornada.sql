-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 10 · El día de la ludoteca termina a las 6:00
--  Ejecutar completo en Supabase > SQL Editor
--
--  Hasta ahora el día cambiaba a las 00:00. Ahora, lo que pasa entre las
--  00:00 y las 6:00 cuenta como el día anterior: un sábado que cierra a la
--  1:30 sigue siendo "sábado" para los cobros, la tarifa, la caja y las
--  entradas de hoy.
--
--  OJO: la hora 6 está también en _lib.js y en index.html (HORA_CAMBIO_DIA).
--  Si algún día se cambia, hay que cambiarla en los tres sitios.
-- =====================================================================

-- "Hoy" de la ludoteca: hora de España menos 6 horas
create or replace function hoy()
returns date language sql stable as $$
  select ((now() at time zone 'Europe/Madrid') - interval '6 hours')::date;
$$;

-- Los valores por defecto de las tablas usan el mismo "hoy"
alter table tickets    alter column fecha      set default hoy();
alter table membresias alter column fecha_alta set default hoy();

-- Solo el servidor (service_role) puede ejecutar funciones
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
