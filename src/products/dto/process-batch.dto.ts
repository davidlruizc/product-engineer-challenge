import { IsArray, IsInt } from 'class-validator';

export class ProcessBatchDto {
  @IsArray()
  @IsInt({ each: true })
  productIds: number[];
}
