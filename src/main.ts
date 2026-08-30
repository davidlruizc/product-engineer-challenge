import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // `whitelist` strips properties that have no decorator on the target DTO.
  // Without it class-transformer copies every body property onto the DTO, and
  // TypeORM's `repository.create()` maps any of them that happen to be columns —
  // including the primary key, which silently turns a POST into an UPDATE.
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
