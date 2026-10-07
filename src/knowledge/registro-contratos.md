# Conocimiento del proceso: registro de contratos vigentes

## Por qué existe
El maestro de contratos estaba congelado desde el 2026-05-30 y solo llegaban a administración los contratos con póliza. El buzón único reemplaza ese flujo: todo contrato firmado, con o sin póliza, debe quedar en el maestro.

## Clasificaciones
- **nuevo**: el contrato no está en el maestro (ni por número, ni por NIT del cliente + objeto similar). Se inserta.
- **actualizacion**: un otrosí, o el mismo contrato con algún valor distinto. Se modifica la fila existente y el cambio queda en el historial.
- **duplicado**: mismo número de contrato con el mismo valor y fechas. No se escribe nada.
- **rechazado**: el correo no trae un contrato (por ejemplo, una cotización), o el texto no tiene partes ni objeto identificables.

El mismo cliente puede tener varios contratos. Un NIT repetido no significa duplicado: se compara también el objeto.

## Confianza y revisión humana
Cada campo trae una confianza entre 0 y 1. Por debajo de 0.8 el campo va a revisión y el registro se detiene hasta que la analista confirme.
- 1.0: el valor en letras coincide con el valor en cifras, o las fechas cuadran con el plazo en meses.
- 0.85–0.95: el campo está en su cláusula, sin verificación cruzada.
- 0.5–0.75: el valor es derivado o ambiguo (plazo contado desde una firma sin día, contrato por demanda).
- 0: el campo no aparece en el documento. Nunca se inventa.

## Casos especiales
- **Contrato por demanda (contrato marco):** valor 0 y `valor_indeterminado = true`. Siempre requiere confirmación.
- **Plazo en meses desde la firma sin día:** se propone inicio el primer día del mes y fin al cierre del mes correspondiente. Siempre requiere confirmación.
- **Otrosí:** solo cambia lo que modifica (valor, plazo). Si exige ampliar garantías, la póliza pasa a `pendiente`.

## Pólizas
- Contrato nuevo con póliza → `estado_poliza = pendiente` hasta que el corredor la expida.
- Sin póliza → `no_aplica`.

## Ciclo de vida de la póliza
`pendiente` → `vigente` cuando el corredor la expide y la analista lo confirma; `vigente` → `vencida` si no se renueva. Un otrosí que amplía garantías la devuelve a `pendiente`. Cada cambio queda en el historial con su soporte (número de póliza, aseguradora).

## Acuse al comercial
Cada mensaje procesado genera un acuse para el remitente: registrado, actualizado, duplicado, rechazado (con el motivo y cómo reenviarlo) o en revisión (con los campos que se están validando). Es el cumplimiento de la regla de gobierno: el comercial siempre sabe qué pasó con lo que envió.

## Alertas
El reporte lista: contratos que vencen en 60 días o menos, pólizas exigidas que no están vigentes, contratos registrados desde el corte (2026-05-30) y contratos vencidos que siguen en el maestro.

## Dónde queda cada cosa
- Maestro: `out/sharepoint/maestro-contratos.csv` (el fixture original nunca se modifica).
- Documentos: `out/sharepoint/Contratos/<año>/<cliente>/<id>.<ext>`.
- Historial de cambios: `out/sharepoint/historial.jsonl`.
- Mensajes cerrados: `out/procesados.json`.
- Acuses a comerciales: `out/acuses/<mensaje>.md`.
