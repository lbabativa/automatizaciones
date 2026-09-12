import { cifrar, rutaProyecto, Sesion } from '@startia/core';
import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext } from 'playwright';

/**
 * Un perfil de navegador persistente por cliente y portal (cookies, storage y
 * huella del navegador se conservan en disco entre corridas).
 *
 * Los portales con protección anti-bots (Sanitas usa Radware Bot Manager) piden
 * un reto la primera vez. Una persona lo resuelve con `npm run sesion` en este
 * mismo perfil y el worker sigue usándolo. El worker no intenta saltarse esos retos:
 * si el portal vuelve a pedirlos, el trabajo falla con SESION_INVALIDA y se avisa.
 */
const contextos = new Map<string, BrowserContext>();

const clave = (clienteSlug: string, portal: string) => `${clienteSlug}::${portal}`;

function dirPerfil(clienteSlug: string, portal: string): string {
  return rutaProyecto(process.env.PERFILES_DIR ?? './perfiles', clienteSlug, portal);
}

export async function obtenerContexto(clienteSlug: string, portal: string, headless: boolean): Promise<BrowserContext> {
  const k = clave(clienteSlug, portal);
  const existente = contextos.get(k);
  if (existente) return existente;

  const dir = dirPerfil(clienteSlug, portal);
  await mkdir(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    headless,
    // Chromium propio (por ejemplo un zip de chromium.org descomprimido). Si no se define, usa el de Playwright.
    executablePath: process.env.CHROMIUM_PATH || undefined,
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    viewport: { width: 1366, height: 768 },
  });
  ctx.setDefaultTimeout(20_000);
  ctx.on('close', () => contextos.delete(k));
  contextos.set(k, ctx);
  return ctx;
}

/** Copia de respaldo de la sesión en Mongo, cifrada. El perfil en disco es la fuente principal. */
export async function guardarSesion(clienteSlug: string, portal: string, ctx: BrowserContext, origen: 'manual' | 'automatica'): Promise<void> {
  const estado = await ctx.storageState();
  await Sesion.updateOne(
    { clienteSlug, portal },
    { $set: { storageStateCifrado: cifrar(JSON.stringify(estado)), origen, valida: true } },
    { upsert: true },
  );
}

/** Marca la sesión como inválida y cierra el navegador de ese cliente y portal. El perfil en disco se conserva. */
export async function invalidarSesion(clienteSlug: string, portal: string): Promise<void> {
  await Sesion.updateOne({ clienteSlug, portal }, { $set: { valida: false } });
  const k = clave(clienteSlug, portal);
  await contextos.get(k)?.close().catch(() => undefined);
  contextos.delete(k);
}

export async function cerrarTodo(): Promise<void> {
  for (const ctx of contextos.values()) await ctx.close().catch(() => undefined);
  contextos.clear();
}
