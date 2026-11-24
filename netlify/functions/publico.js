// /.netlify/functions/publico   — SIN PIN: lo usa el cliente desde el enlace de WhatsApp
// GET  ?t=CODIGO                                → qué enlace es y si sigue valiendo (+ datos de la fiesta)
// POST { t, accion:'registro', tutor, ninos }   → la familia se da de alta y queda en "Llegadas" para cobrar
//      (enlace personal de WhatsApp: un solo uso; QR del cartel o de la pantalla: varias familias, con límites)
// POST { t, accion:'invitados', invitados }     → el organizador guarda la lista de niños de la fiesta
// Solo funciona con un código válido, que crea el personal desde la app.
const {
  supabase, respuesta, leerBody, normalizarTelefono, fechaValida, texto, errorHttp, responderError, ipCliente
} = require('./_lib');
const { leerEnlace } = require('./_enlaces');

const MAX_NINOS = 8;
const MAX_INVITADOS = 60;
const TIPOS_ALTA = ['REGISTRO', 'CARTEL', 'PANTALLA'];
// Límites de las altas con QR (se pueden usar por varias familias)
const LIMITES = {
  CARTEL:   { porMovilHora: 3, porDia: 40 },
  PANTALLA: { porMovilHora: 3, total: 6 }
};

async function comprobarLimites(enlace, ip) {
  const lim = LIMITES[enlace.tipo];
  if (!lim) return;
  const haceUnaHora = new Date(Date.now() - 3600e3).toISOString();
  const { count: deEsteMovil } = await supabase.from('altas_publicas').select('id', { count: 'exact', head: true })
    .eq('ip', ip).gte('created_at', haceUnaHora);
  if (deEsteMovil >= lim.porMovilHora) {
    throw errorHttp(429, 'Se han hecho varias altas seguidas desde este móvil. Pide ayuda al personal del restaurante.');
  }
  let q = supabase.from('altas_publicas').select('id', { count: 'exact', head: true }).eq('enlace_id', enlace.id);
  if (lim.porDia) q = q.gte('created_at', new Date(Date.now() - 24 * 3600e3).toISOString());
  const { count: delEnlace } = await q;
  if (delEnlace >= (lim.porDia || lim.total)) {
    throw errorHttp(429, 'Ahora mismo no se pueden hacer más altas con este código. Pide ayuda al personal del restaurante.');
  }
}
const MENSAJES_ESTADO = {
  USADO: 'Este enlace ya se ha usado. Si necesitas cambiar algo, díselo al personal del restaurante.',
  CADUCADO: 'Este enlace ha caducado. Pide uno nuevo al personal del restaurante (o que te enseñe otra vez el código QR).',
  ANULADO: 'Este enlace ya no está activo. Pide uno nuevo al personal del restaurante.'
};

async function datosFiesta(fiestaId) {
  const [rF, rI] = await Promise.all([
    supabase.from('fiestas').select('id, fecha, hora, cumpleanero, organizador_nombre, ninos_previstos, anulada').eq('id', fiestaId).maybeSingle(),
    supabase.from('fiesta_invitados').select('id, nombre, edad, avisos, es_cumpleanero').eq('fiesta_id', fiestaId).order('orden').order('id')
  ]);
  for (const r of [rF, rI]) if (r.error) throw r.error;
  if (!rF.data || rF.data.anulada) throw errorHttp(404, 'Esta fiesta ya no está activa. Habla con el restaurante.');
  return { ...rF.data, invitados: rI.data };
}

