import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsInt } from 'class-validator';

// Each id costs its own round trip and the loop is serial, so an unbounded
// array is an unbounded request. Well above any real batch, well below a hang.
export const MAX_BATCH_SIZE = 500;

export class ProcessBatchDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_BATCH_SIZE)
  @IsInt({ each: true })
  productIds: number[];
}
