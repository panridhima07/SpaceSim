import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const ROOT = 'c:/Users/medha/Desktop/Hackathons/Astra';
const UPLOADED_IMG = 'C:/Users/medha/.gemini/antigravity/brain/2ac306fa-c208-42b6-a311-cfae006f5da8/.user_uploaded/media_1795310052170_146e3f85.jpg';
const SPACE_ART_OUT = path.join(ROOT, 'public', 'slide1_space_panel.jpg');
const PPTX_OUT = path.join(ROOT, 'ASTRA_Spaceflight_Presentation.pptx');
const PPT_OUT = path.join(ROOT, 'ASTRA_Spaceflight_Presentation.ppt');

// 1. Crop the right-hand space panel (x=638..1023, y=0..573) from the uploaded Slide 1 image
//    and also keep the full uploaded image available.
const psCrop = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile('${UPLOADED_IMG.replace(/\//g, '\\\\')}')
$cropW = $src.Width - 638
$cropH = $src.Height
$dst = New-Object System.Drawing.Bitmap($cropW, $cropH)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$srcRect = New-Object System.Drawing.Rectangle(638, 0, $cropW, $cropH)
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $cropW, $cropH)
$g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$dst.Save('${SPACE_ART_OUT.replace(/\//g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$dst.Dispose()
$src.Dispose()
`;

try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', psCrop], { stdio: 'inherit' });
  console.log('Cropped space artwork panel ->', SPACE_ART_OUT);
} catch (err) {
  console.warn('PowerShell crop fallback:', err.message);
}

// ---------------------------------------------------------------------------
// OpenXML / PPTX Helpers (16:9 Widescreen: 13.333" x 7.5" -> 12192000 x 6858000 EMU)
// ---------------------------------------------------------------------------
const EMU = 914400; // 1 inch = 914400 EMU
const SLIDE_W = 12192000; // 13.333 in
const SLIDE_H = 6858000;  // 7.500 in
const inToEmu = (inches) => Math.round(inches * EMU);

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Palette extracted directly from Slide 1 & ASTRA Spaceflight (.sfb-root)
const C = {
  bg: '0B0C11',         // Exact Slide 1 dark slate background
  bgDeep: '06080D',     // Deeper inset background
  card: '111622',       // Elevated card surface
  cardAlt: '151C2C',    // Highlighted card surface
  border: '24324C',     // Card border line
  borderCyan: '3B7EA1', // Accent cyan border
  borderPurple: '584E9E', // Accent purple border
  kicker: '71B7D5',     // Kicker cyan-blue (ASTRA 2026 · ANTERiX · VIT BHOPAL UNIVERSITY)
  cyan: '65D2E6',       // Bright cyan accent (subtitle & metrics)
  purple: '9A8FEF',     // Lavender-purple section header (TEAM)
  white: 'FFFFFF',      // Pure white headings
  text: 'E2ECF8',       // Primary body text
  muted: '9AA6B8',      // Secondary muted text
  dim: '68778D',        // Subtle caption / footer text
  green: '7DFFB2',      // Nominal / verified green
  amber: 'FFB454',      // Warning / caution amber
  red: 'FF5D6C',        // Critical / fault red
};

let shapeIdCounter = 10;
const nextId = () => ++shapeIdCounter;

function rectShape({
  x, y, w, h,
  fill = C.card,
  line = null,
  lineWidthPt = 1,
  radius = 0, // 0 for rect, or 1..50000 for roundRect adj
  fillAlpha = 100,
}) {
  const id = nextId();
  const prst = radius > 0 ? 'roundRect' : 'rect';
  const avLst = radius > 0 ? `<a:avLst><a:gd name="adj" fmla="val ${radius}"/></a:avLst>` : '<a:avLst/>';
  const alphaTag = fillAlpha < 100 ? `<a:alpha val="${Math.round(fillAlpha * 1000)}"/>` : '';
  const fillXml = fill
    ? `<a:solidFill><a:srgbClr val="${fill}">${alphaTag}</a:srgbClr></a:solidFill>`
    : '<a:noFill/>';
  const lineXml = line
    ? `<a:ln w="${Math.round(lineWidthPt * 12700)}"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>`
    : '<a:ln><a:noFill/></a:ln>';

  return `
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="Shape ${id}"/>
        <p:cNvSpPr/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm>
          <a:off x="${inToEmu(x)}" y="${inToEmu(y)}"/>
          <a:ext cx="${inToEmu(w)}" cy="${inToEmu(h)}"/>
        </a:xfrm>
        <a:prstGeom prst="${prst}">${avLst}</a:prstGeom>
        ${fillXml}
        ${lineXml}
      </p:spPr>
    </p:sp>`;
}

/**
 * Rich text box supporting multiple paragraphs, each with runs or single string.
 * paragraphs: Array of {
 *   text?: string,
 *   runs?: Array<{ text: string, size?: number, bold?: boolean, italic?: boolean, color?: string, font?: string, spc?: number }>,
 *   size?: number, bold?: boolean, italic?: boolean, color?: string, font?: string,
 *   align?: 'l'|'ctr'|'r',
 *   spaceBeforePt?: number, spaceAfterPt?: number, lineSpacingPct?: number,
 *   spc?: number (character spacing in hundredths of a point, e.g. 180 = 1.8pt)
 * }
 */
function textBox({
  x, y, w, h,
  paragraphs = [],
  anchor = 't', // 't', 'ctr', 'b'
  fill = null,
  line = null,
  lineWidthPt = 1,
  radius = 0,
  padL = 0.08, padR = 0.08, padT = 0.06, padB = 0.06,
}) {
  const id = nextId();
  const prst = radius > 0 ? 'roundRect' : 'rect';
  const avLst = radius > 0 ? `<a:avLst><a:gd name="adj" fmla="val ${radius}"/></a:avLst>` : '<a:avLst/>';
  const fillXml = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>';
  const lineXml = line
    ? `<a:ln w="${Math.round(lineWidthPt * 12700)}"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>`
    : '<a:ln><a:noFill/></a:ln>';

  const pXml = paragraphs.map((p) => {
    const algn = p.align || 'l';
    const spcBef = p.spaceBeforePt ? `<a:spcBef><a:spcPts val="${Math.round(p.spaceBeforePt * 100)}"/></a:spcBef>` : '';
    const spcAft = p.spaceAfterPt ? `<a:spcAft><a:spcPts val="${Math.round(p.spaceAfterPt * 100)}"/></a:spcAft>` : '';
    const lnSpc = p.lineSpacingPct ? `<a:lnSpc><a:spcPct val="${Math.round(p.lineSpacingPct * 1000)}"/></a:lnSpc>` : '';

    const runs = p.runs || [{
      text: p.text ?? '',
      size: p.size ?? 14,
      bold: p.bold ?? false,
      italic: p.italic ?? false,
      color: p.color ?? C.text,
      font: p.font ?? 'Segoe UI',
      spc: p.spc ?? 0,
    }];

    const runsXml = runs.map((r) => {
      const sz = Math.round((r.size ?? p.size ?? 14) * 100);
      const b = (r.bold ?? p.bold) ? ' b="1"' : '';
      const i = (r.italic ?? p.italic) ? ' i="1"' : '';
      const spcAttr = (r.spc ?? p.spc) ? ` spc="${Math.round(r.spc ?? p.spc)}"` : '';
      const clr = r.color ?? p.color ?? C.text;
      const font = r.font ?? p.font ?? 'Segoe UI';
      return `<a:r>
        <a:rPr lang="en-US" sz="${sz}"${b}${i}${spcAttr} dirty="0">
          <a:solidFill><a:srgbClr val="${clr}"/></a:solidFill>
          <a:latin typeface="${esc(font)}"/>
          <a:cs typeface="${esc(font)}"/>
        </a:rPr>
        <a:t>${esc(r.text)}</a:t>
      </a:r>`;
    }).join('');

    return `<a:p>
      <a:pPr algn="${algn}">${lnSpc}${spcBef}${spcAft}</a:pPr>
      ${runsXml}
    </a:p>`;
  }).join('');

  return `
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="TextBox ${id}"/>
        <p:cNvSpPr txBox="1"/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm>
          <a:off x="${inToEmu(x)}" y="${inToEmu(y)}"/>
          <a:ext cx="${inToEmu(w)}" cy="${inToEmu(h)}"/>
        </a:xfrm>
        <a:prstGeom prst="${prst}">${avLst}</a:prstGeom>
        ${fillXml}
        ${lineXml}
      </p:spPr>
      <p:txBody>
        <a:bodyPr wrap="square" rtlCol="0" anchor="${anchor}"
          lIns="${inToEmu(padL)}" rIns="${inToEmu(padR)}" tIns="${inToEmu(padT)}" bIns="${inToEmu(padB)}">
          <a:noAutofit/>
        </a:bodyPr>
        <a:lstStyle/>
        ${pXml}
      </p:txBody>
    </p:sp>`;
}

function picShape({ rId, x, y, w, h, name = 'Picture' }) {
  const id = nextId();
  return `
    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="${id}" name="${esc(name)}"/>
        <p:cNvPicPr><a:picLocks noChangeAspect="0"/></p:cNvPicPr>
        <p:nvPr/>
      </p:nvPicPr>
      <p:blipFill>
        <a:blip r:embed="${rId}"/>
        <a:stretch><a:fillRect/></a:stretch>
      </p:blipFill>
      <p:spPr>
        <a:xfrm>
          <a:off x="${inToEmu(x)}" y="${inToEmu(y)}"/>
          <a:ext cx="${inToEmu(w)}" cy="${inToEmu(h)}"/>
        </a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </p:spPr>
    </p:pic>`;
}

/**
 * Native OpenXML Table (<p:graphicFrame> with <a:tbl>) for crisp PowerPoint tables.
 */
function tableShape({
  x, y, w, rowH = 0.34,
  colWidths = [],
  rows = [], // Array of string[]
  headerColor = C.cyan,
  highlightCol = -1,
  highlightColor = C.green,
  warnRowIdx = -1,
  warnColIdx = -1,
}) {
  const id = nextId();
  const totalH = rows.length * rowH;
  const gridColsXml = colWidths.map((cw) => `<a:gridCol w="${inToEmu(cw)}"/>`).join('');

  const rowsXml = rows.map((row, rIdx) => {
    const isHdr = rIdx === 0;
    const bgHex = isHdr ? C.cardAlt : (rIdx % 2 === 0 ? C.bgDeep : C.card);
    const cellsXml = row.map((cellText, cIdx) => {
      const algn = cIdx >= 1 ? 'ctr' : 'l';
      const font = cIdx >= 1 ? 'Consolas' : 'Segoe UI';
      const sz = isHdr ? 950 : 980;
      const b = (isHdr || cIdx === highlightCol) ? ' b="1"' : '';
      let clr = isHdr ? headerColor : (cIdx === highlightCol ? highlightColor : C.text);
      if (rIdx === warnRowIdx && cIdx === warnColIdx) clr = C.amber;

      return `<a:tc>
        <a:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:pPr algn="${algn}"/>
            <a:r>
              <a:rPr lang="en-US" sz="${sz}"${b} dirty="0">
                <a:solidFill><a:srgbClr val="${clr}"/></a:solidFill>
                <a:latin typeface="${font}"/>
                <a:cs typeface="${font}"/>
              </a:rPr>
              <a:t>${esc(cellText)}</a:t>
            </a:r>
          </a:p>
        </a:txBody>
        <a:tcPr marL="${inToEmu(0.06)}" marR="${inToEmu(0.06)}" marT="${inToEmu(0.03)}" marB="${inToEmu(0.03)}" anchor="ctr">
          <a:lnL w="0"><a:noFill/></a:lnL>
          <a:lnR w="0"><a:noFill/></a:lnR>
          <a:lnT w="6350"><a:solidFill><a:srgbClr val="${C.border}"/></a:solidFill></a:lnT>
          <a:lnB w="6350"><a:solidFill><a:srgbClr val="${C.border}"/></a:solidFill></a:lnB>
          <a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill>
        </a:tcPr>
      </a:tc>`;
    }).join('');
    return `<a:tr h="${inToEmu(rowH)}">${cellsXml}</a:tr>`;
  }).join('');

  return `
    <p:graphicFrame>
      <p:nvGraphicFramePr>
        <p:cNvPr id="${id}" name="Table ${id}"/>
        <p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>
        <p:nvPr/>
      </p:nvGraphicFramePr>
      <p:xfrm>
        <a:off x="${inToEmu(x)}" y="${inToEmu(y)}"/>
        <a:ext cx="${inToEmu(w)}" cy="${inToEmu(totalH)}"/>
      </p:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
          <a:tbl>
            <a:tblPr firstRow="1" bandRow="1"/>
            <a:tblGrid>${gridColsXml}</a:tblGrid>
            ${rowsXml}
          </a:tbl>
        </a:graphicData>
      </a:graphic>
    </p:graphicFrame>`;
}

// Common chrome header + footer for Slides 2..7
function slideChrome({ slideNum, kicker, title, subtitle }) {
  const parts = [];
  // Top thin cyan accent line on left margin
  parts.push(rectShape({ x: 0.65, y: 0.42, w: 0.45, h: 0.04, fill: C.cyan }));
  // Kicker
  parts.push(textBox({
    x: 1.20, y: 0.31, w: 9.5, h: 0.28,
    padL: 0, padT: 0,
    paragraphs: [{
      text: kicker,
      size: 10.5, bold: true, color: C.kicker, font: 'Consolas', spc: 220,
    }],
  }));
  // Slide number badge top right
  parts.push(textBox({
    x: 11.45, y: 0.30, w: 1.23, h: 0.32,
    fill: C.card, line: C.border, radius: 18000,
    anchor: 'ctr', padL: 0.05, padR: 0.05, padT: 0, padB: 0,
    paragraphs: [{
      text: `0${slideNum} / 08`,
      size: 10, bold: true, color: C.cyan, font: 'Consolas', align: 'ctr', spc: 120,
    }],
  }));
  // Main slide title
  parts.push(textBox({
    x: 0.65, y: 0.62, w: 12.0, h: 0.58,
    padL: 0, padT: 0,
    paragraphs: [{
      text: title,
      size: 27, bold: true, color: C.white, font: 'Consolas',
    }],
  }));
  // Subtitle
  if (subtitle) {
    parts.push(textBox({
      x: 0.65, y: 1.20, w: 12.0, h: 0.38,
      padL: 0, padT: 0,
      paragraphs: [{
        text: subtitle,
        size: 13.5, color: C.cyan, font: 'Segoe UI',
      }],
    }));
  }
  // Bottom footer bar
  parts.push(rectShape({ x: 0.65, y: 7.02, w: 12.03, h: 0.012, fill: C.border }));
  parts.push(textBox({
    x: 0.65, y: 7.08, w: 7.5, h: 0.28,
    padL: 0, padT: 0,
    paragraphs: [{
      text: 'ASTRA SPACEFLIGHT  ·  ASTRA 2026 · ANTERiX · VIT BHOPAL UNIVERSITY',
      size: 9, color: C.dim, font: 'Consolas', spc: 140,
    }],
  }));
  parts.push(textBox({
    x: 8.5, y: 7.08, w: 4.18, h: 0.28,
    padL: 0, padR: 0, padT: 0,
    paragraphs: [{
      text: 'DOMAIN 05 + DOMAIN 01  ·  BUILD · LAUNCH · EXPLORE · LAND',
      size: 9, color: C.dim, font: 'Consolas', align: 'r', spc: 120,
    }],
  }));
  return parts.join('\n');
}

function wrapSlideXml(shapesXml, bgHex = C.bg) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill>
        <a:effectLst/>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      ${shapesXml}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

// ===========================================================================
// SLIDE 1: Exact reproduction of the attached Slide 1 (with editable native text + right-side Earth/Moon space image)
// ===========================================================================
function buildSlide1() {
  const s = [];
  // Right-side Earth & Moon space photograph from the attached Slide 1 (x = 8.307 in, w = 5.026 in, y = 0, h = 7.5 in)
  // 638 / 1024 * 13.3333 = 8.3073 in; 386 / 1024 * 13.3333 = 5.0260 in
  s.push(picShape({
    rId: 'rId2',
    x: 8.307, y: 0, w: 5.026, h: 7.5,
    name: 'Earth and Moon Space Art',
  }));

  // Kicker: ASTRA 2026 · ANTERiX · VIT BHOPAL UNIVERSITY
  s.push(textBox({
    x: 0.62, y: 0.72, w: 7.3, h: 0.35,
    padL: 0, padT: 0,
    paragraphs: [{
      text: 'ASTRA 2026 · ANTERiX · VIT BHOPAL UNIVERSITY',
      size: 13.5, bold: true, color: C.kicker, font: 'Consolas', spc: 140,
    }],
  }));

  // Main Title: ASTRA Spaceflight
  s.push(textBox({
    x: 0.60, y: 1.04, w: 7.4, h: 1.05,
    padL: 0, padT: 0,
    paragraphs: [{
      text: 'ASTRA Spaceflight',
      size: 50, bold: true, color: C.white, font: 'Consolas',
    }],
  }));

  // Subtitle: A mobile game that makes every rocket design playable, on missions from Mercury to Jupiter.
  s.push(textBox({
    x: 0.62, y: 2.08, w: 7.3, h: 0.85,
    padL: 0, padT: 0,
    paragraphs: [{
      text: 'A mobile game that makes every rocket design playable, on missions from Mercury to Jupiter.',
      size: 20, color: C.cyan, font: 'Segoe UI', lineSpacingPct: 122,
    }],
  }));

  // Domain line
  s.push(textBox({
    x: 0.62, y: 2.94, w: 7.3, h: 0.65,
    padL: 0, padT: 0,
    paragraphs: [{
      text: 'Domain 05: Moon, Mars & Deep-Space Exploration, merged with Domain 01: Indian Space Missions & Space Data',
      size: 13.5, color: C.muted, font: 'Segoe UI', lineSpacingPct: 128,
    }],
  }));

  // TEAM label
  s.push(textBox({
    x: 0.62, y: 3.82, w: 3.0, h: 0.32,
    padL: 0, padT: 0,
    paragraphs: [{
      text: 'TEAM',
      size: 13, bold: true, color: C.purple, font: 'Consolas', spc: 180,
    }],
  }));

  // Team Left Column
  s.push(textBox({
    x: 0.62, y: 4.16, w: 3.5, h: 0.90,
    padL: 0, padT: 0,
    paragraphs: [
      { text: 'Ridhima Pandey (Team Lead)', size: 15.5, color: C.white, font: 'Segoe UI', spaceAfterPt: 8 },
      { text: 'Vidit Agarwal', size: 15.5, color: C.white, font: 'Segoe UI' },
    ],
  }));

  // Team Right Column
  s.push(textBox({
    x: 4.30, y: 4.16, w: 3.5, h: 0.90,
    padL: 0, padT: 0,
    paragraphs: [
      { text: 'Kshitij Jha', size: 15.5, color: C.white, font: 'Segoe UI', spaceAfterPt: 8 },
      { text: 'Medhansh Khattar', size: 15.5, color: C.white, font: 'Segoe UI' },
    ],
  }));

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 2: The Problem
// ===========================================================================
function buildSlide2() {
  const s = [];
  s.push(slideChrome({
    slideNum: 2,
    kicker: 'THE PROBLEM',
    title: 'Rocket designs stay on screen and are never flown',
    subtitle: 'Reaching another planet takes 9.3–10 km/s of delta-v and years of travel.',
  }));

  const stats = [
    { value: '9.3–10 km/s', label: 'delta-v to reach low Earth orbit', color: C.cyan },
    { value: '259 days', label: 'Earth to Mars transfer', color: C.amber },
    { value: '2.7 years', label: 'Earth to Jupiter transfer', color: C.purple },
  ];
  stats.forEach((st, i) => {
    const x = 0.65 + i * 4.12;
    s.push(rectShape({ x, y: 1.85, w: 3.90, h: 2.0, fill: C.card, line: C.border, radius: 12000 }));
    s.push(rectShape({ x, y: 1.85, w: 3.90, h: 0.06, fill: st.color }));
    s.push(textBox({
      x: x + 0.3, y: 2.20, w: 3.3, h: 1.5, padL: 0, padT: 0,
      paragraphs: [
        { text: st.value, size: 30, bold: true, color: C.white, font: 'Segoe UI', spaceAfterPt: 6 },
        { text: st.label, size: 13, color: C.muted, font: 'Segoe UI' },
      ],
    }));
  });

  s.push(textBox({
    x: 0.65, y: 4.35, w: 12.0, h: 2.2, padL: 0, padT: 0,
    paragraphs: [
      { text: 'A CAD model or OpenRocket file describes a rocket, but nothing flies it.', size: 18, bold: true, color: C.text, spaceAfterPt: 8 },
      { text: 'Students and hobbyists need to know whether a design will get off the pad, stay stable and recover, before any hardware is built.', size: 15, color: C.muted, lineSpacingPct: 125 },
    ],
  }));

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 3: Why Existing Tools Fall Short
// ===========================================================================
function buildSlide3() {
  const s = [];
  s.push(slideChrome({
    slideNum: 3,
    kicker: 'THE GAP',
    title: 'Current tools stop at the launch pad',
    subtitle: 'Design tools, hobby simulators and space games each cover one part of the problem.',
  }));

  const gaps = [
    { n: '01', t: 'Design tools stop at launch', b: 'OpenRocket is desktop-only and shows static 2D views.', c: C.red },
    { n: '02', t: 'Simulators plot one flight', b: 'Hobby simulators show a flight to apogee, not a trip to another planet.', c: C.amber },
    { n: '03', t: 'Games use invented worlds', b: 'Kerbal-style games use made-up parts at one-tenth real scale.', c: C.cyan },
    { n: '04', t: 'Hardware tests are costly', b: 'A failed launch costs parts and time. A failed simulation costs nothing.', c: C.green },
  ];
  gaps.forEach((g, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.65 + col * 6.12;
    const y = 1.85 + row * 2.45;
    s.push(rectShape({ x, y, w: 5.90, h: 2.20, fill: C.card, line: C.border, radius: 12000 }));
    s.push(rectShape({ x, y, w: 0.08, h: 2.20, fill: g.c }));
    s.push(textBox({
      x: x + 0.35, y: y + 0.3, w: 5.2, h: 1.7, padL: 0, padT: 0,
      paragraphs: [
        { text: g.n, size: 12, bold: true, color: g.c, font: 'Consolas', spaceAfterPt: 4 },
        { text: g.t, size: 19, bold: true, color: C.white, font: 'Segoe UI', spaceAfterPt: 8 },
        { text: g.b, size: 14, color: C.muted, font: 'Segoe UI', lineSpacingPct: 120 },
      ],
    }));
  });

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 4: The Solution (with app screenshots)
// ===========================================================================
function buildSlide4() {
  const s = [];
  s.push(slideChrome({
    slideNum: 4,
    kicker: 'THE SOLUTION',
    title: 'Every rocket design becomes a playable mission',
    subtitle: 'A mobile game that lets students and adults test a rocket before it is built.',
  }));

  const steps = [
    { n: '01 · IMPORT', t: 'Load any rocket', b: 'OpenRocket (.ork) files today. RockSim and CAD formats are planned.', c: C.cyan },
    { n: '02 · BUILD', t: 'Or build one', b: 'Engines, tanks, decouplers, heat shields and parachutes snap together.', c: C.purple },
    { n: '03 · FLY', t: 'Mercury to Jupiter', b: 'Touch controls: throttle, rotate, stage and switch to the map view.', c: C.green },
    { n: '04 · LEARN', t: 'Fail and find out why', b: 'Warnings never block a launch. Each failure is explained in plain words.', c: C.amber },
  ];
  steps.forEach((st, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.65 + col * 3.98;
    const y = 1.85 + row * 2.50;
    s.push(rectShape({ x, y, w: 3.78, h: 2.30, fill: C.card, line: C.border, radius: 12000 }));
    s.push(rectShape({ x, y, w: 3.78, h: 0.06, fill: st.c }));
    s.push(textBox({
      x: x + 0.25, y: y + 0.25, w: 3.3, h: 1.9, padL: 0, padT: 0,
      paragraphs: [
        { text: st.n, size: 10, bold: true, color: st.c, font: 'Consolas', spc: 150, spaceAfterPt: 4 },
        { text: st.t, size: 16, bold: true, color: C.white, font: 'Segoe UI', spaceAfterPt: 6 },
        { text: st.b, size: 12, color: C.muted, font: 'Segoe UI', lineSpacingPct: 120 },
      ],
    }));
  });

  // Screenshots: desktop builder/pad view on top, two phone views below
  s.push(picShape({ rId: 'rId4', x: 8.62, y: 1.85, w: 4.08, h: 2.08, name: 'Desktop builder and pad' }));
  s.push(picShape({ rId: 'rId2', x: 9.24, y: 4.15, w: 1.27, h: 2.75, name: 'Flight view' }));
  s.push(picShape({ rId: 'rId3', x: 10.81, y: 4.15, w: 1.27, h: 2.75, name: 'Parts builder' }));

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 5: Real Data & Architecture
// ===========================================================================
function buildSlide5() {
  const s = [];
  s.push(slideChrome({
    slideNum: 5,
    kicker: 'REAL DATA & ARCHITECTURE',
    title: 'Real mission data drives every number in the game',
    subtitle: 'Every value is labelled with its source: real, derived or simulated.',
  }));

  const rows = [
    ['Planet positions', 'NASA/JPL Horizons ephemerides', 'Real-scale solar system'],
    ['Planet properties', 'Published gravity, radius, atmosphere', 'Launch, drag and landing physics'],
    ['Player designs', 'OpenRocket .ork files', 'Parts, mass and thrust'],
    ['Delta-v budgets', 'Published reference figures', 'Feasibility check per destination'],
    ['Indian vehicles', 'ISRO specs: LVM3, 43.5 m, 640 t', 'Preset rockets to fly'],
  ];
  const cols = [3.1, 4.6, 4.3];
  const heads = ['Data', 'Source', 'What it drives'];
  let x0 = 0.65;
  const y0 = 1.85;
  const rowH = 0.72;
  // header
  let cx = x0;
  heads.forEach((h, j) => {
    s.push(textBox({ x: cx + 0.2, y: y0 + 0.1, w: cols[j] - 0.3, h: 0.4, padL: 0, padT: 0,
      paragraphs: [{ text: h.toUpperCase(), size: 10, bold: true, color: C.cyan, font: 'Consolas', spc: 150 }] }));
    cx += cols[j];
  });
  rows.forEach((r, i) => {
    const y = y0 + 0.5 + i * rowH;
    s.push(rectShape({ x: x0, y, w: 12.0, h: rowH - 0.08, fill: i % 2 === 0 ? C.card : C.cardAlt, line: C.border, radius: 8000 }));
    let rx = x0;
    r.forEach((cell, j) => {
      s.push(textBox({ x: rx + 0.2, y: y + 0.12, w: cols[j] - 0.3, h: rowH - 0.3, padL: 0, padT: 0, anchor: 'ctr',
        paragraphs: [{ text: cell, size: 13, bold: j === 0, color: j === 0 ? C.white : C.text, font: 'Segoe UI' }] }));
      rx += cols[j];
    });
  });

  // Architecture strip
  const flow = ['Data pack (sourced values)', 'Physics + 3D game engine', 'Web app and Android APK'];
  flow.forEach((t, i) => {
    const x = 0.65 + i * 4.12;
    s.push(rectShape({ x, y: 6.05, w: 3.90, h: 0.85, fill: C.cardAlt, line: C.borderCyan, radius: 12000 }));
    s.push(textBox({ x, y: 6.05, w: 3.90, h: 0.85, anchor: 'ctr', padL: 0.1, padR: 0.1,
      paragraphs: [{ text: t, size: 13, bold: true, color: C.white, font: 'Segoe UI', align: 'ctr' }] }));
  });

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 6: Missions from Mercury to Jupiter
// ===========================================================================
function buildSlide6() {
  const s = [];
  s.push(slideChrome({
    slideNum: 6,
    kicker: 'THE PLAYFIELD',
    title: 'Missions from Mercury to Jupiter, at real scale',
    subtitle: 'Time warp turns a 2.7-year transfer into seconds of play.',
  }));

  const rows = [
    ['Mercury', '3.7', '4.3', '105 days'],
    ['Venus', '8.9', '10.4', '146 days'],
    ['Moon', '1.6', '2.4', 'about 3 days'],
    ['Mars', '3.7', '5.0', '259 days'],
    ['Jupiter', '23.1', '59.5', '2.7 years'],
  ];
  const heads = ['Destination', 'Gravity (m/s²)', 'Escape speed (km/s)', 'Trip from Earth'];
  const cols = [2.6, 2.6, 2.9, 2.6];
  const y0 = 1.85;
  const rowH = 0.70;
  let cx = 0.65;
  heads.forEach((h, j) => {
    s.push(textBox({ x: cx + 0.2, y: y0 + 0.1, w: cols[j] - 0.3, h: 0.4, padL: 0, padT: 0,
      paragraphs: [{ text: h.toUpperCase(), size: 10, bold: true, color: C.cyan, font: 'Consolas', spc: 120 }] }));
    cx += cols[j];
  });
  rows.forEach((r, i) => {
    const y = y0 + 0.5 + i * rowH;
    s.push(rectShape({ x: 0.65, y, w: 10.7, h: rowH - 0.08, fill: i % 2 === 0 ? C.card : C.cardAlt, line: C.border, radius: 8000 }));
    let rx = 0.65;
    r.forEach((cell, j) => {
      s.push(textBox({ x: rx + 0.2, y: y + 0.10, w: cols[j] - 0.3, h: rowH - 0.28, padL: 0, padT: 0, anchor: 'ctr',
        paragraphs: [{ text: cell, size: 14, bold: j === 0, color: j === 0 ? C.white : C.text, font: 'Segoe UI' }] }));
      rx += cols[j];
    });
  });

  // Side fact
  s.push(rectShape({ x: 11.55, y: 1.85, w: 1.15, h: 4.7, fill: C.cardAlt, line: C.borderCyan, radius: 12000 }));
  s.push(textBox({ x: 11.6, y: 2.0, w: 1.05, h: 4.4, padL: 0.05, padR: 0.05, padT: 0,
    paragraphs: [
      { text: '5.2 AU', size: 15, bold: true, color: C.cyan, font: 'Segoe UI', align: 'ctr', spaceAfterPt: 2 },
      { text: 'Jupiter from the Sun', size: 10, color: C.muted, align: 'ctr', spaceAfterPt: 14 },
      { text: '59.5 km/s', size: 15, bold: true, color: C.cyan, font: 'Segoe UI', align: 'ctr', spaceAfterPt: 2 },
      { text: 'escape speed at Jupiter', size: 10, color: C.muted, align: 'ctr', spaceAfterPt: 14 },
      { text: '11.2 km/s', size: 15, bold: true, color: C.cyan, font: 'Segoe UI', align: 'ctr', spaceAfterPt: 2 },
      { text: 'escape speed at Earth', size: 10, color: C.muted, align: 'ctr' },
    ],
  }));

  s.push(textBox({ x: 0.65, y: 6.1, w: 12.0, h: 0.7, padL: 0, padT: 0,
    paragraphs: [{ text: 'Earth for comparison: gravity 9.8 m/s², escape speed 11.2 km/s. A zoomable map keeps a 5.2 AU orbit readable on a phone.', size: 13, color: C.muted, lineSpacingPct: 120 }] }));

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 7: Landing & Test Reports
// ===========================================================================
function buildSlide7() {
  const s = [];
  s.push(slideChrome({
    slideNum: 7,
    kicker: 'LANDING & TEST REPORTS',
    title: 'Landing is where most designs fail',
    subtitle: 'Lunar gravity is one-sixth of Earth’s, and with no air a lander must use its engines for everything.',
  }));

  const limits = [
    { v: '2 m/s', l: 'max vertical touchdown speed', c: C.cyan },
    { v: '0.5 m/s', l: 'max horizontal touchdown speed', c: C.green },
    { v: '12°', l: 'max ground slope at the site', c: C.amber },
    { v: '1.62 m/s²', l: 'lunar surface gravity', c: C.purple },
  ];
  limits.forEach((st, i) => {
    const x = 0.65 + i * 3.02;
    s.push(rectShape({ x, y: 1.85, w: 2.85, h: 1.85, fill: C.card, line: C.border, radius: 12000 }));
    s.push(rectShape({ x, y: 1.85, w: 2.85, h: 0.06, fill: st.c }));
    s.push(textBox({ x: x + 0.25, y: 2.1, w: 2.4, h: 1.5, padL: 0, padT: 0,
      paragraphs: [
        { text: st.v, size: 24, bold: true, color: C.white, font: 'Segoe UI', spaceAfterPt: 6 },
        { text: st.l, size: 12, color: C.muted, font: 'Segoe UI', lineSpacingPct: 118 },
      ] }));
  });

  s.push(rectShape({ x: 0.65, y: 4.05, w: 5.9, h: 2.75, fill: C.cardAlt, line: C.borderPurple, radius: 12000 }));
  s.push(textBox({ x: 0.9, y: 4.25, w: 5.4, h: 2.4, padL: 0, padT: 0,
    paragraphs: [
      { text: 'ON MARS', size: 10, bold: true, color: C.purple, font: 'Consolas', spc: 150, spaceAfterPt: 6 },
      { text: 'A heat shield and parachute do part of the work.', size: 14, bold: true, color: C.white, spaceAfterPt: 8 },
      { text: 'On the Moon and Mercury, the engines must do all of it. Each failed landing shows its cause.', size: 13, color: C.text, lineSpacingPct: 120 },
    ] }));

  s.push(rectShape({ x: 6.8, y: 4.05, w: 5.9, h: 2.75, fill: C.cardAlt, line: C.borderCyan, radius: 12000 }));
  s.push(textBox({ x: 7.05, y: 4.25, w: 5.4, h: 2.4, padL: 0, padT: 0,
    paragraphs: [
      { text: 'EVERY TEST FLIGHT REPORTS', size: 10, bold: true, color: C.cyan, font: 'Consolas', spc: 150, spaceAfterPt: 6 },
      { text: 'Thrust-to-weight at lift-off', size: 13, color: C.text, spaceAfterPt: 4 },
      { text: 'Delta-v per stage', size: 13, color: C.text, spaceAfterPt: 4 },
      { text: 'Peak drag and touchdown speed', size: 13, color: C.text, spaceAfterPt: 4 },
      { text: 'The cause of any failure', size: 13, color: C.text },
    ] }));

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 8: Thank You
// ===========================================================================
function buildSlide8() {
  const s = [];
  s.push(slideChrome({
    slideNum: 8,
    kicker: 'THANK YOU',
    title: 'Thank you',
    subtitle: 'Questions and live flight welcome.',
  }));

  s.push(rectShape({ x: 0.65, y: 2.2, w: 12.03, h: 3.9, fill: C.cardAlt, line: C.borderCyan, lineWidthPt: 1.2, radius: 12000 }));
  s.push(textBox({
    x: 0.65, y: 2.6, w: 12.03, h: 3.1, padL: 0.3, padR: 0.3, anchor: 'ctr',
    paragraphs: [
      { text: 'ASTRA SPACEFLIGHT', size: 14, bold: true, color: C.cyan, font: 'Consolas', align: 'ctr', spc: 200, spaceAfterPt: 14 },
      { text: 'Every rocket design becomes a playable mission.', size: 26, bold: true, color: C.white, font: 'Segoe UI', align: 'ctr', spaceAfterPt: 14 },
      { text: 'Ridhima Pandey · Kshitij Jha · Vidit Agarwal · Medhansh Khattar', size: 14, color: C.muted, font: 'Segoe UI', align: 'ctr' },
    ],
  }));

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// Assemble Full PPTX Package with JSZip
// ===========================================================================
async function generatePptx() {
  const zip = new JSZip();

  const slides = [
    buildSlide1(),
    buildSlide2(),
    buildSlide3(),
    buildSlide4(),
    buildSlide5(),
    buildSlide6(),
    buildSlide7(),
    buildSlide8(),
  ];

  // 1. [Content_Types].xml
  const slideContentTypes = slides
    .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join('\n  ');

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${slideContentTypes}
</Types>`);

  // 2. _rels/.rels
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

  // 3. docProps/core.xml & app.xml
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:dcmitype="http://purl.org/dc/dcmitype/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>ASTRA Spaceflight — ASTRA 2026 Presentation</dc:title>
  <dc:subject>Domain 05 &amp; Domain 01 Spaceflight Simulator</dc:subject>
  <dc:creator>Ridhima Pandey, Vidit Agarwal, Kshitij Jha, Medhansh Khattar</dc:creator>
  <cp:lastModifiedBy>ASTRA Team</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-11-22T00:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2026-11-22T00:00:00Z</dcterms:modified>
