// /.netlify/functions/publico   — SIN PIN: lo usa el cliente desde el enlace de WhatsApp
// GET  ?t=CODIGO                                → qué enlace es y si sigue valiendo (+ datos de la fiesta)
// POST { t, accion:'registro', tutor, ninos }   → la familia se da de alta y queda en "Llegadas" para cobrar
//      (enlace personal de WhatsApp: un solo uso; QR del cartel o de la pantalla: varias familias, con límites)
//      ninos[].acompanado = true → no es su hijo: lo representa solo esa visita (no se vincula al adulto).
//      Si hay alguno, los apellidos del adulto son obligatorios. Si el niño ya es cliente, se usa su ficha.
// POST { t, accion:'buscar_nino', nombre, apellidos?, fecha_nacimiento } → ¿ese niño ya es cliente? (solo sí/no)
// POST { t, accion:'invitados', invitados, organizador_apellidos } → el organizador guarda la lista de la fiesta
//      invitados[].relacion = 'HIJO' | 'REPRESENTADO'; invitados[].fecha_nacimiento (opcional) enlaza con su ficha
// Autocheck-in (solo con el QR del cartel o de la pantalla, es decir, estando en el restaurante):
// POST { t, accion:'identificar', telefono, fecha_nino } → cliente habitual: teléfono + fecha de nacimiento de un hijo
// POST { t, accion:'familia', dispositivo }             → móvil recordado: quién es y qué niños tiene
// POST { t, accion:'checkin', dispositivo, nino_ids, acompanados?, apellidos? } → "ya estamos aquí": entra en Llegadas
//      acompanados: niños que no son suyos y trae hoy (nombre, apellidos, fecha_nacimiento, observaciones)
// POST { accion:'olvidar', dispositivo }                → este móvil deja de estar recordado
// Solo funciona con un código válido, que crea el personal desde la app.
const crypto = require('crypto');
const {
  supabase, respuesta, leerBody, normalizarTelefono, fechaValida, texto, errorHttp, responderError, ipCliente, hoyMadrid
} = require('./_lib');
const { leerEnlace, hashToken } = require('./_enlaces');

const MAX_NINOS = 8;
const MAX_INVITADOS = 60;
const TIPOS_ALTA = ['REGISTRO', 'CARTEL', 'PANTALLA'];
const TIPOS_CHECKIN = ['CARTEL', 'PANTALLA'];      // el QR prueba que el cliente está en el restaurante
const DIAS_MOVIL_RECORDADO = 365;
const MAX_FALLOS_IDENTIFICAR = 5;                  // por móvil cada 15 minutos
const MAX_BUSQUEDAS_NINO = 20;                     // por móvil cada 15 minutos
const MENSAJE_APELLIDOS = 'Si traes a niños que no son tuyos, escribe tu nombre y tus apellidos.';
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
    supabase.from('fiestas').select('id, fecha, hora, cumpleanero, organizador_nombre, organizador_apellidos, ninos_previstos, anulada').eq('id', fiestaId).maybeSingle(),
    supabase.from('fiesta_invitados').select('id, nombre, edad, avisos, es_cumpleanero, relacion, nino_id').eq('fiesta_id', fiestaId).order('orden').order('id')
  ]);
  for (const r of [rF, rI]) if (r.error) throw r.error;
  if (!rF.data || rF.data.anulada) throw errorHttp(404, 'Esta fiesta ya no está activa. Habla con el restaurante.');
  // Al organizador solo se le dice si el invitado está enlazado con una ficha, nunca el id ni sus datos
  const invitados = rI.data.map(({ nino_id, ...i }) => ({ ...i, cliente: !!nino_id }));
  return { ...rF.data, invitados };
}

