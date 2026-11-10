import { IsEnum } from 'class-validator';
import { UserStatus } from '../../../generated/prisma/enums.js';

export class UpdateUserStatusDto {
  @IsEnum(UserStatus)
  status: UserStatus;
}
