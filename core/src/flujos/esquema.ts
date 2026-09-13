/**
 * Esquema de un flujo declarativo: una automatización descrita como datos
 * (parámetros, pasos y condiciones) que el intérprete ejecuta con Playwright.
 *
 * Los flujos se guardan en la colección `flujos`, se editan desde la consola y
 * conviven con los módulos escritos en código. Todo valor de texto admite
 * plantillas `{{variable}}` (por ejemplo `{{num_doc}}`, `{{config.prestadorCodigo}}`,
 * `{{credenciales.usuario}}`, `{{hoy}}`) resueltas en el momento de ejecutar el paso.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------
// Objetivo: cómo ubicar un elemento en la página
// ---------------------------------------------------------------------------------
export type Objetivo = {
  /** Selector CSS. */
  selector?: string;
  /** Texto visible. Admite regex con la forma "/patrón/i". */
  texto?: string;
  /** Con `texto`: coincidencia exacta en vez de por contenido. */
  exacto?: boolean;
  /** Rol ARIA (button, combobox, link, textbox...) más `nombre` accesible. */
  rol?: string;
  nombre?: string;
  /** Texto de la etiqueta (label) del campo. */
  etiqueta?: string;
  placeholder?: string;
  /** Filtra los candidatos a los que contienen este texto (o regex "/.../"). */
  con_texto?: string;
  /** Posición cuando hay varios candidatos (0 = primero). */
  indice?: number;
  /** Buscar solo dentro de otro objetivo. */
  dentro_de?: Objetivo;
};

export const ObjetivoSchema: z.ZodType<Objetivo> = z.lazy(() =>
  z
    .object({
      selector: z.string().min(1).optional(),
      texto: z.string().min(1).optional(),
      exacto: z.boolean().optional(),
      rol: z.string().min(1).optional(),
      nombre: z.string().optional(),
      etiqueta: z.string().min(1).optional(),
      placeholder: z.string().min(1).optional(),
      con_texto: z.string().min(1).optional(),
      indice: z.number().int().min(0).optional(),
      dentro_de: ObjetivoSchema.optional(),
    })
    .refine((o) => o.selector || o.texto || o.rol || o.etiqueta || o.placeholder, {
      message: 'Un objetivo necesita selector, texto, rol, etiqueta o placeholder',
    }),
);

// ---------------------------------------------------------------------------------
// Condiciones: sobre la página o sobre variables
// ---------------------------------------------------------------------------------
export const OPERADORES = ['igual', 'distinto', 'contiene', 'coincide', 'vacio', 'no_vacio', 'mayor', 'menor', 'mayor_igual', 'menor_igual'] as const;
export type Operador = (typeof OPERADORES)[number];

export type Condicion =
  | { existe: Objetivo; espera_ms?: number }
  | { no_existe: Objetivo; espera_ms?: number }
  | { texto_visible: string; espera_ms?: number }
  | { url_coincide: string }
  | { variable: string; op: Operador; valor?: unknown }
  | { todas: Condicion[] }
  | { alguna: Condicion[] }
  | { no: Condicion };

export const CondicionSchema: z.ZodType<Condicion> = z.lazy(() =>
  z.union([
    z.object({ existe: ObjetivoSchema, espera_ms: z.number().int().min(0).optional() }).strict(),
    z.object({ no_existe: ObjetivoSchema, espera_ms: z.number().int().min(0).optional() }).strict(),
    z.object({ texto_visible: z.string().min(1), espera_ms: z.number().int().min(0).optional() }).strict(),
    z.object({ url_coincide: z.string().min(1) }).strict(),
    z.object({ variable: z.string().min(1), op: z.enum(OPERADORES), valor: z.unknown().optional() }).strict(),
    z.object({ todas: z.array(CondicionSchema).min(1) }).strict(),
    z.object({ alguna: z.array(CondicionSchema).min(1) }).strict(),
    z.object({ no: CondicionSchema }).strict(),
  ]),
);

// ---------------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------------
const Comun = {
  /** Etiqueta opcional para reconocer el paso en los registros y en la consola. */
  titulo: z.string().optional(),
  /** Tiempo máximo de espera del paso, en milisegundos. */
  timeout_ms: z.number().int().min(0).optional(),
};

export const TIPOS_ERROR = ['negocio', 'portal', 'sesion'] as const;

export const OperacionTransformarSchema = z.union([
  z.object({ reemplazar: z.tuple([z.string(), z.string()]) }).strict(),
  z.object({ extraer: z.string() }).strict(),
  z.object({ recortar: z.literal(true) }).strict(),
  z.object({ mayusculas: z.literal(true) }).strict(),
  z.object({ minusculas: z.literal(true) }).strict(),
  z.object({ numero: z.literal(true) }).strict(),
  z.object({ fecha: z.literal(true) }).strict(),
  z.object({ unicos: z.literal(true) }).strict(),
  z.object({ largo: z.literal(true) }).strict(),
  z.object({ por_defecto: z.unknown() }).strict(),
]);

export type OperacionTransformar = z.infer<typeof OperacionTransformarSchema>;

