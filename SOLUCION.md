# SOLUCIÓN · Reto 02 — Registro de Contratos Vigentes

> Las secciones marcadas con ⚠️ requieren datos que solo puedo medir en mi despliegue (costo real, link).

## 1. Problema en una frase

Periferia no sabe qué contratos tiene vigentes ni qué pólizas vencen, porque el maestro murió con la salida de una persona y solo llegan a administración los contratos con póliza. Le duele a la analista administrativa (dueña del maestro), a la gerencia (sin visibilidad de vencimientos) y a la empresa (riesgo por pólizas no constituidas).

## 2. Arquitectura

```
┌───────────────┐  POST /api/chat  ┌──────────────────────────────────────────┐
│ web/ (chat)   │ ───────────────▶ │ src/server.ts (Hono sobre Bun)           │
│ historial     │ ◀─────────────── │  └─ src/agent/cycle.ts                   │
│ traza de      │  reply, toolCalls│      prompt → LlmAdapter → herramientas  │
│ herramientas  │  needsConfirm.   │      tope de pasos, tope de tokens,      │
│ banda de      │  pending         │      compuerta de confirmación (CA3)     │
│ confirmación  │                  │  └─ src/llm/{openai,anthropic}.ts        │
└───────────────┘                  └───────────────┬──────────────────────────┘
                                                   │ run(args) validado con zod
                                   ┌───────────────▼──────────────────────────┐
                                   │ src/tools/contratos.ts (7 herramientas)  │
                                   │  └─ src/lib/evaluacion.ts  RN1–RN5       │
                                   │  └─ src/lib/extraction.ts  determinista  │
                                   │  └─ src/lib/reglas.ts      parámetros    │
                                   └──────┬────────────────────────┬──────────┘
                                 fixtures/ (solo lectura)     out/ (escritura)
```

Separación pedida en el PRD:

| Qué | Dónde | Efecto de cambiarlo |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Se relee en cada turno; no requiere reiniciar. |
| Conocimiento | `src/knowledge/registro-contratos.md` | Igual. |
| Parámetros de negocio | `src/lib/reglas.ts` (umbral 0.8, 60 días, corte, NIT propio) | No toca servidor ni ciclo. |
| Ejecución | `src/tools/` + `src/lib/` | Importables desde `demo.ts` y `modulo/` sin el servidor. |

## 3. Ciclo del agente

`ejecutarTurno` en `src/agent/cycle.ts`:

1. Arma el system prompt (prompt + conocimiento) y agrega el mensaje del usuario al historial de la sesión.
2. Llama al modelo con las 7 herramientas (las 5 del PRD más `consultar` y `actualizar_poliza`). Si responde sin herramientas, termina el turno.
3. Si pide herramientas, las ejecuta (validando argumentos con zod), guarda cada llamada en la vista del chat y en `out/log.jsonl`, y vuelve al paso 2.
4. **Tope de iteraciones (CA1):** `MAX_AGENT_ITERATIONS` (25). Al alcanzarlo responde con lo ejecutado y lo pendiente.
5. **Tope de tokens:** `MAX_SESSION_TOKENS` por sesión, contado con el `usage` que devuelve el proveedor.
6. **Errores (CA5):** si el proveedor está saturado (503), limita la tasa (429) o no responde, se reintenta dos veces y luego se pasa al modelo de respaldo (`GEMINI_FALLBACK_MODELS`, y después cualquier otro proveedor con clave). `LlmConRespaldo` implementa la misma interfaz, así que el ciclo no cambia. Un error no transitorio (clave inválida) no cambia de modelo. Si ninguno responde, el error se muestra legible y la sesión sigue viva. Las herramientas nunca lanzan: devuelven `{ ok: false, error }`.

**Confirmación humana (CA3), aplicada por el backend y no solo por el prompt:**