// ---------- Móvil recordado de una familia ----------
async function crearDispositivo(tutorId) {
  const token = crypto.randomBytes(24).toString('base64url');
  const { error } = await supabase.from('dispositivos_familia').insert({ token_hash: hashToken(token), tutor_id: tutorId });
  if (error) throw error;
  return token;
}
// Devuelve el tutor_id si el código del móvil es válido, o null
async function leerDispositivo(token) {
  if (!/^[A-Za-z0-9_-]{30,40}$/.test(String(token || ''))) return null;
  const { data } = await supabase.from('dispositivos_familia')
    .select('id, tutor_id, created_at, anulado').eq('token_hash', hashToken(token)).maybeSingle();
  if (!data || data.anulado) return null;
  if (new Date(data.created_at) < new Date(Date.now() - DIAS_MOVIL_RECORDADO * 86400e3)) return null;
  await supabase.from('dispositivos_familia').update({ ultimo_uso: new Date().toISOString() }).eq('id', data.id);
  return data.tutor_id;
}
// Solo lo justo para saludar y elegir niños: nombres de pila
async function familiaDe(tutorId) {
  const [rT, rN] = await Promise.all([
    supabase.from('tutores').select('nombre, apellidos').eq('id', tutorId).maybeSingle(),
    supabase.from('nino_tutor').select('ninos(id, nombre, activo)').eq('tutor_id', tutorId)
  ]);
  for (const r of [rT, rN]) if (r.error) throw r.error;
  if (!rT.data) return null;
  const ninos = (rN.data || []).map(x => x.ninos).filter(n => n && n.activo)
    .map(n => ({ id: n.id, nombre: n.nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return { nombre: rT.data.nombre, apellidos_ok: (rT.data.apellidos || '').trim().length >= 2, ninos };
}

// ---------- Niños que no son suyos (representados en esta visita) ----------
async function limiteBusquedas(ip) {
  const hace15 = new Date(Date.now() - 15 * 60e3).toISOString();
  const { count } = await supabase.from('identificacion_intentos').select('id', { count: 'exact', head: true })
    .eq('ip', ip).eq('tipo', 'BUSCAR').gte('created_at', hace15);
  if (count >= MAX_BUSQUEDAS_NINO) {
    throw errorHttp(429, 'Demasiadas búsquedas seguidas. Espera unos minutos o pide ayuda al personal del restaurante.');
  }
}
async function ninoExacto(nombre, apellidos, fecha) {
  const { data, error } = await supabase.rpc('buscar_nino_exacto', { p_nombre: nombre, p_apellidos: apellidos || null, p_fecha: fecha });
  if (error) throw error;
  return data || null;
}
// ¿Ese niño ya es cliente? Solo responde sí o no: no se enseña ningún dato suyo
async function buscarNino(body, ip) {
  await limiteBusquedas(ip);
  const nombre = texto(body.nombre);
  if (!nombre || !fechaValida(body.fecha_nacimiento)) throw errorHttp(400, 'Escribe el nombre y la fecha de nacimiento del niño.');
  const id = await ninoExacto(nombre, texto(body.apellidos), body.fecha_nacimiento);
  await supabase.from('identificacion_intentos').insert({ ip, ok: !!id, tipo: 'BUSCAR' });
  return { encontrado: !!id };
}
// Lista de niños acompañados escrita por el cliente → datos validados
function validarAcompanados(lista, desde = 0) {
  return lista.map((n, i) => {
    const et = ` (niño ${desde + i + 1})`;
    const nombre = texto(n.nombre);
    if (!nombre) throw errorHttp(400, `Falta el nombre${et}.`);
    if (!fechaValida(n.fecha_nacimiento)) throw errorHttp(400, `La fecha de nacimiento no es válida${et}.`);
    return { nombre, apellidos: texto(n.apellidos), fecha_nacimiento: n.fecha_nacimiento, observaciones: texto(n.observaciones, 300) };
  });
}
// Si ya es cliente se usa su ficha; si no, se da de alta sin vincularlo a nadie (el adulto solo lo acompaña hoy)
async function idsAcompanados(ninos) {
  const ids = [];
  for (const n of ninos) {
    const id = await ninoExacto(n.nombre, n.apellidos, n.fecha_nacimiento);
    if (id) { ids.push(id); continue; }
    const { data, error } = await supabase.from('ninos').insert(n).select('id').single();
    if (error) throw error;
    ids.push(data.id);
  }
  return ids;
}
// El adulto que trae a niños que no son suyos tiene que tener apellidos (se guardan si aún no los tenía)
async function asegurarApellidos(tutorId, apellidos) {
  const { data } = await supabase.from('tutores').select('apellidos').eq('id', tutorId).single();
  if ((data?.apellidos || '').trim().length >= 2) return;
  const nuevos = texto(apellidos);
  if (!nuevos || nuevos.length < 2) throw errorHttp(400, MENSAJE_APELLIDOS, { pedir_apellidos: true });
  const { error } = await supabase.from('tutores').update({ apellidos: nuevos }).eq('id', tutorId);
  if (error) throw error;
}

// ---------- Autocheck-in ----------
async function identificar(body, ip) {
  const hace15 = new Date(Date.now() - 15 * 60e3).toISOString();
  const { count: fallos } = await supabase.from('identificacion_intentos').select('id', { count: 'exact', head: true })
    .eq('ip', ip).eq('tipo', 'IDENTIFICAR').eq('ok', false).gte('created_at', hace15);
  if (fallos >= MAX_FALLOS_IDENTIFICAR) {
    throw errorHttp(429, 'Demasiados intentos. Espera unos minutos o pide ayuda al personal del restaurante.');
  }
  const telefono = normalizarTelefono(body.telefono);
  if (!telefono || !fechaValida(body.fecha_nino)) {
    throw errorHttp(400, 'Escribe tu teléfono y la fecha de nacimiento de uno de tus hijos.');
  }
  const { data: tutor } = await supabase.from('tutores').select('id').eq('telefono', telefono).maybeSingle();
  let ok = false;
  if (tutor) {
    const { data: suyos } = await supabase.from('nino_tutor').select('ninos(fecha_nacimiento, activo)').eq('tutor_id', tutor.id);
    ok = (suyos || []).some(x => x.ninos && x.ninos.activo && x.ninos.fecha_nacimiento === body.fecha_nino);
  }
  await supabase.from('identificacion_intentos').insert({ ip, ok });
  if (!ok) {
    throw errorHttp(404, 'No encontramos ninguna familia con esos datos. Revisa el teléfono y la fecha, o date de alta si es vuestra primera vez.');
  }
  return { familia: await familiaDe(tutor.id), dispositivo: await crearDispositivo(tutor.id) };
}

async function checkin(enlace, body) {
  const tutorId = await leerDispositivo(body.dispositivo);
  if (!tutorId) throw errorHttp(401, 'No te hemos reconocido. Vuelve a identificarte.', { olvidar: true });
  const familia = await familiaDe(tutorId);
  if (!familia) throw errorHttp(401, 'No te hemos reconocido. Vuelve a identificarte.', { olvidar: true });
  const pedidos = new Set((body.nino_ids || []).map(Number));
  const propios = familia.ninos.filter(n => pedidos.has(n.id)).map(n => n.id);
  const listaAcomp = Array.isArray(body.acompanados) ? body.acompanados : [];
  if (listaAcomp.length > MAX_NINOS) throw errorHttp(400, `Como máximo ${MAX_NINOS} niños acompañados.`);
  const acompanados = validarAcompanados(listaAcomp);
  if (!propios.length && !acompanados.length) throw errorHttp(400, 'Marca qué niños vienen hoy.');
  if (acompanados.length) await asegurarApellidos(tutorId, body.apellidos);
  const idsAcomp = await idsAcompanados(acompanados);
  const ids = [...new Set([...propios, ...idsAcomp])];

  // Si ya estaban en la cola de hoy, se actualiza esa llegada en vez de repetirla
  const { data: pendiente } = await supabase.from('llegadas').select('id, nino_ids')
    .eq('tutor_id', tutorId).eq('fecha', hoyMadrid()).eq('estado', 'PENDIENTE')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (pendiente) {
    const union = [...new Set([...pendiente.nino_ids.map(Number), ...ids])];
    const { error } = await supabase.from('llegadas').update({ nino_ids: union }).eq('id', pendiente.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('llegadas').insert({ tutor_id: tutorId, nino_ids: ids, enlace_id: enlace.id, origen: 'AUTOCHECKIN' });
    if (error) throw error;
  }
  return { ok: true, ninos: [...familia.ninos.filter(n => propios.includes(n.id)).map(n => n.nombre), ...acompanados.map(n => n.nombre)] };
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
  const todos = lista.map((n, i) => {
    const et = lista.length > 1 ? ` (niño ${i + 1})` : '';
    const nn = texto(n.nombre);
    if (!nn) throw errorHttp(400, `Falta el nombre${et}.`);
    if (!fechaValida(n.fecha_nacimiento)) throw errorHttp(400, `La fecha de nacimiento no es válida${et}.`);
    return { nombre: nn, apellidos: texto(n.apellidos), fecha_nacimiento: n.fecha_nacimiento, observaciones: texto(n.observaciones, 300), acompanado: !!n.acompanado };
  });
  const ninos = todos.filter(n => !n.acompanado).map(({ acompanado, ...n }) => n);
  const acompanados = todos.filter(n => n.acompanado).map(({ acompanado, ...n }) => n);
  // Quien trae a niños que no son suyos tiene que dar nombre y apellidos
  if (acompanados.length && (texto(t.apellidos) || '').length < 2) throw errorHttp(400, MENSAJE_APELLIDOS);

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

    // Niños que no son suyos: su ficha si ya son clientes, o alta sin vincular al adulto
    if (acompanados.length) {
      await asegurarApellidos(tutorId, t.apellidos);
      ids.push(...await idsAcompanados(acompanados));
    }

    // Queda en "Llegadas" para que el personal cobre
    const origen = unSoloUso ? 'ENLACE' : enlace.tipo;
    const { error: eL } = await supabase.from('llegadas').insert({ tutor_id: tutorId, nino_ids: ids, enlace_id: enlace.id, origen });
    if (eL) throw eL;
    if (!unSoloUso) await supabase.from('altas_publicas').insert({ enlace_id: enlace.id, ip });

    // El móvil de quien se da de alta queda recordado para el autocheck-in de las próximas veces
    return { ok: true, ninos: todos.map(n => n.nombre), dispositivo: await crearDispositivo(tutorId) };
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
    if (n.fecha_nacimiento && !fechaValida(n.fecha_nacimiento)) throw errorHttp(400, `La fecha de nacimiento de ${nombre} no es válida.`);
    return {
      id: Number(n.id) || null, nombre, edad, avisos: texto(n.avisos, 200), es_cumpleanero: !!n.es_cumpleanero, orden: i,
      relacion: (n.relacion === 'HIJO' || (!n.relacion && n.es_cumpleanero)) ? 'HIJO' : 'REPRESENTADO', fecha: n.fecha_nacimiento || null
    };
  });

  // El organizador representa a los niños que no son suyos: nombre y apellidos obligatorios
  const apellidos = texto(body.organizador_apellidos) || fiesta.organizador_apellidos || '';
  if (filas.some(f => f.relacion === 'REPRESENTADO') && apellidos.trim().length < 2) {
    throw errorHttp(400, 'Escribe tus apellidos: eres el responsable de los niños invitados que no son tuyos.', { pedir_apellidos: true });
  }
  if (texto(body.organizador_apellidos) && texto(body.organizador_apellidos) !== fiesta.organizador_apellidos) {
    const { error } = await supabase.from('fiestas').update({ organizador_apellidos: texto(body.organizador_apellidos) }).eq('id', fiesta.id);
    if (error) throw error;
  }

  // Si el organizador da la fecha de nacimiento y el niño ya es cliente, se enlaza con su ficha.
  // La fecha no se guarda en la lista: solo sirve para encontrarlo.
  const conFecha = filas.filter(f => f.fecha);
  if (conFecha.length > MAX_BUSQUEDAS_NINO) throw errorHttp(400, 'Demasiadas fechas a la vez. Guarda la lista por partes.');
  for (const f of filas) {
    if (f.fecha) {
      const id = await ninoExacto(f.nombre, null, f.fecha);
      if (id) f.nino_id = id;
    }
    delete f.fecha;
  }

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
    const cuerpo = event.httpMethod === 'POST' ? leerBody(event) : {};
    // Olvidar este móvil: no necesita un QR válido
    if (cuerpo.accion === 'olvidar') {
      if (/^[A-Za-z0-9_-]{30,40}$/.test(String(cuerpo.dispositivo || ''))) {
        await supabase.from('dispositivos_familia').update({ anulado: true }).eq('token_hash', hashToken(cuerpo.dispositivo));
      }
      return respuesta(200, { ok: true });
    }

    const token = event.httpMethod === 'GET' ? event.queryStringParameters?.t : cuerpo.t;
    const { enlace, estado } = await leerEnlace(token);

    if (event.httpMethod === 'GET') {
      const esAlta = TIPOS_ALTA.includes(enlace.tipo);
      const base = { tipo: esAlta ? 'REGISTRO' : enlace.tipo, origen: enlace.tipo, estado, mensaje: MENSAJES_ESTADO[estado] || null,
        checkin: TIPOS_CHECKIN.includes(enlace.tipo) };
      if (estado !== 'OK') return respuesta(200, base);
      if (esAlta) return respuesta(200, { ...base, telefono: enlace.telefono });
      return respuesta(200, { ...base, fiesta: await datosFiesta(enlace.fiesta_id) });
    }

    if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
    if (estado !== 'OK') throw errorHttp(410, MENSAJES_ESTADO[estado]);
    const body = leerBody(event);

    if (body.accion === 'registro' && TIPOS_ALTA.includes(enlace.tipo)) return respuesta(200, await registro(enlace, body, ipCliente(event)));
    if (body.accion === 'buscar_nino') return respuesta(200, await buscarNino(body, ipCliente(event)));
    if (body.accion === 'invitados' && enlace.tipo === 'FIESTA') return respuesta(200, await invitados(enlace, body));
    if (TIPOS_CHECKIN.includes(enlace.tipo)) {
      if (body.accion === 'identificar') return respuesta(200, await identificar(body, ipCliente(event)));
      if (body.accion === 'familia') {
        const tutorId = await leerDispositivo(body.dispositivo);
        const familia = tutorId ? await familiaDe(tutorId) : null;
        if (!familia) throw errorHttp(401, 'No te hemos reconocido. Vuelve a identificarte.', { olvidar: true });
        return respuesta(200, { familia });
      }
      if (body.accion === 'checkin') return respuesta(200, await checkin(enlace, body));
    }
    throw errorHttp(400, 'Acción no válida para este enlace.');
  } catch (e) {
    return responderError(e, 'publico');
  }
};
