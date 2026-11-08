import { HttpException } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { signingBytes } from '../src/envelopes/envelope';
import { connect, passphrase, unit } from './helpers';

let root: string;
let a: ReturnType<typeof unit>;
let b: ReturnType<typeof unit>;
// Chuẩn bị hai đơn vị có kho khóa riêng, không tác động dữ liệu của người dùng.
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ptit-crypto-test-'));
  a = unit(root, 'don-vi-a');
  b = unit(root, 'don-vi-b');
  await connect(a, b);
});
// Dọn kho thử sau khi mọi ca kiểm thử đã kết thúc.
after(async () => {
  await rm(root, { recursive: true, force: true });
});
// Mô phỏng byte của một tệp phong bì JSON được truyền qua mạng.
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
// Xác nhận đúng nhóm lỗi HTTP mong đợi, không chỉ kiểm tra có ném lỗi bất kỳ.
const status = (code: number) => (error: unknown) =>
  error instanceof HttpException && error.getStatus() === code;
// Mỗi test nhận một UUID, khóa phiên và IV mới để không bị ảnh hưởng lịch sử nhận của test khác.
const seal = () =>
  a.envelopes.seal(
    Buffer.from('Công văn nội bộ\n'),
    'cong-van.txt',
    'text/plain',
    'don-vi-b',
    passphrase,
  );

