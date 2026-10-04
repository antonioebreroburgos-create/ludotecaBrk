// POST /.netlify/functions/auth
// body.accion: 'estado' | 'setup' | 'login' | 'yo'
const {
  supabase, respuesta, leerBody, pinValido, hashPin, verificarPin,
  crearToken, requerirUsuario, ipCliente
} = require('./_lib');

const MAX_FALLOS = 5;          // intentos fallidos permitidos...
const VENTANA_MIN = 15;        // ...cada 15 minutos por IP

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
  const body = leerBody(event);
  const accion = body.accion || 'login';

  try {
    // ¿Hay que crear el primer administrador?
    if (accion === 'estado') {
      const { count } = await supabase.from('usuarios').select('id', { count: 'exact', head: true });
      return respuesta(200, { necesitaSetup: count === 0 });
    }

    // Crear el primer ADMIN (solo funciona si la tabla está vacía)
    if (accion === 'setup') {
      const { count } = await supabase.from('usuarios').select('id', { count: 'exact', head: true });
      if (count > 0) return respuesta(403, { error: 'Ya existe un administrador.' });

      const nombre = String(body.nombre || '').trim();
      if (!nombre) return respuesta(400, { error: 'Escribe tu nombre.' });
      if (!pinValido(body.pin)) return respuesta(400, { error: 'El PIN debe tener entre 4 y 6 números.' });

      const { data: u, error } = await supabase
        .from('usuarios')
        .insert({ nombre, pin_hash: hashPin(body.pin), rol: 'ADMIN' })
        .select('id, nombre, rol').single();
      if (error) throw error;
      return respuesta(200, { token: crearToken(u), usuario: u });
    }

    // Login por PIN
    if (accion === 'login') {
      const ip = ipCliente(event);
      const desde = new Date(Date.now() - VENTANA_MIN * 60 * 1000).toISOString();
      const { count: fallos } = await supabase
        .from('login_fallos').select('id', { count: 'exact', head: true })
        .eq('ip', ip).gte('created_at', desde);
      if (fallos >= MAX_FALLOS) {
        return respuesta(429, { error: `Demasiados intentos. Espera ${VENTANA_MIN} minutos.` });
      }

      if (!pinValido(body.pin)) return respuesta(400, { error: 'El PIN debe tener entre 4 y 6 números.' });

      const { data: usuarios, error } = await supabase
        .from('usuarios').select('id, nombre, rol, pin_hash').eq('activo', true);
      if (error) throw error;

      const u = (usuarios || []).find(x => verificarPin(body.pin, x.pin_hash));
      if (!u) {
        await supabase.from('login_fallos').insert({ ip });
        const quedan = MAX_FALLOS - fallos - 1;
        return respuesta(401, {
          error: quedan > 0 ? `PIN incorrecto. Te quedan ${quedan} intentos.` : `PIN incorrecto. Espera ${VENTANA_MIN} minutos.`
        });
      }

      await supabase.from('login_fallos').delete().eq('ip', ip);
      const usuario = { id: u.id, nombre: u.nombre, rol: u.rol };
      return respuesta(200, { token: crearToken(usuario), usuario });
    }

    // Comprobar una sesión guardada en el móvil
    if (accion === 'yo') {
      const { usuario, error } = await requerirUsuario(event);
      if (error) return error;
      return respuesta(200, { usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol } });
    }

    return respuesta(400, { error: 'Acción desconocida' });
  } catch (e) {
    console.error('auth error', e);
    return respuesta(500, { error: 'Error del servidor. Inténtalo de nuevo.' });
  }
};
