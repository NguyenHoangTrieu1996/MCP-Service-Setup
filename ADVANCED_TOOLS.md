# MCP Gateway 4 — đọc file lớn và phân tích theo định dạng

## Quyền và kết nối

Root mặc định: `C:\Users\ADMIN\Documents\For Works`.
Gateway chỉ thao tác trong root và thư mục con; chặn đường dẫn thoát root, junction/symlink, Windows ADS và tên thiết bị.
Quyền thực tế còn phụ thuộc tài khoản Windows chạy Node, ACL, khóa file và dung lượng đĩa.
Không thay đổi ACL của thư mục làm việc.

- Tạo mới (`fs_create_file`, `fs_create_directory`, `fs_create_binary`): không cần `fs_confirm`; không ghi đè.
- Sửa (`fs_edit_file`, `fs_edit_binary`), xóa và di chuyển: trả `confirmation_id`; chưa thực hiện cho đến khi gọi `fs_confirm` với `approve: true`.
- Xác nhận hết hạn sau 10 phút. Sửa/xóa có sao lưu trong `C:\MCP-Gateway\backups`.
- `fs_edit_file` chỉ sửa UTF-8 hợp lệ; chặn DOCX/PDF/PSD/video/binary để tránh làm hỏng file.
- `fs_edit_binary` thay thế bytes đã được phần mềm chuyên dụng tạo đúng định dạng; không phải trình chỉnh sửa layer/CAD/video.
- Tạo/sửa binary inline tối đa 20 MiB mỗi yêu cầu. HTTP JSON tối đa 32 MiB.
- Xác nhận là một bước ở giao thức MCP. Client chịu trách nhiệm hỏi người dùng; gateway không thể phân biệt một lệnh xác nhận do người dùng hay mô hình tự gửi.
- Server vẫn chỉ nghe ở 127.0.0.1. Tunnel/client hiện có phải chạy để truy cập từ xa.

Có thể cấu hình trước khi chạy: `MCP_ROOT`, `MCP_LOG_DIR`, `MCP_BACKUP_DIR`, `MCP_PORT`.
Mặc định port 3000; không tự mở cổng ra Internet.

## Không giới hạn tổng nội dung; mỗi phản hồi có giới hạn

Không nạp toàn bộ file lớn hoặc hàng triệu kết quả vào một phản hồi MCP.

| Công cụ | Tiếp tục |
|---|---|
| fs_list / fs_search | Giữ nguyên path/query; dùng next_cursor đến khi complete=true |
| fs_read / fs_read_binary | Dùng next_offset đến khi eof=true; truyền version nhận được thành expected_version |
| office_extract_text / archive_read_text | Dùng next_offset đến khi eof=true; offset theo đơn vị UTF-16 |
| archive_list | Dùng next_offset; offset theo thứ tự entry |
| pdf_extract_text | Trong trang dùng next_offset; hết trang dùng next_page và offset=0 |
| video_sample_frames | Dùng next_timestamp_seconds; chỉ là lấy mẫu, không phân tích mọi frame |

`fs_read` và `fs_read_binary` đọc tối đa 1 MiB mỗi lần; file nguồn không có giới hạn tổng 8/10 MiB cũ.
UTF-8 không bị cắt giữa ký tự; một trang có thể thêm tối đa 3 bytes để hoàn tất ký tự.
`fs_read` dành cho UTF-8; file UTF-16/ANSI cần chuyển mã hoặc đọc binary.
Danh sách tối đa 1000 entry/trang; tìm kiếm vẫn tiếp tục sau 500 kết quả.
Có thể có trang rỗng nhưng còn cursor nếu bộ quét chưa gặp kết quả.
Cursor dùng một lần, hết hạn sau 10 phút không sử dụng; tối đa 32 lượt duyệt hoạt động cùng lúc.
Thứ tự theo filesystem, không phải bản chụp cố định; thư mục thay đổi giữa lúc duyệt có thể thay đổi kết quả.
Lỗi quyền/đọc phải được xử lý, không được coi là đã duyệt hết.
Symlink/junction được bỏ qua và có bộ đếm báo cáo.

Ví dụ gọi công cụ:

```json
{"name":"fs_read","arguments":{"path":"large.txt","offset":0,"length":65536}}
```

Lần sau dùng chính `next_offset` và `version` trả về. Chỉ kết luận đọc hết khi `eof=true`.

## Các bộ đọc

Gọi `fs_capabilities` để kiểm tra bộ chuyển đổi có trên máy, hoặc xem `GET /health`.
Gọi `file_analyze` với đường dẫn để lấy phần nội dung đầu tiên, phạm vi đã đọc và công cụ tiếp tục.
Raw base64 chỉ là bytes; không thay thế trích xuất nội dung hoặc phân tích bằng thị giác.

