import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import type { CatalogItem, CatalogOption } from './catalogs.service.js';
import { CatalogKind, CatalogsService } from './catalogs.service.js';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto.js';
import { ListCatalogQueryDto } from './dto/list-catalog-query.dto.js';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto.js';

/**
 * - Lectura pública (sin sesión): `/catalogs/{categories|zones}`, solo activos.
 * - Lectura administrativa: `/catalogs/admin/{categories|zones}`, activos e inactivos.
 * - Escritura administrativa: POST y PATCH sobre `/catalogs/{categories|zones}`.
 */
@Controller('catalogs')
export class CatalogsController {
  constructor(private readonly catalogsService: CatalogsService) {}

  @Get('categories')
  findActiveCategories(): Promise<CatalogOption[]> {
    return this.catalogsService.findActive(CatalogKind.CATEGORY);
  }

  @Get('categories/:id')
  findActiveCategory(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CatalogOption> {
    return this.catalogsService.findActiveById(CatalogKind.CATEGORY, id);
  }

  @Get('zones')
  findActiveZones(): Promise<CatalogOption[]> {
    return this.catalogsService.findActive(CatalogKind.ZONE);
  }

  @Get('zones/:id')
  findActiveZone(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CatalogOption> {
    return this.catalogsService.findActiveById(CatalogKind.ZONE, id);
  }

  @Get('admin/categories')
  @Auth(RoleName.ADMINISTRADOR)
  findAllCategories(
    @Query() query: ListCatalogQueryDto,
  ): Promise<CatalogItem[]> {
    return this.catalogsService.findAll(CatalogKind.CATEGORY, query);
  }

  @Get('admin/categories/:id')
  @Auth(RoleName.ADMINISTRADOR)
  findCategory(@Param('id', ParseUUIDPipe) id: string): Promise<CatalogItem> {
    return this.catalogsService.findById(CatalogKind.CATEGORY, id);
  }

  @Get('admin/zones')
  @Auth(RoleName.ADMINISTRADOR)
  findAllZones(@Query() query: ListCatalogQueryDto): Promise<CatalogItem[]> {
    return this.catalogsService.findAll(CatalogKind.ZONE, query);
  }

  @Get('admin/zones/:id')
  @Auth(RoleName.ADMINISTRADOR)
  findZone(@Param('id', ParseUUIDPipe) id: string): Promise<CatalogItem> {
    return this.catalogsService.findById(CatalogKind.ZONE, id);
  }

  @Post('categories')
  @Auth(RoleName.ADMINISTRADOR)
  createCategory(
    @CurrentUser() admin: PublicUser,
    @Body() dto: CreateCatalogItemDto,
  ): Promise<CatalogItem> {
    return this.catalogsService.create(CatalogKind.CATEGORY, admin.id, dto);
  }

  @Patch('categories/:id')
  @Auth(RoleName.ADMINISTRADOR)
  updateCategory(
    @CurrentUser() admin: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogItemDto,
  ): Promise<CatalogItem> {
    return this.catalogsService.update(CatalogKind.CATEGORY, admin.id, id, dto);
  }

  @Patch('categories/:id/deactivate')
  @Auth(RoleName.ADMINISTRADOR)
  deactivateCategory(
    @CurrentUser() admin: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CatalogItem> {
    return this.catalogsService.deactivate(CatalogKind.CATEGORY, admin.id, id);
  }

  @Post('zones')
  @Auth(RoleName.ADMINISTRADOR)
  createZone(
    @CurrentUser() admin: PublicUser,
    @Body() dto: CreateCatalogItemDto,
  ): Promise<CatalogItem> {
    return this.catalogsService.create(CatalogKind.ZONE, admin.id, dto);
  }

  @Patch('zones/:id')
  @Auth(RoleName.ADMINISTRADOR)
  updateZone(
    @CurrentUser() admin: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogItemDto,
  ): Promise<CatalogItem> {
    return this.catalogsService.update(CatalogKind.ZONE, admin.id, id, dto);
  }

  @Patch('zones/:id/deactivate')
  @Auth(RoleName.ADMINISTRADOR)
  deactivateZone(
    @CurrentUser() admin: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CatalogItem> {
    return this.catalogsService.deactivate(CatalogKind.ZONE, admin.id, id);
  }
}
