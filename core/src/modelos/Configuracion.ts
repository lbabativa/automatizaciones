import mongoose, { Schema, type InferSchemaType } from 'mongoose';

/** Pares clave/valor de la plataforma, por ejemplo la clave pública con la que la consola cifra credenciales. */
const ConfiguracionSchema = new Schema(
  {
    clave: { type: String, required: true, unique: true },
    valor: { type: Schema.Types.Mixed },
    actualizadoPor: { type: String },
  },
  { timestamps: true, collection: 'configuracion' },
);

export type ConfiguracionDoc = InferSchemaType<typeof ConfiguracionSchema> & { _id: mongoose.Types.ObjectId };

export const Configuracion = mongoose.models.Configuracion ?? mongoose.model('Configuracion', ConfiguracionSchema);
