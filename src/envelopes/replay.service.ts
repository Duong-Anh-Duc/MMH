import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { SETTINGS, Settings } from '../config';
import { EnvelopeHeader } from './envelope';
import { AcceptedFile, StorageService } from '../storage/storage.service';

@Injectable()
export class ReplayService {
  // Nhận đường dẫn kho dữ liệu của đúng đơn vị, không chia sẻ lịch sử nhận nhầm sang đơn vị khác.
  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    @Optional() private readonly storage?: StorageService,
  ) {}

  // Ghi nhận request_id bằng unique index MongoDB; test lõi dùng tệp tạo độc quyền thay thế.
  async claim(header: EnvelopeHeader, record?: AcceptedFile): Promise<string | undefined> {
    if (this.storage?.enabled && record) return this.storage.accept(header, record);
    const dir = join(this.settings.dataDir, 'received');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      // Cờ wx tạo tệp độc quyền trên hệ tệp cục bộ; dấu nhận vẫn còn sau khi ứng dụng khởi động lại.
      const file = await open(join(dir, `${header.request_id}.json`), 'wx', 0o600);
      try {
        // Lưu thông tin tối thiểu để đối soát; không lưu tài liệu rõ hay khóa phiên trong lịch sử.
        await file.writeFile(
          JSON.stringify({ request_id: header.request_id, acceptedAt: new Date().toISOString() }),
        );
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Tệp tồn tại nghĩa là UUID này của cùng khóa gửi đã được tiếp nhận trước đó.
        throw new ConflictException('Gói tin đã được tiếp nhận trước đó (chống phát lại).');
      }
      throw error;
    }
  }
}
