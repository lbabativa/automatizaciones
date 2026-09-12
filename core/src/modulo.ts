import type { Page } from 'playwright';
import type { ZodType, z } from 'zod';

/**
 * Contrato de un módulo de automatización.
 *
 * Un módulo NO conoce clientes: recibe parámetros, credenciales y configuración
 * desde el núcleo y devuelve datos. Todo lo específico de un cliente vive en la
 * colección `clientes` (config del módulo + credenciales cifradas).
 */
export interface ContextoEjecucion<P> {
  parametros: P;
  /** Credenciales ya descifradas del portal del módulo (usuario, password, ...). */
  credenciales: Record<string, string>;
  /** Configuración del módulo para este cliente, por ejemplo { prestadorCodigo: '176805' }. */
  config: Record<string, unknown>;
  page: Page;
  /** Guarda una captura de pantalla como evidencia del paso. */
  capturar(nombre: string): Promise<void>;
  log(mensaje: string): void;
}

export interface Modulo<S extends ZodType = ZodType, R = unknown> {
  /** Identificador único, en kebab-case: 'sanitas-autorizaciones'. */
  nombre: string;
  /** Sector de la automatización. Solo organiza el catálogo: 'salud', 'banca', 'seguros', 'gobierno'. */
  sector: string;
  /** Portal al que pertenece. Agrupa credenciales y sesiones: 'sanitas', 'bancolombia', 'adres'. */
  portal: string;
  version: string;
  descripcion: string;
  urlInicio: string;
  parametros: S;
  credencialesRequeridas: string[];
  /** Devuelve true si la página muestra al usuario ya autenticado. */
  sesionValida(page: Page): Promise<boolean>;
  /** Inicia sesión automáticamente. Si el portal tiene captcha, lanza ErrorSesion para pedir sesión manual. */
  iniciarSesion?(page: Page, credenciales: Record<string, string>): Promise<void>;
  ejecutar(ctx: ContextoEjecucion<z.infer<S>>): Promise<R>;
}

export function definirModulo<S extends ZodType, R>(modulo: Modulo<S, R>): Modulo<S, R> {
  return modulo;
}

/** Resultado de negocio negativo (paciente no existe, sin autorización). No se reintenta. */
export class ErrorNegocio extends Error {
  constructor(
    public readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorNegocio';
  }
}

/** La sesión del portal expiró o no se pudo abrir. El núcleo la invalida y reintenta. */
export class ErrorSesion extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorSesion';
  }
}

/** El portal cambió o no respondió como se esperaba. Se reintenta una vez y luego se alerta. */
export class ErrorPortal extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorPortal';
  }
}
