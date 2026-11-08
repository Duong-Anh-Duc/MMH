import { HttpException } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { Collection, MongoClient } from 'mongodb';
import { createApp } from '../src/bootstrap';
import { KeysService } from '../src/keys/keys.service';
import { EnvelopesService } from '../src/envelopes/envelopes.service';
import { StorageService } from '../src/storage/storage.service';
import { demoSettings, jsonPost } from '../scripts/support';
import { passphrase } from './helpers';

let root: string;
let a: Awaited<ReturnType<typeof createApp>>;
let b: Awaited<ReturnType<typeof createApp>>;
let base: string;
const database = `ptit_test_${randomUUID().replaceAll('-', '')}`;
const mongoUri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27018';

// Kiểm thử với MongoDB thật; cần khởi động docker compose up -d mongodb trước npm test.
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ptit-mongo-test-'));
  a = await createApp(
    { ...demoSettings(root, 'don-vi-a'), mongoUri, mongoDbName: database },
    false,
  );
  b = await createApp(
    {
      ...demoSettings(root, 'don-vi-b'),
      mongoUri,
      mongoDbName: database,
      receivePassphrase: passphrase,
    },
    false,
  );
  await a.listen(0, '127.0.0.1');
  await b.listen(0, '127.0.0.1');
  base = await b.getUrl();
  const keyA = await a.get(KeysService).generate(passphrase, 2048);
  const keyB = await b.get(KeysService).generate(passphrase, 2048);
  await a.get(KeysService).trust('don-vi-b', keyB.publicKeyPem, keyB.fingerprint);
  await b.get(KeysService).trust('don-vi-a', keyA.publicKeyPem, keyA.fingerprint);
});
// Chỉ xóa cơ sở dữ liệu test có UUID do chính lượt chạy này tạo; không xóa DB demo của người dùng.
after(async () => {
  await Promise.all([a?.close(), b?.close()]);
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    await client.db(database).dropDatabase();
  } finally {
    await client.close();
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test('Khóa đối tác được truy xuất từ MongoDB và không bị thay khóa đã ghim', async () => {
  const status = await b.get(StorageService).status();
  assert.ok(status.enabled);
  assert.equal(status.peers, 1);
  const peer = await b.get(KeysService).peer('don-vi-a');
  assert.equal(peer.fingerprint, (await a.get(KeysService).status()).fingerprint);
});

test('POST JSON theo Chương 2 nhận công văn, lưu GridFS và tải đúng byte', async () => {
  const original = Buffer.from('Tài liệu thử nghiệm MongoDB\n');
  const envelope = await a
    .get(EnvelopesService)
    .seal(original, 'mongo.txt', 'text/plain', 'don-vi-b', passphrase, 'Trích yếu công văn');
  const receipt = await jsonPost(base, '/api/envelopes/receive', envelope, 200);
  assert.equal(receipt.request_id, envelope.header.request_id);
  const response = await fetch(`${base}${receipt.download_url}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  assert.equal((await b.get(StorageService).status()).receipts, 1);
  const replay = await fetch(`${base}/api/envelopes/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  assert.equal(replay.status, 409);
});

test('Chỉ mục MongoDB nhận đồng thời một UUID đúng một lần và không để dư file GridFS', async () => {
  const envelope = await a
    .get(EnvelopesService)
    .seal(Buffer.from('race'), 'race.txt', 'text/plain', 'don-vi-b', passphrase);
  const results = await Promise.allSettled([
    b.get(EnvelopesService).open(Buffer.from(JSON.stringify(envelope)), passphrase),
    b.get(EnvelopesService).open(Buffer.from(JSON.stringify(envelope)), passphrase),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(
    results.some(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof HttpException &&
        r.reason.getStatus() === 409,
    ),
  );
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(database);
    assert.equal(
      await db.collection('documents.files').countDocuments({ 'metadata.ownerId': 'don-vi-b' }),
      2,
    );
    assert.equal(await db.collection('receipts').countDocuments({ ownerId: 'don-vi-b' }), 2);
  } finally {
    await client.close();
  }
});

test('Kết nối MongoDB mới vẫn tải lại tài liệu và nhận diện request_id đã xử lý', async () => {
  const settings = { ...demoSettings(root, 'don-vi-b'), mongoUri, mongoDbName: database };
  const reconnected = new StorageService(settings);
  try {
    await reconnected.onModuleInit();
    assert.equal((await reconnected.status()).receipts, 2);
    assert.equal((await reconnected.peer('don-vi-a')).unitId, 'don-vi-a');
  } finally {
    await reconnected.onModuleDestroy();
  }
});

test('Tệp trên 24 KiB đi qua endpoint JSON và được lưu đầy đủ', async () => {
  const original = Buffer.alloc(65536, 42);
  const envelope = await a
    .get(EnvelopesService)
    .seal(original, '64k.bin', 'application/octet-stream', 'don-vi-b', passphrase);
  const receipt = await jsonPost(base, '/api/envelopes/receive', envelope, 200);
  assert.deepEqual((await b.get(StorageService).document(receipt.document_id)).file, original);
});

test('REST receive thiếu body phải trả 400, không phát sinh lỗi nội bộ 500', async () => {
  const before = await b.get(StorageService).status();
  const response = await fetch(`${base}/api/envelopes/receive`, { method: 'POST' });
  assert.equal(response.status, 400);
  assert.equal((await b.get(StorageService).status()).receipts, before.receipts);
});

test('Không xóa tệp đã nhận nếu phản hồi ghi MongoDB bị mất sau khi commit', async () => {
  const original = Buffer.from('Biên nhận đã commit nhưng mất phản hồi mạng.');
  const envelope = await a
    .get(EnvelopesService)
    .seal(original, 'reply-lost.txt', 'text/plain', 'don-vi-b', passphrase);
  const insert = Collection.prototype.insertOne;
  // Cho MongoDB ghi thật rồi mô phỏng mất phản hồi, thay vì mô phỏng lỗi trước khi ghi.
  const intercepted = mock.method(
    Collection.prototype,
    'insertOne',
    async function (this: Collection, ...args: Parameters<Collection['insertOne']>) {
      const result = await insert.apply(this, args);
      if (this.collectionName === 'receipts' && args[0].request_id === envelope.header.request_id) {
        throw new Error('Simulated lost acknowledgement after commit.');
      }
      return result;
    },
  );
  try {
    const accepted = await b
      .get(EnvelopesService)
      .open(Buffer.from(JSON.stringify(envelope)), passphrase);
    assert.ok(accepted.documentId);
    assert.deepEqual((await b.get(StorageService).document(accepted.documentId)).file, original);
  } finally {
    intercepted.mock.restore();
  }
});
