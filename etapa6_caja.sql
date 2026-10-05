-- =====================================================================
--  LUDOTECA BROOKLYN · ETAPA 6 · Caja diaria y cierre
--  Ejecutar completo en Supabase > SQL Editor
-- =====================================================================

alter table cierres_caja
  add column if not exists fondo_caja          numeric(10,2) not null default 0,   -- cambio con el que se empezó
  add column if not exists total               numeric(10,2),                      -- efectivo + tarjeta al cerrar
  add column if not exists tarjeta_datafono    numeric(10,2),                      -- lo que dice el datáfono (opcional)
  add column if not exists diferencia_tarjeta  numeric(10,2),
  add column if not exists actualizado_at      timestamptz;                        -- si se vuelve a cerrar

-- Recordatorio de cómo se guardan las diferencias:
--   diferencia         = efectivo_contado - fondo_caja - total_efectivo   (0 = cuadra, + sobra, - falta)
--   diferencia_tarjeta = tarjeta_datafono - total_tarjeta
