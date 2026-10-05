// /.netlify/functions/caja
// GET  ?fecha=YYYY-MM-DD   → resumen de caja de ese día (monitora: solo hoy)
// GET  ?historial=1        → últimos 45 días con totales y estado del cierre (solo ADMIN)
// POST { fecha, efectivo_contado, fondo_caja, tarjeta_datafono, observaciones } → cierra (o vuelve a cerrar) la caja
const {
  supabase, respuesta, leerBody, requerirUsuario, hoyMadrid, fechaValida, texto, errorHttp, responderError
} = require('./_lib');

const r2 = n => Math.round(Number(n || 0) * 100) / 100;

// '12,50' / '12.5' / '12 €' → 12.5 ; vacío → null
function importe(valor, nombre, obligatorio) {
  const s = String(valor ?? '').replace(/\s|€/g, '').replace(',', '.');
  if (!s) {
    if (obligatorio) throw errorHttp(400, `Escribe ${nombre}.`);
    return null;
  }
  const n = Number(s);
  if (!isFinite(n) || n < 0 || n > 100000) throw errorHttp(400, `El importe de ${nombre} no es válido.`);
  return r2(n);
}

async function resumenDia(fecha) {
  const [rT, rTar, rC] = await Promise.all([
    supabase.from('tickets')
      .select('id, total, metodo_pago, anulado, ticket_lineas ( nino_id, tarifa_codigo, descripcion, precio )')
      .eq('fecha', fecha),
    supabase.from('tarifas').select('codigo, nombre, tipo, orden'),
    supabase.from('cierres_caja').select('*, usuarios ( nombre )').eq('fecha', fecha).maybeSingle()
  ]);
  for (const r of [rT, rTar, rC]) if (r.error) throw r.error;

  const tarifas = new Map(rTar.data.map(t => [t.codigo, t]));
  const validos = rT.data.filter(t => !t.anulado);
  const anulados = rT.data.filter(t => t.anulado);
  const suma = (lista, f) => r2(lista.reduce((s, x) => s + Number(f(x)), 0));

  const efectivo = suma(validos.filter(t => t.metodo_pago === 'EFECTIVO'), t => t.total);
  const tarjeta = suma(validos.filter(t => t.metodo_pago === 'TARJETA'), t => t.total);

  // Desglose por concepto
  const grupos = new Map();
  let entradas = 0;
  const ninos = new Set();
  for (const t of validos) {
    for (const l of t.ticket_lineas) {
      const tarifa = tarifas.get(l.tarifa_codigo);
      const g = grupos.get(l.tarifa_codigo) || {
        codigo: l.tarifa_codigo, nombre: tarifa?.nombre || l.descripcion, orden: tarifa?.orden ?? 99,
        cantidad: 0, importe: 0, efectivo: 0, tarjeta: 0
      };
      g.cantidad++;
      g.importe = r2(g.importe + Number(l.precio));
      if (t.metodo_pago === 'EFECTIVO') g.efectivo = r2(g.efectivo + Number(l.precio));
      if (t.metodo_pago === 'TARJETA') g.tarjeta = r2(g.tarjeta + Number(l.precio));
      grupos.set(l.tarifa_codigo, g);
      if (tarifa?.tipo === 'ENTRADA') { entradas++; if (l.nino_id) ninos.add(l.nino_id); }
    }
  }

  let cierre = null;
  if (rC.data) {
    const { usuarios, ...c } = rC.data;
    cierre = { ...c, usuario: usuarios?.nombre || null };
    for (const k of ['total_efectivo', 'total_tarjeta', 'total', 'efectivo_contado', 'diferencia',
                     'fondo_caja', 'tarjeta_datafono', 'diferencia_tarjeta']) {
      if (cierre[k] !== null && cierre[k] !== undefined) cierre[k] = Number(cierre[k]);
    }
  }

  return {
    fecha,
    efectivo, tarjeta, total: r2(efectivo + tarjeta),
    num_tickets: validos.length,
    entradas, ninos: ninos.size,
    anulados: anulados.length, importe_anulado: suma(anulados, t => t.total),
    desglose: [...grupos.values()].sort((a, b) => a.orden - b.orden),
    cierre,
    // Si tras cerrar se cobró o anuló algo, los totales ya no coinciden
    cambios_desde_cierre: !!cierre && (r2(cierre.total_efectivo) !== efectivo || r2(cierre.total_tarjeta) !== tarjeta)
  };
}

