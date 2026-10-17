# The Curator Cafe — Web Trung Thu 2026 + Đặt Nước

`/` = `index.html` trang chủ: đèn lồng kéo dây bật đèn → thẻ đặt nước, 3 giây sau chạy video quầy bar (`video/bar-loop.mp4|webm`, ảnh `img/home/`).
`/dat-nuoc` = `dat-nuoc.html` trang đặt nước (menu, giỏ, đặt nhóm). Nhận `?q=món` (điền ô tìm) và `#nhom` (mở đặt nhóm).
Link nhóm cũ `/?nhom=MÃ` tự chuyển sang `/dat-nuoc?nhom=MÃ`. `/trungthu` = trang bánh.
`/cafe` chuyển hướng 301 về `/dat-nuoc` (vercel.json).

## Đơn về đâu
Bánh → Form `1FAIpQLSct_Jsf_F3h8vDh-gSHcdVMMwaQAWZp7O92imAM2G2zCF3IZg`
Nước → Form `1FAIpQLSfdi_XJormbVIv4YYC83kJTDfkvB-WXS0v6lSwJfK3d_ZR45Q`
Bật thông báo email cho CẢ HAI. Đơn nước cần người trực 6h–22h.

## Trang đặt nước (/dat-nuoc — dat-nuoc.html)
Ô tìm món (gõ không dấu) · thẻ 2 cột · 62 món · giờ nhận 06:00–21:45 ·
tại quầy / giao ≤10km (miễn ≤5km) · tự lưu tên+SĐT+địa chỉ.
Sửa menu: trang /admin (hoặc menu-default.js).

## Việc còn lại
3 ảnh thật `that-1/2/3.jpg` (vuông ~1000px) bỏ vào img.

## Giá trang bánh
Set 350.000/380.000/560.000 · lẻ 35.000/80.000
Ưu đãi 10–29:−10% · 30–49:−12% · 50–99:−15% · 100+:−20%
0846 413 314 · thecuratorcafe.vn.

## Đặt theo nhóm (/dat-nuoc?nhom=MÃ)
API: `api/nhom.js` (Vercel Function) lưu trên Upstash Redis — cần biến môi trường
`KV_REST_API_URL` + `KV_REST_API_TOKEN` (hoặc `UPSTASH_REDIS_REST_URL` + `_TOKEN`), có sẵn khi gắn Upstash ở tab Storage.
Thiếu biến → nút nhóm báo "chưa được bật", đặt lẻ vẫn chạy bình thường.
Nhóm tự xoá sau 6 giờ · tối đa 30 người · chỉ trưởng nhóm gửi đơn/xoá thành viên.
Đơn nhóm về cùng Google Form, mã `NHOM-XXXX`, chi tiết ghi theo từng người.

Quản trị menu (/admin)

Đăng nhập 1 tài khoản để sửa ảnh, giá, tên, mô tả, nhãn (Best seller / Must try / New), Tạm hết, Ẩn; thêm/xoá/sắp xếp món và loại; bật "đổi hạt Liberica +8k" cho từng loại. Bấm Lưu menu → trang đặt nước cập nhật sau vài giây. Có nút Hoàn tác về lần lưu trước.
Cần biến môi trường trên Vercel: ADMIN_PASSWORD (bắt buộc), ADMIN_USER (mặc định admin), và Upstash Redis như đặt nhóm.
Dữ liệu: key menu, menu:prev, mimg:<id> (ảnh tải lên). Chưa lưu lần nào → trang dùng menu-default.js (menu gốc). Ảnh mẫu trong img/menu/ lấy từ Unsplash, nên thay bằng ảnh chụp thật.
