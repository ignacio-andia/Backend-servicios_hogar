import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuditAction, RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import type { UploadedDocumentFile } from './document-file.js';
import { DocumentTooLargeFilter } from './document-too-large.filter.js';
import { ChangeWorkerProfileStatusDto } from './dto/change-worker-profile-status.dto.js';
import { CreateWorkerProfileDto } from './dto/create-worker-profile.dto.js';
import { ListAdminWorkerProfilesQueryDto } from './dto/list-admin-worker-profiles-query.dto.js';
import { CreateZoneChangeRequestDto } from './dto/create-zone-change-request.dto.js';
import { DecideZoneChangeRequestDto } from './dto/decide-zone-change-request.dto.js';
import { ListInactiveZoneProfilesQueryDto } from './dto/list-inactive-zone-profiles-query.dto.js';
import { ListZoneChangeRequestsQueryDto } from './dto/list-zone-change-requests-query.dto.js';
import { UpdateSchedulesDto } from './dto/update-schedules.dto.js';
import { UpdateSpecialtiesDto } from './dto/update-specialties.dto.js';
import { UpdateWorkerProfileDto } from './dto/update-worker-profile.dto.js';
import { UploadDocumentDto } from './dto/upload-document.dto.js';
import type {
  DocumentDownload,
  WorkerDocumentView,
} from './worker-documents.service.js';
import { WorkerDocumentsService } from './worker-documents.service.js';
import type {
  AdminWorkerProfileView,
  AffectedProfile,
  PaginatedAdminWorkerProfiles,
  WorkerEligibility,
  WorkerProfileView,
  WorkerStatusView,
} from './worker-profile.service.js';
import { WorkerProfileService } from './worker-profile.service.js';
import type {
  AdminZoneChangeRequestView,
  PaginatedZoneChangeRequests,
  ZoneChangeRequestView,
  ZoneStatusView,
} from './zone-change-requests.service.js';
import { ZoneChangeRequestsService } from './zone-change-requests.service.js';

/**
 * Perfil del trabajador autenticado. Todas las rutas `me` actuan sobre el
 * perfil del usuario del JWT: nunca se recibe un id de perfil del cliente.
 */
@Controller('worker-profile')
export class WorkerProfileController {
  constructor(
    private readonly profiles: WorkerProfileService,
    private readonly documents: WorkerDocumentsService,
    private readonly zoneRequests: ZoneChangeRequestsService,
  ) {}

