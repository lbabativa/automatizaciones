import { setServers } from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';

// Algunos resolvedores DNS locales no responden consultas SRV (mongodb+srv). DNS_SERVERS=8.8.8.8,1.1.1.1 lo evita.
if (process.env.DNS_SERVERS) setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));

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
