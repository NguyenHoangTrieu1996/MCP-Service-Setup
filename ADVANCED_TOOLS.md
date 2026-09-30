# Advanced MCP Tools

Phiên bản MCP Gateway 3.0 bổ sung khả năng xử lý file nhị phân, ảnh, video, Word, Excel và preview file thiết kế mà không làm thay đổi các tool filesystem cũ.

## Tool mới

### `fs_stat`
Đọc metadata file/thư mục: kích thước, MIME type, ngày tạo và ngày sửa.

### `fs_read_binary`
Đọc file nhị phân nhỏ dưới dạng Base64.

- Giới hạn mặc định: 8 MB.
- Phù hợp cho file nhỏ cần lấy raw bytes.
- Không nên dùng cho video hoặc PSD lớn.

### `fs_create_binary`
Tạo file nhị phân mới từ Base64.

- Không overwrite file đang tồn tại.
- Giới hạn decoded binary: 20 MB.

### `image_read`
Trả ảnh qua MCP `image` content để client có vision có thể xem trực tiếp.

Hỗ trợ trực tiếp:

- PNG
- JPG/JPEG
- WEBP
- GIF
- BMP
- SVG

PSD/AI/PDF nên dùng `file_preview`.

### `video_probe`
Dùng `ffprobe` để lấy metadata video/audio:

- codec
- width/height
- duration
- FPS
- audio stream
- container metadata

Yêu cầu FFmpeg/ffprobe có trong PATH.

### `video_extract_frame`
Trích một frame tại thời điểm chỉ định và trả về MCP image content.

Yêu cầu FFmpeg có trong PATH.

### `office_extract_text`
Đọc nội dung cơ bản của:

- `.docx`: paragraph text
- `.xlsx`: giá trị cell cơ bản từ worksheet XML

Tool dùng Windows PowerShell + .NET ZIP APIs, không yêu cầu cài thêm package npm.

### `file_preview`
Tạo ảnh preview cho:

- ảnh phổ biến
- video
- PDF
- PSD
- AI

Backend ưu tiên theo loại file:

- Video: FFmpeg
- PDF: Poppler `pdftoppm`, fallback ImageMagick
- PSD/AI: ImageMagick

## Cài công cụ hệ thống tùy chọn

### FFmpeg

Có thể cài bằng WinGet:

```powershell
winget install Gyan.FFmpeg
```

Kiểm tra:

```powershell
ffmpeg -version
ffprobe -version
```

### ImageMagick

```powershell
winget install ImageMagick.ImageMagick
```

Kiểm tra:

```powershell
magick -version
```

Khi cài ImageMagick, nên bật hỗ trợ file legacy nếu workflow cần PSD/AI/PDF.

### Poppler

Poppler cung cấp `pdftoppm` để render PDF ổn định hơn ImageMagick.

Sau khi cài, kiểm tra:

```powershell
pdftoppm -h
```

## Kiểm tra TypeScript

```powershell
cd C:\MCP-Gateway
npm install
npm run typecheck
```

## Chạy server

```powershell
npm start
```

Kiểm tra health:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

Kết quả phiên bản mới sẽ có:

```json
{
  "status": "ok",
  "version": "3.0.0",
  "capabilities": [
    "text",
    "binary",
    "image",
    "video",
    "docx",
    "xlsx",
    "pdf-preview",
    "psd-preview",
    "ai-preview"
  ]
}
```

## Thiết kế an toàn

Các tool mới vẫn dùng cùng security model của MCP cũ:

- chỉ truy cập `D:\Documents For Work`
- chặn path traversal
- chặn UNC
- chặn symbolic link/reparse escape
- audit mọi thao tác
- không overwrite file binary hiện có
- giới hạn kích thước dữ liệu inline

## Lưu ý file lớn

Không nên truyền toàn bộ video/PSD/AI dung lượng lớn bằng Base64 qua MCP. Thay vào đó:

1. dùng `fs_stat` để kiểm tra file;
2. dùng `video_probe`, `video_extract_frame`, `file_preview` hoặc `office_extract_text`;
3. chỉ dùng `fs_read_binary` khi thực sự cần raw bytes và file nhỏ hơn giới hạn.

Phiên bản sau có thể bổ sung chunked binary upload/download và resource links cho file dung lượng lớn.
