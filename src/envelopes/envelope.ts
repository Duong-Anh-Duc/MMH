import { BadRequestException } from '@nestjs/common';
import { UNIT_ID_PATTERN } from '../config';

export const SUITE = {
  version: '1.0',
  encryption: 'AES-256-CBC',
  keyWrap: 'RSA-OAEP-SHA256',
  signature: 'RSASSA-PKCS1-v1_5-SHA256',
} as const;

export interface EnvelopeHeader {
  request_id: string;
  sender_id: string;
  receiver_id: string;
  timestamp: string;
  key: string;
}

export interface UnsignedEnvelope {
  header: EnvelopeHeader;
  payload: { encrypted_data: string; iv: string };
}

export interface Envelope extends UnsignedEnvelope {
  payload: UnsignedEnvelope['payload'] & { signature: string };
}

export interface FilePayload {
  protocol: 'PTIT-ENVELOPE-CH2';
  control: { header: EnvelopeHeader; iv: string };
  subject: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  data: string;
}

// Kiểm tra một giá trị JSON là object có đúng tập trường cho phép, không thiếu và không có trường dư.
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('Cấu trúc gói tin không hợp lệ.');
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) {
    throw new BadRequestException('Gói tin có trường thiếu hoặc không được hỗ trợ.');
  }
  return record;
}

// Giải mã Base64 nghiêm ngặt và giới hạn kích thước; field giúp thông báo lỗi đúng tên trường.
export function decodeBase64(value: unknown, maxBytes: number, field: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > 4 * Math.ceil(maxBytes / 3) ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new BadRequestException(`${field}: Base64 không hợp lệ hoặc vượt giới hạn.`);
  }
  const decoded = Buffer.from(value, 'base64');
  // Mã hóa ngược để loại các chuỗi mà Buffer.from có thể chấp nhận nhưng không phải Base64 chuẩn.
  if (decoded.length > maxBytes || decoded.toString('base64') !== value) {
    throw new BadRequestException(`${field}: Base64 không ở dạng chuẩn.`);
  }
  return decoded;
}

// Chỉ cho phép tên tệp đơn, chặn đường dẫn ../, dấu phân cách và ký tự điều khiển.
// asserts giúp TypeScript biết value chắc chắn là string sau khi kiểm tra thành công.
export function validateFilename(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > 255 ||
    value === '.' ||
    value === '..' ||
    /[\/\\\x00-\x1f\x7f]/.test(value)
  ) {
    throw new BadRequestException('Tên tệp không hợp lệ; không được chứa đường dẫn.');
  }
}

// Multipart thường gửi tên tệp UTF-8 nhưng Multer đọc tham số filename theo Latin-1.
// Chỉ phục hồi khi chuỗi còn là các byte Latin-1 và tạo thành UTF-8 hợp lệ; không sửa tên đã là Unicode.
export function normalizeUploadFilename(value: string): string {
  if ([...value].some((character) => character.codePointAt(0)! > 255)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1'));
  } catch {
    return value;
  }
}

// Chuyển byte UTF-8 thành JSON; trả unknown để buộc lớp gọi phải kiểm tra cấu trúc tiếp.
export function parseJson(bytes: Buffer): unknown {
  try {
    // fatal=true từ chối UTF-8 lỗi thay vì âm thầm thay byte hỏng bằng ký tự khác.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BadRequestException('Tệp phải chứa JSON UTF-8 hợp lệ.');
  }
}

// Kiểm tra dung lượng, schema, thuật toán, UUID, thời gian và kích thước các trường nhị phân.
// Đây mới là kiểm tra định dạng; nội dung chỉ đáng tin sau khi verify() xác minh chữ ký.
export function parseEnvelope(bytes: Buffer, maxBytes: number): Envelope {
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new BadRequestException('Gói tin trống hoặc vượt giới hạn dung lượng.');
  }
  const outer = object(parseJson(bytes), ['header', 'payload']);
  const header = object(outer.header, [
    'request_id',
    'sender_id',
    'receiver_id',
    'timestamp',
    'key',
  ]);
  const payload = object(outer.payload, ['encrypted_data', 'iv', 'signature']);
  if (
    typeof header.request_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(header.request_id)
  ) {
    throw new BadRequestException('request_id phải là UUID v4.');
  }
  for (const name of ['sender_id', 'receiver_id']) {
    if (typeof header[name] !== 'string' || !UNIT_ID_PATTERN.test(header[name])) {
      throw new BadRequestException('Mã đơn vị trong header không hợp lệ.');
    }
  }
  // Chấp nhận ISO 8601 UTC có hoặc không có mili giây như ví dụ tại mục 2.3.1.
  const date = header.timestamp;
  if (
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(date)
  ) {
    throw new BadRequestException('timestamp phải là ISO 8601 UTC.');
  }
  if (
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().replace('.000Z', 'Z') !== date.replace('.000Z', 'Z')
  ) {
    throw new BadRequestException('Thời gian không hợp lệ.');
  }
  const iv = decodeBase64(payload.iv, 16, 'payload.iv');
  const key = decodeBase64(header.key, 512, 'header.key');
  const signature = decodeBase64(payload.signature, 512, 'payload.signature');
  const ciphertext = decodeBase64(payload.encrypted_data, maxBytes, 'payload.encrypted_data');
  if (
    iv.length !== 16 ||
    key.length < 256 ||
    signature.length < 256 ||
    ciphertext.length === 0 ||
    ciphertext.length % 16 !== 0
  ) {
    throw new BadRequestException('Kích thước IV, khóa bọc, chữ ký hoặc bản mã không hợp lệ.');
  }
  return outer as unknown as Envelope;
}

// Đúng mục 2.3.3 và 2.4.2: ký các byte ASCII của chuỗi Base64 encrypted_data.
// Header và IV được đối chiếu với bản sao trong payload kín sau giải mã để chặn việc sửa metadata.
export function signingBytes(envelope: UnsignedEnvelope): Buffer {
  return Buffer.from(envelope.payload.encrypted_data, 'ascii');
}

// So sánh từng trường điều khiển với bản sao được mã hóa; không phụ thuộc thứ tự khóa trong JSON.
export function sameControl(control: unknown, envelope: Envelope): boolean {
  const saved = object(control, ['header', 'iv']);
  const header = object(saved.header, [
    'request_id',
    'sender_id',
    'receiver_id',
    'timestamp',
    'key',
  ]);
  return (
    saved.iv === envelope.payload.iv &&
    Object.keys(envelope.header).every(
      (name) => header[name] === envelope.header[name as keyof EnvelopeHeader],
    )
  );
}

// Tính cận trên cho kích thước tệp phong bì, gồm metadata, padding và các lớp Base64.
export function maxEnvelopeBytes(maxFileBytes: number): number {
  // Tệp được Base64 trong payload rồi bản mã lại Base64 ngoài envelope; cộng thêm biên an toàn.
  return Math.ceil((Math.ceil(maxFileBytes / 3) * 4 + 4096) / 16 + 1) * 16 * 2 + 8192;
}
