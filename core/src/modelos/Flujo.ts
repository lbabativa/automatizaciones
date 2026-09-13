import mongoose, { Schema, type InferSchemaType } from 'mongoose';

export const ESTADOS_FLUJO = ['borrador', 'publicado'] as const;

/**
 * Flujo declarativo guardado en Mongo. `definicion` cumple FlujoDefSchema (core/src/flujos/esquema.ts).
 * `version` sube en cada publicación; `borrador` guarda la edición en curso sin afectar producción.
 */
const FlujoSchema = new Schema(
  {
    nombre: { type: String, required: true, unique: true, lowercase: true, trim: true },
    estado: { type: String, enum: ESTADOS_FLUJO, default: 'borrador', index: true },
    version: { type: Number, default: 0 },
    /** Definición publicada (la que ejecutan API y worker). */
    definicion: { type: Schema.Types.Mixed },
    /** Definición en edición, aún no publicada. */
    borrador: { type: Schema.Types.Mixed },
    publicadoEn: { type: Date },
  },
  { timestamps: true, collection: 'flujos' },
);

export type FlujoDoc = InferSchemaType<typeof FlujoSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };

export const Flujo = mongoose.models.Flujo ?? mongoose.model('Flujo', FlujoSchema);
