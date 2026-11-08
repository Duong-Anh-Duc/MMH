import { BadRequestException, Injectable } from '@nestjs/common';
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

export interface RsaPair {
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprint: string;
}

@Injectable()
export class CryptoService {
  // Sinh cặp khóa RSA theo số bit yêu cầu; trả khóa công khai, khóa bí mật đã mã hóa và vân tay.
  async generateRsaPair(passphrase: string, modulusLength: number): Promise<RsaPair> {
    // Bọc API callback trong Promise để các service gọi được bằng await.
    return new Promise((resolve, reject) => {
      generateKeyPair(
        'rsa',
        {
          modulusLength,
          publicExponent: 65537,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: {
            // PKCS#8 chứa khóa bí mật; OpenSSL mã hóa tệp này bằng mật khẩu của đơn vị.
            type: 'pkcs8',
            format: 'pem',
            cipher: 'aes-256-cbc',
            passphrase,
          },
        },
        (error, publicKey, privateKey) => {
          // Chỉ trả kết quả khi quá trình sinh khóa hoàn tất; lỗi được chuyển cho hàm gọi xử lý.
          if (error) return reject(error);
          resolve({
            publicKeyPem: publicKey,
            privateKeyPem: privateKey,
            fingerprint: this.fingerprint(createPublicKey(publicKey)),
          });
        },
      );
    });
  }

  // Đọc chuỗi PEM công khai thành KeyObject và từ chối khóa không thuộc bộ RSA được hỗ trợ.
  publicKey(pem: string): KeyObject {
    if (!/^-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(pem)) {
      throw new BadRequestException('Cần khóa công khai PEM dạng SPKI hoặc PKCS#1.');
    }
    try {
      const key = createPublicKey(pem);
      this.checkRsa(key);
      return key;
    } catch {
      throw new BadRequestException('Khóa phải là RSA từ 2048 đến 4096 bit.');
    }
  }

  // Dùng mật khẩu mở khóa bí mật PKCS#8; không trả chi tiết lỗi mật mã ra API.
  privateKey(pem: string, passphrase: string): KeyObject {
    try {
      const key = createPrivateKey({ key: pem, passphrase });
      this.checkRsa(key);
      return key;
    } catch {
      throw new BadRequestException('Không mở được khóa bí mật. Kiểm tra mật khẩu và tệp khóa.');
    }
  }

  // Nhập PKCS#1/PKCS#8, kiểm tra RSA rồi chuẩn hóa thành PKCS#8 mã hóa trước khi lưu tại đơn vị.
  importRsaPair(pem: string, passphrase: string): RsaPair {
    const key = this.privateKey(pem, passphrase);
    const publicKey = createPublicKey(key);
    return {
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: key
        .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase })
        .toString(),
      fingerprint: this.fingerprint(publicKey),
    };
  }

  // Chặn loại khóa khác RSA và các độ dài ngoài khoảng 2048–4096 bit của bản thực nghiệm.
  private checkRsa(key: KeyObject): void {
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (key.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 4096) {
      throw new Error('Unsupported RSA key.');
    }
  }

  // Tạo mã nhận diện khóa: SHA-256 của khóa công khai SPKI ở dạng nhị phân DER.
  // Hai tệp PEM biểu diễn cùng một khóa sẽ có cùng vân tay dù khác cách xuống dòng.
  fingerprint(key: KeyObject): string {
    const publicKey = key.type === 'public' ? key : createPublicKey(key);
    return this.sha256(publicKey.export({ type: 'spki', format: 'der' }));
  }

  // Băm dữ liệu nhị phân thành chuỗi hex 64 ký tự, dùng để đối chiếu tài liệu trước/sau truyền.
  sha256(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  // Mã hóa AES-256-CBC; nếu chưa truyền khóa/IV thì sinh mới, sau đó trả bản mã và vật liệu mã hóa.
  encrypt(
    plaintext: Buffer,
    key = randomBytes(32),
    iv = randomBytes(16),
  ): { key: Buffer; iv: Buffer; ciphertext: Buffer } {
    // Khóa AES-256 cần 32 byte; IV của AES-CBC cần 16 byte và phải khó đoán trước.
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    // autoPadding mặc định là true: final() bổ sung đệm PKCS#7 vào khối cuối.
    return { key, iv, ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]) };
  }

  // Khôi phục payload bằng đúng khóa phiên và IV; final() kiểm tra rồi bỏ đệm PKCS#7.
  // Chỉ gọi sau khi chữ ký encrypted_data hợp lệ; kiểm tra control của header/IV sau giải mã.
  decrypt(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  // Bọc khóa AES bằng khóa công khai của bên nhận; RSA chỉ xử lý 32 byte khóa, không mã hóa tệp.
  wrapKey(key: Buffer, recipient: KeyObject): Buffer {
    // Chỉ định SHA-256 rõ ràng vì giá trị OAEP mặc định của API không phải SHA-256.
    return publicEncrypt(
      { key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      key,
    );
  }

  // Bên nhận dùng khóa bí mật của mình mở khóa phiên; cấu hình OAEP phải giống lúc bọc khóa.
  unwrapKey(wrappedKey: Buffer, recipient: KeyObject): Buffer {
    return privateDecrypt(
      { key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      wrappedKey,
    );
  }

  // Ký dữ liệu đã chuẩn hóa bằng khóa bí mật bên gửi, theo RSASSA-PKCS1-v1_5/SHA-256.
  // sign() tự băm SHA-256: không băm trước lần nữa để tránh vô tình ký giá trị băm hai lần.
  sign(data: Buffer, sender: KeyObject): Buffer {
    return sign('sha256', data, { key: sender, padding: constants.RSA_PKCS1_PADDING });
  }

  // Dùng khóa công khai bên gửi kiểm tra chữ ký; trả true nếu dữ liệu và chữ ký khớp nhau.
  verify(data: Buffer, signature: Buffer, sender: KeyObject): boolean {
    return verify('sha256', data, { key: sender, padding: constants.RSA_PKCS1_PADDING }, signature);
  }
}