test('Luồng chuẩn khôi phục đúng từng byte và SHA-256', async () => {
  const result = await b.envelopes.open(bytes(await seal()), passphrase);
  assert.deepEqual(result.file, Buffer.from('Công văn nội bộ\n'));
  assert.equal(result.sha256, a.crypto.sha256(result.file));
});
test('Phong bì có đúng 5 trường header và 3 trường payload theo Chương 2', async () => {
  const e = await seal();
  assert.deepEqual(Object.keys(e).sort(), ['header', 'payload']);
  assert.deepEqual(Object.keys(e.header).sort(), [
    'key',
    'receiver_id',
    'request_id',
    'sender_id',
    'timestamp',
  ]);
  assert.deepEqual(Object.keys(e.payload).sort(), ['encrypted_data', 'iv', 'signature']);
});
test('Chữ ký là RSASSA-PKCS1-v1_5/SHA-256 trên chuỗi Base64 encrypted_data', async () => {
  const e = await seal();
  assert.deepEqual(signingBytes(e), Buffer.from(e.payload.encrypted_data, 'ascii'));
  assert.ok(
    a.crypto.verify(
      Buffer.from(e.payload.encrypted_data),
      Buffer.from(e.payload.signature, 'base64'),
      a.crypto.publicKey(await a.keys.publicPem()),
    ),
  );
});
test('Cùng đầu vào vẫn có khóa phiên, IV, UUID và bản mã mới', async () => {
  const first = await seal();
  const second = await seal();
  assert.notEqual(first.header.request_id, second.header.request_id);
  assert.notEqual(first.header.key, second.header.key);
  assert.notEqual(first.payload.iv, second.payload.iv);
  assert.notEqual(first.payload.encrypted_data, second.payload.encrypted_data);
});
for (const field of ['encrypted_data', 'signature'] as const) {
  test(`Sửa payload.${field}: từ chối trước bước mở khóa bí mật`, async () => {
    const e = await seal();
    const data = Buffer.from(e.payload[field], 'base64');
    data[0] ^= 1;
    e.payload[field] = data.toString('base64');
    await assert.rejects(b.envelopes.open(bytes(e), 'wrong-password-123'), status(401));
  });
}
for (const field of ['request_id', 'timestamp', 'key', 'receiver_id', 'iv'] as const) {
  test(`Sửa ${field}: không được chấp nhận nội dung hoặc ghi biên nhận`, async () => {
    const e = await seal();
    if (field === 'request_id') e.header.request_id = randomUUID();
    else if (field === 'timestamp')
      e.header.timestamp = new Date(Date.parse(e.header.timestamp) + 1000).toISOString();
    else if (field === 'receiver_id') e.header.receiver_id = 'don-vi-c';
    else {
      const value = Buffer.from(field === 'key' ? e.header.key : e.payload.iv, 'base64');
      value[0] ^= 1;
      if (field === 'key') e.header.key = value.toString('base64');
      else e.payload.iv = value.toString('base64');
    }
    await assert.rejects(b.envelopes.open(bytes(e), passphrase), status(400));
  });
}
test('Không thể thay sender_id bằng bí danh cùng khóa để giả mạo đơn vị', async () => {
  const pem = await a.keys.publicPem();
  await b.keys.trust('bi-danh-a', pem, a.crypto.fingerprint(a.crypto.publicKey(pem)));
  const e = await seal();
  e.header.sender_id = 'bi-danh-a';
  await assert.rejects(b.envelopes.open(bytes(e), passphrase), status(400));
});
test('Không thể sửa UUID và timestamp để phát lại bản mã cũ', async () => {
  const e = await seal();
  await b.envelopes.open(bytes(e), passphrase);
  e.header.request_id = randomUUID();
  e.header.timestamp = new Date().toISOString();
  await assert.rejects(b.envelopes.open(bytes(e), passphrase), status(400));
});
test('Giả mạo chữ ký bằng khóa kẻ tấn công bị từ chối', async () => {
  const e = await seal();
  const attacker = await a.crypto.generateRsaPair(passphrase, 2048);
  e.payload.signature = a.crypto
    .sign(signingBytes(e), a.crypto.privateKey(attacker.privateKeyPem, passphrase))
    .toString('base64');
  await assert.rejects(b.envelopes.open(bytes(e), passphrase), status(401));
});
test('Người gửi chưa ghim khóa bị từ chối', async () => {
  const e = await seal();
  e.header.sender_id = 'nguoi-la';
  await assert.rejects(b.envelopes.open(bytes(e), passphrase), status(404));
});
test('Sai mật khẩu không tiêu thụ request_id', async () => {
  const e = bytes(await seal());
  await assert.rejects(b.envelopes.open(e, 'wrong-password-123'), status(400));
  await b.envelopes.open(e, passphrase);
});
test('Khởi tạo lại service vẫn từ chối gói đã nhận', async () => {
  const e = bytes(await seal());
  await b.envelopes.open(e, passphrase);
  await assert.rejects(unit(root, 'don-vi-b').envelopes.open(e, passphrase), status(409));
});
test('Hai lần nhận đồng thời chỉ có một lần thành công', async () => {
  const e = bytes(await seal());
  const results = await Promise.allSettled([
    b.envelopes.open(e, passphrase),
    b.envelopes.open(e, passphrase),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.some((r) => r.status === 'rejected' && status(409)(r.reason)));
});
test('verify không tiêu thụ UUID và chưa xác nhận bản sao control', async () => {
  const e = bytes(await seal());
  await b.envelopes.verify(e);
  await b.envelopes.verify(e);
  await b.envelopes.open(e, passphrase);
});
test('Thứ tự trường JSON và khoảng trắng không ảnh hưởng kết quả', async () => {
  const e = await seal();
  const reordered = {
    payload: Object.fromEntries(Object.entries(e.payload).reverse()),
    header: Object.fromEntries(Object.entries(e.header).reverse()),
  };
  await b.envelopes.open(Buffer.from(JSON.stringify(reordered, null, 4)), passphrase);
});
for (const delta of [-301000, 301000]) {
  test(`Timestamp lệch ${delta / 1000} giây ngoài cửa sổ ±300 giây bị từ chối`, async () => {
    const e = await seal();
    e.header.timestamp = new Date(Date.now() + delta).toISOString();
    await assert.rejects(b.envelopes.open(bytes(e), passphrase), status(400));
  });
}
test('Tệp rỗng và kích thước quanh khối AES đều khôi phục đúng', async () => {
  for (const size of [0, 1, 15, 16, 17, 65536]) {
    const original = randomBytes(size);
    const e = await a.envelopes.seal(
      original,
      'binary.bin',
      'application/octet-stream',
      'don-vi-b',
      passphrase,
    );
    assert.deepEqual((await b.envelopes.open(bytes(e), passphrase)).file, original);
  }
});
test('JSON, Base64 sai, trường dư và schema cũ bị từ chối', async () => {
  await assert.rejects(b.envelopes.verify(Buffer.from('{invalid')), status(400));
  const e = await seal();
  for (const bad of [
    { ...e, unknown: true },
    { ...e, payload: { ...e.payload, iv: '???=' } },
    { ...e, header: { ...e.header, version: '1.0' } },
  ]) {
    await assert.rejects(b.envelopes.verify(bytes(bad)), status(400));
  }
});
test('Tên có đường dẫn và tệp vượt giới hạn bị từ chối', async () => {
  await assert.rejects(
    a.envelopes.seal(Buffer.from('x'), '../secret', 'text/plain', 'don-vi-b', passphrase),
    status(400),
  );
  await assert.rejects(
    a.envelopes.seal(
      Buffer.alloc(a.settings.maxFileBytes + 1),
      'large.bin',
      'application/octet-stream',
      'don-vi-b',
      passphrase,
    ),
    status(400),
  );
});
test('Khóa bí mật mã hóa, quyền POSIX 0600 và không được ghi đè', async () => {
  const path = join(a.settings.dataDir, 'identity/private.pem');
  assert.match(await readFile(path, 'utf8'), /BEGIN ENCRYPTED PRIVATE KEY/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(a.keys.generate(passphrase, 2048), status(409));
});
test('Không tin khóa sai vân tay hoặc thay khóa đã ghim', async () => {
  const attacker = await a.crypto.generateRsaPair(passphrase, 2048);
  await assert.rejects(
    a.keys.trust('don-vi-c', attacker.publicKeyPem, '0'.repeat(64)),
    status(400),
  );
  await assert.rejects(
    a.keys.trust('don-vi-b', attacker.publicKeyPem, attacker.fingerprint),
    status(409),
  );
});
test('Tên tệp không lộ trên gói tin; IV và RSA có đúng kích thước', async () => {
  const e = await seal();
  assert.ok(!JSON.stringify(e).includes('cong-van.txt'));
  assert.equal(Buffer.from(e.payload.iv, 'base64').length, 16);
  assert.equal(Buffer.from(e.header.key, 'base64').length, 256);
});

test('Nhập PKCS#1 rồi lưu thành PKCS#8 mã hóa mà không đổi cặp khóa', async () => {
  const importer = unit(root, 'don-vi-import');
  const original = await a.keys.privateKey(passphrase);
  const pem = original.export({ type: 'pkcs1', format: 'pem' }).toString();
  const imported = await importer.keys.importIdentity(pem, passphrase);
  assert.equal(imported.fingerprint, a.crypto.fingerprint(original));
  assert.match(
    await readFile(join(importer.settings.dataDir, 'identity/private.pem'), 'utf8'),
    /ENCRYPTED PRIVATE KEY/,
  );
  await assert.rejects(importer.keys.importIdentity(pem, passphrase), status(409));
});
