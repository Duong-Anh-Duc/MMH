import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { UNIT_ID_PATTERN } from '../config';

// DTO kiểm tra các trường văn bản khi gửi; tệp nhị phân được Multer xử lý riêng.
// @ApiProperty chỉ mô tả Swagger, còn @IsString/@Length/@Matches mới kiểm tra dữ liệu khi chạy.
export class SealDto {
  @ApiProperty({ description: 'Trích yếu công văn, nằm trong nội dung mã hóa.', required: false })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  subject?: string;
  @ApiProperty({ example: 'don-vi-b' })
  @IsString()
  @Matches(UNIT_ID_PATTERN)
  recipientId!: string;

  @ApiProperty({ description: 'Mật khẩu khóa bí mật của đơn vị gửi.' })
  @IsString()
  @Length(12, 128)
  passphrase!: string;
}

// Khi nhận, người dùng chỉ nhập mật khẩu của đơn vị mình; khóa bí mật được đọc từ kho cục bộ.
export class OpenDto {
  @ApiProperty({ description: 'Mật khẩu khóa bí mật của đơn vị nhận.' })
  @IsString()
  @Length(12, 128)
  passphrase!: string;
}
