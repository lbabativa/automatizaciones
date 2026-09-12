# StartIA Automatizaciones

Plataforma única para todas las automatizaciones (RPA) que StartIA desarrolla, sin importar el sector ni el cliente. Un núcleo multicliente compartido y un módulo independiente por cada portal o proceso: consultas en bancos para un broker, autorizaciones de EPS para una clínica, trámites en portales del Estado, lo que venga.

Primer cliente: CardioIB. Primer módulo: `salud/sanitas-autorizaciones`.

## Estructura

```
core/       modelos (clientes, trabajos, sesiones), cola, cifrado, contrato de módulo
api/        API HTTP (Hono). Recibe solicitudes, valida la clave del cliente y encola trabajos. Se despliega en Vercel.
worker/     Proceso Playwright. Toma trabajos de la cola y ejecuta el módulo que toque. Corre en un PC con escritorio (ver "Protección anti-bots").
modulos/
  registro/                        catálogo de módulos disponibles
  salud/sanitas-autorizaciones/    afiliación, autorizaciones y copago en el Validador Sanitas
  banca/...                        por ejemplo, consultas de extractos o estados de crédito para velandiabroker
  seguros/...
```

## Reglas de independencia

- **Un módulo nunca conoce a un cliente.** Recibe parámetros, credenciales y configuración desde el núcleo y devuelve datos. Si un módulo guarda algo específico de un cliente, deja de servir para los demás.
- **Un módulo nunca depende de otro.** Comparten solo el núcleo. Se pueden desarrollar, probar y desplegar por separado.
- **Cada cliente es una fila en `clientes`**: su clave de API, los módulos que tiene habilitados, la configuración de cada módulo (por ejemplo el código de prestador) y sus credenciales por portal, cifradas con AES-256-GCM. Un cliente puede tener módulos de varios sectores.
- **Los clientes solo consumen la URL.** El sitio de CardioIB, el sistema de velandiabroker o una hoja de Google llaman a la API con su clave. Nunca importan código de aquí.
- **El worker ejecuta en fila por cliente y portal.** Nunca abre dos navegadores sobre la misma cuenta del mismo portal, que es lo que los portales bloquean. Portales distintos sí pueden correr en paralelo con varios workers.

## Puesta en marcha

```bash
npm install
npx playwright install chromium   # o definir CHROMIUM_PATH en .env apuntando a un chrome.exe propio
cp .env.example .env.local   # completar MONGODB_URI y MASTER_KEY (.env.local tiene prioridad sobre .env)
```

Generar la clave maestra:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Registrar un cliente. Las credenciales de sus portales se leen de variables `CRED_<PORTAL>_<CAMPO>`, nunca de argumentos, para que no queden en el historial:

```bash
CRED_SANITAS_USUARIO=1019126688 CRED_SANITAS_PASSWORD=**** npm run cliente:crear -- --slug cardioib --nombre "CARDIOIB SAS" --modulo sanitas-autorizaciones --config sanitas-autorizaciones.prestadorCodigo=176805
```

El comando imprime la clave de API una sola vez. Para un segundo cliente de otro sector es el mismo comando con otros módulos y otras credenciales.

Arrancar en dos terminales:

```bash
npm run api
```

```bash
npm run worker
```

Si un portal tiene captcha o segundo factor, una persona abre la sesión una vez y el worker la reutiliza:

```bash
npm run sesion -- cardioib sanitas
```

## Uso de la API

Autenticación con el encabezado `x-api-key`. Los parámetros van siempre en el cuerpo JSON, nunca en la URL, porque suelen ser datos personales.

```
POST /v1/<portal>/<modulo>
POST /v1/sanitas/sanitas-autorizaciones
x-api-key: rpa_cardioib_...

{ "tipo_doc": "CC", "num_doc": "79589789", "cups": "890328", "fecha_cita": "2026-09-15", "modo": "sync" }
```

Campos reservados, iguales para todos los módulos:

| Campo | Efecto |
|---|---|
| `modo` | `sync` espera la respuesta hasta `SYNC_TIMEOUT_MS`; `async` responde 202 de inmediato con la URL de estado |
| `callback_url` | Se le hace POST con el resultado cuando el trabajo termina |
| `forzar` | Ignora la caché de `CACHE_HORAS` y vuelve al portal |
| `prioridad` | 0 a 10; los trabajos con mayor prioridad se atienden primero |

Otros endpoints:

```
GET /v1/salud              estado del servicio y trabajos pendientes
GET /v1/modulos            módulos habilitados para el cliente autenticado
GET /v1/trabajos/:id       estado y resultado de un trabajo
```

