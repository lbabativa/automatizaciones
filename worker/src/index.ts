/**
 * Worker: toma trabajos de la cola, abre el portal con la sesión del cliente,
 * ejecuta el módulo y guarda resultado y evidencias.
 *
 * Un solo worker procesa en fila. Nunca abre dos navegadores sobre la misma
 * cuenta del mismo portal, que es lo que los portales de las EPS bloquean.
 */
import {
  Cliente,
  completar,
  conectarDb,
  descifrar,
  env,
  envNum,
  ErrorNegocio,
  ErrorSesion,
  fallar,
  reclamar,
  rescatarHuerfanos,
  type ClienteDoc,
  type TrabajoDoc,
} from '@startia/core';
import { nombresModulosSoportados, registro, resolverModulo } from '@startia/modulos';
import { asegurarSesion } from './sesionHelper.js';
import { capturarEvidencia } from './evidencias.js';
import { cerrarTodo, guardarSesion, invalidarSesion, obtenerContexto } from './navegador.js';

const WORKER_ID = env('WORKER_ID', 'worker-1');
const POLL_MS = envNum('POLL_MS', 3000);
const PAUSA_MIN = envNum('PAUSA_MIN_MS', 20_000);
const PAUSA_MAX = envNum('PAUSA_MAX_MS', 40_000);
const HEADLESS = env('HEADLESS', 'true') !== 'false';

