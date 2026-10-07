import { z } from "zod";
import type { Herramienta, ToolCtx } from "./tipos";
import * as contratos from "./contratos";

export type JsonSchema = { [k: string]: unknown };

/** Convierte un esquema zod a JSON Schema (solo los tipos que usan las herramientas). */
export function zodAJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const descripcion = schema.description ? { description: schema.description } : {};
  if (schema instanceof z.ZodOptional) return { ...zodAJsonSchema(schema.unwrap()), ...descripcion };
  if (schema instanceof z.ZodNullable) {
    const interno = zodAJsonSchema(schema.unwrap());
    return { ...interno, type: [interno.type, "null"], ...descripcion };
  }
  if (schema instanceof z.ZodString) return { type: "string", ...descripcion };
  if (schema instanceof z.ZodNumber) return { type: "number", ...descripcion };
  if (schema instanceof z.ZodBoolean) return { type: "boolean", ...descripcion };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options, ...descripcion };
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodAJsonSchema(v);
      if (!v.isOptional()) required.push(k);
    }
    return { type: "object", properties, required, additionalProperties: false, ...descripcion };
  }
  return { type: "string", ...descripcion };
}

export type HerramientaRegistrada = {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Valida con zod y ejecuta. Si los argumentos no cumplen, devuelve el error al modelo sin ejecutar. */
  run: (raw: unknown, ctx: ToolCtx) => Promise<string>;
};

function registrarHerramienta<S extends z.ZodRawShape>(archivo: string, exportName: string, h: Herramienta<S>): HerramientaRegistrada {
  const schema = z.object(h.args);
  return {
    name: `${archivo}_${exportName}`,
    description: h.description,
    parameters: zodAJsonSchema(schema),
    async run(raw, ctx) {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) {
        const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
        return JSON.stringify({ ok: false, error: `argumentos inválidos: ${detalle}` });
      }
      return h.execute(parsed.data, ctx);
    },
  };
}

/** El nombre que ve el modelo es <archivo>_<export> (PRD 6.2). */
export const herramientas: HerramientaRegistrada[] = [
  registrarHerramienta("contratos", "leer_buzon", contratos.leer_buzon),
  registrarHerramienta("contratos", "extraer", contratos.extraer),
  registrarHerramienta("contratos", "validar", contratos.validar),
  registrarHerramienta("contratos", "registrar", contratos.registrar),
  registrarHerramienta("contratos", "alertas", contratos.alertas),
  registrarHerramienta("contratos", "consultar", contratos.consultar),
  registrarHerramienta("contratos", "actualizar_poliza", contratos.actualizar_poliza),
];

export function buscarHerramienta(nombre: string): HerramientaRegistrada | undefined {
  return herramientas.find((h) => h.name === nombre);
}