async function historial() {
  const d = new Date(hoyMadrid() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 45);
  const desde = d.toISOString().slice(0, 10);
  const [rV, rC] = await Promise.all([
    supabase.from('vw_caja_diaria').select('*').gte('fecha', desde),
    supabase.from('cierres_caja').select('fecha, diferencia, diferencia_tarjeta').gte('fecha', desde)
  ]);
  for (const r of [rV, rC]) if (r.error) throw r.error;
  const cierres = new Map(rC.data.map(c => [c.fecha, c]));
  const fechas = new Set([...rV.data.map(v => v.fecha), ...rC.data.map(c => c.fecha)]);
  return [...fechas].sort().reverse().map(f => {
    const v = rV.data.find(x => x.fecha === f) || {};
    const c = cierres.get(f);
    return {
      fecha: f,
      efectivo: r2(v.total_efectivo), tarjeta: r2(v.total_tarjeta), total: r2(v.total),
      cerrada: !!c,
      diferencia: c?.diferencia !== null && c?.diferencia !== undefined ? Number(c.diferencia) : null,
      diferencia_tarjeta: c?.diferencia_tarjeta !== null && c?.diferencia_tarjeta !== undefined ? Number(c.diferencia_tarjeta) : null
    };
  });
}

exports.handler = async (event) => {
  const { usuario, error: errAuth } = await requerirUsuario(event);
  if (errAuth) return errAuth;
  const esAdmin = usuario.rol === 'ADMIN';
  const hoy = hoyMadrid();

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      if (q.historial) {
        if (!esAdmin) throw errorHttp(403, 'Solo el administrador puede ver el historial.');
        return respuesta(200, { dias: await historial() });
      }
      const fecha = q.fecha || hoy;
      if (!fechaValida(fecha)) throw errorHttp(400, 'Fecha no válida.');
      if (fecha !== hoy && !esAdmin) throw errorHttp(403, 'Solo puedes ver la caja de hoy.');
      return respuesta(200, await resumenDia(fecha));
    }

    if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
    const body = leerBody(event);
    const fecha = body.fecha || hoy;
    if (!fechaValida(fecha)) throw errorHttp(400, 'Fecha no válida.');
    if (fecha !== hoy && !esAdmin) throw errorHttp(403, 'Solo puedes cerrar la caja de hoy.');

    const contado = importe(body.efectivo_contado, 'el efectivo contado', true);
    const fondo = importe(body.fondo_caja, 'el fondo de cambio', false) ?? 0;
    const datafono = importe(body.tarjeta_datafono, 'el datáfono', false);

    const res = await resumenDia(fecha);
    const fila = {
      fecha,
      total_efectivo: res.efectivo,
      total_tarjeta: res.tarjeta,
      total: res.total,
      fondo_caja: fondo,
      efectivo_contado: contado,
      diferencia: r2(contado - fondo - res.efectivo),
      tarjeta_datafono: datafono,
      diferencia_tarjeta: datafono === null ? null : r2(datafono - res.tarjeta),
      num_entradas: res.entradas,
      observaciones: texto(body.observaciones, 300),
      usuario_id: usuario.id
    };
    if (res.cierre) fila.actualizado_at = new Date().toISOString();

    const { error } = await supabase.from('cierres_caja').upsert(fila, { onConflict: 'fecha' });
    if (error) throw error;
    return respuesta(200, await resumenDia(fecha));
  } catch (e) {
    return responderError(e, 'caja');
  }
};
