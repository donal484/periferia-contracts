import type { z } from "zod";
import type { ToolCtx } from "../lib/paths";

export type { ToolCtx };

/**
 * Contrato de herramienta del PRD (6.2): descripción de una frase, argumentos zod
 * con .describe() y execute que devuelve SIEMPRE un string JSON { ok, data } o { ok, error }.
 */
export type Herramienta<S extends z.ZodRawShape> = {
  description: string;
  args: S;
  execute: (args: z.infer<z.ZodObject<S>>, ctx: ToolCtx) => Promise<string>;
};

/** Ayuda a TypeScript a inferir el tipo de los argumentos sin repetirlo. */
export function herramienta<S extends z.ZodRawShape>(h: Herramienta<S>): Herramienta<S> {
  return h;
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string };