- La sesión guarda `pendientes`: mensajes cuyo `contratos_validar` o `contratos_registrar` reportó campos en revisión. El backend calcula `needsConfirmation` a partir de ese estado, no del texto del modelo.
- La compuerta aplica a toda herramienta que escribe con `confirmado: true`: `contratos_registrar` (por mensaje) y `contratos_actualizar_poliza` (por contrato). Una llamada así solo se ejecuta si ese mensaje ya estaba pendiente **antes** del último mensaje del usuario, y ese mensaje es una confirmación (no empieza con "no", "espera", "cancela"). Si el modelo intenta confirmar por su cuenta en el mismo turno, el backend bloquea la llamada y le devuelve el motivo.
- El front muestra la banda "Esperando tu confirmación" con cada campo, su valor propuesto y el motivo, y un botón para confirmar.

## 4. Elección del modelo

- **Proveedor usado:** Google Gemini (`gemini-2.5-flash`) a través de su API compatible con OpenAI, por su capa gratuita. También están implementados OpenAI y Anthropic (`LLM_PROVIDER`). Cambiar de proveedor no toca el ciclo: todos implementan `LlmAdapter.enviar(mensajes, herramientas)`.
- **Nota sobre la capa gratuita:** Google puede usar los datos enviados para mejorar sus modelos; aceptable aquí porque los fixtures son ficticios, no para contratos reales.
- **Por qué un modelo pequeño:** el modelo solo orquesta y redacta. La extracción, la clasificación y la escritura son deterministas, así que no se necesita un modelo grande para acertar los valores.
- ⚠️ **Costo por caso:** cada respuesta de `/api/chat` trae `usage` (tokens de entrada y salida del turno). Costo por caso ≈ tokens del turno de "procesa el buzón" ÷ 6 mensajes × precio por token del modelo. Completar con la cifra medida en el despliegue.

## 5. Estrategia de extracción

Todo en `src/lib/extraction.ts`, sin modelo:

- **Tipo de documento** por contenido, no por nombre de archivo: contrato, contrato marco, otrosí o cotización.
- **Partes:** se leen todas las partes con su NIT/RUC y se elige la que cumple el rol de CONTRATANTE y no es Periferia (NIT 900123456). La razón social con mayúsculas correctas se toma del bloque de firmas.
- **NIT:** sin puntos ni dígito de verificación. **País:** por la forma del identificador (NIT con DV → CO; RUC de 13 dígitos terminado en 001 → EC; RUC de 11 → PE) y cruzado con el domicilio.
- **Valor:** se interpreta la cifra según la convención de la moneda (`$265.000.000` vs `USD 120,000.00`) y se verifica contra el valor en letras.
- **Plazo:** rango "desde … hasta …" verificado contra el número de meses; plazo "desde la firma" calculado desde la fecha de firma.
- **Póliza:** tipos de la cláusula de garantías; condición y porcentaje como notas.

**Confianza por campo:**

| Confianza | Cuándo |
|---|---|
| 1.0 | Hay verificación cruzada: letras = cifras, fechas = plazo en meses, identificador = domicilio. |
| 0.85–0.95 | El campo está en su cláusula, sin verificación cruzada. |
| 0.5–0.75 | Valor derivado o ambiguo: contrato por demanda, firma sin día, fecha calculada. |
| 0.4 | El modelo propuso un valor distinto al del documento. |
| 0 | El campo no aparece. Queda `null`, nunca se inventa. |

**Dónde entra el modelo y dónde no:** el modelo decide el orden de las llamadas, interpreta la respuesta de la analista y redacta. No fija valores: `contratos_validar` y `contratos_registrar` vuelven a extraer del documento, y cualquier valor del modelo que difiera pasa a revisión humana. Lo que se registra es exactamente lo que se validó (ambas usan `evaluar()`).

## 6. Regla de gobierno (propuesta)

