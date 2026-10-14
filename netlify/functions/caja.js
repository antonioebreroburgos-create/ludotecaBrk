// /.netlify/functions/caja
// GET  ?fecha=YYYY-MM-DD   → caja de ese día: totales, desglose con nombres, tickets, cierre e historial (monitora: solo hoy)
// GET  ?historial=1        → últimos 45 días con totales y estado del cierre (solo ADMIN)
// POST { accion:'cerrar', fecha, efectivo_contado, tarjeta_datafono, observaciones }
//        → cierra la caja con el fondo fijo. Una vez cerrada queda bloqueada.
// POST { accion:'corregir', fecha, efectivo_contado, tarjeta_datafono, fondo_caja, observaciones, motivo }  (solo ADMIN)
// POST { accion:'reabrir', fecha, motivo }                                                                (solo ADMIN)
// Cada cierre, corrección y reapertura queda en caja_auditoria.
const {
  supabase, respuesta, leerBody, requerirUsuario, hoyMadrid, fechaValida, texto, errorHttp, responderError
} = require('./_lib');

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const FONDO_POR_DEFECTO = 30;

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

async function fondoFijo() {
  const { data, error } = await supabase.from('ajustes').select('valor').eq('clave', 'fondo_caja').maybeSingle();
  if (error) throw error;
  const n = Number(data?.valor);
  return isFinite(n) && n >= 0 ? r2(n) : FONDO_POR_DEFECTO;
}

const SELECT_TICKET = `
  id, numero, fecha, creado_at, total, metodo_pago, anulado, anulado_motivo, enviado_whatsapp,
  tutores ( id, nombre, apellidos, telefono, consentimiento_marketing ),
  usuarios ( nombre ),
  ticket_lineas ( id, nino_id, descripcion, precio, tarifa_codigo, ninos ( id, nombre, apellidos, numero_pulsera ) ),
  membresias ( fecha_alta, fecha_caducidad, activo )
`;

// Mismo formato que entradas.js, para poder abrir el ticket desde la caja
function formatoTicket(t, cajaCerrada) {
  return {
    id: t.id, numero: t.numero, fecha: t.fecha, creado_at: t.creado_at,
    total: Number(t.total), metodo_pago: t.metodo_pago,
    anulado: t.anulado, anulado_motivo: t.anulado_motivo, enviado_whatsapp: t.enviado_whatsapp,
    tutor: t.tutores, usuario: t.usuarios?.nombre || null,
    socio_desde: t.membresias?.[0]?.fecha_alta || null,
    socio_hasta: t.membresias?.[0]?.fecha_caducidad || null,
    caja_cerrada: cajaCerrada,
    lineas: (t.ticket_lineas || [])
      .sort((a, b) => a.id - b.id)
      .map(l => ({ descripcion: l.descripcion, precio: Number(l.precio), tarifa_codigo: l.tarifa_codigo, nino: l.ninos }))
  };
}

function numerosCierre(c) {
  if (!c) return null;
  const out = { ...c };
  for (const k of ['total_efectivo', 'total_tarjeta', 'total', 'efectivo_contado', 'diferencia',
                   'fondo_caja', 'tarjeta_datafono', 'diferencia_tarjeta']) {
    if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  }
  return out;
}