Estados de un trabajo: `pendiente`, `en_proceso`, `completado`, `fallido`. Los resultados negativos de negocio (paciente no existe, sin contrato) llegan como `fallido` con un `error.codigo` propio del módulo y no se reintentan. Los errores de sesión o del portal se reintentan hasta `maxIntentos` y luego se marcan fallidos.

### Ejemplo: sanitas-autorizaciones

```json
{
  "id": "66e...", "estado": "completado", "modulo": "sanitas-autorizaciones",
  "resultado": {
    "paciente": { "nombre": "BELTRAN RODRIGUEZ, EDSON AUGUSTO", "estado_afiliacion": "VIGENTE", "plan": "10 REGIMEN CONTRIBUTIVO", "contrato": "1389266" },
    "autorizacion_seleccionada": { "numero": "333983714", "estado": "APROBADA", "cups": "890328", "descripcion": "CONSULTA DE CONTROL POR CARDIOLOGIA", "fecha_aprobacion": "2026-02-02", "fecha_vigencia": "2026-06-02" },
    "copago": { "condicion": "Cuota Moderadora", "valor_recaudo": 5000 },
    "semaforo": "VERDE",
    "observaciones": []
  },
  "capturas": ["https://res.cloudinary.com/.../05-copago.png"]
}
```

Semáforo: `VERDE` afiliado vigente con autorización aprobada y vigente para el CUPS pedido. `AMARILLO` hay autorización pero no coincide el CUPS, o el paciente tiene varios contratos. `ROJO` afiliación inactiva, sin autorización o vencida.

## Agregar un módulo nuevo

1. Crear `modulos/<sector>/<nombre>/` con `package.json` (nombre `@startia/modulo-<nombre>`) y `src/index.ts` que exporte `definirModulo({...})` con `nombre`, `sector`, `portal`, `parametros` (esquema zod), `credencialesRequeridas`, `sesionValida`, `iniciarSesion` opcional y `ejecutar`.
2. Añadirlo como dependencia en `modulos/registro/package.json`, a la lista en `modulos/registro/src/index.ts` y a `paths` en `tsconfig.json`.
3. Habilitarlo al cliente en `clientes.modulos` y cargar las credenciales del portal.

Lo que el módulo recibe en `ejecutar`: `parametros` ya validados, `credenciales` descifradas, `config` del cliente para ese módulo, la `page` de Playwright con la sesión del cliente, `capturar(nombre)` para evidencias y `log`. Lo que devuelve se guarda tal cual como `resultado`.

## Pendientes de la fase 0 del módulo Sanitas

Marcados con `VERIFICAR` en `modulos/salud/sanitas-autorizaciones/src`:

- Pantalla de login del validador: campos, botón y si hay captcha. Si lo hay, se usa `npm run sesion`.
- Orden de los combos del formulario de búsqueda y el botón de lupa.
- Control de selección en la primera celda de la tabla de autorizaciones.
- Textos exactos de las etiquetas del bloque de copago.

Grabar el flujo real:

```bash
npx playwright codegen "https://portal.colsanitas.com/sso/login?service=https%3A%2F%2Fappcore.colsanitas.com%2FValidadorDerechos%2Fpages%2Fgestion%2FValidacionDerechos.seam"
```

## Protección anti-bots del portal Sanitas

El Validador Sanitas está detrás de Radware Bot Manager. En la primera prueba (12/09/2026) un Chromium sin ventana fue desviado a una página de captcha de Radware antes de llegar al login. Por eso el worker:

- Corre con ventana visible (`HEADLESS=false`) en un PC con escritorio, no en un servidor sin pantalla.
- Usa un perfil de navegador persistente por cliente y portal (`PERFILES_DIR`), el mismo que abre `npm run sesion`. Una persona pasa el reto y el login una vez, y el worker sigue en ese perfil.
- No intenta resolver ni evadir los retos. Si el portal vuelve a pedirlos, el trabajo falla con `SESION_INVALIDA` y hay que repetir `npm run sesion`.

Esto confirma el riesgo previsto en la fase 0 y fija el escenario de despliegue del worker: PC de la clínica o de StartIA con sesión de Windows abierta.

## Despliegue

- **API** en Vercel: raíz del proyecto `api/`, variables `MONGODB_URI` y `MASTER_KEY`. Hono se detecta sin configuración adicional.
- **Worker** en un PC Windows con escritorio, del cliente o de StartIA. Un VPS sin pantalla no sirve para portales con anti-bots como Sanitas. Ejecutar `npm run worker` como servicio (NSSM o Tarea programada) con el `.env` de la raíz. Un worker atiende a varios clientes; se agregan más cuando el volumen lo pida.