1. **Canal único.** Todo contrato se envía a `contratos@periferia.com`. Lo administra la analista administrativa, que es la dueña del maestro; su jefe directo es suplente.
2. **Obligación del comercial.** Dentro de los 3 días hábiles siguientes a la firma envía el PDF firmado por ambas partes, cada otrosí y cada acta de terminación o liquidación, con o sin póliza. Asunto: `[CONTRATO] <Cliente> - <N.º contrato>` (o `[OTROSÍ]`, `[TERMINACIÓN]`).
3. **Acuse automático.** Al procesar cada mensaje el agente redacta la respuesta al comercial: registrado (con número, valor, vigencia y ruta), actualizado (con los cambios), duplicado, rechazado (con el motivo y cómo reenviarlo) o en revisión (con los campos que se validan). En el reto queda como borrador en `out/acuses/`; en producción se envía por Exchange en el mismo momento.
4. **Excepciones y escalamiento.** Sin firma, sin valor o con campos dudosos: queda pendiente y la analista confirma o pide la corrección al comercial. Si en 5 días hábiles no se resuelve, se escala al gerente comercial.
5. **Cierre del gap (junio–agosto 2026).** Una campaña de dos semanas: se cruza la facturación emitida de junio a agosto contra el maestro, se envía a cada comercial la lista de clientes facturados sin contrato registrado y se exige el envío por el canal único antes de una fecha límite.
6. **Indicador mensual.** % de clientes facturados en el mes que tienen contrato vigente en el maestro (meta: 100%). Secundario: días promedio entre firma y registro.

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista (regex + verificación cruzada). | Extraer con el modelo. | Resultados repetibles, demo sin clave y confianza explicable. Costo: es frágil ante formatos nuevos (ver Riesgos). |
| `registrar` vuelve a extraer del documento y solo acepta correcciones confirmadas. | Registrar el objeto `contrato` que envía el modelo. | Hace imposible que el modelo "redondee" un valor (CA2 por diseño, no por prompt). |
| La confirmación la controla el backend (estado `pendientes` + compuerta). | Detectar en el texto del modelo si pidió confirmación. | El texto del modelo no es una fuente confiable; el estado sí. |
| Un otrosí actualiza solo los campos que cambia. | Reemplazar la fila con lo extraído. | Un otrosí no trae objeto ni fecha de inicio; reemplazar borraría datos. |
| Front en HTML + JS sin framework. | React. | Sin build, un solo servicio, menos que explicar. Suficiente para el alcance. |
| `modulo/` se genera desde las fuentes de la app y la demo verifica que estén sincronizados. | Copiar los archivos. | El PRD evalúa que no haya copias divergentes. |
| Cadena de modelos de respaldo dentro de un adaptador (`LlmConRespaldo`). | Manejar el cambio de modelo en el ciclo del agente. | El ciclo sigue sin saber qué proveedor usa; la capa gratuita de Gemini se satura y esto evita que la demo falle. |
| Acuse generado por `registrar`, no por el modelo. | Pedirle al modelo que redacte cada acuse. | El acuse sale siempre, con datos exactos y sin costo; el comercial recibe lo mismo sin importar cómo conversó la analista. |
| Consulta y cambio de póliza como herramientas adicionales. | Limitarse a las 5 herramientas del PRD. | El primer dolor del PRD es "¿qué contratos vencen este trimestre?" y la alerta de pólizas pendientes nunca se limpiaba; sin esto el producto registra pero no da visibilidad ni cierra el riesgo. |
| Sesiones en memoria. | Persistirlas en archivo. | El PRD lo permite; un reinicio pierde el chat, pero no el maestro (que está en `out/`). |

## 8. Supuestos

- `fecha_registro` es la fecha de recepción del correo (hace la demo determinista).
- Contrato firmado "en el mes de agosto de 2026" sin día: se propone inicio 2026-08-01 y fin 2027-08-31 (cierre de mes, cubre cualquier día de firma). Inicio y fin van a revisión.
- Un otrosí que exige ampliar garantías deja `estado_poliza = pendiente`.
- El contrato marco con póliza condicional (órdenes > COP 100 M) se registra con `requiere_poliza = true` y póliza `pendiente`, para que alguien la vigile.
- Si el remitente no está en `comerciales.json`, el campo `comercial` guarda su correo.
- El documento de un otrosí se archiva como `<id>-otrosi-<mensaje>.txt` sin reemplazar el contrato; la fila conserva la ruta del contrato original y el historial guarda la del otrosí.
- El reporte agrega una sección "Vencidos sin cierre": contratos con fecha fin pasada que siguen en el maestro de vigentes.
- Duplicados y rechazados se marcan en `procesados.json` (no escriben el maestro) para que el buzón quede vacío.

