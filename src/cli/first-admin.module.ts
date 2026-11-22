import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UsersModule } from '../modules/users/users.module.js';
import { FirstAdministratorService } from './first-admin.service.js';

/**
 * Contexto minimo del comando de inicializacion: configuracion (.env) y
 * UsersModule, que trae el PrismaService compartido. No carga el servidor
 * HTTP, ni las tareas programadas, ni el resto de los modulos.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), UsersModule],
  providers: [FirstAdministratorService],
})
export class FirstAdminModule {}
