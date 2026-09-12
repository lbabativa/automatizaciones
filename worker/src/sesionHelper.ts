import { ErrorSesion, type Modulo } from '@startia/core';
import type { BrowserContext, Page } from 'playwright';
import { guardarSesion } from './navegador.js';

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Garantiza que la página tenga sesión iniciada en el portal del módulo.
 *
 * 1. Si ya hay sesión (cookies reinyectadas del respaldo), no hace nada.
 * 2. Intenta el login automático del módulo.
 * 3. Si el portal lo rechaza (CAS/anti-bots) y hay ventana visible, espera a que
 *    una persona inicie sesión a mano en la MISMA ventana, hasta `esperaManualMs`.
 *
 * En modo sin ventana (worker desatendido) un login bloqueado lanza ErrorSesion,
 * que el worker trata como sesión inválida y reintenta o alerta.
 */
export async function asegurarSesion(
  modulo: Modulo,
  ctx: BrowserContext,
  page: Page,
  credenciales: Record<string, string>,
  opciones: { headless: boolean; log: (m: string) => void; esperaManualMs?: number; clienteSlug: string },
): Promise<void> {
  const { headless, log, clienteSlug } = opciones;
  const esperaManualMs = opciones.esperaManualMs ?? 5 * 60_000;

  if (await modulo.sesionValida(page)) {
    log(`Sesión vigente en ${modulo.portal}`);
    return;
  }

  let errorAuto: Error | null = null;
  if (modulo.iniciarSesion) {
    try {
      log(`Intentando login automático en ${modulo.portal}`);
      await modulo.iniciarSesion(page, credenciales);
      await guardarSesion(clienteSlug, modulo.portal, ctx, 'automatica');
      log('Login automático correcto');
      return;
    } catch (e) {
      errorAuto = e as Error;
      log(`Login automático falló: ${errorAuto.message}`);
    }
  }

  // Desatendido: no se puede pedir intervención humana.
  if (headless) {
    throw new ErrorSesion(errorAuto?.message ?? `No hay sesión de ${modulo.portal} y el módulo no soporta login automático`);
  }

  // Con ventana visible: esperar login manual en la misma ventana.
  log('');
  log(`>>> Inicie sesión a mano en la ventana de ${modulo.portal}. Esperando hasta ${Math.round(esperaManualMs / 60000)} min... <<<`);
  await page.bringToFront().catch(() => undefined);
  const limite = Date.now() + esperaManualMs;
  while (Date.now() < limite) {
    await espera(3_000);
    if (await modulo.sesionValida(page).catch(() => false)) {
      await guardarSesion(clienteSlug, modulo.portal, ctx, 'manual');
      log('Sesión iniciada a mano y guardada. Continuando.');
      return;
    }
  }
  throw new ErrorSesion(`No se inició sesión en ${modulo.portal} dentro del tiempo de espera`);
}
