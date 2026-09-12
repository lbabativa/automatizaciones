import { cifrar, descifrar, Sesion } from '@startia/core';
import { chromium, type Browser, type BrowserContext } from 'playwright';

let navegador: Browser | null = null;
const contextos = new Map<string, BrowserContext>();

const clave = (clienteSlug: string, portal: string) => `${clienteSlug}::${portal}`;

export async function abrirNavegador(headless: boolean): Promise<Browser> {
  if (!navegador || !navegador.isConnected()) {
    navegador = await chromium.launch({ headless, args: ['--disable-blink-features=AutomationControlled'] });
  }
  return navegador;
}

/** Un contexto por cliente y portal, con la sesión guardada en Mongo si existe. */
export async function obtenerContexto(clienteSlug: string, portal: string, headless: boolean): Promise<BrowserContext> {
  const k = clave(clienteSlug, portal);
  const existente = contextos.get(k);
  if (existente) return existente;

  const browser = await abrirNavegador(headless);
  const sesion = await Sesion.findOne({ clienteSlug, portal, valida: true }).lean<{ storageStateCifrado: string }>();
  const storageState = sesion ? JSON.parse(descifrar(sesion.storageStateCifrado)) : undefined;
  const ctx = await browser.newContext({
    storageState,
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    viewport: { width: 1366, height: 768 },
  });
  ctx.setDefaultTimeout(20_000);
  contextos.set(k, ctx);
  return ctx;
}

export async function guardarSesion(clienteSlug: string, portal: string, ctx: BrowserContext, origen: 'manual' | 'automatica'): Promise<void> {
  const estado = await ctx.storageState();
  await Sesion.updateOne(
    { clienteSlug, portal },
    { $set: { storageStateCifrado: cifrar(JSON.stringify(estado)), origen, valida: true } },
    { upsert: true },
  );
}

export async function invalidarSesion(clienteSlug: string, portal: string): Promise<void> {
  await Sesion.updateOne({ clienteSlug, portal }, { $set: { valida: false } });
  const k = clave(clienteSlug, portal);
  await contextos.get(k)?.close().catch(() => undefined);
  contextos.delete(k);
}

export async function cerrarTodo(): Promise<void> {
  for (const ctx of contextos.values()) await ctx.close().catch(() => undefined);
  contextos.clear();
  await navegador?.close().catch(() => undefined);
  navegador = null;
}
