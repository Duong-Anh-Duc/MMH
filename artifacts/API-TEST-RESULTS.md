# Kết quả kiểm thử API

Thời điểm: `2026-11-08T02:19:01.518Z` (UTC).

Chạy HTTP thực tế với hai ứng dụng NestJS dùng kho khóa và cơ sở dữ liệu MongoDB riêng cho kiểm thử.

- Toàn bộ bộ kiểm thử: **65/65 đạt**, 0 thất bại, 0 bỏ qua.
- Bao phủ hành vi: **12/12 API** có luồng thành công.
- Tổng yêu cầu HTTP: **72**, gồm API và kiểm tra Swagger/chuyển hướng.
- Mã HTTP khác mong đợi: **0**.

## Kết quả từng API

| Method | Endpoint                 | Lượt gọi | Mã HTTP đã kiểm tra | Kết quả |
| ------ | ------------------------ | -------: | ------------------- | ------- |
| `GET`  | `/api/health`            |        4 | 200, 403            | Đạt     |
| `GET`  | `/api/keys/status`       |        3 | 200                 | Đạt     |
| `GET`  | `/api/keys/public`       |        3 | 200, 404            | Đạt     |
| `POST` | `/api/keys/generate`     |        6 | 201, 400, 409       | Đạt     |
| `POST` | `/api/keys/import`       |        3 | 201, 400, 409       | Đạt     |
| `POST` | `/api/peers`             |        6 | 201, 400, 409       | Đạt     |
| `POST` | `/api/envelopes/seal`    |        9 | 200, 400, 404       | Đạt     |
| `POST` | `/api/envelopes/verify`  |        4 | 200, 401            | Đạt     |
| `POST` | `/api/envelopes/open`    |        4 | 200, 400, 401, 409  | Đạt     |
| `POST` | `/api/envelopes/receive` |       15 | 200, 400, 409, 503  | Đạt     |
| `GET`  | `/api/documents/{id}`    |        8 | 200, 400, 404       | Đạt     |
| `GET`  | `/api/storage/status`    |        2 | 200                 | Đạt     |

## Các hành vi được xác nhận

- Sinh khóa, nhập khóa PEM, tải khóa công khai và chặn ghi đè cặp khóa đã có.
- Ghim khóa hai chiều; từ chối sai vân tay, tự ghim chính mình và thay khóa đối tác.
- Mã hóa/ký, xác minh trước giải mã, nhận tệp bằng multipart hoặc JSON và tải lại từ GridFS.
- Khôi phục đúng từng byte của PDF, DOCX, PNG và tệp nhị phân có tên tiếng Việt.
- Sai mật khẩu không tiêu thụ UUID; phát lại giữa `open`/`receive` trả 409.
- Bản mã bị sửa trả 401; UUID/thời gian/Base64/body lỗi trả 400.
- Thiếu cấu hình nhận tự động trả 503; origin trình duyệt khác bị chặn bằng 403.
- Bên A không tải được tài liệu thuộc B; ID tài liệu sai hoặc không tồn tại bị từ chối.
- Kiểm tra metadata phản hồi, SHA-256, số bản ghi theo đơn vị và schema OpenAPI.

## Bằng chứng và chạy lại

- [Mã kiểm thử HTTP](../tests/api.integration.spec.ts)
- [Chi tiết từng yêu cầu HTTP](api-test-results.json)
- [Tổng kết kiểm thử](test-results.json)
- [Nhật ký TAP đầy đủ](test-results.tap)

Có MongoDB sẵn, chạy `npm test`; nếu MongoDB không ở cổng mặc định 27018, đặt `MONGODB_URI` trong môi trường tiến trình.

Các số 400/401/403/404/409/503 là kết quả mong đợi của ca lỗi đã chủ động tạo. Bao phủ đủ endpoint không đồng nghĩa bao phủ mọi tổ hợp đầu vào hoặc kiểm thử tải.