async function resumenDia(fecha) {
  const [rT, rTar, rC, rA, fondo] = await Promise.all([
    supabase.from('tickets').select(SELECT_TICKET).eq('fecha', fecha).order('creado_at', { ascending: false }),
    supabase.from('tarifas').select('codigo, nombre, tipo, orden'),
    supabase.from('cierres_caja').select('*, usuarios ( nombre )').eq('fecha', fecha).maybeSingle(),
    supabase.from('caja_auditoria').select('id, accion, motivo, antes, despues, created_at, usuarios ( nombre )')
      .eq('fecha', fecha).order('created_at', { ascending: true }),
    fondoFijo()
  ]);
  for (const r of [rT, rTar, rC, rA]) if (r.error) throw r.error;

  const tarifas = new Map(rTar.data.map(t => [t.codigo, t]));
  const validos = rT.data.filter(t => !t.anulado);
  const anulados = rT.data.filter(t => t.anulado);
  const suma = (lista, f) => r2(lista.reduce((s, x) => s + Number(f(x)), 0));

  const efectivo = suma(validos.filter(t => t.metodo_pago === 'EFECTIVO'), t => t.total);
  const tarjeta = suma(validos.filter(t => t.metodo_pago === 'TARJETA'), t => t.total);

  // Desglose por concepto, con el nombre de cada niño
  const grupos = new Map();
  let entradas = 0;
  const ninos = new Set();
  for (const t of [...validos].reverse()) {           // en orden de llegada
    for (const l of t.ticket_lineas) {
      const tarifa = tarifas.get(l.tarifa_codigo);
      const g = grupos.get(l.tarifa_codigo) || {
        codigo: l.tarifa_codigo, nombre: tarifa?.nombre || l.descripcion, orden: tarifa?.orden ?? 99,
        cantidad: 0, importe: 0, efectivo: 0, tarjeta: 0, sin_coste: 0, detalle: []
      };
      g.cantidad++;
      g.importe = r2(g.importe + Number(l.precio));
      if (t.metodo_pago === 'EFECTIVO') g.efectivo = r2(g.efectivo + Number(l.precio));
      else if (t.metodo_pago === 'TARJETA') g.tarjeta = r2(g.tarjeta + Number(l.precio));
      else g.sin_coste++;
      g.detalle.push({
        nino: l.ninos ? `${l.ninos.nombre} ${l.ninos.apellidos || ''}`.trim() : '',
        hora: t.creado_at, metodo: t.metodo_pago, precio: Number(l.precio), ticket_id: t.id
      });
      grupos.set(l.tarifa_codigo, g);
      if (tarifa?.tipo === 'ENTRADA') { entradas++; if (l.nino_id) ninos.add(l.nino_id); }
    }
  }

  let cierre = null;
  if (rC.data) {
    const { usuarios, ...c } = rC.data;
    cierre = { ...numerosCierre(c), usuario: usuarios?.nombre || null };
  }

  return {
    fecha,
    fondo_fijo: fondo,
    efectivo, tarjeta, total: r2(efectivo + tarjeta),
    num_tickets: validos.length,
    entradas, ninos: ninos.size,
    anulados: anulados.length, importe_anulado: suma(anulados, t => t.total),
    desglose: [...grupos.values()].sort((a, b) => a.orden - b.orden),
    tickets: rT.data.map(t => formatoTicket(t, !!cierre)),
    cierre,
    // Por si quedaran tickets de antes de que existiera el bloqueo
    cambios_desde_cierre: !!cierre && (r2(cierre.total_efectivo) !== efectivo || r2(cierre.total_tarjeta) !== tarjeta),
    auditoria: rA.data.map(a => ({
      id: a.id, accion: a.accion, motivo: a.motivo, created_at: a.created_at,
      usuario: a.usuarios?.nombre || null,
      antes: numerosCierre(a.antes), despues: numerosCierre(a.despues)
    }))
  };
}

async function historial() {
  const d = new Date(hoyMadrid() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 45);
  const desde = d.toISOString().slice(0, 10);
  const [rV, rC, rA] = await Promise.all([
    supabase.from('vw_caja_diaria').select('*').gte('fecha', desde),
    supabase.from('cierres_caja').select('fecha, diferencia, diferencia_tarjeta').gte('fecha', desde),
    supabase.from('caja_auditoria').select('fecha').in('accion', ['CORRECCION', 'REAPERTURA']).gte('fecha', desde)
  ]);
  for (const r of [rV, rC, rA]) if (r.error) throw r.error;
  const cierres = new Map(rC.data.map(c => [c.fecha, c]));
  const retocados = new Set(rA.data.map(a => a.fecha));
  const fechas = new Set([...rV.data.map(v => v.fecha), ...rC.data.map(c => c.fecha)]);
  return [...fechas].sort().reverse().map(f => {
    const v = rV.data.find(x => x.fecha === f) || {};
    const c = cierres.get(f);
    return {
      fecha: f,
      efectivo: r2(v.total_efectivo), tarjeta: r2(v.total_tarjeta), total: r2(v.total),
      cerrada: !!c,
      retocada: retocados.has(f),
      diferencia: c?.diferencia !== null && c?.diferencia !== undefined ? Number(c.diferencia) : null,
      diferencia_tarjeta: c?.diferencia_tarjeta !== null && c?.diferencia_tarjeta !== undefined ? Number(c.diferencia_tarjeta) : null
    };
  });
}

// Lo que se guarda del cierre en el historial (sin ids ni fechas internas)
function foto(c) {
  if (!c) return null;
  const { usuario, usuarios, ...resto } = c;
  return {
    fondo_caja: resto.fondo_caja, total_efectivo: resto.total_efectivo, total_tarjeta: resto.total_tarjeta,
    efectivo_contado: resto.efectivo_contado, diferencia: resto.diferencia,
    tarjeta_datafono: resto.tarjeta_datafono, diferencia_tarjeta: resto.diferencia_tarjeta,
    observaciones: resto.observaciones
  };
}

