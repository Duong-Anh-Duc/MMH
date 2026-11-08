import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { KeyObject } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SETTINGS, Settings, UNIT_ID_PATTERN } from '../config';
import { CryptoService } from '../crypto/crypto.service';
import { StorageService } from '../storage/storage.service';

interface Peer {
  unitId: string;
  fingerprint: string;
  publicKeyPem: string;
}

@Injectable()
export class KeysService {
  // NestJS truyền cấu hình đơn vị và bộ hàm mật mã vào service qua cơ chế dependency injection.
  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly crypto: CryptoService,
    @Optional() private readonly storage?: StorageService,
  ) {}

  // Tính đường dẫn nơi lưu cặp khóa và thông tin nhận diện của đơn vị hiện tại.
  private get identityDir(): string {
    return join(this.settings.dataDir, 'identity');
  }

  // Tạo thư mục dữ liệu nếu chưa có; trên POSIX, quyền 0700 chỉ cho chủ sở hữu truy cập.
  private async prepareRoot(): Promise<void> {
    await mkdir(this.settings.dataDir, { recursive: true, mode: 0o700 });
  }

  // Sinh và lưu cặp khóa mới; chỉ trả khóa công khai, không trả khóa bí mật qua HTTP.
  async generate(passphrase: string, modulusLength: number) {
    await this.prepareRoot();
    // Tạo thư mục theo thao tác nguyên tử: hai yêu cầu đồng thời không thể ghi đè cặp khóa nhau.
    try {
      await mkdir(this.identityDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConflictException('Đã có khóa cho đơn vị này. Không ghi đè khóa hiện tại.');
      }
      throw error;
    }
    try {
      const pair = await this.crypto.generateRsaPair(passphrase, modulusLength);
      // Quyền 0600 cho phép chủ sở hữu đọc/ghi tệp; private.pem đã được mã hóa bằng mật khẩu.
      await writeFile(join(this.identityDir, 'private.pem'), pair.privateKeyPem, { mode: 0o600 });
      await writeFile(join(this.identityDir, 'public.pem'), pair.publicKeyPem, { mode: 0o600 });
      // Ghi manifest cuối cùng; status() chỉ coi đơn vị sẵn sàng khi có tệp này.
      await writeFile(
        join(this.identityDir, 'identity.json'),
        JSON.stringify({
          unitId: this.settings.unitId,
          fingerprint: pair.fingerprint,
          modulusLength,
        }),
        { mode: 0o600 },
      );
      return {
        unitId: this.settings.unitId,
        fingerprint: pair.fingerprint,
        publicKeyPem: pair.publicKeyPem,
      };
    } catch (error) {
      // Nếu sinh hoặc lưu khóa thất bại, xóa phần dữ liệu vừa tạo để có thể thử lại từ đầu.
      await rm(this.identityDir, { recursive: true, force: true });
      throw error;
    }
  }

  // Nhập khóa do đơn vị đã có sẵn; không ghi đè và luôn lưu lại dưới dạng PKCS#8 mã hóa.
  async importIdentity(privateKeyPem: string, passphrase: string) {
    const pair = this.crypto.importRsaPair(privateKeyPem, passphrase);
    await this.prepareRoot();
    try {
      await mkdir(this.identityDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new ConflictException('Đơn vị đã có cặp khóa, không được ghi đè.');
      throw error;
    }
    try {
      await writeFile(join(this.identityDir, 'private.pem'), pair.privateKeyPem, { mode: 0o600 });
      await writeFile(join(this.identityDir, 'public.pem'), pair.publicKeyPem, { mode: 0o600 });
      const modulusLength = this.crypto.publicKey(pair.publicKeyPem).asymmetricKeyDetails!
        .modulusLength;
      await writeFile(
        join(this.identityDir, 'identity.json'),
        JSON.stringify({
          unitId: this.settings.unitId,
          fingerprint: pair.fingerprint,
          modulusLength,
        }),
        { mode: 0o600 },
      );
      return {
        unitId: this.settings.unitId,
        fingerprint: pair.fingerprint,
        publicKeyPem: pair.publicKeyPem,
      };
    } catch (error) {
      await rm(this.identityDir, { recursive: true, force: true });
      throw error;
    }
  }

  // Đọc manifest để cho biết đã sinh khóa chưa; đồng thời phát hiện dùng nhầm DATA_DIR của đơn vị khác.
  async status() {
    try {
      const identity = JSON.parse(await readFile(join(this.identityDir, 'identity.json'), 'utf8'));
      if (identity.unitId !== this.settings.unitId) {
        throw new ConflictException('DATA_DIR thuộc đơn vị khác. Mỗi đơn vị cần thư mục riêng.');
      }
      return { initialized: true as const, ...identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { initialized: false as const, unitId: this.settings.unitId };
      }
      throw error;
    }
  }

  // Đọc khóa công khai để tải về hoặc gửi cho đối tác; yêu cầu đơn vị đã khởi tạo khóa.
  async publicPem(): Promise<string> {
    if (!(await this.status()).initialized) throw new NotFoundException('Chưa sinh khóa RSA.');
    return readFile(join(this.identityDir, 'public.pem'), 'utf8');
  }

  // Nạp khóa bí mật từ đĩa, mở bằng mật khẩu và kiểm tra nó khớp với khóa công khai đã lưu.
  async privateKey(passphrase: string): Promise<KeyObject> {
    if (!(await this.status()).initialized) throw new NotFoundException('Chưa sinh khóa RSA.');
    const pem = await readFile(join(this.identityDir, 'private.pem'), 'utf8');
    const key = this.crypto.privateKey(pem, passphrase);
    const expected = this.crypto.fingerprint(this.crypto.publicKey(await this.publicPem()));
    if (this.crypto.fingerprint(key) !== expected) {
      throw new BadRequestException('Cặp khóa tại đơn vị không khớp.');
    }
    return key;
  }

  // Ghim khóa công khai của đối tác sau khi vân tay thực tế khớp vân tay đã đối chiếu qua kênh độc lập.
  async trust(unitId: string, pem: string, expectedFingerprint: string): Promise<Peer> {
    if (!UNIT_ID_PATTERN.test(unitId) || unitId === this.settings.unitId) {
      throw new BadRequestException('Mã đơn vị đối tác không hợp lệ.');
    }
    const key = this.crypto.publicKey(pem);
    const fingerprint = this.crypto.fingerprint(key);
    // Kiểm tra này chỉ hữu ích nếu expectedFingerprint đã được xác nhận ngoài kênh gửi tệp khóa.
    if (fingerprint !== expectedFingerprint) {
      throw new BadRequestException('Vân tay khóa không khớp với giá trị đã đối chiếu.');
    }
    if (this.storage?.enabled) {
      return this.storage.trust({
        unitId,
        fingerprint,
        publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString(),
      });
    }
    await this.prepareRoot();
    const peerDir = join(this.settings.dataDir, 'peers');
    await mkdir(peerDir, { recursive: true, mode: 0o700 });
    const peer: Peer = {
      unitId,
      fingerprint,
      publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString(),
    };
    try {
      // Cờ wx yêu cầu tạo tệp mới, không được âm thầm thay khóa đối tác đã ghim.
      await writeFile(join(peerDir, `${unitId}.json`), JSON.stringify(peer), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await this.peer(unitId);
      // Cho phép gửi lại đúng khóa cũ; khóa khác phải được xử lý theo quy trình thay khóa thủ công.
      if (current.fingerprint !== fingerprint) {
        throw new ConflictException(
          'Đơn vị đã ghim khóa khác. Cần xác minh và thay khóa thủ công.',
        );
      }
      return current;
    }
    return peer;
  }

  // Tra cứu khóa đối tác đã ghim; kiểm tra mã đơn vị trước khi ghép vào đường dẫn tệp.
  async peer(unitId: string): Promise<Peer> {
    if (!UNIT_ID_PATTERN.test(unitId)) throw new BadRequestException('Mã đơn vị không hợp lệ.');
    if (this.storage?.enabled) return this.storage.peer(unitId);
    try {
      return JSON.parse(
        await readFile(join(this.settings.dataDir, 'peers', `${unitId}.json`), 'utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Chưa có khóa công khai đã ghim của đơn vị đối tác.');
      }
      throw error;
    }
  }
}
