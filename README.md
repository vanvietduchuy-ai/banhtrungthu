# Trung Thu 2026 — The Curator Cafe

Trang đặt bánh trung thu (HTML tĩnh, không cần build).

## Cấu trúc — QUAN TRỌNG

`index.html` **phải nằm ở thư mục gốc của repo**, không nằm trong thư mục con.

```
repo/
├── index.html        ← ngay ở đây
├── vercel.json
├── img/
│   ├── d1.webp ... d12.webp
│   ├── share.jpg
│   └── favicon.png
└── README.md
```

Nếu trên GitHub anh thấy phải bấm vào một thư mục (ví dụ `dist/`) rồi mới thấy `index.html`
→ đó chính là nguyên nhân lỗi **404: NOT_FOUND**.

## Cấu hình trên Vercel

Vào **Project → Settings → Build and Deployment**:

| Mục | Giá trị |
|---|---|
| Framework Preset | **Other** |
| Build Command | để trống (tắt Override) |
| Output Directory | để trống (tắt Override) |
| Install Command | để trống |
| Root Directory | `./` — trừ khi file nằm trong thư mục con thì điền tên thư mục đó |

Sửa xong vào tab **Deployments → ... → Redeploy**.

## Ba việc cần sửa trong index.html trước khi chạy thật

1. `const SHOP = {` — thay số điện thoại `09xx xxx xxx` ở cả `phone` và `phoneRaw`.
   `phoneRaw` chỉ gồm chữ số, dùng cho nút Gọi và Zalo.
2. `TEN-MIEN-CUA-ANH` — thay bằng tên miền thật (ví dụ `banhtrungthu-lemon.vercel.app`),
   quyết định ảnh hiện ra khi chia sẻ Facebook/Zalo.
3. `const SETS = {` — xác nhận giá 350.000 / 380.000 / 560.000.

## Ba set

| Set | Tên | Hộp | Quy cách | Giá |
|---|---|---|---|---|
| 01 | Mộc Nguyệt Đoàn Viên | MOON | 4 × 50g | 350.000đ |
| 02 | Minh Viên Nguyệt | FULL MOON | 6 × 50g | 380.000đ |
| 03 | An Nhiên Sen Thu | LOTUS | 4 × 150g | 560.000đ |

Bánh lẻ tại quán: 35.000đ (50g) · 80.000đ (150g)