  // RF-06: crear el perfil propio (queda en BORRADOR hasta enviarlo). Una
  // cuenta de cliente recibe aqui el rol TRABAJADOR; el resto de rutas `me`
  // ya lo exigen.
  @Post()
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR)
  create(
    @CurrentUser() user: PublicUser,
    @Body() dto: CreateWorkerProfileDto,
  ): Promise<WorkerProfileView> {
    return this.profiles.create(user.id, dto);
  }

  @Get('me')
  @Auth(RoleName.TRABAJADOR)
  getOwn(@CurrentUser() user: PublicUser): Promise<WorkerProfileView> {
    return this.profiles.getOwn(user.id);
  }

  @Patch('me')
  @Auth(RoleName.TRABAJADOR)
  update(
    @CurrentUser() user: PublicUser,
    @Body() dto: UpdateWorkerProfileDto,
  ): Promise<WorkerProfileView> {
    return this.profiles.updateOwn(user.id, dto);
  }

  @Put('me/specialties')
  @Auth(RoleName.TRABAJADOR)
  replaceSpecialties(
    @CurrentUser() user: PublicUser,
    @Body() dto: UpdateSpecialtiesDto,
  ): Promise<WorkerProfileView> {
    return this.profiles.replaceSpecialties(user.id, dto);
  }

  @Put('me/schedules')
  @Auth(RoleName.TRABAJADOR)
  replaceSchedules(
    @CurrentUser() user: PublicUser,
    @Body() dto: UpdateSchedulesDto,
  ): Promise<WorkerProfileView> {
    return this.profiles.replaceSchedules(user.id, dto);
  }

  // RF-06 y RF-08: enviar o reenviar a revision (pasa a PENDIENTE).
  @Post('me/submit')
  @HttpCode(HttpStatus.OK)
  @Auth(RoleName.TRABAJADOR)
  submit(@CurrentUser() user: PublicUser): Promise<WorkerProfileView> {
    return this.profiles.submit(user.id);
  }

  // RF-08: estado vigente, observaciones e historial.
  @Get('me/status')
  @Auth(RoleName.TRABAJADOR)
  getStatus(@CurrentUser() user: PublicUser): Promise<WorkerStatusView> {
    return this.profiles.getOwnStatus(user.id);
  }

  // RF-03 y RF-09: si la cuenta puede usar funciones de trabajador.
  @Get('me/eligibility')
  @Auth(RoleName.TRABAJADOR)
  getEligibility(@CurrentUser() user: PublicUser): Promise<WorkerEligibility> {
    return this.profiles.getEligibility(user.id);
  }

  // RF-07: documentos de respaldo (multipart/form-data: type + file).
  @Get('me/documents')
  @Auth(RoleName.TRABAJADOR)
  listDocuments(
    @CurrentUser() user: PublicUser,
  ): Promise<WorkerDocumentView[]> {
    return this.documents.listOwn(user.id);
  }

  @Post('me/documents')
  @Auth(RoleName.TRABAJADOR)
  @UseInterceptors(FileInterceptor('file'))
  @UseFilters(DocumentTooLargeFilter)
  uploadDocument(
    @CurrentUser() user: PublicUser,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: UploadedDocumentFile | undefined,
  ): Promise<WorkerDocumentView> {
    return this.documents.upload(user.id, dto.type, file);
  }

  @Post('me/documents/:documentId/replace')
  @Auth(RoleName.TRABAJADOR)
  @UseInterceptors(FileInterceptor('file'))
  @UseFilters(DocumentTooLargeFilter)
  replaceDocument(
    @CurrentUser() user: PublicUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @UploadedFile() file: UploadedDocumentFile | undefined,
  ): Promise<WorkerDocumentView> {
    return this.documents.replace(user.id, documentId, file);
  }

  @Get('me/documents/:documentId/download')
  @Auth(RoleName.TRABAJADOR)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadDocument(
    @CurrentUser() user: PublicUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<StreamableFile> {
    return toStreamable(
      await this.documents.openOwn(user.id, documentId),
      'attachment',
    );
  }

  // RF-13: la zona es fija; los cambios se piden y los decide un administrador.
  // Zona actual, solicitud pendiente y si puede pedir un cambio (y por que no).
  @Get('me/zone')
  @Auth(RoleName.TRABAJADOR)
  getZoneStatus(@CurrentUser() user: PublicUser): Promise<ZoneStatusView> {
    return this.zoneRequests.getOwnZoneStatus(user.id);
  }

  @Post('me/zone-change-requests')
  @Auth(RoleName.TRABAJADOR)
  requestZoneChange(
    @CurrentUser() user: PublicUser,
    @Body() dto: CreateZoneChangeRequestDto,
  ): Promise<ZoneChangeRequestView> {
    return this.zoneRequests.requestZoneChange(user.id, dto);
  }

  // T4.3: retiro voluntario de la solicitud pendiente propia.
  @Post('me/zone-change-requests/:requestId/withdraw')
  @HttpCode(HttpStatus.OK)
  @Auth(RoleName.TRABAJADOR)
  withdrawZoneChangeRequest(
    @CurrentUser() user: PublicUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<ZoneChangeRequestView> {
    return this.zoneRequests.withdraw(user.id, requestId);
  }

  @Get('me/zone-change-requests')
  @Auth(RoleName.TRABAJADOR)
  listZoneChangeRequests(
    @CurrentUser() user: PublicUser,
  ): Promise<ZoneChangeRequestView[]> {
    return this.zoneRequests.listOwn(user.id);
  }

  // RF-13: revision administrativa de solicitudes de cambio de zona.
  @Get('admin/zone-change-requests')
  @Auth(RoleName.ADMINISTRADOR)
  listZoneChangeRequestsForAdmin(
    @Query() query: ListZoneChangeRequestsQueryDto,
  ): Promise<PaginatedZoneChangeRequests> {
    return this.zoneRequests.listForAdmin(query);
  }

  @Get('admin/zone-change-requests/:requestId')
  @Auth(RoleName.ADMINISTRADOR)
  getZoneChangeRequestForAdmin(
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<AdminZoneChangeRequestView> {
    return this.zoneRequests.getForAdmin(requestId);
  }

  @Patch('admin/zone-change-requests/:requestId')
  @Auth(RoleName.ADMINISTRADOR)
  decideZoneChangeRequest(
    @CurrentUser() admin: PublicUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DecideZoneChangeRequestDto,
  ): Promise<AdminZoneChangeRequestView> {
    return this.zoneRequests.decide(admin.id, requestId, dto);
  }

  // RF-10 y RF-47: listado y detalle de perfiles para revisarlos. Nunca
  // incluyen el perfil del propio administrador.
  @Get('admin/profiles')
  @Auth(RoleName.ADMINISTRADOR)
  listProfilesForAdmin(
    @CurrentUser() admin: PublicUser,
    @Query() query: ListAdminWorkerProfilesQueryDto,
  ): Promise<PaginatedAdminWorkerProfiles> {
    return this.profiles.listForAdmin(admin.id, query);
  }

  @Get('admin/profiles/:profileId')
  @Auth(RoleName.ADMINISTRADOR)
  getProfileForAdmin(
    @CurrentUser() admin: PublicUser,
    @Param('profileId', ParseUUIDPipe) profileId: string,
  ): Promise<AdminWorkerProfileView> {
    return this.profiles.getForAdmin(admin.id, profileId);
  }

  // RF-56: documentos privados de un perfil, solo para administradores y
  // nunca los del propio perfil. Cada acceso exitoso queda en la bitacora.
  @Get('admin/profiles/:profileId/documents')
  @Auth(RoleName.ADMINISTRADOR)
  listProfileDocumentsForAdmin(
    @CurrentUser() admin: PublicUser,
    @Param('profileId', ParseUUIDPipe) profileId: string,
  ): Promise<WorkerDocumentView[]> {
    return this.documents.listForAdmin(admin.id, profileId);
  }

  @Get('admin/profiles/:profileId/documents/:documentId/view')
  @Auth(RoleName.ADMINISTRADOR)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async viewProfileDocumentForAdmin(
    @CurrentUser() admin: PublicUser,
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<StreamableFile> {
    return toStreamable(
      await this.documents.openForAdmin(
        admin.id,
        profileId,
        documentId,
        AuditAction.VISUALIZACION_DOCUMENTO,
      ),
      'inline',
    );
  }

  @Get('admin/profiles/:profileId/documents/:documentId/download')
  @Auth(RoleName.ADMINISTRADOR)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadProfileDocumentForAdmin(
    @CurrentUser() admin: PublicUser,
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<StreamableFile> {
    return toStreamable(
      await this.documents.openForAdmin(
        admin.id,
        profileId,
        documentId,
        AuditAction.DESCARGA_DOCUMENTO,
      ),
      'attachment',
    );
  }

  // RF-10 y RF-47: el administrador aprueba, observa, rechaza o suspende un
  // perfil. Reutiliza changeStatusByAdmin: transiciones validas, motivo
  // obligatorio, requisitos de aprobacion, historial y bitacora. El
  // administrador sale del token; no puede decidir sobre su propio perfil.
  @Patch('admin/profiles/:profileId/status')
  @Auth(RoleName.ADMINISTRADOR)
  changeProfileStatus(
    @CurrentUser() admin: PublicUser,
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() dto: ChangeWorkerProfileStatusDto,
  ): Promise<WorkerProfileView> {
    return this.profiles.changeStatusByAdmin(admin.id, profileId, dto);
  }

  // RF-49: perfiles cuya zona fue desactivada (uso administrativo).
  @Get('admin/inactive-zone-profiles')
  @Auth(RoleName.ADMINISTRADOR)
  findProfilesWithInactiveZone(
    @Query() query: ListInactiveZoneProfilesQueryDto,
  ): Promise<AffectedProfile[]> {
    return this.profiles.findProfilesWithInactiveZone(query.zoneId);
  }
}

/** Respuesta binaria del documento: en linea (ver) o como adjunto (descargar). */
function toStreamable(
  file: DocumentDownload,
  disposition: 'inline' | 'attachment',
): StreamableFile {
  return new StreamableFile(file.stream, {
    type: file.mimeType,
    length: file.sizeBytes,
    disposition: contentDisposition(disposition, file.fileName),
  });
}

/** Nombre ASCII de respaldo y nombre UTF-8. */
function contentDisposition(
  disposition: 'inline' | 'attachment',
  fileName: string,
): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
