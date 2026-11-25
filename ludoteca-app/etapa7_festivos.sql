-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 7 · Festivos precargados
--  Ejecutar completo en Supabase > SQL Editor
--
--  Fuentes: Decreto 101/2025 (BOJA 19/05/2025) para 2026 y
--           Decreto 84/2026 (BOJA 05/05/2026) para 2027.
--  FALTAN las 2 fiestas locales de cada año: añadirlas desde la app.
--  Los festivos que caen en viernes, sábado o domingo no cambian el precio,
--  pero se dejan para que el calendario esté completo.
-- =====================================================================

insert into festivos (fecha, descripcion) values
  -- Lo que queda de 2026
  ('2026-10-12', 'Fiesta Nacional de España'),
  ('2026-11-02', 'Todos los Santos (trasladado)'),
  ('2026-12-07', 'Día de la Constitución (trasladado)'),
  ('2026-12-08', 'Inmaculada Concepción'),
  ('2026-12-25', 'Navidad'),
  -- 2027
  ('2027-01-01', 'Año Nuevo'),
  ('2027-01-06', 'Epifanía del Señor'),
  ('2027-03-01', 'Día de Andalucía (trasladado)'),
  ('2027-03-25', 'Jueves Santo'),
  ('2027-03-26', 'Viernes Santo'),
  ('2027-05-01', 'Fiesta del Trabajo'),
  ('2027-08-16', 'Asunción de la Virgen (trasladado)'),
  ('2027-10-12', 'Fiesta Nacional de España'),
  ('2027-11-01', 'Todos los Santos'),
  ('2027-12-06', 'Día de la Constitución'),
  ('2027-12-08', 'Inmaculada Concepción'),
  ('2027-12-25', 'Navidad')
on conflict (fecha) do nothing;
