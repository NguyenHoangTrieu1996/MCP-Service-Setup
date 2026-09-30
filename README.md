# MCP SERVICE + OPENAI SECURE MCP TUNNEL

## Hệ thống hiện hỗ trợ những gì?

MCP Gateway này cho phép ChatGPT truy cập và làm việc với dữ liệu trong thư mục được cấu hình tại `MCP_ROOT` trên máy Windows, thông qua OpenAI Secure MCP Tunnel.

| Nhóm chức năng | Hỗ trợ hiện tại |
| --- | --- |
| **Quản lý file/thư mục** | Liệt kê thư mục, tìm kiếm tên file/thư mục, đọc file UTF-8, xem metadata, tạo file/thư mục mới, di chuyển/đổi tên và xóa có xác nhận. |
| **File dung lượng lớn** | Đọc file theo từng trang/chunk với `next_offset` / `next_cursor`, không giới hạn tổng kích thước chỉ vì một response bị giới hạn. |
| **Binary** | Đọc binary theo từng trang, tạo file binary mới và chỉnh file binary có xác nhận. |
| **Nhận file trực tiếp từ ChatGPT** | `fs_create_from_file` nhận file parameter từ ChatGPT và stream trực tiếp xuống `MCP_ROOT`, không cần tự chuyển sang Base64. Chỉ tạo file mới, không ghi đè. |
| **Ảnh raster** | PNG, JPG/JPEG, WebP, GIF, BMP, TIFF: xem preview, phân tích và xử lý ảnh. |
| **Chỉnh sửa ảnh local** | `image_transform`, `image_composite`, `design_export_preview` sử dụng ImageMagick; mặc định tạo file mới thay vì ghi đè file gốc. |
| **Photoshop / thiết kế** | PSD/PSB: đọc header, xem composite/layer preview khi ImageMagick hỗ trợ. AI/PDF-compatible AI: đọc text nhúng và render preview. |
| **PDF** | Đọc text theo trang, render preview; PDF scan không có text nhúng cần OCR ngoài pipeline hiện tại. |
| **Office** | DOCX/DOCM, XLSX/XLSM, PPTX/PPTM, ODT/ODS/ODP: trích xuất text/XML theo từng phần. |
| **Archive / design package** | ZIP, Sketch, Krita, ORA, IDML và các Office package: liệt kê entry, đọc JSON/XML/text và đọc thumbnail/image nhúng phù hợp. |
| **CAD / 3D** | Phân tích cấu trúc ASCII DXF, OBJ, STL, glTF/GLB. DWG và BLEND hiện chủ yếu đọc header/metadata; FBX và định dạng proprietary nên export sang DXF/PDF/glTF/GLB/OBJ/STL để phân tích sâu. |
| **Video / Audio** | Đọc metadata bằng FFprobe, trích frame và lấy mẫu nhiều frame bằng FFmpeg. Không tự động hiểu toàn bộ video hoặc transcript âm thanh nếu chưa có pipeline riêng. |
| **Metadata thiết kế** | Đọc metadata bằng ExifTool khi đã cài đặt. |
| **Dịch vụ ngoài** | Có workflow bridge cho Figma, Canva, OpenAI Image và dịch vụ khác. Việc gửi asset ra ngoài máy yêu cầu approval trước. |
| **Bảo mật thao tác** | Đọc/phân tích được phép; tạo file mới không cần xác nhận; sửa file hiện có, xóa, move/rename phải qua `fs_confirm`. Các thao tác quan trọng có audit log và backup khi phù hợp. |

### Các tool chính

```text
fs_list
fs_search
fs_read
fs_stat
fs_read_binary
fs_create_file
fs_create_directory
fs_create_binary
fs_create_from_file
fs_edit_file
fs_edit_binary
fs_delete
fs_move
fs_confirm
fs_capabilities
file_analyze
file_preview
image_read
office_extract_text
archive_list
archive_read_text
archive_read_image
pdf_extract_text
model_inspect
design_metadata
video_probe
video_extract_frame
video_sample_frames
asset_edit_capabilities
image_transform
image_composite
design_export_preview
external_asset_request
external_asset_approve
```

Chi tiết pipeline chỉnh sửa asset: [ASSET_EDITING.md](ASSET_EDITING.md).

---

# HƯỚNG DẪN CÀI ĐẶT MCP SERVICE + OPENAI SECURE MCP TUNNEL
## 1. Cài Node.js

Tải Node.js chính thức:

https://nodejs.org/en/download

Sau khi cài, mở PowerShell và kiểm tra:

```powershell
node --version
npm --version
```

Nếu cả hai lệnh trả về version thì Node.js đã hoạt động.

## 2. Cài MCP Server từ GitHub

Nếu bộ MCP Service đã có sẵn trên GitHub, clone repository hoặc tải file ZIP về máy:

```powershell
cd C:\
git clone https://github.com/NguyenHoangTrieu1996/MCP-Service-Setup MCP-Gateway
cd C:\MCP-Gateway
npm install
```

### Cài ImageMagick để sử dụng chức năng chỉnh ảnh local

```powershell
winget install ImageMagick.ImageMagick
```

Sau khi cài xong, nên đóng PowerShell hiện tại và mở lại PowerShell mới để Windows cập nhật biến `PATH`.

Kiểm tra ImageMagick:

```powershell
magick -version
```

Nếu lệnh trả về phiên bản ImageMagick thì các chức năng chỉnh ảnh local như `image_transform`, `image_composite` và `design_export_preview` có thể sử dụng ImageMagick.

Tạo file `.env` tại:

```text
C:\MCP-Gateway\.env
```

Nội dung:

```env
CONTROL_PLANE_API_KEY=PASTE_API_KEY
```

