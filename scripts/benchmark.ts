import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, arch, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CryptoService } from '../src/crypto/crypto.service';
import { EnvelopesService } from '../src/envelopes/envelopes.service';
import { ReplayService } from '../src/envelopes/replay.service';
import { KeysService } from '../src/keys/keys.service';
import { StorageService } from '../src/storage/storage.service';
import { demoSettings } from './support';

const rounds = 5;
// Tính trung bình cộng của các lần đo để báo cáo thời gian tổng quát cho từng kích thước tệp.
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
// Lấy trung vị của năm lượt đo để có thêm chỉ số ít bị ảnh hưởng bởi một lượt chậm bất thường.
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// Đo hiệu năng toàn luồng ở lớp service, không đo mạng và không tính thời gian sinh cặp RSA vào từng lượt.
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'ptit-benchmark-'));
  const crypto = new CryptoService();
  const password = randomBytes(24).toString('hex');
  const settingsA = demoSettings(root, 'don-vi-a');
  const settingsB = demoSettings(root, 'don-vi-b');
  settingsA.mongoDbName = settingsB.mongoDbName = `ptit_benchmark_${Date.now()}`;
  const storageA = new StorageService(settingsA);
  const storageB = new StorageService(settingsB);
  await storageA.onModuleInit();
  await storageB.onModuleInit();
  const aKeys = new KeysService(settingsA, crypto, storageA);
  const bKeys = new KeysService(settingsB, crypto, storageB);
  const a = new EnvelopesService(settingsA, crypto, aKeys, new ReplayService(settingsA, storageA));
  const b = new EnvelopesService(settingsB, crypto, bKeys, new ReplayService(settingsB, storageB));
  try {
    const start = performance.now();
    const keyA = await aKeys.generate(password, 2048);
    const keyB = await bKeys.generate(password, 2048);
    const keyGenerationMs = performance.now() - start;
    await aKeys.trust(keyB.unitId, keyB.publicKeyPem, keyB.fingerprint);
    await bKeys.trust(keyA.unitId, keyA.publicKeyPem, keyA.fingerprint);
    // Chạy một lượt làm nóng trước khi thu số liệu để giảm ảnh hưởng khởi tạo lần đầu.
    const warmup = await a.seal(
      Buffer.alloc(1024),
      'warmup.bin',
      'application/octet-stream',
      'don-vi-b',
      password,
    );
    await b.open(Buffer.from(JSON.stringify(warmup)), password);
    const rows = [];
    for (const size of [1024, 64 * 1024, 1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024]) {
      const source = randomBytes(size);
      const timings = [];
      let envelopeBytes = 0;
      for (let round = 0; round < rounds; round++) {
        // Tính cả chuyển đổi JSON/Base64 và thao tác kho khóa/lịch sử như luồng ứng dụng thật.
        const begin = performance.now();
        const sealed = await a.seal(
          source,
          'benchmark.bin',
          'application/octet-stream',
          'don-vi-b',
          password,
        );
        const wire = Buffer.from(JSON.stringify(sealed));
        const sealedAt = performance.now();
        const opened = await b.open(wire, password);
        const openedAt = performance.now();
        // Chỉ ghi nhận phép đo nếu tài liệu khôi phục đúng từng byte.
        assert.deepEqual(opened.file, source);
        envelopeBytes = wire.length;
        timings.push({ sealMs: sealedAt - begin, openMs: openedAt - sealedAt });
      }
      rows.push({
        originalBytes: size,
        envelopeBytes,
        overheadPercent: (envelopeBytes / size - 1) * 100,
        sealMeanMs: mean(timings.map((value) => value.sealMs)),
        openMeanMs: mean(timings.map((value) => value.openMs)),
        sealMedianMs: median(timings.map((value) => value.sealMs)),
        openMedianMs: median(timings.map((value) => value.openMs)),
        timings,
      });
    }
    // Lưu cấu hình máy và số liệu thô để người đọc biết điều kiện đo và có thể kiểm tra lại.
    const report = {
      executedAt: new Date().toISOString(),
      rounds,
      warmup: 1,
      rsaBits: 2048,
      node: process.version,
      openssl: process.versions.openssl,
      protocol: 'chapter-2-header-payload',
      mongo: await storageB.status(),
      machine: {
        os: platform(),
        architecture: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        ramGiB: totalmem() / 1024 ** 3,
      },
      measurement:
        'Service-layer including JSON/Base64, PEM import, cryptography, MongoDB peer lookup and GridFS persistence; excludes HTTP transfer, input generation and RSA key generation. Fresh request_id for each round.',
      keyGenerationMsForTwoUnits: keyGenerationMs,
      rows,
    };
    await mkdir(resolve('artifacts'), { recursive: true });
    await writeFile(resolve('artifacts/benchmark.json'), JSON.stringify(report, null, 2));
    const columns = [
      'originalBytes',
      'envelopeBytes',
      'overheadPercent',
      'sealMeanMs',
      'openMeanMs',
      'sealMedianMs',
      'openMedianMs',
    ] as const;
    await writeFile(
      resolve('artifacts/benchmark.csv'),
      `${columns.join(',')}\n${rows.map((row) => columns.map((key) => row[key]).join(',')).join('\n')}\n`,
    );
    console.table(rows.map(({ timings: _timings, ...row }) => row));
    console.log('Số liệu thực tế: artifacts/benchmark.json và artifacts/benchmark.csv');
  } finally {
    await Promise.all([storageA.onModuleDestroy(), storageB.onModuleDestroy()]);
    // Xóa kho khóa thử trong thư mục tạm; không tác động kho data/ mà người dùng tự tạo.
    await rm(root, { recursive: true, force: true });
  }
}

// Nếu phép đo hoặc đối chiếu thất bại, báo lỗi thay vì xuất kết quả thành công giả.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
