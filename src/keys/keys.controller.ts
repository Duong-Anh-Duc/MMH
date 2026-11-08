import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { GenerateKeysDto, ImportKeysDto, TrustPeerDto } from './keys.dto';
import { KeysService } from './keys.service';

@ApiTags('1. Quản lý khóa')
@Controller('api')
export class KeysController {
  // Nhận KeysService để controller chỉ phụ trách HTTP, còn xử lý khóa nằm trong service.
  constructor(private readonly keys: KeysService) {}

  // GET /api/keys/status: xem trạng thái và vân tay khóa của đơn vị hiện tại.
  @Get('keys/status')
  @ApiOperation({ summary: 'Kiểm tra đơn vị và trạng thái cặp khóa RSA' })
  status() {
    return this.keys.status();
  }

  // POST /api/keys/generate: DTO đã kiểm tra mật khẩu và độ dài RSA trước khi gọi service.
  @Post('keys/generate')
  @ApiOperation({ summary: 'Sinh cặp khóa RSA; khóa bí mật được mã hóa và giữ tại đơn vị' })
  generate(@Body() body: GenerateKeysDto) {
    return this.keys.generate(body.passphrase, body.modulusLength);
  }

  // Nạp cặp khóa PEM đã tồn tại thay vì sinh mới, đúng yêu cầu xuất/nhập khóa tại mục 2.1.2.
  @Post('keys/import')
  @ApiOperation({ summary: 'Nhập khóa PEM PKCS#1/PKCS#8 và lưu PKCS#8 mã hóa tại đơn vị' })
  importIdentity(@Body() body: ImportKeysDto) {
    return this.keys.importIdentity(body.privateKeyPem, body.passphrase);
  }

  // GET /api/keys/public: trả khóa công khai dưới dạng tệp PEM đính kèm để trình duyệt tải về.
  @Get('keys/public')
  @ApiOperation({ summary: 'Tải khóa công khai để trao đổi với đối tác' })
  @ApiProduces('application/x-pem-file')
  async publicKey(@Res() response: Response) {
    const pem = await this.keys.publicPem();
    response.type('application/x-pem-file');
    response.attachment('public.pem');
    response.send(pem);
  }

  // POST /api/peers: lưu mối liên hệ giữa mã đơn vị đối tác và khóa công khai đã xác nhận.
  @Post('peers')
  @ApiOperation({ summary: 'Ghim khóa công khai đối tác sau khi đối chiếu vân tay SHA-256' })
  trust(@Body() body: TrustPeerDto) {
    return this.keys.trust(body.unitId, body.publicKeyPem, body.expectedFingerprint);
  }
}
