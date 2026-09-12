import mongoose from 'mongoose';
import { env } from './env.js';

let conexion: Promise<typeof mongoose> | null = null;

export function conectarDb(): Promise<typeof mongoose> {
  if (!conexion) {
    conexion = mongoose.connect(env('MONGODB_URI'), { serverSelectionTimeoutMS: 10_000 });
  }
  return conexion;
}

export async function cerrarDb(): Promise<void> {
  if (conexion) {
    await mongoose.disconnect();
    conexion = null;
  }
}
