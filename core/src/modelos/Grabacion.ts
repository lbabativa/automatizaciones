import mongoose, { Schema, type InferSchemaType } from 'mongoose';

export const ESTADOS_GRABACION = ['solicitada', 'grabando', 'terminada', 'cancelada', 'fallida'] as const;

/**
 * Grabación de acciones en un portal para convertirlas en pasos de un flujo.
 * La consola crea la solicitud; un worker con ventana visible la toma, abre el
 * portal con la sesión del cliente y registra cada acción como un paso.
 */
const GrabacionSchema = new Schema(
  {
    flujoNombre: { type: String, index: true },
    clienteSlug: { type: String, required: true },
    portal: { type: String, required: true },
    urlInicio: { type: String, required: true },
    /** Valores usados durante la grabación; los pasos que los escriban quedan como {{parametro}}. */
    parametrosPrueba: { type: Schema.Types.Mixed, default: {} },
    estado: { type: String, enum: ESTADOS_GRABACION, default: 'solicitada', index: true },
    /** La consola lo pone en true para que el worker cierre la grabación. */
    detener: { type: Boolean, default: false },
    workerId: { type: String },
    /** Pasos en formato del flujo, en orden. `alternativas` trae otros objetivos posibles para el mismo elemento. */
    pasos: { type: [Schema.Types.Mixed], default: [] },
    error: { type: String },
    iniciadaEn: { type: Date },
    terminadaEn: { type: Date },
  },
  { timestamps: true, collection: 'grabaciones' },
);

export type GrabacionDoc = InferSchemaType<typeof GrabacionSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };

export const Grabacion = mongoose.models.Grabacion ?? mongoose.model('Grabacion', GrabacionSchema);
