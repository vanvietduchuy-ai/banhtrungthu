# Trung Thu 2026 — The Curator Cafe

Trang đặt bánh trung thu (HTML tĩnh, không cần build).
`index.html` phải nằm ở **thư mục gốc** của repo.

## Còn một việc trước khi chạy thật
Tìm `TEN-MIEN-CUA-ANH` trong `index.html` (2 chỗ), thay bằng `banhtrungthu-lemon.vercel.app`.
Chỗ này quyết định ảnh hiện ra khi dán link lên Facebook / Zalo.

Số điện thoại **0846 413 314** đã điền sẵn cho nút Gọi và Zalo.

## Ba set

| Set | Tên | Hộp | Quy cách | Giá |
|---|---|---|---|---|
| 01 | Mộc Nguyệt Đoàn Viên | MOON | 4 × 50g | 350.000đ |
| 02 | Minh Viên Nguyệt | FULL MOON | 6 × 50g | 380.000đ |
| 03 | An Nhiên Sen Thu | LOTUS | 4 × 150g | 560.000đ |

Bánh lẻ tại quán: 35.000đ (50g) · 80.000đ (150g)

## Ưu đãi theo số lượng (cả ba set)

| Số lượng | Giảm |
|---|---|
| 10 – 29 set | 10% |
| 30 – 49 set | 12% |
| 50 – 99 set | 15% |
| Từ 100 set | 20% |

Sửa bậc ưu đãi: `const TIERS`. Sửa giá: `const SETS`.
Banner đầu trang: `<div class="slides"`, tốc độ ở `const DELAY = 4500`.