// ---------- Alta de la familia ----------
async function registro(enlace, body, ip) {
  // Campo trampa invisible: solo lo rellenan los programas automáticos
  if (body.web) return { ok: true, ninos: [] };
  const unSoloUso = enlace.tipo === 'REGISTRO';
  if (!unSoloUso) await comprobarLimites(enlace, ip);
  const t = body.tutor || {};
  const nombre = texto(t.nombre);
  const telefono = normalizarTelefono(t.telefono);
  if (!nombre) throw errorHttp(400, 'Escribe tu nombre.');
  if (!telefono) throw errorHttp(400, 'El teléfono no es válido. Escribe los 9 números.');
  if (t.fecha_nacimiento && !fechaValida(t.fecha_nacimiento)) throw errorHttp(400, 'Tu fecha de nacimiento no es válida.');
  if (!t.consentimiento_servicio) throw errorHttp(400, 'Para registraros hay que aceptar el uso de los datos para la ludoteca.');

  const lista = Array.isArray(body.ninos) ? body.ninos : [];
  if (!lista.length) throw errorHttp(400, 'Añade al menos un niño.');
  if (lista.length > MAX_NINOS) throw errorHttp(400, `Como máximo ${MAX_NINOS} niños por registro.`);
  const ninos = lista.map((n, i) => {
    const et = lista.length > 1 ? ` (niño ${i + 1})` : '';
    const nn = texto(n.nombre);
    if (!nn) throw errorHttp(400, `Falta el nombre${et}.`);
    if (!fechaValida(n.fecha_nacimiento)) throw errorHttp(400, `La fecha de nacimiento no es válida${et}.`);
    return { nombre: nn, apellidos: texto(n.apellidos), fecha_nacimiento: n.fecha_nacimiento, observaciones: texto(n.observaciones, 300) };
  });

  // Enlace personal: se reserva (un solo uso) antes de guardar nada
  if (unSoloUso) {
    const { data: reservado, error: eR } = await supabase.from('enlaces')
      .update({ usado_at: new Date().toISOString() }).eq('id', enlace.id).is('usado_at', null).select('id');
    if (eR) throw eR;
    if (!reservado.length) throw errorHttp(409, MENSAJES_ESTADO.USADO);
  }

  try {
    const ahora = new Date().toISOString();
    const marketing = !!t.consentimiento_marketing;

    // Adulto: si el teléfono ya estaba, se usa ese registro (sin mostrar ni cambiar sus datos)
    let tutorId;
    const { data: existe } = await supabase.from('tutores')
      .select('id, consentimiento_marketing').eq('telefono', telefono).maybeSingle();
    if (existe) {
      tutorId = existe.id;
      if (marketing && !existe.consentimiento_marketing) {
        await supabase.from('tutores').update({ consentimiento_marketing: true, consentimiento_marketing_at: ahora }).eq('id', tutorId);
      }
    } else {
      const { data, error } = await supabase.from('tutores').insert({
        nombre, apellidos: texto(t.apellidos), telefono,
        email: texto(t.email, 120), fecha_nacimiento: t.fecha_nacimiento || null,
        consentimiento_servicio: true, consentimiento_servicio_at: ahora,
        consentimiento_marketing: marketing, consentimiento_marketing_at: marketing ? ahora : null
      }).select('id').single();
      if (error) throw error;
      tutorId = data.id;
    }

    // Niños: si ya estaban en esta familia (mismo nombre y fecha), se reutilizan
    const { data: suyos } = await supabase.from('nino_tutor')
      .select('ninos(id, nombre, fecha_nacimiento)').eq('tutor_id', tutorId);
    const clave = (n, f) => `${String(n).trim().toLowerCase()}|${f}`;
    const yaEstan = new Map((suyos || []).filter(x => x.ninos).map(x => [clave(x.ninos.nombre, x.ninos.fecha_nacimiento), x.ninos.id]));

    const ids = [];
    const nuevos = [];
    for (const n of ninos) {
      const id = yaEstan.get(clave(n.nombre, n.fecha_nacimiento));
      if (id) ids.push(id); else nuevos.push(n);
    }
    if (nuevos.length) {
      const { data: creados, error } = await supabase.from('ninos').insert(nuevos).select('id');
      if (error) throw error;
      const nuevosIds = creados.map(c => c.id);
      const { error: e2 } = await supabase.from('nino_tutor').insert(nuevosIds.map(id => ({
        nino_id: id, tutor_id: tutorId, parentesco: texto(t.parentesco, 30), principal: true
      })));
      if (e2) throw e2;
      ids.push(...nuevosIds);
    }

    // Queda en "Llegadas" para que el personal cobre
    const origen = unSoloUso ? 'ENLACE' : enlace.tipo;
    const { error: eL } = await supabase.from('llegadas').insert({ tutor_id: tutorId, nino_ids: ids, enlace_id: enlace.id, origen });
    if (eL) throw eL;
    if (!unSoloUso) await supabase.from('altas_publicas').insert({ enlace_id: enlace.id, ip });

    return { ok: true, ninos: ninos.map(n => n.nombre) };
  } catch (e) {
    // Si algo falla, el enlace personal vuelve a quedar libre para intentarlo otra vez
    if (unSoloUso) await supabase.from('enlaces').update({ usado_at: null }).eq('id', enlace.id);
    throw e;
  }
}

