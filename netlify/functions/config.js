// /.netlify/functions/config   (solo ADMIN)
// GET                                         → tarifas, festivos (desde hace 60 días) y tipo de día de hoy
// POST { accion:'tarifa', codigo, nombre, precio }   → cambia nombre y/o precio de una tarifa
// POST { accion:'festivo', fecha, descripcion }      → añade (o renombra) un festivo
// POST { accion:'quitar_festivo', fecha }            → quita un festivo
const {
  supabase, respuesta, leerBody, requerirUsuario, hoyMadrid, texto, errorHttp, responderError
} = require('./_lib');

// Fecha real YYYY-MM-DD (aquí sí se permiten fechas futuras)
function fechaReal(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s && s >= '2020-01-01' && s <= '2100-12-31';
}

async function datos() {
  const hoy = hoyMadrid();
  const d = new Date(hoy + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 60);
  const [rT, rF, rD] = await Promise.all([
    supabase.from('tarifas').select('codigo, nombre, tipo, precio, orden, updated_at').order('orden'),
    supabase.from('festivos').select('fecha, descripcion').gte('fecha', d.toISOString().slice(0, 10)).order('fecha'),
    supabase.rpc('tipo_dia', { p_fecha: hoy })
  ]);
  for (const r of [rT, rF, rD]) if (r.error) throw r.error;
  return {
    hoy,
    tipoDia: rD.data,
    tarifas: rT.data.map(t => ({ ...t, precio: Number(t.precio) })),
    festivos: rF.data
  };
}

exports.handler = async (event) => {
  const { error: errAuth } = await requerirUsuario(event, ['ADMIN']);
  if (errAuth) return errAuth;

  try {
    if (event.httpMethod === 'GET') return respuesta(200, await datos());
    if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
    const body = leerBody(event);

    if (body.accion === 'tarifa') {
      const nombre = texto(body.nombre, 80);
      const precio = Number(String(body.precio ?? '').replace(/\s|€/g, '').replace(',', '.'));
      if (!body.codigo) throw errorHttp(400, 'Falta la tarifa.');
      if (!nombre) throw errorHttp(400, 'El nombre no puede quedar vacío.');
      if (String(body.precio ?? '').trim() === '' || !isFinite(precio) || precio < 0 || precio > 1000) {
        throw errorHttp(400, 'El precio no es válido. Usa números y coma, por ejemplo 3,50.');
      }
      const { data, error } = await supabase.from('tarifas')
        .update({ nombre, precio: Math.round(precio * 100) / 100, updated_at: new Date().toISOString() })
        .eq('codigo', body.codigo).select('codigo');
      if (error) throw error;
      if (!data.length) throw errorHttp(404, 'Esa tarifa no existe.');
      return respuesta(200, await datos());
    }

    if (body.accion === 'festivo') {
      const descripcion = texto(body.descripcion, 80);
      if (!fechaReal(body.fecha)) throw errorHttp(400, 'Elige una fecha válida.');
      if (!descripcion) throw errorHttp(400, 'Escribe qué fiesta es.');
      const { error } = await supabase.from('festivos')
        .upsert({ fecha: body.fecha, descripcion }, { onConflict: 'fecha' });
      if (error) throw error;
      return respuesta(200, await datos());
    }

    if (body.accion === 'quitar_festivo') {
      if (!fechaReal(body.fecha)) throw errorHttp(400, 'Fecha no válida.');
      const { error } = await supabase.from('festivos').delete().eq('fecha', body.fecha);
      if (error) throw error;
      return respuesta(200, await datos());
    }

    throw errorHttp(400, 'Acción desconocida.');
  } catch (e) {
    return responderError(e, 'config');
  }
};
