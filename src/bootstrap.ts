import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { Settings } from './config';
import { json } from 'express';
import { maxEnvelopeBytes } from './envelopes/envelope';

// Tạo một ứng dụng NestJS cho một đơn vị; chưa mở cổng để demo và kiểm thử tự chọn cổng riêng.
export async function createApp(settings: Settings, logging = true) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(settings), {
    logger: logging ? ['log', 'warn', 'error'] : false,
    bodyParser: false,
  });
  // REST receive nhận cả phong bì JSON lớn; các API cấu hình khóa vẫn giới hạn JSON 24 KiB.
  app.use('/api/envelopes/receive', json({ limit: maxEnvelopeBytes(settings.maxFileBytes) }));
  app.useBodyParser('json', { limit: '24kb' });
  app.disable('x-powered-by');
  // Middleware chạy trước route: không cache phản hồi và chặn yêu cầu trình duyệt từ origin khác.
  app.use(
    (
      request: import('express').Request,
      response: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      const origin = request.get('origin');
      if (origin && origin !== `${request.protocol}://${request.get('host')}`) {
        response.status(403).json({ message: 'Không cho phép yêu cầu từ origin khác.' });
        return;
      }
      next();
    },
  );
  // DTO chỉ nhận trường đã khai báo, từ chối trường dư và kiểm tra decorator class-validator.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  const config = new DocumentBuilder()
    .setTitle(`Phong bì số · ${settings.unitId}`)
    .setDescription(
      'Thực nghiệm Chương 3: AES-256-CBC + RSA-OAEP/SHA-256 + RSASSA-PKCS1-v1_5. ' +
        'Schema Chương 2: header {request_id, sender_id, receiver_id, timestamp, key}, payload {encrypted_data, iv, signature}. ' +
        '1. Sinh khóa mỗi đơn vị. 2. Trao đổi và ghim khóa công khai. ' +
        '3. Bên gửi dùng seal. 4. Bên nhận dùng verify/open. ' +
        'Khóa bí mật ở lại máy đơn vị. Chỉ dùng dữ liệu thử nghiệm trên localhost.',
    )
    .setVersion('1.0')
    .build();
  // Sinh OpenAPI từ controller/DTO để có giao diện Try it out, chọn tệp và tải kết quả tại /docs.
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: false, defaultModelsExpandDepth: -1 },
    customSiteTitle: `Thực nghiệm mật mã · ${settings.unitId}`,
  });
  return app;
}
