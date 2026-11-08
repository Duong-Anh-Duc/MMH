import { join } from 'node:path';
import { Settings } from '../src/config';
import { CryptoService } from '../src/crypto/crypto.service';
import { EnvelopesService } from '../src/envelopes/envelopes.service';
import { ReplayService } from '../src/envelopes/replay.service';
import { KeysService } from '../src/keys/keys.service';

export const passphrase = 'MatKhau-ThucNghiem-2026!';

// Tạo bộ service của một đơn vị trong thư mục thử nghiệm riêng, không đụng dữ liệu người dùng.
export function unit(root: string, unitId: string) {
  const settings: Settings = {
    unitId,
    host: '127.0.0.1',
    port: 0,
    dataDir: join(root, unitId),
    maxFileBytes: 1024 * 1024,
    timestampWindowSeconds: 300,
  };
  const crypto = new CryptoService();
  const keys = new KeysService(settings, crypto);
  const replay = new ReplayService(settings);
  const envelopes = new EnvelopesService(settings, crypto, keys, replay);
  return { settings, crypto, keys, replay, envelopes };
}

// Chuẩn bị cặp đơn vị đã có khóa và đã ghim khóa công khai của nhau cho các bài kiểm thử.
export async function connect(a: ReturnType<typeof unit>, b: ReturnType<typeof unit>) {
  const [aKey, bKey] = await Promise.all([
    a.keys.generate(passphrase, 2048),
    b.keys.generate(passphrase, 2048),
  ]);
  await Promise.all([
    a.keys.trust(bKey.unitId, bKey.publicKeyPem, bKey.fingerprint),
    b.keys.trust(aKey.unitId, aKey.publicKeyPem, aKey.fingerprint),
  ]);
  return { aKey, bKey };
}
