// /.netlify/functions/config   (solo ADMIN)
// GET                                         → tarifas, festivos (desde hace 60 días) y tipo de día de hoy
// POST { accion:'tarifa', codigo, nombre, precio }   → cambia nombre y/o precio de una tarifa
// POST { accion:'festivo', fecha, descripcion }      → añade (o renombra) un festivo
// POST { accion:'quitar_festivo', fecha }            → quita un festivo
// POST { accion:'fondo', fondo }                     → cambia el fondo de cambio fijo de la caja
// POST { accion:'nueva_tarifa', nombre, precio }     → crea otra entrada para elegir al cobrar (invitación, media entrada...)
//      (en 'tarifa' también se puede mandar activo: true/false, solo para las que no son de las 6 de siempre)
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
  const [rT, rF, rD, rA] = await Promise.all([
    supabase.from('tarifas').select('codigo, nombre, tipo, precio, orden, base, activo, updated_at').order('orden').order('nombre'),
    supabase.from('festivos').select('fecha, descripcion').gte('fecha', d.toISOString().slice(0, 10)).order('fecha'),
    supabase.rpc('tipo_dia', { p_fecha: hoy }),
    supabase.from('ajustes').select('valor').eq('clave', 'fondo_caja').maybeSingle()
  ]);
  for (const r of [rT, rF, rD, rA]) if (r.error) throw r.error;
  return {
    hoy,
    tipoDia: rD.data,
    fondo: Number(rA.data?.valor ?? 30),
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

    if (body.accion === 'tarifa' || body.accion === 'nueva_tarifa') {
      const nombre = texto(body.nombre, 80);
      const precio = Number(String(body.precio ?? '').replace(/\s|€/g, '').replace(',', '.'));
      if (!nombre) throw errorHttp(400, 'El nombre no puede quedar vacío.');
      if (String(body.precio ?? '').trim() === '' || !isFinite(precio) || precio < 0 || precio > 1000) {
        throw errorHttp(400, 'El precio no es válido. Usa números y coma, por ejemplo 3,50.');
      }
      const precioOk = Math.round(precio * 100) / 100;

      if (body.accion === 'nueva_tarifa') {
        const codigo = 'EXTRA_' + require('crypto').randomBytes(3).toString('hex').toUpperCase();
        const { error } = await supabase.from('tarifas').insert({
          codigo, nombre, tipo: 'ENTRADA', precio: precioOk, orden: 20, base: false, activo: true
        });
        if (error) throw error;
        return respuesta(200, await datos());
      }

      if (!body.codigo) throw errorHttp(400, 'Falta la tarifa.');
      const { data: actual } = await supabase.from('tarifas').select('codigo, base').eq('codigo', body.codigo).maybeSingle();
      if (!actual) throw errorHttp(404, 'Esa tarifa no existe.');
      const cambios = { nombre, precio: precioOk, updated_at: new Date().toISOString() };
      if (body.activo !== undefined) {
        if (actual.base && !body.activo) throw errorHttp(400, 'Las tarifas de siempre no se pueden desactivar.');
        if (!actual.base) cambios.activo = !!body.activo;
      }
      const { error } = await supabase.from('tarifas').update(cambios).eq('codigo', body.codigo);
      if (error) throw error;
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

    if (body.accion === 'fondo') {
      const n = Number(String(body.fondo ?? '').replace(/\s|€/g, '').replace(',', '.'));
      if (String(body.fondo ?? '').trim() === '' || !isFinite(n) || n < 0 || n > 10000) {
        throw errorHttp(400, 'El fondo no es válido. Usa números y coma, por ejemplo 30,00.');
      }
      const { error } = await supabase.from('ajustes').upsert(
        { clave: 'fondo_caja', valor: (Math.round(n * 100) / 100).toFixed(2), updated_at: new Date().toISOString() },
        { onConflict: 'clave' });
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
