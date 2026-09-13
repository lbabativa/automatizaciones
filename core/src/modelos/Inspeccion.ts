import mongoose, { Schema, type InferSchemaType } from 'mongoose';

/**
 * Elementos de la página en el momento de una captura de un trabajo de prueba:
 * posición sobre la captura (a página completa), texto y sugerencias de objetivo.
 * Sirven para elegir selectores con un clic desde el editor de flujos.
 * Se borran solos a los 7 días.
 */
const ElementoSchema = new Schema(
  {
    /** Etiqueta HTML en minúsculas: button, input, td... */
    tag: { type: String, required: true },
    /** Texto visible, recortado. */
    texto: { type: String, default: '' },
    /** Caja en píxeles de la página completa: [x, y, ancho, alto]. */
    caja: { type: [Number], required: true },
    id: { type: String },
    name: { type: String },
    placeholder: { type: String },
    rol: { type: String },
    etiqueta: { type: String },
    tipo: { type: String },
    /** Posición entre los elementos del mismo rol (para combobox 0, 1, 2...). */
    indiceRol: { type: Number },
    /** Objetivos sugeridos, del más estable al menos: [{ selector }, { rol, nombre }, { texto, exacto }...]. */
    sugerencias: { type: [Schema.Types.Mixed], default: [] },
  },
  { _id: false },
);

const InspeccionSchema = new Schema(
  {
    trabajoId: { type: Schema.Types.ObjectId, required: true, index: true },
    /** Nombre de la captura a la que corresponde (paso-3-clic, 01-busqueda...). */
    captura: { type: String, required: true },
    url: { type: String },
    ancho: { type: Number },
    alto: { type: Number },
    elementos: { type: [ElementoSchema], default: [] },
    createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 3600 },
  },
  { collection: 'inspecciones' },
);
InspeccionSchema.index({ trabajoId: 1, captura: 1 }, { unique: true });

export type ElementoInspeccion = InferSchemaType<typeof ElementoSchema>;
export type InspeccionDoc = InferSchemaType<typeof InspeccionSchema> & { _id: mongoose.Types.ObjectId };

export const Inspeccion = mongoose.models.Inspeccion ?? mongoose.model('Inspeccion', InspeccionSchema);
