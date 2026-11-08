import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Length, Matches } from 'class-validator';
import { UNIT_ID_PATTERN } from '../config';

// DTO giới hạn đầu vào sinh khóa; không cho client yêu cầu RSA dưới 2048 bit.
export class GenerateKeysDto {
  @ApiProperty({ description: 'Mật khẩu bảo vệ khóa bí mật (12–128 ký tự).', minLength: 12 })
  @IsString()
  @Length(12, 128)
  passphrase!: string;

  @ApiProperty({ enum: [2048, 3072, 4096], default: 2048 })
  @IsInt()
  @IsIn([2048, 3072, 4096])
  modulusLength!: number;
}

// DTO trao đổi khóa công khai: ghim theo mã đơn vị và yêu cầu xác nhận vân tay SHA-256.
export class TrustPeerDto {
  @ApiProperty({ example: 'don-vi-b' })
  @IsString()
  @Matches(UNIT_ID_PATTERN)
  unitId!: string;

  @ApiProperty({ description: 'Nội dung tệp khóa công khai PEM của đơn vị đối tác.' })
  @IsString()
  @Length(100, 8192)
  publicKeyPem!: string;

  @ApiProperty({ description: 'SHA-256 (64 ký tự hex), đối chiếu qua kênh độc lập.' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  expectedFingerprint!: string;
}

// Chỉ nhập khóa bí mật của chính đơn vị trên máy cục bộ; service chuẩn hóa và mã hóa trước khi lưu.
export class ImportKeysDto {
  @ApiProperty({ description: 'Khóa bí mật PEM PKCS#1 hoặc PKCS#8 của đơn vị hiện tại.' })
  @IsString()
  @Length(100, 16384)
  privateKeyPem!: string;

  @ApiProperty({ description: 'Mật khẩu mở khóa và bảo vệ lại tệp PKCS#8, tối thiểu 12 ký tự.' })
  @IsString()
  @Length(12, 128)
  passphrase!: string;
}