## 9. Cobertura

| Historia / regla | Estado | Nota |
|---|---|---|
| HU-1 Leer el buzón | Hecho | `tiene_contrato` por contenido; rechazados con motivo. |
| HU-2 Extraer | Hecho | Confianza por campo; `null` con confianza 0 si falta. |
| HU-3 Validar | Hecho | RN1–RN4; remitente desconocido se reporta sin bloquear. |
| HU-4 Registrar y archivar | Hecho | Maestro, archivo, historial, procesados. |
| HU-5 Alertas | Hecho | Fecha `hoy` como argumento. |
| HU-6 Errores | Hecho | Texto vacío, fecha inválida, moneda desconocida, mensaje inexistente. |
| CA1–CA5 | Hecho | Ver sección 3. |
| `contratos_leer_pdf` (P1) | No hecho | |
| Bonus `modulo/` | Hecho | `bun run build:modulo`; la demo verifica sincronía. |
| Extra: consultar el maestro | Hecho | `contratos_consultar`: cliente/NIT, rango de vencimiento, vigencia, estado de póliza, país. |
| Extra: ciclo de vida de la póliza | Hecho | `contratos_actualizar_poliza` con confirmación e historial. |
| Extra: acuse al comercial | Hecho (borrador) | `out/acuses/`; falta el envío real. |
| Extra: vista de reporte | Hecho | Botón "Ver reporte": alertas, maestro y acuses. |

**Para producción falta:** lectura de PDF y OCR, conexión real a Exchange y SharePoint (Microsoft Graph), envío real de los acuses, autenticación, persistencia con control de concurrencia y un estado de cierre del contrato (terminado/liquidado) para sacar los vencidos del maestro de vigentes.

## 10. Uso de IA

- **Cursor:** generó el esqueleto inicial (estructura de carpetas, servidor Hono, adaptador de OpenAI, front básico y una primera versión de las herramientas).
- **Claude:** revisión del PRD y de los fixtures para identificar los casos trampa, y reescritura de la extracción, la clasificación, el ciclo del agente, el adaptador de Anthropic, el front, la demo y esta documentación.
- **Qué descarté de lo propuesto:**
  - La primera versión de las herramientas clasificaba mal 5 de 6 mensajes: la regex del número de contrato no reconocía el título, el otrosí se procesaba como contrato y perdía campos, y el valor del contrato marco quedaba sin fechas.
  - La detección de "pide confirmación" por expresiones regulares sobre el texto del modelo; se reemplazó por estado en el backend.
  - La idea de deduplicar solo por NIT: el mismo cliente tiene varios contratos (Industrias Delta, Corporación Andina, Distribuidora Caribe).

## 11. Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| Contratos con formatos distintos rompen las expresiones regulares. | Usar el modelo como segundo extractor y comparar: si coinciden, alta confianza; si difieren, revisión humana. |
| PDFs escaneados. | OCR con validación cruzada (letras vs cifras) antes de confiar. |
| Instrucciones maliciosas dentro de un correo o contrato (prompt injection). | El modelo nunca recibe el texto crudo del contrato, solo campos estructurados; las escrituras exigen confirmación. |
| Dos procesos escribiendo el CSV a la vez. | Base de datos o lista de SharePoint con bloqueo optimista. |
| Falsos duplicados por variaciones del nombre del cliente. | Dedupe por NIT + objeto, nunca por nombre. |
| Costo descontrolado del link público. | `ACCESS_KEY`, tope de tokens por sesión y de pasos por turno. |
| Datos personales y confidencialidad de los contratos. | Almacenamiento con permisos por rol y retención definida. |
