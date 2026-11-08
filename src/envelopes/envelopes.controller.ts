import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { OpenDto, SealDto } from './envelopes.dto';
import { EnvelopesService } from './envelopes.service';
import { normalizeUploadFilename } from './envelope';

const fileProperty = { type: 'string', format: 'binary' };
const passwordProperty = { type: 'string', format: 'password', minLength: 12, maxLength: 128 };

@ApiTags('2. Truyền nhận phong bì số')
@ApiConsumes('multipart/form-data')
@Controller('api/envelopes')
export class EnvelopesController {
  // Nhận service xử lý nghiệp vụ; controller chỉ chuyển đổi yêu cầu và phản hồi HTTP.
  constructor(private readonly envelopes: EnvelopesService) {}

  // Từ chối yêu cầu chưa chọn tệp để các route luôn nhận được Express.Multer.File hợp lệ.
  private requireFile(file: Express.Multer.File | undefined): Express.Multer.File {
    if (!file) throw new BadRequestException('Chưa chọn tệp trong trường file.');
    return file;
  }

  // POST /api/envelopes/seal: Multer đọc tệp vào RAM, DTO kiểm tra các trường văn bản.
  @Post('seal')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Bên gửi: chọn tệp, mã hóa và ký số, tải gói tin JSON' })
  @ApiProduces('application/json')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'recipientId', 'passphrase'],
      properties: {
        file: fileProperty,
        recipientId: { type: 'string', example: 'don-vi-b' },
        passphrase: passwordProperty,
        subject: { type: 'string', description: 'Trích yếu công văn (tùy chọn)', maxLength: 500 },
      },
    },
  })
  async seal(
    @UploadedFile() input: Express.Multer.File | undefined,
    @Body() body: SealDto,
    @Res() response: Response,
  ) {
    const file = this.requireFile(input);
    const envelope = await this.envelopes.seal(
      file.buffer,
      normalizeUploadFilename(file.originalname),
      file.mimetype,
      body.recipientId,
      body.passphrase,
      body.subject,
    );
    // Content-Disposition giúp Swagger/trình duyệt hiện liên kết tải phong bì dưới dạng tệp JSON.
    response.attachment(`envelope-${envelope.header.request_id}.json`);
    response.type('application/json').send(JSON.stringify(envelope, null, 2));
  }

  // POST /api/envelopes/verify: chỉ báo kết quả xác minh, không giải mã và không tiêu thụ UUID.
  @Post('verify')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Kiểm tra chữ ký và header; chưa giải mã và chưa đánh dấu đã nhận' })
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: fileProperty } } })
  async verify(@UploadedFile() input: Express.Multer.File | undefined) {
    const file = this.requireFile(input);
    const envelope = await this.envelopes.verify(file.buffer);
    return {
      signatureValid: true,
      header: envelope.header,
      controlCheck: 'performed-after-decryption',
      replayCheck: 'performed-on-open',
    };
  }

  // POST /api/envelopes/open: nhận phong bì và mật khẩu của bên nhận, trả byte của tệp gốc.
  @Post('open')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Bên nhận: xác minh, chống phát lại, giải mã và tải tệp gốc' })
  @ApiProduces('application/octet-stream')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'passphrase'],
      properties: { file: fileProperty, passphrase: passwordProperty },
    },
  })
  async open(
    @UploadedFile() input: Express.Multer.File | undefined,
    @Body() body: OpenDto,
    @Res() response: Response,
  ) {
    const file = this.requireFile(input);
    const result = await this.envelopes.open(file.buffer, body.passphrase);
    // Trả dạng tải xuống, không hiển thị nội dung tài liệu như HTML ngay trong trang.
    response.attachment(result.filename);
    response.type('application/octet-stream');
    // Các header hỗ trợ đối chiếu băm, mã gói và đơn vị gửi đã được xác minh.
    response.setHeader('X-Content-SHA256', result.sha256);
    response.setHeader('X-Message-Id', result.header.request_id);
    response.setHeader('X-Verified-Sender', result.header.sender_id);
    if (result.documentId) response.setHeader('X-Document-Id', result.documentId);
    response.send(result.file);
  }
}
