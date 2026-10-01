# The Curator Cafe — Web Trung Thu 2026 + Đặt Nước

Hai trang tĩnh: `/` = `index.html` đặt nước (trang chủ) · `/trungthu` = `trungthu.html` trang bánh.
`/cafe` chuyển hướng 301 về `/` (vercel.json); `cafe.html` chỉ còn là file chuyển hướng.

## Đơn về đâu
Bánh → Form `1FAIpQLSct_Jsf_F3h8vDh-gSHcdVMMwaQAWZp7O92imAM2G2zCF3IZg`
Nước → Form `1FAIpQLSfdi_XJormbVIv4YYC83kJTDfkvB-WXS0v6lSwJfK3d_ZR45Q`
Bật thông báo email cho CẢ HAI. Đơn nước cần người trực 6h–22h.

## Trang đặt nước (/ — index.html)
Ô tìm món (gõ không dấu) · thẻ 2 cột · 62 món · giờ nhận 06:00–21:45 ·
tại quầy / giao ≤10km (miễn ≤5km) · tự lưu tên+SĐT+địa chỉ.
Sửa menu: `const DATA` trong index.html.

## Việc còn lại
3 ảnh thật `that-1/2/3.jpg` (vuông ~1000px) bỏ vào img.

## Giá trang bánh
Set 350.000/380.000/560.000 · lẻ 35.000/80.000
Ưu đãi 10–29:−10% · 30–49:−12% · 50–99:−15% · 100+:−20%
0846 413 314 · thecuratorcafe.vn.

## Đặt theo nhóm (/?nhom=MÃ)
API: `api/nhom.js` (Vercel Function) lưu trên Upstash Redis — cần biến môi trường
`KV_REST_API_URL` + `KV_REST_API_TOKEN` (hoặc `UPSTASH_REDIS_REST_URL` + `_TOKEN`), có sẵn khi gắn Upstash ở tab Storage.
Thiếu biến → nút nhóm báo "chưa được bật", đặt lẻ vẫn chạy bình thường.
Nhóm tự xoá sau 6 giờ · tối đa 30 người · chỉ trưởng nhóm gửi đơn/xoá thành viên.
Đơn nhóm về cùng Google Form, mã `NHOM-XXXX`, chi tiết ghi theo từng người.