async function registrar(fecha, accion, usuarioId, motivo, antes, despues) {
  const { error } = await supabase.from('caja_auditoria').insert({
    fecha, accion, usuario_id: usuarioId, motivo: motivo || null, antes: foto(antes), despues: foto(despues)
  });
  if (error) throw error;
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
    const accion = body.accion || 'cerrar';
    const fecha = body.fecha || hoy;
    if (!fechaValida(fecha)) throw errorHttp(400, 'Fecha no válida.');

    const res = await resumenDia(fecha);
    const actual = res.cierre;

    // ---------- Cerrar ----------
    if (accion === 'cerrar') {
      if (fecha !== hoy && !esAdmin) throw errorHttp(403, 'Solo puedes cerrar la caja de hoy.');
      if (actual) {
        throw errorHttp(409, esAdmin
          ? 'La caja ya está cerrada. Usa «Corregir cierre» o «Reabrir caja».'
          : 'La caja ya está cerrada. Si hay que cambiar algo, avisa al administrador.');
      }
      const contado = importe(body.efectivo_contado, 'el efectivo contado', true);
      const datafono = importe(body.tarjeta_datafono, 'el datáfono', false);
      const fondo = res.fondo_fijo;
      const fila = {
        fecha,
        total_efectivo: res.efectivo, total_tarjeta: res.tarjeta, total: res.total,
        fondo_caja: fondo,
        efectivo_contado: contado,
        diferencia: r2(contado - fondo - res.efectivo),
        tarjeta_datafono: datafono,
        diferencia_tarjeta: datafono === null ? null : r2(datafono - res.tarjeta),
        num_entradas: res.entradas,
        observaciones: texto(body.observaciones, 300),
        usuario_id: usuario.id,
        cerrado_at: new Date().toISOString(),
        actualizado_at: null
      };
      const { error } = await supabase.from('cierres_caja').insert(fila);
      if (error) {
        if (error.code === '23505') throw errorHttp(409, 'La caja ya está cerrada.');
        throw error;
      }
      await registrar(fecha, 'CIERRE', usuario.id, null, null, fila);
      return respuesta(200, await resumenDia(fecha));
    }

    // A partir de aquí, solo el administrador
    if (!esAdmin) throw errorHttp(403, 'Solo el administrador puede modificar una caja cerrada.');
    const motivo = texto(body.motivo, 300);
    if (!motivo || motivo.length < 3) throw errorHttp(400, 'Escribe el motivo. Quedará registrado.');
    if (!actual) throw errorHttp(400, 'Esta caja no está cerrada.');

    // ---------- Corregir el cierre ----------
    if (accion === 'corregir') {
      const contado = importe(body.efectivo_contado, 'el efectivo contado', true);
      const datafono = importe(body.tarjeta_datafono, 'el datáfono', false);
      const fondo = importe(body.fondo_caja, 'el fondo de cambio', false) ?? actual.fondo_caja ?? res.fondo_fijo;
      const cambios = {
        total_efectivo: res.efectivo, total_tarjeta: res.tarjeta, total: res.total,
        fondo_caja: fondo,
        efectivo_contado: contado,
        diferencia: r2(contado - fondo - res.efectivo),
        tarjeta_datafono: datafono,
        diferencia_tarjeta: datafono === null ? null : r2(datafono - res.tarjeta),
        num_entradas: res.entradas,
        observaciones: texto(body.observaciones, 300),
        actualizado_at: new Date().toISOString()
      };
      const { error } = await supabase.from('cierres_caja').update(cambios).eq('fecha', fecha);
      if (error) throw error;
      await registrar(fecha, 'CORRECCION', usuario.id, motivo, actual, { ...actual, ...cambios });
      return respuesta(200, await resumenDia(fecha));
    }

    // ---------- Reabrir ----------
    if (accion === 'reabrir') {
      const { error } = await supabase.from('cierres_caja').delete().eq('fecha', fecha);
      if (error) throw error;
      await registrar(fecha, 'REAPERTURA', usuario.id, motivo, actual, null);
      return respuesta(200, await resumenDia(fecha));
    }

    throw errorHttp(400, 'Acción desconocida.');
  } catch (e) {
    return responderError(e, 'caja');
  }
};
