param(
  [Parameter(Mandatory=$true)][string]$Target,
  [ValidateSet("text","archive","entry_text","entry_image")][string]$Mode = "text",
  [long]$Offset = 0,
  [int]$Limit = 32000,
  [string]$EntryName = ""
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$source = @'
using System;
using System.IO;
using System.IO.Compression;
using System.Xml;
using System.Text;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

public class GatewayOfficePage {
  public string text;
  public long offset;
  public object next_offset;
  public bool eof;
  public string[] coverage;
  public string[] limitations;
}
public class GatewayArchiveEntry {
  public string name;
  public long size;
  public long compressed_size;
  public bool directory;
  public bool unsafe_path;
}
public class GatewayArchivePage {
  public GatewayArchiveEntry[] entries;
  public long offset;
  public object next_offset;
  public bool eof;
  public int total_entries;
  public string[] limitations;
}
public class GatewayPageComplete : Exception {}

public class GatewayOfficeReader {
  long start;
  int limit;
  long position;
  StringBuilder output = new StringBuilder();
  bool more;
  char[] buffer = new char[4096];

  public GatewayOfficeReader(long offset, int length) {
    if (offset < 0 || length < 1 || length > 128000) throw new ArgumentOutOfRangeException();
    start = offset; limit = length;
  }
  void Emit(string value) {
    if (String.IsNullOrEmpty(value)) return;
    long end = checked(position + value.Length);
    if (end > start && output.Length < limit) {
      int skip = (int)Math.Max(0, start - position);
      int take = Math.Min(value.Length - skip, limit - output.Length);
      if (take > 0) output.Append(value, skip, take);
    }
    position = end;
    if (position > start && position - start > limit) {
      more = true;
      throw new GatewayPageComplete();
    }
  }
  void NormalizePage() {
    if (more && output.Length > 0 && Char.IsHighSurrogate(output[output.Length - 1])) output.Length--;
    if (more && output.Length == 0) throw new InvalidDataException("Page length is too small for this Unicode character; use a limit of at least 2.");
    if (output.Length > 0 && Char.IsLowSurrogate(output[0])) throw new InvalidDataException("Offset splits a Unicode character; resume using the previous next_offset.");
  }
  void Value(XmlReader reader) {
    if (reader.CanReadValueChunk) {
      int count;
      while ((count = reader.ReadValueChunk(buffer, 0, buffer.Length)) > 0)
        Emit(new String(buffer, 0, count));
    } else Emit(reader.Value);
  }
  static bool IsText(XmlReader reader) {
    return reader.NodeType == XmlNodeType.Text || reader.NodeType == XmlNodeType.CDATA ||
      reader.NodeType == XmlNodeType.SignificantWhitespace;
  }
  static XmlReader OpenXml(Stream stream) {
    XmlReaderSettings settings = new XmlReaderSettings();
    settings.DtdProcessing = DtdProcessing.Prohibit;
    settings.XmlResolver = null;
    settings.IgnoreComments = true;
    settings.MaxCharactersFromEntities = 1024;
    return XmlReader.Create(stream, settings);
  }
  static string SortKey(string name) {
    return Regex.Replace(name, @"\d+", m => m.Value.PadLeft(12, '0'));
  }
  static IEnumerable<ZipArchiveEntry> Parts(ZipArchive archive, string family) {
    if (family == "word") {
      var main = archive.GetEntry("word/document.xml");
      if (main != null) yield return main;
      foreach (var entry in archive.Entries.Where(e => Regex.IsMatch(e.FullName,
        @"^word/(header\d+|footer\d+|footnotes|endnotes|comments)\.xml$")).OrderBy(e => SortKey(e.FullName)))
        yield return entry;
    } else if (family == "slides") {
      foreach (var entry in archive.Entries.Where(e => Regex.IsMatch(e.FullName,
        @"^ppt/(slides/slide\d+|notesSlides/notesSlide\d+)\.xml$")).OrderBy(e => SortKey(e.FullName)))
        yield return entry;
    } else if (family == "sheet") {
      foreach (string name in new [] {"xl/workbook.xml", "xl/sharedStrings.xml"}) {
        var entry = archive.GetEntry(name);
        if (entry != null) yield return entry;
      }
      foreach (var entry in archive.Entries.Where(e => Regex.IsMatch(e.FullName,
        @"^xl/(worksheets/sheet\d+|comments\d+)\.xml$")).OrderBy(e => SortKey(e.FullName)))
        yield return entry;
    } else {
      var entry = archive.GetEntry("content.xml");
      if (entry != null) yield return entry;
    }
  }
  void ReadWordOrSlides(XmlReader reader) {
    bool inText = false;
    while (reader.Read()) {
      string local = reader.LocalName;
      if (reader.NodeType == XmlNodeType.Element) {
        if (local == "t" || local == "instrText" || local == "delText")
          inText = !reader.IsEmptyElement;
        if (local == "tab") Emit("\t");
        if (local == "br" || local == "cr") Emit("\n");
        if (local == "docPr" || local == "cNvPr") {
          string alt = reader.GetAttribute("descr");
          if (!String.IsNullOrEmpty(alt)) Emit("[image alt: " + alt + "] ");
        }
      } else if (reader.NodeType == XmlNodeType.EndElement) {
        if (local == "t" || local == "instrText" || local == "delText") inText = false;
        if (local == "p" || local == "tr") Emit("\n");
        if (local == "tc") Emit("\t");
      } else if (inText && IsText(reader)) Value(reader);
    }
  }
  void ReadSheet(XmlReader reader, string part) {
    bool inValue = false;
    int stringIndex = -1;
    string cellType = "";
    bool isSharedStrings = part == "xl/sharedStrings.xml";
    while (reader.Read()) {
      string local = reader.LocalName;
      if (reader.NodeType == XmlNodeType.Element) {
        if (local == "sheet") Emit("[sheet name=" + reader.GetAttribute("name") + " id=" + reader.GetAttribute("sheetId") + "]\n");
        if (local == "si" && isSharedStrings) Emit("[shared-string:" + (++stringIndex) + "] ");
        if (local == "c") {
          cellType = reader.GetAttribute("t") ?? "";
          Emit("[cell:" + reader.GetAttribute("r") + " type=" + cellType + "] ");
        }
        if (local == "v" || local == "t" || local == "f") {
          inValue = !reader.IsEmptyElement;
          if (local == "f") Emit("[formula] ");
          else if (local == "v" && cellType == "s") Emit("[shared-string:");
        }
      } else if (reader.NodeType == XmlNodeType.EndElement) {
        if (local == "v" || local == "t" || local == "f") {
          inValue = false;
          if (local == "v" && cellType == "s") Emit("]");
          Emit(" ");
        }
        if (local == "si" || local == "c" || local == "row" || local == "comment") Emit("\n");
      } else if (inValue && IsText(reader)) Value(reader);
    }
  }
  void ReadOpenDocument(XmlReader reader) {
    int paragraphDepth = -1;
    while (reader.Read()) {
      string local = reader.LocalName;
      if (reader.NodeType == XmlNodeType.Element) {
        if ((local == "p" || local == "h") && paragraphDepth < 0 && !reader.IsEmptyElement) paragraphDepth = reader.Depth;
        if (local == "tab") Emit("\t");
        if (local == "line-break") Emit("\n");
        if (local == "s") {
          string count = reader.GetAttribute("c", "urn:oasis:names:tc:opendocument:xmlns:text:1.0");
          Emit(String.IsNullOrEmpty(count) || count == "1" ? " " : "[spaces:" + count + "]");
        }
        if (local == "table" || local == "page") {
          string name = reader.GetAttribute("name", "urn:oasis:names:tc:opendocument:xmlns:table:1.0")
            ?? reader.GetAttribute("name", "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0");
          Emit("[" + local + ": " + name + "]\n");
        }
        if (local == "table-cell" || local == "table-row") {
          string repeated = reader.GetAttribute(local == "table-cell" ? "number-columns-repeated" : "number-rows-repeated",
            "urn:oasis:names:tc:opendocument:xmlns:table:1.0");
          if (!String.IsNullOrEmpty(repeated) && repeated != "1") Emit("[repeat:" + repeated + "] ");
          string formula = reader.GetAttribute("formula", "urn:oasis:names:tc:opendocument:xmlns:table:1.0");
          if (!String.IsNullOrEmpty(formula)) Emit("[formula:" + formula + "] ");
          if (reader.IsEmptyElement) Emit(local == "table-cell" ? "\t" : "\n");
        }
      } else if (reader.NodeType == XmlNodeType.EndElement) {
        if (reader.Depth == paragraphDepth) { paragraphDepth = -1; Emit("\n"); }
        if (local == "table-cell") Emit("\t");
        if (local == "table-row") Emit("\n");
      } else if (paragraphDepth >= 0 && IsText(reader)) Value(reader);
    }
  }
  public GatewayOfficePage Read(string target) {
    string ext = Path.GetExtension(target).ToLowerInvariant();
    string family = ext == ".docx" || ext == ".docm" ? "word" :
      ext == ".xlsx" || ext == ".xlsm" ? "sheet" :
      ext == ".pptx" || ext == ".pptm" ? "slides" : "odf";
    List<string> coverage = new List<string>();
    using (FileStream file = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Read)) {
      var parts = Parts(archive, family).ToArray();
      if (parts.Length == 0) throw new InvalidDataException("No supported document XML parts found; the file may be invalid or encrypted.");
      foreach (var part in parts) coverage.Add(part.FullName);
      try {
        foreach (var part in parts) {
          Emit("\n--- " + part.FullName + " ---\n");
          using (Stream stream = part.Open())
          using (XmlReader reader = OpenXml(stream)) {
            if (family == "word" || family == "slides") ReadWordOrSlides(reader);
            else if (family == "sheet") ReadSheet(reader, part.FullName);
            else ReadOpenDocument(reader);
          }
        }
      } catch (GatewayPageComplete) {}
    }
    NormalizePage();
    return new GatewayOfficePage {
      text = output.ToString(), offset = start,
      next_offset = more ? (object)(start + output.Length) : null, eof = !more,
      coverage = coverage.ToArray(),
      limitations = new [] {
        "Text and stored formula results only; images, drawing geometry, layout, embedded files, macros and linked data are not rendered or executed.",
        "Character offsets use UTF-16 units; later pages rescan earlier XML. A page has a 60-second process deadline.",
        "XLSX shared strings are a numbered dictionary; cells with type=s reference [shared-string:N]. Dates/numbers are stored values without style formatting.",
        "OpenDocument repeated rows/cells/spaces are represented by repeat/space counts, not expanded.",
        "Tracked insertions/deletions and notes may appear together; this is document XML text, not a rendered reading-order guarantee."
      }
    };
  }

  public static GatewayOfficePage EntryText(string target, string entryName, long offset, int limit) {
    string ext = Path.GetExtension(entryName).ToLowerInvariant();
    string[] allowed = {".json", ".xml", ".txt", ".svg", ".css", ".html", ".csv", ".md", ".yaml", ".yml", ".rels", ".ini", ".config"};
    if (!allowed.Contains(ext)) throw new InvalidDataException("Entry must use a supported text extension: JSON/XML/TXT/SVG/CSS/HTML/CSV/MD/YAML/RELS/INI/CONFIG.");
    var page = new GatewayOfficeReader(offset, limit);
    using (FileStream file = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Read)) {
      var entry = archive.GetEntry(entryName);
      if (entry == null) throw new FileNotFoundException("Archive entry not found.");
      using (Stream stream = entry.Open())
      using (StreamReader reader = new StreamReader(stream, new UTF8Encoding(false, true), true, 4096)) {
        try {
          char[] chars = new char[4096];
          int count;
          while ((count = reader.Read(chars, 0, chars.Length)) > 0) {
            if (Array.IndexOf(chars, '\0', 0, count) >= 0) throw new InvalidDataException("Text entry contains NUL characters; use binary tools.");
            page.Emit(new String(chars, 0, count));
          }
        } catch (GatewayPageComplete) {}
      }
    }
    page.NormalizePage();
    return new GatewayOfficePage {
      text = page.output.ToString(), offset = offset,
      next_offset = page.more ? (object)(offset + page.output.Length) : null, eof = !page.more,
      coverage = new [] {entryName},
      limitations = new [] {"Text content only; archive entry is decoded as UTF-8 or BOM-detected Unicode. No scripts or document instructions are executed.",
        "Character offsets use UTF-16 units. Each page rescans the preceding compressed data; 60-second deadline."}
    };
  }
  public static object EntryImage(string target, string entryName) {
    using (FileStream file = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Read)) {
      var entry = archive.GetEntry(entryName);
      if (entry == null) throw new FileNotFoundException("Archive entry not found.");
      if (entry.Length > 4 * 1024 * 1024) throw new InvalidDataException("Thumbnail exceeds 4 MiB.");
      using (Stream stream = entry.Open())
      using (MemoryStream output = new MemoryStream()) {
        byte[] bytes = new byte[8192];
        int count;
        while ((count = stream.Read(bytes, 0, bytes.Length)) > 0) {
          if (output.Length + count > 4 * 1024 * 1024) throw new InvalidDataException("Thumbnail exceeds 4 MiB.");
          output.Write(bytes, 0, count);
        }
        byte[] data = output.ToArray();
        string mime = data.Length >= 8 && data[0] == 137 && data[1] == 80 && data[2] == 78 && data[3] == 71 &&
          data[4] == 13 && data[5] == 10 && data[6] == 26 && data[7] == 10 ? "image/png" :
          data.Length >= 3 && data[0] == 255 && data[1] == 216 && data[2] == 255 ? "image/jpeg" : null;
        if (mime == null) throw new InvalidDataException("Only PNG/JPEG thumbnails are supported.");
        return new { entry = entryName, mimeType = mime, data = Convert.ToBase64String(data) };
      }
    }
  }

  public static GatewayArchivePage Archive(string target, long offset, int limit) {
    if (offset < 0 || limit < 1 || limit > 1000) throw new ArgumentOutOfRangeException();
    List<GatewayArchiveEntry> result = new List<GatewayArchiveEntry>();
    int total;
    using (FileStream file = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Read)) {
      total = archive.Entries.Count;
      for (long i = offset; i < total && result.Count < limit; i++) {
        var entry = archive.Entries[(int)i];
        string name = entry.FullName;
        bool unsafePath = name.StartsWith("/") || name.StartsWith("\\") || Regex.IsMatch(name, @"^[A-Za-z]:") ||
          name.Split(new [] {'/', '\\'}).Any(p => p == "..");
        result.Add(new GatewayArchiveEntry {
          name = name, size = entry.Length, compressed_size = entry.CompressedLength,
          directory = name.EndsWith("/") || name.EndsWith("\\"), unsafe_path = unsafePath
        });
      }
    }
    bool eof = offset >= total || result.Count >= total - offset;
    return new GatewayArchivePage {
      entries = result.ToArray(), offset = offset,
      next_offset = eof ? null : (object)(offset + result.Count), eof = eof,
      total_entries = total,
      limitations = new [] {
        "ZIP container metadata only; entries are never extracted and design layer contents are not interpreted.",
        "ZIP central-directory metadata is read in memory; encrypted or unsupported archives may fail."
      }
    };
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.IO.Compression, System.Core, System.Xml
if ($Mode -eq "archive") {
  [GatewayOfficeReader]::Archive($Target, $Offset, $Limit) | ConvertTo-Json -Depth 6 -Compress
} elseif ($Mode -eq "entry_text") {
  $page = [GatewayOfficeReader]::EntryText($Target, $EntryName, $Offset, $Limit)
  $page | Add-Member -NotePropertyName entry -NotePropertyValue $EntryName
  $page | ConvertTo-Json -Depth 6 -Compress
} elseif ($Mode -eq "entry_image") {
  [GatewayOfficeReader]::EntryImage($Target, $EntryName) | ConvertTo-Json -Depth 6 -Compress
} else {
  $reader = New-Object GatewayOfficeReader($Offset, $Limit)
  $reader.Read($Target) | ConvertTo-Json -Depth 6 -Compress
}


