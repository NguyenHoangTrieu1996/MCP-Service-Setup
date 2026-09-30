Bản 4.0: xem [công cụ đọc file lớn và định dạng hỗ trợ](ADVANCED_TOOLS.md).

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

Nếu bộ MCP Service đã có sẵn trên GitHub, clone repository về máy:

```powershell
cd C:\
git clone <GITHUB_REPOSITORY_URL> MCP-Gateway
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