export type Paso =
  | { tipo: 'ir'; url: string; titulo?: string; timeout_ms?: number }
  | { tipo: 'clic'; objetivo: Objetivo; opcional?: boolean; titulo?: string; timeout_ms?: number }
  | { tipo: 'escribir'; objetivo: Objetivo; valor: string; tecla?: string; titulo?: string; timeout_ms?: number }
  | { tipo: 'seleccionar'; objetivo: Objetivo; texto?: string; valor?: string; titulo?: string; timeout_ms?: number }
  | { tipo: 'presionar'; tecla: string; objetivo?: Objetivo; titulo?: string; timeout_ms?: number }
  | {
      tipo: 'esperar';
      objetivo?: Objetivo;
      texto?: string;
      url?: string;
      ms?: number;
      habilitado?: boolean;
      opcional?: boolean;
      guardar_como?: string;
      titulo?: string;
      timeout_ms?: number;
    }
  | {
      tipo: 'leer';
      guardar_como: string;
      objetivo?: Objetivo;
      etiqueta?: string;
      atributo?: string;
      extraer?: string;
      como?: 'texto' | 'numero' | 'fecha';
      titulo?: string;
      timeout_ms?: number;
    }
  | { tipo: 'leer_lista'; guardar_como: string; objetivo: Objetivo; coincide?: string; unicos?: boolean; titulo?: string; timeout_ms?: number }
  | { tipo: 'leer_tabla'; guardar_como: string; objetivo: Objetivo; encabezados?: boolean; titulo?: string; timeout_ms?: number }
  | { tipo: 'leer_lineas'; guardar_como: string; despues_de?: string; titulo?: string; timeout_ms?: number }
  | { tipo: 'capturar'; nombre: string; titulo?: string; timeout_ms?: number }
  | { tipo: 'asignar'; variable: string; valor: unknown; titulo?: string; timeout_ms?: number }
  | { tipo: 'agregar'; a: string; valor: unknown; titulo?: string; timeout_ms?: number }
  | {
      tipo: 'buscar';
      en: string;
      guardar_como: string;
      coincide?: string;
      distinto_de?: string;
      todos?: boolean;
      desde_el_final?: boolean;
      titulo?: string;
      timeout_ms?: number;
    }
  | { tipo: 'transformar'; variable: string; guardar_como?: string; operaciones: z.infer<typeof OperacionTransformarSchema>[]; titulo?: string; timeout_ms?: number }
  | {
      tipo: 'elegir';
      de: string;
      guardar_como: string;
      como?: string;
      preferir?: Condicion[];
      ordenar_por?: string;
      desc?: boolean;
      titulo?: string;
      timeout_ms?: number;
    }
  | { tipo: 'decidir'; guardar_como: string; reglas: Array<{ cuando: Condicion; valor: unknown }>; por_defecto?: unknown; titulo?: string; timeout_ms?: number }
  | { tipo: 'si'; condicion: Condicion; entonces: Paso[]; si_no?: Paso[]; titulo?: string; timeout_ms?: number }
  | { tipo: 'para_cada'; lista: string; como?: string; pasos: Paso[]; titulo?: string; timeout_ms?: number }
  | { tipo: 'error'; codigo: string; mensaje: string; clase?: (typeof TIPOS_ERROR)[number]; titulo?: string; timeout_ms?: number }
  | { tipo: 'fin'; titulo?: string; timeout_ms?: number };

