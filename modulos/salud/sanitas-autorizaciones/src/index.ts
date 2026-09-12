import { definirModulo, ErrorSesion } from '@startia/core';
import type { Page } from 'playwright';
import { z } from 'zod';
import { consultarAutorizaciones } from './flujo.js';

export const TIPOS_DOCUMENTO = ['CC', 'TI', 'CE', 'PA', 'RC', 'PE', 'PT', 'AS', 'MS', 'NU', 'CD', 'SC'] as const;

export const ParametrosSanitas = z.object({
  tipo_doc: z.enum(TIPOS_DOCUMENTO).default('CC'),
  num_doc: z.string().regex(/^\d{4,15}$/, 'num_doc debe ser numérico, de 4 a 15 dígitos'),
  /** Código CUPS del servicio de la cita. Si se envía, se selecciona la autorización que lo cubre. */
  cups: z.string().regex(/^\d{6}$/, 'cups debe tener 6 dígitos').optional(),
  /** Fecha de la cita (YYYY-MM-DD). Se usa para verificar que la autorización esté vigente ese día. */
  fecha_cita: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha_cita debe ser YYYY-MM-DD').optional(),
  /** Qué contrato abrir cuando el paciente tiene varios. AUTO prefiere EPS. */
  contrato: z.enum(['AUTO', 'EPS', 'PAC']).default('AUTO'),
});

export type ParametrosSanitas = z.infer<typeof ParametrosSanitas>;

/** Página de trabajo del validador. El cid lo asigna el portal en cada sesión, no se fija. */
export const URL_VALIDADOR = 'https://appcore.colsanitas.com/ValidadorDerechos/pages/gestion/ValidacionDerechos.seam';
/** Login único (SSO/CAS) de Colsanitas. Si ya hay sesión, redirige de inmediato al validador. */
export const URL_LOGIN = 'https://portal.colsanitas.com/sso/login?service=' + encodeURIComponent(URL_VALIDADOR);

export default definirModulo({
  nombre: 'sanitas-autorizaciones',
  sector: 'salud',
  portal: 'sanitas',
  version: '0.1.0',
  descripcion: 'Consulta afiliación, autorizaciones vigentes y copago de un paciente en el Validador de Usuarios Sanitas (Keralty).',
  urlInicio: URL_LOGIN,
  parametros: ParametrosSanitas,
  credencialesRequeridas: ['usuario', 'password'],

  async sesionValida(page: Page): Promise<boolean> {
    const url = page.url();
    // Login del SSO o reto de Radware: no hay sesión.
    if (/\/sso\/login/i.test(url) || /perfdrive\.com/i.test(url)) return false;
    const dentroDelValidador = /appcore\.colsanitas\.com\/ValidadorDerechos/i.test(url);
    const cuerpo = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).toLowerCase();
    const textoSesion = /\bsalir\b/.test(cuerpo) || /validaci[oó]n\s*-\s*b[uú]squeda/.test(cuerpo) || /usuario:\s*\d+/.test(cuerpo);
    return dentroDelValidador ? textoSesion || cuerpo.length > 0 : textoSesion;
  },

  /**
   * Login único de Colsanitas (CAS). Formulario simple: #username, #password y botón "Ingresar".
   * Verificado el 12/09/2026 contra portal.colsanitas.com/sso/login. Sin captcha en el formulario;
   * la protección anti-bots (Radware) actúa antes y se resuelve una vez con `npm run sesion`.
   */
  async iniciarSesion(page: Page, credenciales: Record<string, string>): Promise<void> {
    if (!/\/sso\/login/i.test(page.url())) {
      await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    }
    if (/perfdrive\.com/i.test(page.url()) || (await page.title().catch(() => '')).toLowerCase().includes('captcha')) {
      throw new ErrorSesion('El portal de Colsanitas muestra el reto anti-bots. Ábralo una vez con: npm run sesion -- <cliente> sanitas');
    }
    const usuario = page.locator('#username');
    const clave = page.locator('#password');
    if (!(await clave.isVisible({ timeout: 10_000 }).catch(() => false))) {
      throw new ErrorSesion('No se encontró el formulario de inicio de sesión de Colsanitas (#username / #password)');
    }
    await usuario.fill(credenciales.usuario);
    await clave.fill(credenciales.password);
    await Promise.all([
      page.waitForURL(/appcore\.colsanitas\.com\/ValidadorDerechos|\/sso\/login/i, { timeout: 30_000 }).catch(() => undefined),
      page.locator('input[name="submit"][value="Ingresar"]').click(),
    ]);
    await page.waitForLoadState('networkidle').catch(() => undefined);

    if (/\/sso\/login/i.test(page.url())) {
      const aviso = (await page.locator('#status, .errors, #msg, .error').first().innerText().catch(() => '')).trim();
      throw new ErrorSesion(`Colsanitas no aceptó las credenciales${aviso ? `: ${aviso}` : ''}`);
    }
    if (!(await this.sesionValida(page))) {
      throw new ErrorSesion(`Tras el login el portal no mostró el validador (URL: ${page.url()})`);
    }
  },

  ejecutar: consultarAutorizaciones,
});
