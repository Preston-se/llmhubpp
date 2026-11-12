import { describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument } from "pdf-lib";
import { memoryVault } from "./testSupport/memoryVault";
import { readSourceDocument } from "./sourceDocuments";
import { extractPdfTextWithOffsets } from 'obsidian-llm-hub-common/vault';

vi.mock("obsidian-llm-hub-common/vault", () => ({ extractPdfTextWithOffsets: vi.fn(async () => null) }));
function archive(entries: Record<string, string>) {
  const bytes = zipSync(Object.fromEntries(Object.entries(entries).map(([p, s]) => [p, strToU8(s)])));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("original document extraction", () => {
  it('flags mixed PDF blank pages and garbled/short text instead of claiming complete extraction', async()=>{
    const m=memoryVault(),pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();
    m.files.set('mixed.pdf',Uint8Array.from(await pdf.save()).buffer);
    vi.mocked(extractPdfTextWithOffsets).mockResolvedValueOnce({text:'Correct 42 kg on page one',pageOffsets:[0,25],numPages:2});
    expect((await readSourceDocument(m.app,'mixed.pdf')).quality).toMatchObject({status:'needs-review',noTextPages:[2]});
    m.files.set('garbled.txt','�'.repeat(30));expect((await readSourceDocument(m.app,'garbled.txt')).quality.status).toBe('needs-review');
    m.files.set('long.txt','甲'.repeat(300000));
    const result=await readSourceDocument(m.app,'long.txt');expect(result.text.length).toBe(120000);expect(result.truncated).toBe(true);
    expect((await readSourceDocument(m.app,'long.txt',{maxChars:400000})).text.length).toBe(300000);
    expect(m.files.get('long.txt')).toHaveLength(300000);
  });
  it("keeps declared slide order and empty spreadsheet columns", async () => {
    const m = memoryVault();
    m.files.set("重排.pptx", archive({
      "ppt/presentation.xml": '<p:presentation><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide1.xml": "<a:p><a:t>实际后页</a:t></a:p>", "ppt/slides/slide2.xml": "<a:p><a:t>实际首页</a:t></a:p>",
    }));
    const slides = (await readSourceDocument(m.app, "重排.pptx")).text;
    expect(slides.indexOf("实际首页")).toBeLessThan(slides.indexOf("实际后页"));
    m.files.set("间隔.xlsx", archive({ "xl/worksheets/sheet1.xml": '<worksheet><row><c r="A1" t="inlineStr"><is><t>课程</t></is></c><c r="C1"><v>9</v></c></row></worksheet>' }));
    expect((await readSourceDocument(m.app, "间隔.xlsx")).text).toContain("课程\t\t9");
  });
  it("reads EPUB chapters in declared spine order rather than archive order", async () => {
    const m = memoryVault(); m.files.set("教材.epub", archive({
      "META-INF/container.xml": '<container><rootfile full-path="OEBPS/book.opf"/></container>',
      "OEBPS/book.opf": '<package><manifest><item id="b" href="b.xhtml"/><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
      "OEBPS/b.xhtml": "<h1>第二章</h1><p>乙 &amp; 丙</p>", "OEBPS/a.xhtml": "<h1>第一章</h1><script>忽略脚本</script><p>甲</p>",
    }));
    const result = await readSourceDocument(m.app, "教材.epub");
    expect(result.text.indexOf("第一章")).toBeLessThan(result.text.indexOf("第二章"));
    expect(result.text).toContain("乙 & 丙"); expect(result.text).not.toContain("忽略脚本");
  });
  it("extracts actual DOCX/PPTX/XLSX content and keeps spreadsheet shared/inline strings", async () => {
    const m = memoryVault();
    m.files.set("书.docx", archive({ "word/document.xml": '<w:document><w:p><w:t>教程正文</w:t></w:p></w:document>' }));
    m.files.set("课.pptx", archive({ "ppt/slides/slide2.xml": '<a:p><a:t>后页</a:t></a:p>', "ppt/slides/slide1.xml": '<a:p><a:t>首页</a:t></a:p>' }));
    m.files.set("表.xlsx", archive({ "xl/sharedStrings.xml": '<sst><si><t>共享词</t></si></sst>',
      "xl/worksheets/sheet1.xml": '<worksheet><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>内联词</t></is></c><c><v>42</v></c></row></worksheet>' }));
    expect((await readSourceDocument(m.app, "书.docx")).text).toContain("教程正文");
    const slides = (await readSourceDocument(m.app, "课.pptx")).text;
    expect(slides.indexOf("首页")).toBeLessThan(slides.indexOf("后页"));
    expect((await readSourceDocument(m.app, "表.xlsx")).text).toContain("共享词\t内联词\t42");
  });
  it("reports missing, empty/scanned PDF, malformed archive and cancellation distinctly", async () => {
    const m = memoryVault(); const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = await pdf.save();
    m.files.set("扫描.pdf", Uint8Array.from(bytes).buffer); m.files.set("坏.epub", new ArrayBuffer(4)); m.files.set("坏.pdf", new ArrayBuffer(4));
    await expect(readSourceDocument(m.app, "没有.txt")).rejects.toMatchObject({ code: "missing" });
    await expect(readSourceDocument(m.app, "扫描.pdf")).rejects.toMatchObject({ code: "no-text" });
    await expect(readSourceDocument(m.app, "坏.epub")).rejects.toMatchObject({ code: "corrupt" });
    await expect(readSourceDocument(m.app, "坏.pdf")).rejects.toMatchObject({ code: "corrupt" });
    const c = new AbortController(); c.abort();
    await expect(readSourceDocument(m.app, "扫描.pdf", { signal: c.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("marks material truncated and does not modify the original", async () => {
    const m = memoryVault(); m.files.set("长.md", "原文甲乙丙丁戊己");
    const doc = await readSourceDocument(m.app, "长.md", { maxChars: 4 });
    expect(doc.text).toBe("原文甲乙"); expect(doc.truncated).toBe(true);
    expect(m.files.get("长.md")).toBe("原文甲乙丙丁戊己");
  });
});
