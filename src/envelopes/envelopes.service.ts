import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { SETTINGS, Settings } from '../config';
import { CryptoService } from '../crypto/crypto.service';
import { KeysService } from '../keys/keys.service';
import {
  decodeBase64,
  Envelope,
  EnvelopeHeader,
  FilePayload,
  maxEnvelopeBytes,
  object,
  parseEnvelope,
  parseJson,
  sameControl,
  signingBytes,
  UnsignedEnvelope,
  validateFilename,
} from './envelope';
import { ReplayService } from './replay.service';

@Injectable()
export class EnvelopesService {
  // Kết hợp mật mã, danh mục khóa và kho chống phát lại thành luồng gửi/nhận của Chương 2.
  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly crypto: CryptoService,
    private readonly keys: KeysService,
    private readonly replay: ReplayService,
  ) {}

  // Bên gửi: Base64 tệp, tạo khóa AES/IV, mã hóa, ký encrypted_data và đóng đúng header/payload.
  async seal(
    file: Buffer,
    filename: string,
    mimeType: string,
    recipientId: string,
    passphrase: string,
    subject = '',
  ): Promise<Envelope> {
    validateFilename(filename);
    if (file.length > this.settings.maxFileBytes)
      throw new BadRequestException('Tệp vượt giới hạn dung lượng.');
    if (subject.length > 500) throw new BadRequestException('Trích yếu tối đa 500 ký tự.');
    const sender = await this.keys.privateKey(passphrase);
    const recipient = await this.keys.peer(recipientId);
    const key = randomBytes(32);
    const iv = randomBytes(16);
    try {
      // Bọc khóa trước để có thể đặt bản sao header.key vào bên trong dữ liệu được bảo vệ.
      const header: EnvelopeHeader = {
        request_id: randomUUID(),
        sender_id: this.settings.unitId,
        receiver_id: recipientId,
        timestamp: new Date().toISOString(),
        key: this.crypto
          .wrapKey(key, this.crypto.publicKey(recipient.publicKeyPem))
          .toString('base64'),
      };
      const ivBase64 = iv.toString('base64');
      const payload: FilePayload = {
        protocol: 'PTIT-ENVELOPE-CH2',
        control: { header, iv: ivBase64 },
        subject,
        filename,
        mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream',
        size: file.length,
        sha256: this.crypto.sha256(file),
        data: file.toString('base64'),
      };
      // Protocol/control được mã hóa cùng tài liệu, giúp phát hiện sửa header hoặc IV sau khi mở.
      const encrypted = this.crypto.encrypt(Buffer.from(JSON.stringify(payload), 'utf8'), key, iv);
      const envelope: UnsignedEnvelope = {
        header,
        payload: { encrypted_data: encrypted.ciphertext.toString('base64'), iv: ivBase64 },
      };
      // sign() tự băm SHA-256 chuỗi encrypted_data đúng mục 2.4.2, không băm lặp hai lần.
      return {
        ...envelope,
        payload: {
          ...envelope.payload,
          signature: this.crypto.sign(signingBytes(envelope), sender).toString('base64'),
        },
      };
    } finally {
      // Chỉ xóa Buffer khóa do hàm sở hữu; không bảo đảm xóa mọi bản sao do runtime/OpenSSL tạo.
      key.fill(0);
    }
  }

  // Kiểm tra cấu trúc, timestamp, địa chỉ nhận và chữ ký bản mã, chưa giải mã hoặc ghi nhận UUID.
  async verify(bytes: Buffer): Promise<Envelope> {
    const envelope = parseEnvelope(bytes, maxEnvelopeBytes(this.settings.maxFileBytes));
    if (
      Math.abs(Date.now() - Date.parse(envelope.header.timestamp)) >
      this.settings.timestampWindowSeconds * 1000
    ) {
      throw new BadRequestException('timestamp nằm ngoài cửa sổ thời gian tiếp nhận.');
    }
    if (envelope.header.receiver_id !== this.settings.unitId)
      throw new BadRequestException('Gói tin không dành cho đơn vị này.');
    const peer = await this.keys.peer(envelope.header.sender_id);
    const valid = this.crypto.verify(
      signingBytes(envelope),
      Buffer.from(envelope.payload.signature, 'base64'),
      this.crypto.publicKey(peer.publicKeyPem),
    );
    if (!valid)
      throw new UnauthorizedException('Chữ ký không hợp lệ. Gói tin có thể đã bị can thiệp.');
    return envelope;
  }

  // Bên nhận: xác minh chữ ký trước, giải RSA/AES sau, đối chiếu control rồi mới lưu và trả tệp gốc.
  async open(bytes: Buffer, passphrase: string) {
    const envelope = await this.verify(bytes);
    const recipient = await this.keys.privateKey(passphrase);
    let sessionKey: Buffer | undefined;
    let plaintext: Buffer;
    try {
      sessionKey = this.crypto.unwrapKey(Buffer.from(envelope.header.key, 'base64'), recipient);
      if (sessionKey.length !== 32) throw new Error('Wrong key length.');
      plaintext = this.crypto.decrypt(
        Buffer.from(envelope.payload.encrypted_data, 'base64'),
        sessionKey,
        Buffer.from(envelope.payload.iv, 'base64'),
      );
    } catch {
      throw new BadRequestException('Không thể khôi phục nội dung gói tin.');
    } finally {
      sessionKey?.fill(0);
    }
    const payload = object(parseJson(plaintext), [
      'protocol',
      'control',
      'subject',
      'filename',
      'mimeType',
      'size',
      'sha256',
      'data',
    ]);
    // Chữ ký của Chương 2 chỉ trực tiếp bao phủ encrypted_data. Phải kiểm tra bản sao control này
    // trước khi xử lý nghiệp vụ để không thể đổi UUID/timestamp rồi phát lại một bản mã đã ký.
    if (payload.protocol !== 'PTIT-ENVELOPE-CH2' || !sameControl(payload.control, envelope)) {
      throw new BadRequestException('Header hoặc IV khác bản sao được bảo vệ trong tài liệu.');
    }
    validateFilename(payload.filename);
    if (
      typeof payload.subject !== 'string' ||
      payload.subject.length > 500 ||
      typeof payload.mimeType !== 'string' ||
      payload.mimeType.length > 255 ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(payload.mimeType) ||
      typeof payload.size !== 'number' ||
      !Number.isSafeInteger(payload.size) ||
      payload.size < 0 ||
      typeof payload.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.sha256)
    ) {
      throw new BadRequestException('Metadata tài liệu không hợp lệ.');
    }
    const file = decodeBase64(payload.data, this.settings.maxFileBytes, 'data');
    if (file.length !== payload.size || this.crypto.sha256(file) !== payload.sha256)
      throw new BadRequestException('Kích thước hoặc SHA-256 của tài liệu không khớp.');
    // MongoDB lưu tệp GridFS và biên nhận với unique request_id; bản test lõi dùng dấu tệp cục bộ.
    const record = {
      file,
      filename: payload.filename,
      subject: payload.subject,
      sha256: payload.sha256,
    };
    const documentId = await this.replay.claim(envelope.header, record);
    return { ...record, header: envelope.header, documentId };
  }

  // Tiếp nhận JSON qua REST API; mật khẩu khóa B chỉ lấy từ cấu hình riêng của B, không do A gửi sang.
  async receive(envelope: unknown) {
    // Chặn body thiếu/null/không phải phong bì trước khi JSON.stringify, tránh lỗi nội bộ 500.
    const body = object(envelope, ['header', 'payload']);
    const passphrase = this.settings.receivePassphrase;
    if (!passphrase)
      throw new ServiceUnavailableException(
        'Chưa cấu hình RECEIVE_KEY_PASSPHRASE tại đơn vị nhận.',
      );
    const result = await this.open(Buffer.from(JSON.stringify(body)), passphrase);
    return {
      request_id: result.header.request_id,
      sender_id: result.header.sender_id,
      receiver_id: result.header.receiver_id,
      filename: result.filename,
      sha256: result.sha256,
      document_id: result.documentId,
      download_url: result.documentId ? `/api/documents/${result.documentId}` : undefined,
      status: 'accepted',
    };
  }
}
