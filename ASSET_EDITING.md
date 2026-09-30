# Asset Editing Pipeline (v5)

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

---

This layer extends the existing MCP Gateway without replacing the v4 filesystem/design readers.

## Security policy

- READ / ANALYZE / PREVIEW: no confirmation.
- CREATE NEW FILE: no confirmation.
- Existing file edit/delete/move: still uses the existing `fs_confirm` flow.
- Asset editing tools in this module are **create-only** and never overwrite originals.
- Sending a local source asset to an external service requires `external_asset_request` + `external_asset_approve` first.

## Local dependency

Image transforms, compositing and design preview export require ImageMagick.

```powershell
winget install ImageMagick.ImageMagick
```

Check:

```powershell
magick -version
```

Existing media/video tools can also use FFmpeg:

```powershell
winget install Gyan.FFmpeg
```

## New tools

### `asset_edit_capabilities`
Reports local editing engines and external-service workflow support.

### `image_transform`
Creates a new PNG/JPG/WebP/TIFF with optional resize, crop, rotate, quality and metadata stripping.

Example flow:

```text
poster.jpg
  -> image_transform
  -> poster_v2.jpg
```

The original remains unchanged.

### `image_composite`
Composites an overlay/logo/image onto a base image and creates a new output.

### `design_export_preview`
Renders supported PSD/PSB/PDF/AI/SVG/raster input to a new PNG/JPEG preview when ImageMagick and its delegates can decode that format.

This is a rendered derivative, not an editable reconstruction of proprietary layers.

### `external_asset_request`
Creates an approval request before the source file may leave the PC for Figma, Canva, OpenAI image editing or another external service.

### `external_asset_approve`
Approves/rejects the pending transfer. Approval returns a receipt and workflow instructions. The MCP does **not** silently upload the file itself.

After an external connector/plugin returns a binary result, save it under a new filename using `fs_create_from_file` when a ChatGPT file parameter is available, or `fs_create_binary` for legacy Base64 workflows.

## Typical workflow

```text
D:\Documents For Work\50nam\poster.psd
        |
        v
file_analyze / design_export_preview
        |
        v
ChatGPT analyzes layout
        |
        +--> local edit (ImageMagick)
        |        |
        |        v
        |    poster_v2.png
        |
        +--> external_asset_request
                 |
                 v
          explicit user approval
                 |
                 v
          Figma / Canva / image AI
                 |
                 v
          returned file
                 |
                 v
          fs_create_from_file
                 |
                 v
          poster_v2.png / PDF / other result
```

## Start

```powershell
cd C:\MCP-Gateway
npm install
npm run typecheck
npm start
```

The existing Secure MCP Tunnel command is unchanged:

```powershell
cd C:\MCP-Gateway\tunnel
.\tunnel-client.exe run --profile windows-mcp
```
