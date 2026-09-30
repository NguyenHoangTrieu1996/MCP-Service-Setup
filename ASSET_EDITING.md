# Asset Editing Pipeline (v5)

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

After an external connector/plugin returns a binary result, save it under a new filename using the existing `fs_create_binary` tool.

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
          returned binary result
                 |
                 v
          fs_create_binary
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
