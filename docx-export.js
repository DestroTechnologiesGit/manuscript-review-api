import { AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph, TextRun } from "docx";

/* ---------------------------------------------------------------------------
   Turn the page's marked-up text into a Word file.

   The page keeps headings as line markers while the models work on the text:
     # Chapter title        → Heading 1
     ## Subheading          → Heading 2
     ### Smaller heading    → Heading 3
     - item                 → bulleted list
   Every other line is a body paragraph. Real Word heading styles matter here:
   KDP, Kindle Create and Word's navigation pane all build the table of
   contents from them.
--------------------------------------------------------------------------- */

const LEVELS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
const FONT = "Times New Roman";

const heading = (id, name, size, before, after, extra = {}) => ({
  id, name, basedOn: "Normal", next: "Normal", quickFormat: true,
  run: { font: FONT, size, bold: true, ...extra },
  paragraph: { spacing: { before, after }, keepNext: true, keepLines: true },
});

export async function manuscriptToDocx(text, title = "") {
  const children = [];
  let lastWasH1 = false;

  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      children.push(new Paragraph({
        heading: LEVELS[level],
        children: [new TextRun(h[2].trim())],
        // Each chapter starts on a new page, as in a printed book. A "Chapter 3"
        // line followed by its title line stays together on one page.
        pageBreakBefore: level === 1 && children.length > 0 && !lastWasH1,
      }));
      lastWasH1 = level === 1;
      continue;
    }
    lastWasH1 = false;

    const bullet = line.match(/^[-*•]\s+(.+)$/);
    children.push(bullet
      ? new Paragraph({ children: [new TextRun(bullet[1])], numbering: { reference: "bullets", level: 0 } })
      : new Paragraph({ children: [new TextRun(line)] }));
  }

  const doc = new Document({
    title: title || undefined,
    creator: "Manuscript review",
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 24 },                       // 12 pt
          paragraph: { spacing: { after: 160, line: 276 } },   // 8 pt after, 1.15 lines
        },
      },
      paragraphStyles: [
        heading("Heading1", "Heading 1", 36, 0, 360),           // 18 pt
        heading("Heading2", "Heading 2", 28, 320, 120),         // 14 pt
        heading("Heading3", "Heading 3", 24, 240, 80, { italics: true }),
      ],
    },
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
