# HƯỚNG DẪN CÀI ĐẶT MCP SERVICE + OPENAI SECURE MCP TUNNEL

> Xem chức năng hệ thống và các tool hiện hỗ trợ: [ASSET_EDITING.md](ASSET_EDITING.md)

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

Sau khi cài xong, đóng PowerShell hiện tại và mở lại PowerShell mới để Windows cập nhật `PATH`.

```powershell
magick -version
```

Tạo file `.env` tại:

```text
C:\MCP-Gateway\.env
```

Nội dung:

```env
CONTROL_PLANE_API_KEY=PASTE_API_KEY
```

Không commit `.env` hoặc API Key lên GitHub.

## 3. Cấu hình ROOT và port MCP

MCP Gateway mặc định chỉ lắng nghe local tại:

```text
http://127.0.0.1:8765
```

Port `8765` được dành cho MCP Gateway để tránh xung đột với các backend như NestJS thường chạy ở port `3000`.

Có thể đổi port mà không sửa source bằng biến môi trường `MCP_PORT`, ví dụ:

```powershell
$env:MCP_PORT=9000
npm start
```

ROOT mặc định nằm trong `src/index.ts`:

```typescript
const ROOT = path.resolve(process.env.MCP_ROOT || "C:\\Users\\ADMIN\\Documents\\For Works");
```

Có thể cấu hình ROOT bằng biến môi trường thay vì sửa source:

```powershell
$env:MCP_ROOT="D:\Documents For Work"
npm start
```

Không nên cấp toàn bộ `C:\` hoặc `D:\` nếu không thực sự cần thiết.

Khởi động MCP:

```powershell
cd C:\MCP-Gateway
npm start
```

Kiểm tra port:

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen
```

Kết quả phải cho thấy MCP đang listen tại `127.0.0.1:8765`.

---

## 4. Kiểm tra `tunnel-client`

```powershell
cd C:\MCP-Gateway\tunnel
.\tunnel-client.exe --version
.\tunnel-client.exe help quickstart
```

---

## 5. Tạo Tunnel trên OpenAI

Mở:

https://platform.openai.com/settings/organization/tunnels

Tạo MCP Tunnel mới và lưu Tunnel ID:

```text
tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 6. Tạo Runtime API Key và nạp `.env`

Mở:

https://platform.openai.com/settings/organization/api-keys

Lưu Runtime API Key vào:

```text
C:\MCP-Gateway\.env
```

```env
CONTROL_PLANE_API_KEY=PASTE_API_KEY
```

Nạp `.env` vào PowerShell:

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

Kiểm tra mà không in API Key:

```powershell
if ($env:CONTROL_PLANE_API_KEY) { "CONTROL_PLANE_API_KEY loaded" } else { "CONTROL_PLANE_API_KEY missing" }
```

---

## 7. Cấu hình Tunnel cho MCP port 8765

Trước tiên bảo đảm MCP Server đang chạy:

```powershell
cd C:\MCP-Gateway
npm start
```

Mở PowerShell khác, nạp API Key từ `.env` như bước 6, sau đó cấu hình Tunnel:

```powershell
cd C:\MCP-Gateway\tunnel

.\tunnel-client.exe init --sample sample_mcp_remote_no_auth --profile windows-mcp --tunnel-id tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx --mcp-server-url http://127.0.0.1:8765/mcp
```

**Lưu ý:** `--mcp-server-url` phải dùng port `8765`, không dùng port `3000`.

Profile Windows thường nằm tại:

```text
C:\Users\<USERNAME>\AppData\Roaming\tunnel-client\windows-mcp.yaml
```

Nếu profile `windows-mcp` đã được tạo trước đây với port `3000`, hãy tạo lại/cập nhật profile để `mcp_server_url` trỏ tới:

```text
http://127.0.0.1:8765/mcp
```

---

## 8. Kiểm tra Tunnel

Kiểm tra MCP local trước:

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen
```

Sau đó chạy doctor:

```powershell
cd C:\MCP-Gateway\tunnel
.\tunnel-client.exe doctor --profile windows-mcp --explain
```

Kết quả mong muốn:

```text
RESULT ok
```

Nếu profile dùng health port `8080`, kiểm tra:

```powershell
Invoke-WebRequest http://127.0.0.1:8080/readyz -UseBasicParsing
```

Kết quả mong muốn:

```text
StatusCode : 200
Content    : ready
```

Local Tunnel UI (nếu dùng port 8080):

http://127.0.0.1:8080/ui

---

## 9. Chạy Tunnel

```powershell
cd C:\MCP-Gateway\tunnel
.\tunnel-client.exe run --profile windows-mcp
```

Luồng kết nối đúng:

```text
ChatGPT
   ↓
OpenAI Secure MCP Tunnel
   ↓
http://127.0.0.1:8765/mcp
   ↓
MCP Gateway
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