Thay `PASTE_API_KEY` bằng Runtime API Key của bạn. Đảm bảo `.env` nằm trong `.gitignore` và không commit API Key lên GitHub.

## 3. Sửa ROOT trong `index.ts`

Mở file MCP, ví dụ:

```text
C:\MCP-Gateway\src\index.ts
```

Tìm:

```typescript
const ROOT = path.resolve(process.env.MCP_ROOT || "C:\\Users\\ADMIN\\Documents\\For Works");
```

Đổi thành thư mục muốn cấp quyền cho AI.

Ví dụ:

```typescript
const ROOT = path.resolve(process.env.MCP_ROOT || "C:\\Users\\ADMIN\\Documents\\For Works");
```

Sau khi sửa, restart MCP:

```powershell
cd C:\MCP-Gateway
npm start
```

Không nên đặt ROOT thành `C:\`, `D:\` hoặc toàn bộ ổ đĩa nếu không thực sự cần thiết.

---

## 4. Kiểm tra `tunnel-client`

```powershell
cd C:\MCP-Gateway\tunnel
.\tunnel-client.exe --version
.\tunnel-client.exe help quickstart
```
---

## 5. Tạo Tunnel trên OpenAI

Mở trực tiếp:

https://platform.openai.com/settings/organization/tunnels

Tạo một MCP Tunnel mới và liên kết đúng Platform organization / ChatGPT workspace cần sử dụng.

Sau khi tạo, lưu lại Tunnel ID dạng:

```text
tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Không chia sẻ Runtime API Key hoặc Admin API Key trong README/GitHub.

---

## 6. Tạo Runtime API Key và lưu vào `.env`

Mở:

https://platform.openai.com/settings/organization/api-keys

Tạo Runtime API Key dùng cho `tunnel-client`.

Sau khi có API Key, mở file:

```text
C:\MCP-Gateway\.env
```

Thêm hoặc cập nhật:

```env
CONTROL_PLANE_API_KEY=PASTE_API_KEY
```

Không commit `.env` lên GitHub. Đảm bảo `.gitignore` có:

```gitignore
.env
```

Từ bước này trở đi không cần ghi API Key trực tiếp trong các lệnh PowerShell. Khi cần chạy `tunnel-client`, nạp `CONTROL_PLANE_API_KEY` từ file `.env` vào biến môi trường của PowerShell.

Có thể nạp bằng:

```powershell
$envFile = "C:\MCP-Gateway\.env"
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
        $name = $matches[1].Trim()
        $value = $matches[2].Trim()
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}
```

Kiểm tra biến đã được nạp mà không in API Key ra màn hình:

```powershell
if ($env:CONTROL_PLANE_API_KEY) { "CONTROL_PLANE_API_KEY loaded" } else { "CONTROL_PLANE_API_KEY missing" }
```

---

## 7. Cấu hình `tunnel-client`

Trước tiên nạp API Key từ `.env`:

```powershell
$envFile = "C:\MCP-Gateway\.env"
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
        $name = $matches[1].Trim()
        $value = $matches[2].Trim()
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}
```

Sau đó cấu hình Tunnel:

```powershell
cd C:\MCP-Gateway\tunnel

.\tunnel-client.exe init --sample sample_mcp_remote_no_auth --profile windows-mcp --tunnel-id tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx --mcp-server-url http://127.0.0.1:3000/mcp
```

Profile trên Windows thường được lưu tại:

```text
C:\Users\<USERNAME>\AppData\Roaming\tunnel-client\windows-mcp.yaml
```

`tunnel-client` sẽ đọc `CONTROL_PLANE_API_KEY` từ biến môi trường Process vừa được nạp từ `.env`, thay vì ghi API Key trực tiếp vào profile.

---

## 8. Kiểm tra Tunnel

Đầu tiên bảo đảm MCP Server đang chạy:

```powershell
cd C:\MCP-Gateway
npm start
```

Ở PowerShell khác, nạp API Key từ `.env` rồi chạy `doctor`:

```powershell
$envFile = "C:\MCP-Gateway\.env"
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
        $name = $matches[1].Trim()
        $value = $matches[2].Trim()
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

cd C:\MCP-Gateway\tunnel
.\tunnel-client.exe doctor --profile windows-mcp --explain
```

Kết quả mong muốn:

```text
RESULT ok
```

Sau khi tunnel đang chạy, có thể kiểm tra readiness tại port health đã cấu hình, ví dụ:

```powershell
Invoke-WebRequest http://127.0.0.1:8080/readyz -UseBasicParsing
```

Kết quả mong muốn:

```text
StatusCode : 200
Content    : ready
```

Local Tunnel UI (nếu profile dùng port 8080):

http://127.0.0.1:8080/ui

---

## 9. Chạy Tunnel

```powershell
cd C:\MCP-Gateway\tunnel
.\tunnel-client.exe run --profile windows-mcp
```

---

## 10. Tạo Plugin trên ChatGPT

Hướng dẫn OpenAI:

https://developers.openai.com/plugins/deploy/connect-chatgpt

Mở ChatGPT:

https://chatgpt.com/


# Các đường dẫn quan trọng

Node.js:
https://nodejs.org/en/download

OpenAI Secure MCP Tunnel:
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

Tunnel Client Releases:
https://github.com/openai/tunnel-client/releases/latest

OpenAI Tunnels Management:
https://platform.openai.com/settings/organization/tunnels

OpenAI Runtime API Keys:
https://platform.openai.com/settings/organization/api-keys

OpenAI Admin API Keys:
https://platform.openai.com/settings/organization/admin-keys

ChatGPT:
https://chatgpt.com/

ChatGPT MCP/Plugin connection guide:
https://developers.openai.com/plugins/deploy/connect-chatgpt

MCP Inspector:
https://github.com/modelcontextprotocol/inspector

---
