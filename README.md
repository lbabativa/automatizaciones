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

Definir el acceso a la consola web `/admin` (un solo operador). La contraseña se guarda como hash, nunca en claro:

```bash
ADMIN_PASSWORD=**** npm run admin:password   # imprime ADMIN_PASSWORD_HASH=... para pegar en .env.local junto con ADMIN_USER
```

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

## Flujos declarativos (sin código)

Además de los módulos en código, una automatización puede describirse como **datos**: parámetros de entrada, condición de sesión, login y una lista de pasos. El intérprete del núcleo (`core/src/flujos/`) los ejecuta con Playwright y los expone como un módulo más, así que API, worker y consola los tratan igual. Se guardan en la colección `flujos` y el worker los toma sin reiniciar (refresca la lista cada 30 s).

Ejemplo completo: [`flujos/sanitas-autorizaciones.json`](flujos/sanitas-autorizaciones.json), la versión declarativa del módulo de Sanitas con los mismos pasos y reglas.

```bash
npm run flujo:importar -- flujos/sanitas-autorizaciones.json              # guarda como borrador
npm run flujo:importar -- flujos/sanitas-autorizaciones.json --publicar   # lo deja disponible para API y worker
npm run probar -- cardioib sanitas-autorizaciones-flujo '{"num_doc":"79589789"}'   # lo ejecuta contra el portal real
npm run test:flujos    # prueba el intérprete contra un portal falso (core/test/portal-falso.html), sin Mongo ni credenciales
```

Tipos de paso: `ir`, `clic`, `escribir`, `seleccionar`, `presionar`, `esperar`, `leer`, `leer_lista`, `leer_tabla`, `leer_lineas`, `capturar`, `asignar`, `agregar`, `buscar`, `transformar`, `elegir`, `decidir`, `si`, `para_cada`, `error`, `fin`. Los elementos se ubican con un **objetivo** (`selector`, `texto`, `rol`+`nombre`, `etiqueta`, `placeholder`, con `con_texto`, `indice` y `dentro_de`). Cualquier texto admite plantillas `{{variable}}`: los parámetros de la consulta, `{{config.<clave>}}`, `{{credenciales.<campo>}}`, `{{hoy}}` y todo lo leído en pasos anteriores. Las condiciones de `si`, `decidir` y `elegir` comparan variables (`igual`, `contiene`, `coincide`, `vacio`, `mayor`...) o la página (`existe`, `texto_visible`, `url_coincide`). El esquema completo está en `core/src/flujos/esquema.ts`.

Dentro de los textos que se ejecutan en el navegador (`page.evaluate`) no se pueden declarar funciones con nombre: bajo tsx, esbuild les inyecta un helper `__name` que en la página no existe. Por eso esas lecturas van como texto.

### Editor de flujos en la consola

En `/admin/flujos` se crean y editan los flujos sin tocar código: datos generales, parámetros de entrada, condición de sesión y login, pasos (con formularios por tipo, pasos anidados en `si` y `para_cada`, reordenar, duplicar, pegar JSON), plantilla del resultado, clientes habilitados y la definición completa en JSON.

Ciclo de trabajo:

1. **Guardar borrador**: valida contra el esquema y guarda sin afectar producción.
2. **Probar aquí**: encola una prueba con la sesión real de un cliente. El worker usa el borrador, captura después de cada paso que toca la página y escribe una bitácora que la consola muestra en vivo, con el resultado o el paso exacto donde falló.
3. **Publicar**: el borrador pasa a ser la versión que ejecutan la API y el worker (sube la versión). El worker toma la nueva versión sin reiniciarse.

Un flujo publicado se habilita a un cliente desde la pestaña Clientes y desde ese momento aparece en Consultas y responde en `POST /v1/<portal>/<nombre>` con la clave del cliente.

### Elegir selectores desde las capturas y versiones

En cada prueba lanzada desde el editor, el worker guarda además de la captura los **elementos de la página** (posición sobre la captura, texto, rol, etiqueta, placeholder) con objetivos sugeridos del más estable al menos, en la colección `inspecciones` (se borran a los 7 días). En el editor:

- El botón 📷 junto a cualquier objetivo abre el **inspector**: la captura del paso con los elementos resaltados y una lista filtrable. Un clic en un elemento muestra sus objetivos sugeridos y "Usar" lo escribe en el paso.
- Desde la miniatura de una captura en "Probar aquí" se abre el mismo inspector para copiar un objetivo o **añadir un paso nuevo** (clic, escribir, leer, esperar, seleccionar) con ese elemento.
- La pestaña **Versiones** lista cada publicación; se puede ver, comparar con el borrador (diferencias línea a línea) y restaurar como borrador para volver a publicarla.

### Grabador de acciones