| Định dạng | Công cụ và phạm vi |
|---|---|
| Văn bản, SVG, JSON, XML, mã nguồn | fs_read: toàn bộ nội dung UTF-8 qua các trang |
| DOCX/DOCM | office_extract_text: nội dung chính, bảng dưới dạng text, header/footer, footnote/endnote/comment, một số alt text |
| XLSX/XLSM | office_extract_text: tên sheet, tọa độ cell, giá trị lưu, công thức; shared strings là bảng đánh số để tra cứu |
| PPTX/PPTM | office_extract_text: text slide và speaker notes |
| ODT/ODS/ODP | office_extract_text: text content.xml; hàng/ô lặp trả số lần lặp |
| PDF / AI có PDF compatibility | pdf_extract_text đọc text từng trang; file_preview xem từng trang |
| PSD/PSB | file_analyze đọc header kích thước/kênh/màu; file_preview page=1 xem composite, page>=2 chọn layer |
| PNG/JPEG/WebP/GIF/BMP/TIFF | image_read/file_preview trả MCP image; ảnh lớn cần ImageMagick để thu nhỏ |
| Sketch/Krita/ORA/IDML/ZIP | archive_list liệt kê; archive_read_text đọc JSON/XML; archive_read_image đọc PNG/JPEG nhúng tối đa 4 MiB |
| AutoCAD DXF dạng ASCII | model_inspect đọc cấu trúc entity/layer và metadata; không render bản vẽ |
| AutoCAD DWG | metadata header; xuất ASCII DXF để đọc cấu trúc hoặc PDF/PNG để xem bản vẽ |
| OBJ/STL | model_inspect thống kê geometry/bounds từ dữ liệu |
| glTF/GLB | model_inspect đọc cấu trúc scene/mesh/material JSON; không đọc tải trọng binary geometry hoặc liên kết ngoài |
| BLEND | thông tin header; xuất glTF/GLB/OBJ/STL để phân tích thêm |
| FBX/3DS/C4D/MAX | cần xuất glTF/GLB/OBJ/STL bằng phần mềm gốc |
| CDR/INDD/FIG/Affinity và định dạng độc quyền khác | design_metadata qua ExifTool nếu hỗ trợ; xuất PDF/SVG/PNG, INDD có thể xuất IDML |
| Video/audio | video_probe đọc stream/codec/duration; video_extract_frame/video_sample_frames trả ảnh mẫu |

Office không thực thi macro, không OCR và không hiểu hình/đối tượng nhúng chỉ từ phần text.
Đọc ảnh nhúng bằng archive_read_image khi cần; ảnh lớn có thể cần xuất hoặc thu nhỏ.
PDF scan chưa có OCR. AI kiểu PostScript cũ cần xuất PDF-compatible.
PSD không giải mã đầy đủ text layer/effect/smart object. Các bản xem trước không thay thế dữ liệu chỉnh sửa gốc.
Video chưa có phiên âm, chưa phân tích phần nằm giữa các frame mẫu.
Không công cụ nào tuyên bố đã hiểu đầy đủ mọi định dạng độc quyền.

Office/ZIP đọc stream XML/entry; mỗi trang sau có thể quét lại nội dung trước đó.
ZIP central directory cần bộ nhớ; file nén lỗi/mã hóa hoặc XML không hợp lệ sẽ báo lỗi.
Mỗi yêu cầu PowerShell có thời hạn 60 giây; các converter có thời hạn 120 giây.
Với tài liệu vượt thời gian xử lý, chia tài liệu hoặc xuất định dạng phù hợp; không có giới hạn tổng kích thước không có nghĩa tài nguyên vô hạn.

## Bộ chuyển đổi tùy chọn

Không có dependency npm mới. Office/ZIP dùng Windows PowerShell/.NET có sẵn.
Các bộ chuyển đổi dưới đây cần được cài riêng; capability chỉ báo sẵn sàng khi tìm thấy executable, không bảo đảm mọi codec/định dạng đều đọc được.

| Thành phần | Dùng cho |
|---|---|
| FFmpeg + ffprobe | video/audio metadata và ảnh frame |
| Poppler: pdftotext, pdfinfo, pdftoppm | PDF/AI-compatible text và preview |
| ImageMagick: magick | PSD/PSB/raster và preview ảnh lớn |
| ExifTool: exiftool | metadata của nhiều định dạng thiết kế/CAD |

Đặt executable trong PATH, hoặc cấu hình đường dẫn tuyệt đối, ví dụ:

```powershell
$env:MCP_FFMPEG_PATH = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
$env:MCP_FFPROBE_PATH = 'C:\Tools\ffmpeg\bin\ffprobe.exe'
$env:MCP_PDFTOTEXT_PATH = 'C:\Tools\poppler\Library\bin\pdftotext.exe'
$env:MCP_PDFINFO_PATH = 'C:\Tools\poppler\Library\bin\pdfinfo.exe'
$env:MCP_PDFTOPPM_PATH = 'C:\Tools\poppler\Library\bin\pdftoppm.exe'
$env:MCP_MAGICK_PATH = 'C:\Tools\ImageMagick\magick.exe'
$env:MCP_EXIFTOOL_PATH = 'C:\Tools\ExifTool\exiftool.exe'
npm.cmd start
```

Các đường dẫn ví dụ cần được thay bằng vị trí cài thực tế. Các biến này không tự được đọc từ .env bởi index.ts.

Tham khảo định dạng/công cụ: [FFmpeg](https://ffmpeg.org/ffmpeg-protocols.html), [ImageMagick](https://imagemagick.org/command-line-options/), [glTF/GLB](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).

## Kiểm tra và chạy

```powershell
npm.cmd test
npm.cmd start
Invoke-RestMethod http://127.0.0.1:3000/health
```

Test tạo dữ liệu giả trong thư mục tạm riêng, gồm kiểm thử MCP qua HTTP; không sửa file làm việc của bạn.
Dừng tiến trình gateway cũ trước khi chạy bản mới. Cursor và confirmation cũ mất khi restart.
Sau khi cập nhật, client cần tải lại danh sách/schema công cụ nếu có cache.