let detener = false;
process.on('SIGINT', () => (detener = true));
process.on('SIGTERM', () => (detener = true));

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toISOString()}] [${WORKER_ID}] ${msg}`);

async function procesar(trabajo: TrabajoDoc): Promise<void> {
  const capturas: string[] = [];
  const id = String(trabajo._id);
  const modulo = await resolverModulo(trabajo.modulo);
  if (!modulo) {
    await fallar(trabajo._id, { codigo: 'MODULO_INEXISTENTE', mensaje: `El worker no tiene el módulo ${trabajo.modulo}` }, [], false);
    return;
  }

  const cliente = await Cliente.findOne({ slug: trabajo.clienteSlug }).lean<ClienteDoc>();
  if (!cliente || !cliente.activo) {
    await fallar(trabajo._id, { codigo: 'CLIENTE_INACTIVO', mensaje: `Cliente ${trabajo.clienteSlug} inexistente o inactivo` }, [], false);
    return;
  }
  const configModulo = (cliente.modulos.find((m) => m.nombre === modulo.nombre)?.config ?? {}) as Record<string, unknown>;
  const credCifradas = ((cliente.credenciales as Record<string, Record<string, string>>)?.[modulo.portal] ?? {});
  const credenciales = Object.fromEntries(Object.entries(credCifradas).map(([k, v]) => [k, descifrar(v)]));
  const faltantes = modulo.credencialesRequeridas.filter((c) => !credenciales[c]);
  if (faltantes.length) {
    await fallar(trabajo._id, { codigo: 'CREDENCIALES_INCOMPLETAS', mensaje: `Faltan credenciales de ${modulo.portal}: ${faltantes.join(', ')}` }, [], false);
    return;
  }

  const contexto = await obtenerContexto(cliente.slug, modulo.portal, HEADLESS);
  const page = await contexto.newPage();
  const capturar = async (nombre: string) => {
    try {
      capturas.push(await capturarEvidencia(page, cliente.slug, id, nombre));
    } catch (e) {
      log(`No se pudo guardar la captura ${nombre}: ${(e as Error).message}`);
    }
  };

  try {
    await page.goto(modulo.urlInicio, { waitUntil: 'networkidle' });
    await asegurarSesion(modulo, contexto, page, credenciales, { headless: HEADLESS, log, clienteSlug: cliente.slug });

    const resultado = await modulo.ejecutar({ parametros: trabajo.parametros, credenciales, config: configModulo, page, capturar, log });
    await guardarSesion(cliente.slug, modulo.portal, contexto, 'automatica');
    await completar(trabajo._id, resultado, capturas);
    log(`Trabajo ${id} completado (${modulo.nombre}, ${cliente.slug})`);
    await notificar(trabajo, 'completado', resultado, capturas);
  } catch (e) {
    const err = e as Error;
    await capturar('error');
    if (err instanceof ErrorNegocio) {
      await fallar(trabajo._id, { codigo: err.codigo, mensaje: err.message }, capturas, false);
      log(`Trabajo ${id} sin resultado: ${err.codigo}`);
      await notificar(trabajo, 'fallido', { codigo: err.codigo, mensaje: err.message }, capturas);
    } else if (err instanceof ErrorSesion) {
      await invalidarSesion(cliente.slug, modulo.portal);
      const reencolado = await fallar(trabajo._id, { codigo: 'SESION_INVALIDA', mensaje: err.message }, capturas, true);
      log(`Trabajo ${id}: sesión inválida. ${reencolado ? 'Se reintentará.' : err.message}`);
      if (!reencolado) await notificar(trabajo, 'fallido', { codigo: 'SESION_INVALIDA', mensaje: err.message }, capturas);
    } else {
      const reencolado = await fallar(trabajo._id, { codigo: err.name === 'ErrorPortal' ? 'PORTAL_INESPERADO' : 'ERROR_INTERNO', mensaje: err.message }, capturas, true);
      log(`Trabajo ${id} falló: ${err.message}. ${reencolado ? 'Se reintentará.' : 'Sin más intentos.'}`);
      if (!reencolado) await notificar(trabajo, 'fallido', { codigo: 'PORTAL_INESPERADO', mensaje: err.message }, capturas);
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Avisa al callback_url del cliente cuando el trabajo termina. Fallar aquí no afecta el trabajo. */
async function notificar(trabajo: TrabajoDoc, estado: 'completado' | 'fallido', carga: unknown, capturas: string[]): Promise<void> {
  if (!trabajo.callbackUrl) return;
  try {
    const r = await fetch(trabajo.callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: String(trabajo._id), modulo: trabajo.modulo, estado, parametros: trabajo.parametros, [estado === 'completado' ? 'resultado' : 'error']: carga, capturas }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) log(`Callback ${trabajo.callbackUrl} respondió ${r.status}`);
  } catch (e) {
    log(`Callback ${trabajo.callbackUrl} falló: ${(e as Error).message}`);
  }
}

async function principal(): Promise<void> {
  await conectarDb();
  let modulosSoportados = await nombresModulosSoportados();
  log(`Worker listo. Módulos en código: ${Object.keys(registro).join(', ')}. Flujos publicados: ${modulosSoportados.filter((m) => !registro[m]).join(', ') || 'ninguno'}. Headless: ${HEADLESS}`);
  let ultimoRescate = 0;
  let ultimaLista = Date.now();

  while (!detener) {
    if (Date.now() - ultimoRescate > 5 * 60_000) {
      const n = await rescatarHuerfanos(15);
      if (n) log(`${n} trabajo(s) huérfano(s) devueltos a la cola`);
      ultimoRescate = Date.now();
    }
    if (Date.now() - ultimaLista > 30_000) {
      // Los flujos declarativos se publican desde la consola sin reiniciar el worker.
      modulosSoportados = await nombresModulosSoportados().catch(() => modulosSoportados);
      ultimaLista = Date.now();
    }
    const trabajo = await reclamar(WORKER_ID, modulosSoportados);
    if (!trabajo) {
      await dormir(POLL_MS);
      continue;
    }
    log(`Trabajo ${String(trabajo._id)} (${trabajo.modulo}, ${trabajo.clienteSlug}) intento ${trabajo.intentos}`);
    await procesar(trabajo);
    const pausa = PAUSA_MIN + Math.random() * Math.max(0, PAUSA_MAX - PAUSA_MIN);
    await dormir(pausa);
  }
  await cerrarTodo();
  log('Worker detenido');
  process.exit(0);
}

principal().catch(async (e) => {
  console.error(e);
  await cerrarTodo();
  process.exit(1);
});
