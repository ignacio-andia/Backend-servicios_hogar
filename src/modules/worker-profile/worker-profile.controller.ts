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
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import type { UploadedDocumentFile } from './document-file.js';
import { DocumentTooLargeFilter } from './document-too-large.filter.js';
import { CreateWorkerProfileDto } from './dto/create-worker-profile.dto.js';
import { CreateZoneChangeRequestDto } from './dto/create-zone-change-request.dto.js';
import { ListInactiveZoneProfilesQueryDto } from './dto/list-inactive-zone-profiles-query.dto.js';
import { UpdateSchedulesDto } from './dto/update-schedules.dto.js';
import { UpdateSpecialtiesDto } from './dto/update-specialties.dto.js';
import { UpdateWorkerProfileDto } from './dto/update-worker-profile.dto.js';
import { UploadDocumentDto } from './dto/upload-document.dto.js';
import type { WorkerDocumentView } from './worker-documents.service.js';
import { WorkerDocumentsService } from './worker-documents.service.js';
import type {
  AffectedProfile,
  WorkerEligibility,
  WorkerProfileView,
  WorkerStatusView,
  ZoneChangeRequestView,
} from './worker-profile.service.js';
import { WorkerProfileService } from './worker-profile.service.js';

/**
 * Perfil del trabajador autenticado. Todas las rutas `me` actuan sobre el
 * perfil del usuario del JWT: nunca se recibe un id de perfil del cliente.
 */
@Controller('worker-profile')
export class WorkerProfileController {
  constructor(
    private readonly profiles: WorkerProfileService,
    private readonly documents: WorkerDocumentsService,
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
    const file = await this.documents.openOwn(user.id, documentId);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.sizeBytes,
      disposition: contentDisposition(file.fileName),
    });
  }

  // RF-13: la zona es fija; los cambios se piden y los decide un administrador.
  @Post('me/zone-change-requests')
  @Auth(RoleName.TRABAJADOR)
  requestZoneChange(
    @CurrentUser() user: PublicUser,
    @Body() dto: CreateZoneChangeRequestDto,
  ): Promise<ZoneChangeRequestView> {
    return this.profiles.requestZoneChange(user.id, dto);
  }

  @Get('me/zone-change-requests')
  @Auth(RoleName.TRABAJADOR)
  listZoneChangeRequests(
    @CurrentUser() user: PublicUser,
  ): Promise<ZoneChangeRequestView[]> {
    return this.profiles.listOwnZoneChangeRequests(user.id);
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

/** Descarga como adjunto, con nombre ASCII de respaldo y nombre UTF-8. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