// ---------- Lista de invitados de una fiesta ----------
async function invitados(enlace, body) {
  const fiesta = await datosFiesta(enlace.fiesta_id);
  const lista = Array.isArray(body.invitados) ? body.invitados : [];
  if (lista.length > MAX_INVITADOS) throw errorHttp(400, `Como máximo ${MAX_INVITADOS} niños.`);

  const filas = lista.map((n, i) => {
    const nombre = texto(n.nombre);
    if (!nombre) throw errorHttp(400, `Falta el nombre del niño ${i + 1}.`);
    let edad = null;
    if (n.edad !== '' && n.edad !== null && n.edad !== undefined) {
      edad = Number(n.edad);
      if (!Number.isInteger(edad) || edad < 0 || edad > 17) throw errorHttp(400, `La edad de ${nombre} no es válida.`);
    }
    return { id: Number(n.id) || null, nombre, edad, avisos: texto(n.avisos, 200), es_cumpleanero: !!n.es_cumpleanero, orden: i };
  });

  // Se actualizan los que ya estaban (para no perder si han llegado), se añaden los nuevos y se quitan los borrados
  const actuales = new Set(fiesta.invitados.map(i => i.id));
  const mantener = filas.filter(f => f.id && actuales.has(f.id));
  const quitar = [...actuales].filter(id => !mantener.some(m => m.id === id));
  if (quitar.length) {
    const { error } = await supabase.from('fiesta_invitados').delete().in('id', quitar).eq('fiesta_id', fiesta.id);
    if (error) throw error;
  }
  for (const f of mantener) {
    const { id, ...resto } = f;
    const { error } = await supabase.from('fiesta_invitados').update(resto).eq('id', id).eq('fiesta_id', fiesta.id);
    if (error) throw error;
  }
  const nuevos = filas.filter(f => !(f.id && actuales.has(f.id))).map(({ id, ...resto }) => ({ ...resto, fiesta_id: fiesta.id }));
  if (nuevos.length) {
    const { error } = await supabase.from('fiesta_invitados').insert(nuevos);
    if (error) throw error;
  }
  return { ok: true, fiesta: await datosFiesta(fiesta.id) };
}

exports.handler = async (event) => {
  try {
    const token = event.httpMethod === 'GET' ? event.queryStringParameters?.t : leerBody(event).t;
    const { enlace, estado } = await leerEnlace(token);

    if (event.httpMethod === 'GET') {
      const esAlta = TIPOS_ALTA.includes(enlace.tipo);
      const base = { tipo: esAlta ? 'REGISTRO' : enlace.tipo, origen: enlace.tipo, estado, mensaje: MENSAJES_ESTADO[estado] || null };
      if (estado !== 'OK') return respuesta(200, base);
      if (esAlta) return respuesta(200, { ...base, telefono: enlace.telefono });
      return respuesta(200, { ...base, fiesta: await datosFiesta(enlace.fiesta_id) });
    }

    if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
    if (estado !== 'OK') throw errorHttp(410, MENSAJES_ESTADO[estado]);
    const body = leerBody(event);

    if (body.accion === 'registro' && TIPOS_ALTA.includes(enlace.tipo)) return respuesta(200, await registro(enlace, body, ipCliente(event)));
    if (body.accion === 'invitados' && enlace.tipo === 'FIESTA') return respuesta(200, await invitados(enlace, body));
    throw errorHttp(400, 'Acción no válida para este enlace.');
  } catch (e) {
    return responderError(e, 'publico');
  }
};
