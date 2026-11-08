import { Controller, DynamicModule, Get, Inject, Module, Res } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { SETTINGS, Settings } from './config';
import { CryptoService } from './crypto/crypto.service';
import { maxEnvelopeBytes } from './envelopes/envelope';
import { EnvelopesController } from './envelopes/envelopes.controller';
import { EnvelopesService } from './envelopes/envelopes.service';
import { ReceiveController } from './envelopes/receive.controller';
import { ReplayService } from './envelopes/replay.service';
import { KeysController } from './keys/keys.controller';
import { KeysService } from './keys/keys.service';
import { StorageService } from './storage/storage.service';

@Controller()
class AppController {
  // Nhận cấu hình để endpoint health hiển thị đúng mã đơn vị của tiến trình hiện tại.
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  // Chuyển trang gốc sang giao diện Swagger để người dùng có thể thao tác ngay.
  @Get()
  @ApiExcludeEndpoint()
  root(@Res() response: Response) {
    response.redirect('/docs');
  }

  // Kiểm tra máy chủ đang hoạt động và xác định đang thao tác với đơn vị nào.
  @Get('api/health')
  health() {
    return { status: 'ok', unitId: this.settings.unitId };
  }
}

@Module({})
export class AppModule {
  // Đăng ký controller, service và cấu hình upload cho một phiên bản ứng dụng của một đơn vị.
  static register(settings: Settings): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Tệp phong bì lớn hơn tệp gốc do Base64; giới hạn HTTP phải tính cả phần tăng dung lượng này.
        MulterModule.register({
          limits: {
            fileSize: maxEnvelopeBytes(settings.maxFileBytes),
            files: 1,
            fields: 4,
            parts: 6,
            fieldSize: 16384,
          },
        }),
      ],
      controllers: [AppController, KeysController, EnvelopesController, ReceiveController],
      providers: [
        { provide: SETTINGS, useValue: settings },
        CryptoService,
        KeysService,
        ReplayService,
        EnvelopesService,
        StorageService,
      ],
    };
  }
}
