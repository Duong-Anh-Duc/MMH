import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { StorageService } from '../storage/storage.service';
import { EnvelopesService } from './envelopes.service';

@ApiTags('3. REST API và MongoDB (Chương 2)')
@Controller('api')
export class ReceiveController {
  // Nhận lõi mật mã và kho MongoDB; không nhận khóa bí mật hoặc mật khẩu của B từ phía A.
  constructor(
    private readonly envelopes: EnvelopesService,
    private readonly storage: StorageService,
  ) {}

  // POST nhận trực tiếp JSON header/payload; phục vụ truyền dữ liệu liên đơn vị qua REST.
  @Post('envelopes/receive')
  @HttpCode(200)
  @ApiConsumes('application/json')
  @ApiOperation({ summary: 'Nhận JSON theo Chương 2, giải mã và lưu tài liệu vào MongoDB' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['header', 'payload'],
      properties: {
        header: {
          type: 'object',
          required: ['request_id', 'sender_id', 'receiver_id', 'timestamp', 'key'],
          properties: {
            request_id: { type: 'string', format: 'uuid' },
            sender_id: { type: 'string' },
            receiver_id: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
            key: { type: 'string' },
          },
        },
        payload: {
          type: 'object',
          required: ['encrypted_data', 'iv', 'signature'],
          properties: {
            encrypted_data: { type: 'string' },
            iv: { type: 'string' },
            signature: { type: 'string' },
          },
        },
      },
    },
  })
  receive(@Body() envelope: unknown) {
    return this.envelopes.receive(envelope);
  }

  // Trả bằng chứng các bản ghi MongoDB của đơn vị hiện tại, không trả chuỗi kết nối hay bí mật.
  @Get('storage/status')
  @ApiOperation({ summary: 'Kiểm tra MongoDB, số khóa đối tác và số tài liệu đã nhận' })
  status() {
    return this.storage.status();
  }

  // Tải lại tài liệu gốc từ GridFS theo mã trả về trong biên nhận REST.
  @Get('documents/:id')
  @ApiOperation({ summary: 'Tải tài liệu đã phục hồi từ MongoDB GridFS (demo localhost)' })
  async document(@Param('id') id: string, @Res() response: Response) {
    const record = await this.storage.document(id);
    response.attachment(record.filename).type('application/octet-stream');
    response.setHeader('X-Content-SHA256', record.sha256);
    response.send(record.file);
  }
}
