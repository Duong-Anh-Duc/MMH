import { createApp } from './bootstrap';
import { loadSettings } from './config';

// Điểm vào chương trình: đọc cấu hình, tạo NestJS rồi mở cổng HTTP của đơn vị.
async function main() {
  const settings = loadSettings();
  const app = await createApp(settings);
  // Cho NestJS đóng tài nguyên đúng cách khi nhận tín hiệu dừng như Ctrl+C.
  app.enableShutdownHooks();
  await app.listen(settings.port, settings.host);
  console.log(`Đơn vị ${settings.unitId}: ${await app.getUrl()}/docs`);
}

// Báo lỗi khởi động và trả mã thất bại cho terminal; không tiếp tục chạy với cấu hình sai.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Không khởi động được ứng dụng.');
  process.exitCode = 1;
});
