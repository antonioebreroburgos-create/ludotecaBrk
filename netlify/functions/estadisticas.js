// /.netlify/functions/estadisticas   (solo ADMIN)
// GET ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD → visitas, niños, ingresos, días de la semana, edades y niños que más vienen
const {
  supabase, respuesta, requerirUsuario, hoyMadrid, errorHttp, responderError
} = require('./_lib');

function fechaReal(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s && s >= '2020-01-01';
}

exports.handler = async (event) => {
  const { error: errAuth } = await requerirUsuario(event, ['ADMIN']);
  if (errAuth) return errAuth;

  try {
    if (event.httpMethod !== 'GET') return respuesta(405, { error: 'Método no permitido' });
    const q = event.queryStringParameters || {};
    const hoy = hoyMadrid();
    const hasta = fechaReal(q.hasta) ? q.hasta : hoy;
    const desde = fechaReal(q.desde) ? q.desde : hasta.slice(0, 8) + '01';
    if (hasta < desde) throw errorHttp(400, 'La fecha final es anterior a la inicial.');
    const dias = (new Date(hasta) - new Date(desde)) / 86400000;
    if (dias > 731) throw errorHttp(400, 'Elige como mucho dos años.');

    const { data, error } = await supabase.rpc('estadisticas', { p_desde: desde, p_hasta: hasta });
    if (error) throw error;

    const n = v => Number(v || 0);
    return respuesta(200, {
      ...data,
      hoy,
      efectivo: n(data.efectivo),
      tarjeta: n(data.tarjeta),
      total: Math.round((n(data.efectivo) + n(data.tarjeta)) * 100) / 100,
      por_tarifa: (data.por_tarifa || []).map(t => ({ ...t, importe: n(t.importe) }))
    });
  } catch (e) {
    return responderError(e, 'estadisticas');
  }
};
