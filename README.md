# MuseBatch Studio — Tool Tạo Video AI Hàng Loạt

Ứng dụng Web chạy cục bộ trên Windows giúp bạn sản xuất video ngắn & video dài **hàng loạt** kết hợp **Muse API**, **Giọng đọc AI tiếng Việt miễn phí (Edge-TTS)**, **Phụ đề tự động kiểu TikTok/CapCut**, **Nhạc nền**, **Logo/Watermark**, và **Hiệu ứng chuyển cảnh FFmpeg**.

## Khởi chạy nhanh
- **Cách 1 (1 file `.exe` duy nhất):** Chạy `dist/MuseBatchStudio.exe` (tự tạo bằng `npm run build:exe`) — bấm đúp là chạy độc lập không cần `node_modules` hay thư mục `public/`, tự mở trình duyệt tại `http://localhost:3456` và tự lưu dữ liệu vào `musebatch-data/` cạnh file `.exe`.
- **Cách 2 (Mã nguồn):** Bấm đúp vào file `start.bat` hoặc chạy:
  ```cmd
  npm install
  npm start
  ```

## Tự đóng gói lại thành 1 file `.exe` (Node.js 26+)
```cmd
npm run build:exe
```
File xuất ra: `dist/MuseBatchStudio.exe` (tích hợp sẵn toàn bộ backend, thư viện và giao diện web).

## Quy trình tạo video hàng loạt (3 bước)
1. **Cấu hình Muse API Key:** Mở tab **Cài đặt API & Hậu kỳ**, chọn nền tảng Muse API của bạn (MuseVideos `musevideos.io`, Muse AI `muse-ai.pro`, Gateway `/v1/videos` như APIMart/APIMODELS/LaoZhang, hoặc Custom REST), dán API Key và bấm **Kiểm tra kết nối**.
   - Ngoài Muse API, bạn cũng có thể chuyển nhanh sang **Ảnh/Clip cục bộ** (tạo slideshow Ken Burns + chuyển cảnh) hoặc **Demo Render** để test toàn bộ hậu kỳ miễn phí.
2. **Nạp danh sách kịch bản hàng loạt:**
   - **Nhập CSV / Excel / TXT** (bấm **Tải file mẫu CSV** để xem đúng cột mẫu).
   - **Dán nhanh nhiều dòng:** mỗi dòng 1 video theo định dạng `Tiêu đề ;; Prompt hình ảnh ;; Lời thoại tiếng Việt ;; Hook`.
   - **Tách nhiều cảnh trong 1 video:** dùng dấu `|` trong ô Prompt (ví dụ `Cảnh 1 ... | Cảnh 2 ...`), tool sẽ gọi Muse API từng cảnh rồi tự ghép mượt bằng hiệu ứng `xfade`.
   - **AI sinh kịch bản hàng loạt:** nhập 1 chủ đề và số lượng để tự động viết hàng loạt dòng kịch bản.
3. **Bấm "▶ Chạy hàng loạt":** Theo dõi tiến độ real-time từng video, xem trước trực tiếp trên web, tải từng file MP4 hoặc tải trọn bộ `.ZIP`, hoặc bấm **Mở thư mục Output** (`data/outputs/`).
