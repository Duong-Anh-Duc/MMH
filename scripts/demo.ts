import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/bootstrap';
import { CryptoService } from '../src/crypto/crypto.service';
import { Envelope, signingBytes } from '../src/envelopes/envelope';
import { StorageService } from '../src/storage/storage.service';
import { createSamples } from './samples';
import { demoSettings, jsonPost, upload } from './support';

// Chạy đúng luồng Chương 2: A đóng gói, POST JSON sang B, B lưu MongoDB rồi tải lại tệp GridFS.
async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const output = resolve('artifacts/demo', runId);
  await mkdir(output, { recursive: true });
  const mongoDbName = `ptit_demo_${Date.now()}`;
  const passwordA = randomBytes(24).toString('hex');
  const passwordB = randomBytes(24).toString('hex');
  const a = await createApp(
    { ...demoSettings(resolve(output, 'private-data'), 'don-vi-a'), mongoDbName },
    false,
  );
  const b = await createApp(
    {
      ...demoSettings(resolve(output, 'private-data'), 'don-vi-b'),
      mongoDbName,
      receivePassphrase: passwordB,
    },
    false,
  );
  const crypto = new CryptoService();
  try {
    await a.listen(0, '127.0.0.1');
    await b.listen(0, '127.0.0.1');
    const urlA = await a.getUrl();
    const urlB = await b.getUrl();
    const [keyA, keyB] = await Promise.all([
      jsonPost(urlA, '/api/keys/generate', { passphrase: passwordA, modulusLength: 2048 }),
      jsonPost(urlB, '/api/keys/generate', { passphrase: passwordB, modulusLength: 2048 }),
    ]);
    await jsonPost(urlA, '/api/peers', {
      unitId: keyB.unitId,
      publicKeyPem: keyB.publicKeyPem,
      expectedFingerprint: keyB.fingerprint,
    });
    await jsonPost(urlB, '/api/peers', {
      unitId: keyA.unitId,
      publicKeyPem: keyA.publicKeyPem,
      expectedFingerprint: keyA.fingerprint,
    });
    await writeFile(resolve(output, 'don-vi-a-public.pem'), keyA.publicKeyPem);
    await writeFile(resolve(output, 'don-vi-b-public.pem'), keyB.publicKeyPem);
    const files = [];
    let first: Envelope | undefined;
    for (const sample of await createSamples()) {
      const start = performance.now();
      const sealed = await fetch(`${urlA}/api/envelopes/seal`, {
        method: 'POST',
        body: upload(
          sample.data,
          sample.name,
          {
            recipientId: 'don-vi-b',
            passphrase: passwordA,
            subject: 'Công văn thử nghiệm liên đơn vị',
          },
          sample.mime,
        ),
      });
      assert.equal(sealed.status, 200, await sealed.clone().text());
      const wire = Buffer.from(await sealed.arrayBuffer());
      const sealMs = performance.now() - start;
      const envelope = JSON.parse(wire.toString()) as Envelope;
      first ??= envelope;
      await writeFile(resolve(output, `${sample.name}.envelope.json`), wire);
      if (sample.name.endsWith('.pdf')) await writeFile(resolve(output, 'package.json'), wire);
      const receiveStart = performance.now();
      const receipt = await jsonPost(urlB, '/api/envelopes/receive', envelope, 200);
      const receiveMs = performance.now() - receiveStart;
      assert.equal(receipt.status, 'accepted');
      assert.match(receipt.document_id, /^[a-f0-9]{24}$/);
      const downloaded = await fetch(`${urlB}${receipt.download_url}`);
      assert.equal(downloaded.status, 200);
      const restored = Buffer.from(await downloaded.arrayBuffer());
      assert.deepEqual(restored, sample.data);
      assert.equal(receipt.sha256, crypto.sha256(restored));
      await writeFile(resolve(output, `restored-${sample.name}`), restored);
      await writeFile(
        resolve(output, `${sample.name}.receipt.json`),
        JSON.stringify(receipt, null, 2),
      );
      files.push({
        filename: sample.name,
        originalBytes: sample.data.length,
        envelopeBytes: wire.length,
        sha256: crypto.sha256(restored),
        identical: true,
        sealHttpMs: sealMs,
        receiveHttpMs: receiveMs,
        documentId: receipt.document_id,
      });
    }
    assert.ok(first);
    // Gọi đúng endpoint nhận JSON, không giả lập bằng cách nạp thẳng service hoặc bản rõ.
    const attempt = (e: Envelope) =>
      fetch(`${urlB}/api/envelopes/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(e),
      });
    const tampered = structuredClone(first);
    const modified = Buffer.from(tampered.payload.encrypted_data, 'base64');
    modified[0] ^= 1;
    tampered.payload.encrypted_data = modified.toString('base64');
    const tamper = await attempt(tampered);
    assert.equal(tamper.status, 401);
    const attackerPassword = randomBytes(24).toString('hex');
    const pair = await crypto.generateRsaPair(attackerPassword, 2048);
    const spoofed = structuredClone(first);
    spoofed.payload.signature = crypto
      .sign(signingBytes(spoofed), crypto.privateKey(pair.privateKeyPem, attackerPassword))
      .toString('base64');
    const spoof = await attempt(spoofed);
    assert.equal(spoof.status, 401);
    const replay = await attempt(first);
    assert.equal(replay.status, 409);
    const rewritten = structuredClone(first);
    rewritten.header.request_id = randomUUID();
    rewritten.header.timestamp = new Date().toISOString();
    const rewrittenReplay = await attempt(rewritten);
    assert.equal(rewrittenReplay.status, 400);
    const mongo = await b.get(StorageService).status();
    assert.ok(mongo.enabled);
    assert.equal(mongo.receipts, 3);
    const summary = {
      executedAt: new Date().toISOString(),
      node: process.version,
      protocol: 'chapter-2-header-payload',
      transport: 'HTTP POST application/json + MongoDB GridFS',
      outputDirectory: output,
      files,
      mongo,
      scenarios: {
        happyCase: 'PASS',
        multipleFormats: 'PASS',
        tampering: { status: tamper.status, result: 'PASS' },
        spoofing: { status: spoof.status, result: 'PASS' },
        replay: { status: replay.status, result: 'PASS' },
        rewrittenReplay: { status: rewrittenReplay.status, result: 'PASS' },
      },
    };
    await writeFile(resolve(output, 'results.json'), JSON.stringify(summary, null, 2));
    await writeFile(resolve('artifacts/demo-results.json'), JSON.stringify(summary, null, 2));
    console.table(
      files.map(({ filename, originalBytes, envelopeBytes, identical }) => ({
        filename,
        originalBytes,
        envelopeBytes,
        identical,
      })),
    );
    console.log(
      `Can thiệp ${tamper.status}; giả mạo ${spoof.status}; phát lại ${replay.status}; đổi UUID phát lại ${rewrittenReplay.status}.`,
    );
    console.log(
      `MongoDB ${mongo.version}: ${mongo.peers} khóa đối tác, ${mongo.receipts} tài liệu. Kết quả: ${output}`,
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}
// Mọi lỗi demo phải làm lệnh thất bại; số liệu chỉ được ghi khi tất cả phép đối chiếu đã đạt.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
