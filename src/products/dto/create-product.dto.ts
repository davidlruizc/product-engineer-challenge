import {
  IsString,
  IsNumber,
  IsOptional,
  Min,
  Max,
  IsInt,
} from 'class-validator';
import { INT4_MAX, INT4_MIN } from '../../common/database-errors';

export class CreateProductDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  stock?: number;

  @IsInt()
  @Min(INT4_MIN)
  @Max(INT4_MAX)
  @IsOptional()
  categoryId?: number;
}

export class CreateCategoryDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @Min(INT4_MIN)
  @Max(INT4_MAX)
  @IsOptional()
  parentId?: number;
}