Desde el editor, **⏺ Grabar** pide a un worker con ventana visible (`HEADLESS=false`, el del PC de la clínica) que abra el portal con la sesión del cliente. Lo que la persona hace en esa ventana se convierte en pasos: clics (`clic`), texto (`escribir`, con `tecla: Enter` si se confirmó así), listas (`seleccionar`). Alt+clic sobre un dato crea un paso `leer` con su etiqueta detectada; Ctrl+Shift+S crea una `capturar`. Los valores de prueba indicados al iniciar quedan en los pasos como `{{parametro}}`. Se termina con "Detener" en la barra flotante de la ventana o desde la consola, y los pasos se añaden al borrador en la posición elegida. Cada paso trae `alternativas` con otros objetivos posibles, por si el sugerido no es estable.

`npm run test:grabador` prueba el grabador contra el portal falso con acciones simuladas.

### Clientes desde la consola

En `/admin/clientes` se crean clientes, se genera o rota su clave de API, se habilitan automatizaciones con su configuración propia y se cargan las **credenciales por portal**. Un flujo nunca lleva usuario ni contraseña: usa `{{credenciales.usuario}}` y `{{credenciales.password}}`, y el worker las toma del cliente para el que ejecuta.

Las credenciales que se guardan desde la consola se cifran con la **clave pública del worker** (X25519 + AES-256-GCM, formato `v2.`), derivada de `MASTER_KEY` y publicada por el worker al arrancar en la colección `configuracion`. La API en Vercel puede cifrar pero nunca descifrar; el worker descifra tanto este formato como el simétrico clásico de los scripts. Por eso, antes de cargar credenciales desde la web, hay que haber arrancado el worker al menos una vez.

Entrega 2 del grabador: **pausar y reanudar** (botón en la barra, Ctrl+Shift+P o desde la consola; en pausa no se graba nada, útil para navegar o iniciar sesión), **deshacer** el último paso (↶ o Ctrl+Shift+Z), gestos adicionales: Shift+clic crea `esperar`, Ctrl+clic crea un `si` con condición "existe" listo para llenar, Alt+Shift+clic sobre una tabla crea `leer_tabla`. En la consola se puede quitar cualquier paso grabado o desmarcarlo antes de añadir. En el editor, cada paso tiene una casilla: los marcados se pueden **envolver en `si` o en `para_cada`** o quitar en grupo.

### Asistente de nueva automatización

`/admin/nueva` guía el alta completa en ocho pasos: primero el cliente y sus códigos, después el flujo. Cada paso se guarda como borrador al continuar y el enlace (`?c=<cliente>&f=<flujo>&paso=<paso>`) permite retomarlo; desde el editor de flujos, "Continuar en el asistente" abre el mismo punto.

1. **Cliente y códigos**: elegir o crear el cliente. El identificador se genera del nombre (sin la forma societaria: "Clínica Norte S.A.S." → `clinica-norte`) y la clave de API se muestra una sola vez al crearla o rotarla.
2. **Portal y acceso**: qué hace el robot y la URL de inicio; el portal y el nombre técnico se deducen. Credenciales del cliente para ese portal (cifradas con la clave pública del worker) y el texto que confirma la sesión, o "sin inicio de sesión".
3. **Datos de entrada**: parámetros con atajos (tipo y número de documento, fecha). Los valores de prueba viven solo en la pestaña del navegador (`sessionStorage`), no en el flujo.
4. **Grabar**: indica si hay un robot con ventana conectado y sigue la grabación en vivo. Si detecta usuario y contraseña, propone moverlos a `sesion.login`; `credenciales_requeridas` se calcula a partir de los pasos.
5. **Condiciones**: mapa del flujo con los otros caminos. Hay casos frecuentes de un clic (tabla sin resultados, el portal muestra un mensaje, según un valor) y "＋ Condición aquí" entre cualquier par de pasos. Cada condición es un paso `si` de nivel superior: *si* un dato (de entrada o leído antes de ese punto) es igual, distinto, contiene, está vacío, tiene valor, es mayor o menor, o si aparece o no un texto en pantalla; *entonces* terminar y devolver valores (`asignar` + `fin`), terminar con error de negocio (`error`, sin reintentos), guardar un valor y seguir, o hacer otros pasos. Los pasos de un camino se graban con "Grabar este camino" (se pausa con Ctrl+Shift+P hasta llegar al punto) y pueden terminar la consulta al acabar. Lo que no encaja en estas formas se muestra como condición avanzada y se conserva; el "si no" siempre sigue con el paso siguiente salvo que se defina en el editor avanzado. Los cambios se guardan solos cuando la condición está completa.
6. **Qué devuelve**: elige qué variables leídas van en `resultado` y con qué nombre.
7. **Probar**: prueba con el robot real y bitácora en vivo; cuenta como correcta si terminó después del último cambio del borrador.
8. **Publicar y entregar**: revisión (credenciales que faltan, valores `{{config.*}}` del cliente), publica, habilita para el cliente y entrega la URL, la clave y ejemplos en cURL, JavaScript y Python. Los ejemplos usan valores ficticios, nunca los de prueba.

