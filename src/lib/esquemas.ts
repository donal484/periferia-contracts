import { z } from "zod";
import { REGLAS } from "./reglas";

const fechaIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "formato YYYY-MM-DD")
  .describe("Fecha en formato YYYY-MM-DD");

/**
 * Valores de contrato que el modelo (o la analista, vía el modelo) propone.
 * Todos son opcionales: lo que no se envía se toma del documento.
 * Cualquier valor distinto al documento pasa a revisión humana.
 */
export const ContratoPropuestaSchema = z
  .object({
    id_contrato: z.string().nullable().optional().describe("Número del contrato tal como aparece en el documento"),
    cliente: z.string().nullable().optional().describe("Razón social del CONTRATANTE"),
    nit_cliente: z.string().nullable().optional().describe("Identificador tributario sin puntos ni dígito de verificación"),
    pais: z.enum(REGLAS.paises).nullable().optional().describe("País del cliente"),
    objeto: z.string().max(200).nullable().optional().describe("Objeto del contrato, máx. 200 caracteres"),
    valor: z.number().nonnegative().nullable().optional().describe("Valor total sin separadores; 0 si es por demanda"),
    moneda: z.enum(REGLAS.monedas).nullable().optional().describe("Moneda del valor"),
    valor_indeterminado: z.boolean().nullable().optional().describe("true si el contrato es por demanda y no fija valor"),
    fecha_inicio: fechaIso.nullable().optional(),
    fecha_fin: fechaIso.nullable().optional(),
    requiere_poliza: z.boolean().nullable().optional().describe("true si el contrato exige póliza"),
    tipo_poliza: z.string().nullable().optional().describe("Tipos de póliza separados por ';'"),
  })
  .describe("Valores propuestos para el contrato. Omite los campos que no quieras cambiar.");

export type ContratoPropuesta = z.infer<typeof ContratoPropuestaSchema>;
