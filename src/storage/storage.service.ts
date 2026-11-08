import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Db, GridFSBucket, MongoClient, MongoServerError, ObjectId } from 'mongodb';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SETTINGS, Settings } from '../config';
import type { EnvelopeHeader } from '../envelopes/envelope';

export interface PeerRecord {
  unitId: string;
  fingerprint: string;
  publicKeyPem: string;
}

export interface AcceptedFile {
  file: Buffer;
  filename: string;
  subject: string;
  sha256: string;
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private client?: MongoClient;
  private database?: Db;
  private bucket?: GridFSBucket;

  // MongoDB chỉ chứa khóa công khai và tài liệu đã nhận; khóa bí mật vẫn ở kho PEM cục bộ.
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  // Báo có cấu hình MongoDB hay không; chế độ không MongoDB chỉ dùng trong kiểm thử lõi.
  get enabled(): boolean {
    return Boolean(this.settings.mongoUri);
  }

  // NestJS gọi khi khởi động: kết nối MongoDB và tạo chỉ mục duy nhất cho khóa và request_id.
  async onModuleInit(): Promise<void> {
    if (!this.settings.mongoUri) return;
    this.client = new MongoClient(this.settings.mongoUri, { serverSelectionTimeoutMS: 5000 });
    await this.client.connect();
    this.database = this.client.db(this.settings.mongoDbName ?? 'ptit_envelope');
    this.bucket = new GridFSBucket(this.database, { bucketName: 'documents' });
    await this.database
      .collection('peers')
      .createIndex({ ownerId: 1, unitId: 1 }, { unique: true });
    await this.database
      .collection('receipts')
      .createIndex({ ownerId: 1, request_id: 1 }, { unique: true });
  }

  // Đóng connection pool khi dừng ứng dụng hoặc kết thúc demo/kiểm thử.
  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  // Kiểm tra kết nối đã sẵn sàng, tránh ghi vào kho tệp thay thế khi MongoDB gặp lỗi.
  private db(): Db {
    if (!this.database) throw new Error('MongoDB chưa được khởi tạo.');
    return this.database;
  }

  // Lưu khóa công khai theo đơn vị sở hữu; chỉ cho phép ghi lại cùng vân tay đã ghim.
  async trust(peer: PeerRecord): Promise<PeerRecord> {
    const query = { ownerId: this.settings.unitId, unitId: peer.unitId };
    try {
      await this.db()
        .collection('peers')
        .insertOne({ ...query, ...peer });
      return peer;
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const existing = await this.peer(peer.unitId);
      if (existing.fingerprint !== peer.fingerprint) {
        throw new ConflictException('Đối tác đã ghim khóa khác trong MongoDB.');
      }
      return existing;
    }
  }

  // Tra cứu khóa công khai của đối tác trong danh mục riêng của đơn vị hiện tại.
  async peer(unitId: string): Promise<PeerRecord> {
    const record = await this.db()
      .collection('peers')
      .findOne({ ownerId: this.settings.unitId, unitId });
    if (!record) throw new NotFoundException('Chưa có khóa công khai đối tác trong MongoDB.');
    return {
      unitId: String(record.unitId),
      fingerprint: String(record.fingerprint),
      publicKeyPem: String(record.publicKeyPem),
    };
  }

  // Lưu byte gốc vào GridFS và tạo biên nhận có request_id duy nhất để chống phát lại nguyên tử.
  async accept(header: EnvelopeHeader, record: AcceptedFile): Promise<string> {
    const bucket = this.bucket!;
    const query = { ownerId: this.settings.unitId, request_id: header.request_id };
    if (await this.db().collection('receipts').findOne(query)) {
      throw new ConflictException('Gói tin đã được tiếp nhận trước đó (MongoDB request_id).');
    }
    const upload = bucket.openUploadStream(record.filename, {
      metadata: { ...query, sender_id: header.sender_id, sha256: record.sha256 },
    });
    try {
      await pipeline(Readable.from([record.file]), upload);
    } catch (error) {
      // Chưa thử ghi biên nhận, có thể dọn bản tải lên thất bại mà không xóa một lần nhận đã commit.
      await bucket.delete(upload.id).catch(() => undefined);
      throw error;
    }
    try {
      await this.db()
        .collection('receipts')
        .insertOne({
          ...query,
          sender_id: header.sender_id,
          receiver_id: header.receiver_id,
          timestamp: header.timestamp,
          filename: record.filename,
          subject: record.subject,
          sha256: record.sha256,
          size: record.file.length,
          fileId: upload.id,
          acceptedAt: new Date(),
        });
      return upload.id.toHexString();
    } catch (error) {
      // Mất phản hồi không đồng nghĩa MongoDB chưa commit. Đọc lại bằng request_id và fileId trước.
      const existing = await this.db()
        .collection('receipts')
        .findOne(query)
        .catch(() => undefined);
      if (existing?.fileId instanceof ObjectId && existing.fileId.equals(upload.id)) {
        return upload.id.toHexString();
      }
      if (error instanceof MongoServerError && error.code === 11000) {
        // Chỉ dọn tệp khi xác nhận một biên nhận khác đã thắng cạnh tranh cùng UUID.
        if (existing?.fileId instanceof ObjectId && !existing.fileId.equals(upload.id)) {
          await bucket.delete(upload.id).catch(() => undefined);
        }
        throw new ConflictException('Gói tin đã được nhận bởi yêu cầu đồng thời.');
      }
      // Nếu chưa xác định được kết quả ghi, giữ tệp để đối soát; xóa lúc này có thể làm mất dữ liệu.
      throw error;
    }
  }

  // Lấy đúng tệp thuộc đơn vị hiện tại từ GridFS; không cho truy cập bằng đường dẫn hệ điều hành.
  async document(id: string): Promise<{ file: Buffer; filename: string; sha256: string }> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new BadRequestException('Mã tài liệu không hợp lệ.');
    const receipt = await this.db()
      .collection('receipts')
      .findOne({ ownerId: this.settings.unitId, fileId: new ObjectId(id) });
    if (!receipt) throw new NotFoundException('Không tìm thấy tài liệu tại đơn vị này.');
    const chunks: Buffer[] = [];
    for await (const chunk of this.bucket!.openDownloadStream(new ObjectId(id)))
      chunks.push(Buffer.from(chunk));
    return {
      file: Buffer.concat(chunks),
      filename: String(receipt.filename),
      sha256: String(receipt.sha256),
    };
  }

  // Trả số bản ghi thực tế và phiên bản MongoDB để đưa bằng chứng lưu trữ vào báo cáo.
  async status() {
    if (!this.enabled) return { enabled: false as const };
    const db = this.db();
    const ownerId = this.settings.unitId;
    const [peers, receipts, build] = await Promise.all([
      db.collection('peers').countDocuments({ ownerId }),
      db.collection('receipts').countDocuments({ ownerId }),
      db.admin().command({ buildInfo: 1 }),
    ]);
    return {
      enabled: true as const,
      database: db.databaseName,
      unitId: ownerId,
      peers,
      receipts,
      version: String(build.version),
    };
  }
}
