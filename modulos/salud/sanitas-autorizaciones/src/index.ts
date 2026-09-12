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

  // VERIFICAR EN FASE 0: la pantalla de login no aparece en el video de referencia.
  // Si tiene captcha o segundo factor, este método debe lanzar ErrorSesion y la
  // sesión se abre manualmente con `npm run sesion -- <cliente> sanitas`.
  async iniciarSesion(page: Page, credenciales: Record<string, string>): Promise<void> {
    const usuario = page.getByLabel(/usuario|login/i).first().or(page.locator('input[type="text"]').first());
    const clave = page.getByLabel(/contraseña|clave|password/i).first().or(page.locator('input[type="password"]').first());

    if (!(await clave.isVisible({ timeout: 10_000 }).catch(() => false))) {
      throw new ErrorSesion('No se encontró el formulario de inicio de sesión del Validador Sanitas');
    }
    if (await page.locator('iframe[src*="recaptcha"], .g-recaptcha, img[src*="captcha" i]').first().isVisible().catch(() => false)) {
      throw new ErrorSesion('El login del Validador Sanitas tiene captcha. Abra la sesión manualmente con: npm run sesion -- <cliente> sanitas');
    }

    await usuario.fill(credenciales.usuario);
    await clave.fill(credenciales.password);
    await page.getByRole('button', { name: /ingresar|entrar|iniciar/i }).first().or(clave).press('Enter');
    await page.waitForLoadState('networkidle');

    if (!(await this.sesionValida(page))) {
      throw new ErrorSesion('El Validador Sanitas no aceptó las credenciales o cambió la pantalla de ingreso');
    }
  },

  ejecutar: consultarAutorizaciones,
});