export const PasoSchema: z.ZodType<Paso> = z.lazy(() =>
  z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('ir'), url: z.string().min(1), ...Comun }).strict(),
    z.object({ tipo: z.literal('clic'), objetivo: ObjetivoSchema, opcional: z.boolean().optional(), ...Comun }).strict(),
    z.object({ tipo: z.literal('escribir'), objetivo: ObjetivoSchema, valor: z.string(), tecla: z.string().optional(), ...Comun }).strict(),
    z
      .object({ tipo: z.literal('seleccionar'), objetivo: ObjetivoSchema, texto: z.string().optional(), valor: z.string().optional(), ...Comun })
      .strict()
      .refine((p) => p.texto !== undefined || p.valor !== undefined, { message: 'seleccionar necesita texto o valor' }),
    z.object({ tipo: z.literal('presionar'), tecla: z.string().min(1), objetivo: ObjetivoSchema.optional(), ...Comun }).strict(),
    z
      .object({
        tipo: z.literal('esperar'),
        objetivo: ObjetivoSchema.optional(),
        texto: z.string().optional(),
        url: z.string().optional(),
        ms: z.number().int().min(0).optional(),
        habilitado: z.boolean().optional(),
        opcional: z.boolean().optional(),
        guardar_como: z.string().optional(),
        ...Comun,
      })
      .strict(),
    z
      .object({
        tipo: z.literal('leer'),
        guardar_como: z.string().min(1),
        objetivo: ObjetivoSchema.optional(),
        etiqueta: z.string().optional(),
        atributo: z.string().optional(),
        extraer: z.string().optional(),
        como: z.enum(['texto', 'numero', 'fecha']).optional(),
        ...Comun,
      })
      .strict()
      .refine((p) => p.objetivo || p.etiqueta, { message: 'leer necesita objetivo o etiqueta' }),
    z.object({ tipo: z.literal('leer_lista'), guardar_como: z.string().min(1), objetivo: ObjetivoSchema, coincide: z.string().optional(), unicos: z.boolean().optional(), ...Comun }).strict(),
    z.object({ tipo: z.literal('leer_tabla'), guardar_como: z.string().min(1), objetivo: ObjetivoSchema, encabezados: z.boolean().optional(), ...Comun }).strict(),
    z.object({ tipo: z.literal('leer_lineas'), guardar_como: z.string().min(1), despues_de: z.string().optional(), ...Comun }).strict(),
    z.object({ tipo: z.literal('capturar'), nombre: z.string().min(1), ...Comun }).strict(),
    z.object({ tipo: z.literal('asignar'), variable: z.string().min(1), valor: z.unknown(), ...Comun }).strict(),
    z.object({ tipo: z.literal('agregar'), a: z.string().min(1), valor: z.unknown(), ...Comun }).strict(),
    z
      .object({
        tipo: z.literal('buscar'),
        en: z.string().min(1),
        guardar_como: z.string().min(1),
        coincide: z.string().optional(),
        distinto_de: z.string().optional(),
        todos: z.boolean().optional(),
        desde_el_final: z.boolean().optional(),
        ...Comun,
      })
      .strict(),
    z.object({ tipo: z.literal('transformar'), variable: z.string().min(1), guardar_como: z.string().optional(), operaciones: z.array(OperacionTransformarSchema).min(1), ...Comun }).strict(),
    z
      .object({
        tipo: z.literal('elegir'),
        de: z.string().min(1),
        guardar_como: z.string().min(1),
        como: z.string().optional(),
        preferir: z.array(CondicionSchema).optional(),
        ordenar_por: z.string().optional(),
        desc: z.boolean().optional(),
        ...Comun,
      })
      .strict(),
    z
      .object({
        tipo: z.literal('decidir'),
        guardar_como: z.string().min(1),
        reglas: z.array(z.object({ cuando: CondicionSchema, valor: z.unknown() }).strict()).min(1),
        por_defecto: z.unknown().optional(),
        ...Comun,
      })
      .strict(),
    z.object({ tipo: z.literal('si'), condicion: CondicionSchema, entonces: z.array(PasoSchema), si_no: z.array(PasoSchema).optional(), ...Comun }).strict(),
    z.object({ tipo: z.literal('para_cada'), lista: z.string().min(1), como: z.string().optional(), pasos: z.array(PasoSchema), ...Comun }).strict(),
    z.object({ tipo: z.literal('error'), codigo: z.string().min(1), mensaje: z.string().min(1), clase: z.enum(TIPOS_ERROR).optional(), ...Comun }).strict(),
    z.object({ tipo: z.literal('fin'), ...Comun }).strict(),
  ]),
);

// ---------------------------------------------------------------------------------
// Parámetros de entrada y definición completa
// ---------------------------------------------------------------------------------
export const ParametroDefSchema = z
  .object({
    nombre: z.string().regex(/^[a-z][a-z0-9_]*$/, 'nombre en snake_case'),
    etiqueta: z.string().min(1),
    tipo: z.enum(['texto', 'numero', 'fecha', 'opcion', 'booleano']),
    requerido: z.boolean().default(false),
    ayuda: z.string().optional(),
    ejemplo: z.string().optional(),
    /** Regex que debe cumplir un texto. */
    patron: z.string().optional(),
    /** Para tipo opcion: [valor, etiqueta] o solo valor. */
    opciones: z.array(z.union([z.string(), z.tuple([z.string(), z.string()])])).optional(),
    por_defecto: z.unknown().optional(),
  })
  .strict();
export type ParametroDef = z.infer<typeof ParametroDefSchema>;

export const SesionDefSchema = z
  .object({
    /** Condición que se cumple cuando la página muestra al usuario ya autenticado. */
    valida_si: CondicionSchema,
    /** Pasos de login automático. Si faltan, la sesión se abre a mano una vez. */
    login: z.array(PasoSchema).optional(),
  })
  .strict();

export const FlujoDefSchema = z
  .object({
    nombre: z.string().regex(/^[a-z][a-z0-9-]*$/, 'nombre en kebab-case'),
    titulo: z.string().min(1),
    sector: z.string().min(1),
    portal: z.string().regex(/^[a-z][a-z0-9-]*$/),
    descripcion: z.string().default(''),
    url_inicio: z.string().url(),
    credenciales_requeridas: z.array(z.string()).default([]),
    parametros: z.array(ParametroDefSchema).default([]),
    sesion: SesionDefSchema,
    pasos: z.array(PasoSchema).min(1),
    /** Plantilla del resultado. Si falta, se devuelven todas las variables leídas. */
    resultado: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type FlujoDef = z.infer<typeof FlujoDefSchema>;