</cp:coreProperties>`);

  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
            xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <TotalTime>0</TotalTime>
  <Words>1200</Words>
  <Application>Microsoft Office PowerPoint</Application>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Paragraphs>80</Paragraphs>
  <Slides>${slides.length}</Slides>
  <Notes>0</Notes>
  <HiddenSlides>0</HiddenSlides>
  <MMClips>0</MMClips>
  <ScaleCrop>false</ScaleCrop>
  <Company>VIT Bhopal University</Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0000</AppVersion>
</Properties>`);

  // 4. ppt/presentation.xml & ppt/_rels/presentation.xml.rels
  const sldIdEntries = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
    .join('\n    ');

  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                saveSubsetFonts="1">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
    ${sldIdEntries}
  </p:sldIdLst>
  <p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>
  <p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>
  <p:defaultTextStyle>
    <a:defPPr><a:defRPr lang="en-US"/></a:defPPr>
  </p:defaultTextStyle>
</p:presentation>`);

  const presRels = slides
    .map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`)
    .join('\n  ');

  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${presRels}
  <Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
  <Relationship Id="rId${slides.length + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
  <Relationship Id="rId${slides.length + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rId${slides.length + 5}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>`);

  zip.file('ppt/presProps.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
          xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`);

  zip.file('ppt/viewProps.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
          xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>
  <p:slideViewPr>
    <p:cSldViewPr>
      <p:cViewPr varScale="1"><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr>
      <p:guideLst/>
    </p:cSldViewPr>
  </p:slideViewPr>
</p:viewPr>`);

  zip.file('ppt/tableStyles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);

  // 5. Slide Master, Slide Layout & Theme
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
  </p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3600"/></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr marL="0" indent="0"><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>
    <p:otherStyle><a:lvl1pPr marL="0" indent="0"><a:defRPr sz="1400"/></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>`);

  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`);

  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`);

  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`);

  zip.file('ppt/theme/theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ASTRA Dark Theme">
  <a:themeElements>
    <a:clrScheme name="ASTRA">
      <a:dk1><a:srgbClr val="0B0C11"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="111622"/></a:dk2>
      <a:lt2><a:srgbClr val="E2ECF8"/></a:lt2>
      <a:accent1><a:srgbClr val="65D2E6"/></a:accent1>
      <a:accent2><a:srgbClr val="9A8FEF"/></a:accent2>
      <a:accent3><a:srgbClr val="7DFFB2"/></a:accent3>
      <a:accent4><a:srgbClr val="FFB454"/></a:accent4>
      <a:accent5><a:srgbClr val="FF5D6C"/></a:accent5>
      <a:accent6><a:srgbClr val="71B7D5"/></a:accent6>
      <a:hlink><a:srgbClr val="65D2E6"/></a:hlink>
      <a:folHlink><a:srgbClr val="9A8FEF"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="ASTRA Fonts">
      <a:majorFont><a:latin typeface="Consolas"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="ASTRA Formats">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`);

  // 6. Media files
  const spaceArtBytes = fs.existsSync(SPACE_ART_OUT)
    ? fs.readFileSync(SPACE_ART_OUT)
    : fs.readFileSync(UPLOADED_IMG);
  zip.file('ppt/media/slide1_space.jpg', spaceArtBytes);
  zip.file('ppt/media/slide4_flight.jpg', fs.readFileSync(path.join(ROOT, 'screenshots', 'mobile', '04-launch.jpg')));
  zip.file('ppt/media/slide4_build.jpg', fs.readFileSync(path.join(ROOT, 'screenshots', 'mobile', '03-build-parts.jpg')));
  zip.file('ppt/media/slide4_desktop.jpg', fs.readFileSync(path.join(ROOT, 'screenshots', 'desktop-build-pad.jpg')));
  const shotFlight = path.join(ROOT, 'screenshots', 'mobile', '04-launch.jpg');
  const shotBuild = path.join(ROOT, 'screenshots', 'mobile', '03-build-parts.jpg');
  zip.file('ppt/media/slide6_flight.jpg', fs.readFileSync(shotFlight));
  zip.file('ppt/media/slide6_build.jpg', fs.readFileSync(shotBuild));

  // 7. Write slides & slide relationships
  slides.forEach((xml, idx) => {
    const num = idx + 1;
    zip.file(`ppt/slides/slide${num}.xml`, xml);
    const imgRel = (id, target) => `
  <Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${target}"/>`;
    const extraRel = num === 1
      ? imgRel('rId2', 'slide1_space.jpg')
      : num === 4
        ? imgRel('rId2', 'slide4_flight.jpg') + imgRel('rId3', 'slide4_build.jpg') + imgRel('rId4', 'slide4_desktop.jpg')
        : '';
    zip.file(`ppt/slides/_rels/slide${num}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${extraRel}
</Relationships>`);
  });

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(PPTX_OUT, buf);
  fs.writeFileSync(PPT_OUT, buf);
  console.log(`Wrote 7-slide PPTX (${(buf.length / 1024).toFixed(1)} KB) -> ${PPTX_OUT}`);
  console.log(`Wrote 7-slide PPT  (${(buf.length / 1024).toFixed(1)} KB) -> ${PPT_OUT}`);
}

await generatePptx();