La ficha del cliente (`/admin/clientes`) muestra los mismos códigos de integración para cada automatización habilitada y genera el identificador al escribir el nombre.

Cada worker publica un latido cada 30 s en `configuracion` (`worker:<WORKER_ID>`, con `ventana: true` si corre con `HEADLESS=false`); la consola lo lee en `GET /admin/api/estado` (`workers`). Al grabar, cualquier valor escrito que coincida con una credencial del cliente queda como `{{credenciales.<campo>}}`, y lo escrito en un campo de contraseña nunca se guarda en claro. Cada lectura grabada recibe su propia variable, sin tildes ni espacios: "Fecha de afiliación" queda `fecha_de_afiliacion`, y dos lecturas sin etiqueta o dos tablas quedan `valor`, `valor_2` y `filas`, `filas_2`. Al añadir pasos grabados a un flujo que ya usa ese nombre, se renombran con el siguiente sufijo libre.


### Dominios permitidos por cliente (CORS)

En la ficha del cliente (`/admin/clientes` › Dominios permitidos) se configuran los sitios web desde los que un navegador puede llamar a la API con la clave de ese cliente: `https://portal.cardioib.com`, o `https://*.cardioib.com` para todos sus subdominios (el comodín no incluye el dominio raíz). Van sin ruta; la consola los valida, normaliza y quita duplicados.

- **Preflight:** `OPTIONS /v1/*` responde 204 con `Access-Control-Allow-Origin` solo si el dominio está configurado en algún cliente (la unión se refresca cada minuto); si no, 403. Las respuestas a dominios configurados llevan `Access-Control-Allow-Origin` para que el portal pueda leer también los errores.
- **Con la clave:** si la petición trae `Origin` y no está en la lista de ese cliente, responde `403 ORIGEN_NO_PERMITIDO`.
- **Sin `Origin` (desde servidores):** se acepta, salvo que se desmarque "Permitir también llamadas desde servidores" (`permitirSinOrigen: false`), que responde `403 ORIGEN_REQUERIDO`.

El `Origin` lo pone el navegador. Evita que otra página web use una clave del cliente, pero un programa puede falsificarlo: la protección de fondo sigue siendo guardar la clave en el servidor del cliente. `npm run test:origenes` prueba la validación y la coincidencia de patrones.


### Lotes

Muchas consultas de una automatización en una sola solicitud, por API o con un Excel o CSV desde la consola. El robot las sigue haciendo una por una; el lote agrupa el envío, el avance y los resultados.

- **Por API:** `POST /v1/<portal>/<automatizacion>/lote` con `{ "items": [ { ...parámetros }, … ], "nombre"?, "forzar"?, "programar_para"? }` (máximo 1.000 filas; `programar_para` en ISO 8601 con zona). Si alguna fila no cumple los parámetros responde `400 ITEMS_INVALIDOS` con el índice y el motivo de cada una, y no crea nada. Si todo está bien responde `202` con el id, `estado_url` y `resultado_url`. Una llamada de lote cuenta una sola vez para el límite por minuto.
- `GET /v1/lotes/<id>`: estado (`programado`, `en_cola`, `procesando`, `terminado`, `cancelado`), contadores por fila, `restante_ms` estimado con un robot, e `items` paginados (`?desde=0&limite=100&estado=completado|fallido|activos`).
- `GET /v1/lotes/<id>/resultado?formato=xlsx|csv`: una fila por consulta con parámetros, estado, cada campo del resultado y el error. `POST /v1/lotes/<id>/cancelar` cancela lo que no ha empezado.
- **Consola:** `/admin/lotes` › Nuevo lote: cliente y automatización, Excel (.xlsx) o CSV (`;`, `,` o tabulador), columnas asignadas solas por nombre y ajustables (convierte "Cédula de ciudadanía" en `CC`, fechas de Excel y DD/MM/AAAA), revisión fila por fila con errores y repetidas, y "Ahora" o "Programar". La plantilla de cada automatización se descarga en Excel o CSV. El detalle se actualiza cada 5 s, filtra por estado, cancela pendientes y descarga los resultados.
- **Cómo se procesa:** cada fila única es un trabajo con `loteId` y prioridad −1, así que las consultas sueltas pasan delante. Las filas repetidas comparten trabajo y las ya consultadas en las últimas `CACHE_HORAS` reutilizan el resultado (salvo `forzar`). Un lote programado deja sus trabajos en estado `programado` y el worker los pasa a la cola cuando llega la hora (`activarProgramados`, cada 15 s), así que **necesita el worker actualizado**. Al cerrar cada trabajo, `completar` y `fallar` recalculan el lote.
- Los módulos en código exponen sus parámetros derivados del esquema zod (`parametrosDesdeZod`), para formularios y para asignar columnas.
- El Excel se genera y se lee sin dependencias: zip con `zlib` en el servidor y `DecompressionStream` en el navegador.
