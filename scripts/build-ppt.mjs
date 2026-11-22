import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const ROOT = 'c:/Users/medha/Desktop/Hackathons/Astra';
const UPLOADED_IMG = 'C:/Users/medha/.gemini/antigravity/brain/2ac306fa-c208-42b6-a311-cfae006f5da8/.user_uploaded/media_1795310052170_146e3f85.jpg';
const SPACE_ART_OUT = path.join(ROOT, 'public', 'slide1_space_panel.jpg');
const PPTX_OUT = path.join(ROOT, 'ASTRA_Spaceflight_Presentation.pptx');

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
          lIns="${inToEmu(padL)}" rIns="${inToEmu(padR)}" tIns="${inToEmu(padT)}" bIns="${inToEmu(padB)}"/>
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
      text: `0${slideNum} / 07`,
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
// SLIDE 2: Problem Statement & Dual-Domain Vision
// ===========================================================================
function buildSlide2() {
  const s = [];
  s.push(slideChrome({
    slideNum: 2,
    kicker: 'PROBLEM & DUAL-DOMAIN VISION',
    title: 'Bridging Desktop Rocket CAD & Interactive Spaceflight',
    subtitle: 'Why student rocketry teams and space enthusiasts need a unified 3D physics sandbox on Web & Mobile.',
  }));

  // Left column: 3 Problem Cards
  s.push(textBox({
    x: 0.65, y: 1.72, w: 5.8, h: 0.3,
    padL: 0, padT: 0,
    paragraphs: [{ text: 'THE GAPS IN EXISTING TOOLS', size: 11, bold: true, color: C.purple, font: 'Consolas', spc: 180 }],
  }));

  const problems = [
    {
      num: '01',
      title: 'Desktop-Bound, 2D Rocket CAD',
      desc: 'Student rocket teams design in OpenRocket (.ork), which is locked to desktop Java, offers only static 2D schematics, and cannot run on phones at the launch pad.',
      color: C.red,
    },
    {
      num: '02',
      title: 'Opaque Flight Failures',
      desc: 'When a design tumbles, weathercocks, or shreds fins, raw CSV plots do not show 3D force vectors (CG vs CP) or explain which part failed and how to fix it.',
      color: C.amber,
    },
    {
      num: '03',
      title: 'Disconnected ISRO & Deep-Space Data',
      desc: 'Existing mobile space games use arcade physics, while real ISRO mission telemetry (LVM3-M4, Chandrayaan-3, RH-200) sits in static tables instead of playable 3D worlds.',
      color: C.cyan,
    },
  ];

  problems.forEach((p, idx) => {
    const y = 2.08 + idx * 1.56;
    s.push(rectShape({ x: 0.65, y, w: 5.85, h: 1.40, fill: C.card, line: C.border, radius: 12000 }));
    s.push(rectShape({ x: 0.65, y, w: 0.08, h: 1.40, fill: p.color }));
    s.push(textBox({
      x: 0.88, y: y + 0.12, w: 0.55, h: 0.35,
      padL: 0, padT: 0,
      paragraphs: [{ text: p.num, size: 14, bold: true, color: p.color, font: 'Consolas' }],
    }));
    s.push(textBox({
      x: 1.40, y: y + 0.10, w: 4.95, h: 1.20,
      padL: 0, padT: 0,
      paragraphs: [
        { text: p.title, size: 15, bold: true, color: C.white, font: 'Segoe UI', spaceAfterPt: 5 },
        { text: p.desc, size: 12, color: C.muted, font: 'Segoe UI', lineSpacingPct: 122 },
      ],
    }));
  });

  // Right column: Our Solution & Dual-Domain Merger
  s.push(textBox({
    x: 6.80, y: 1.72, w: 5.85, h: 0.3,
    padL: 0, padT: 0,
    paragraphs: [{ text: 'THE ASTRA SPACEFLIGHT SOLUTION', size: 11, bold: true, color: C.cyan, font: 'Consolas', spc: 180 }],
  }));

  // Domain 05 Card
  s.push(rectShape({ x: 6.80, y: 2.08, w: 5.88, h: 1.95, fill: C.cardAlt, line: C.borderCyan, lineWidthPt: 1.2, radius: 12000 }));
  s.push(textBox({
    x: 7.02, y: 2.20, w: 5.45, h: 1.75,
    padL: 0, padT: 0,
    paragraphs: [
      { text: 'DOMAIN 05 · MOON, MARS & DEEP-SPACE EXPLORATION', size: 10.5, bold: true, color: C.cyan, font: 'Consolas', spc: 150, spaceAfterPt: 4 },
      { text: 'Solar-System 3D Sandbox + Lunar Lander', size: 16.5, bold: true, color: C.white, font: 'Segoe UI', spaceAfterPt: 6 },
      { text: '• True-scale JPL Keplerian Solar System (Sun, 8 planets from Mercury to Neptune, Moon) with d3-celestial star catalog & time warp up to 100,000×.', size: 11.8, color: C.text, spaceAfterPt: 3 },
      { text: '• Interactive 6-DOF Powered Lunar Descent from 100 km perilune to touchdown with procedural boulder fields, slope hazard maps, and manual/autopilot guidance.', size: 11.8, color: C.text },
    ],
  }));

  // Domain 01 Card
  s.push(rectShape({ x: 6.80, y: 4.20, w: 5.88, h: 1.95, fill: C.cardAlt, line: C.borderPurple, lineWidthPt: 1.2, radius: 12000 }));
  s.push(textBox({
    x: 7.02, y: 4.32, w: 5.45, h: 1.75,
    padL: 0, padT: 0,
    paragraphs: [
      { text: 'DOMAIN 01 · INDIAN SPACE MISSIONS & SPACE DATA', size: 10.5, bold: true, color: C.purple, font: 'Consolas', spc: 150, spaceAfterPt: 4 },
      { text: 'Sriharikota Pad, ISRO Vehicles & Telemetry Validation', size: 16.5, bold: true, color: C.white, font: 'Segoe UI', spaceAfterPt: 6 },
      { text: '• Default launch complex at SDSC SHAR Sriharikota (13.72°N, 80.23°E) on a rotating WGS-84 ellipsoid Earth with local GMST sky alignment.', size: 11.8, color: C.text, spaceAfterPt: 3 },
      { text: '• Fly ISRO LVM3-M4 (Chandrayaan-3) to its 170 × 36,500 km GTO against 14 July 2023 flight timestamps, plus the 2-stage ISRO RH-200 Rohini sounding rocket.', size: 11.8, color: C.text },
    ],
  }));

  // Bottom highlight strip on right
  s.push(rectShape({ x: 6.80, y: 6.30, w: 5.88, h: 0.54, fill: C.card, line: C.border, radius: 12000 }));
  s.push(textBox({
    x: 6.95, y: 6.36, w: 5.6, h: 0.42,
    padL: 0, padT: 0, anchor: 'ctr',
    paragraphs: [{
      runs: [
        { text: 'ONE CODEBASE, TWO BUILDS: ', size: 11, bold: true, color: C.green, font: 'Consolas', spc: 120 },
        { text: 'Offline-first PWA Web App + Native Capacitor Android APK', size: 12, bold: true, color: C.white, font: 'Segoe UI' },
      ],
      align: 'ctr',
    }],
  }));

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 3: Four Integrated Gameplay & Engineering Modes
// ===========================================================================
function buildSlide3() {
  const s = [];
  s.push(slideChrome({
    slideNum: 3,
    kicker: 'PRODUCT EXPERIENCE  ·  BUILD · LAUNCH · EXPLORE · LAND',
    title: 'Four Integrated Modes in One 3D World',
    subtitle: 'From snapping airframe tubes together to orbital staging and lunar touchdown.',
  }));

  const modes = [
    {
      badge: 'MODE 01 · BUILD',
      title: '3D Rocket Builder & .ork CAD',
      accent: C.cyan,
      metrics: '40+ Real Parts  ·  8 Categories  ·  .ork Round-Trip',
      bullets: [
        'Drag-and-drop or tap-to-snap 3D assembly across Nose Cones, Body Tubes, Transitions, Fins, Motor Mounts, Parachutes, Payloads & Rings.',
        'Native OpenRocket (.ork zip/XML) & RASP (.eng) import and export — round-trip verified on geometry, mass, CG, CP, and CNα.',
        'Multi-stage decouplers, 2×/3×/4× radial strap-on boosters, cutaway internal X-ray view, and automatic Best / OK / Bad workmanship grading.',
      ],
    },
    {
      badge: 'MODE 02 · LAUNCH & DIAGNOSE',
      title: '6-DOF Pad Flight & Flaw Analyzer',
      accent: C.green,
      metrics: '2 ms RK4 Step  ·  20+ ThrustCurve Motors  ·  19-Flight Sweep',
      bullets: [
        'Barrowman aerodynamics (normal-force slope, CP per part, pitch damping, skin/base/pressure drag + transonic wave Cd) in an ISA atmosphere to 86 km.',
        'Rule-based Flaw Analyzer catches 11+ failure modes (Unstable, Over-stable, Fin Flutter, Hard Landing, Thermal/Pressure faults) with timestamps & fixes.',
        'Interactive replay pauses at each flaw and draws live 3D force arrows (Thrust, Drag, Normal force at CP, Weight at CG) plus a 19-flight wind/rail stress sweep.',
      ],
    },
    {
      badge: 'MODE 03 · ISRO MISSION',
      title: 'LVM3-M4 Orbital Ascent & Fault Lab',
      accent: C.purple,
      metrics: 'S200 + L110 + C25 Stages  ·  12 Live Health Bars  ·  IIP Track',
      bullets: [
        'Full 6-DOF orbital launcher from Sriharikota with closed-loop Linear-Tangent guidance, J2-J4 gravity harmonics, and vacuum-expanding two-cone exhaust plumes.',
        'Live event timeline compares simulated vs actual 14 July 2023 LVM3-M4 staging (S200 sep 126.7s vs 127.0s, L110 sep 307.1s vs 305.6s).',
        'Destructive Fault Injection Lab: test Gimbal Lock, Vikas Engine-Out, C25 Shutdown, Blocked Fairing Vent, or Tank Overpressure with live Bay of Bengal IIP impact rings.',
      ],
    },
    {
      badge: 'MODE 04 · DEEP SPACE & MOON',
      title: 'Shiv Shakti Lunar Powered Descent',
      accent: C.amber,
      metrics: '69.37°S, 32.35°E  ·  3-Nested Terrain Meshes  ·  Auto & Manual',
      bullets: [
        'Deorbit from a 100 km polar lunar orbit through Braking, Approach, and Terminal descent phases to the Chandrayaan-3 Shiv Shakti landing site.',
        'Multi-resolution lunar regolith heightfield (240 m rock-field, 1.6 km approach patch, full Moon globe) with real-time footpad slope & boulder hazard classification.',
        'Fly hands-on with touch/keyboard pitch, roll & throttle controls or watch closed-loop PD attitude + terminal descent guidance score your touchdown.',
      ],
    },
  ];

  modes.forEach((m, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.65 + col * 6.12;
    const y = 1.75 + row * 2.58;
    const w = 5.90;
    const h = 2.40;

    s.push(rectShape({ x, y, w, h, fill: C.card, line: C.border, radius: 12000 }));
    s.push(rectShape({ x, y, w, h: 0.06, fill: m.accent }));

    // Badge + metric pill row
    s.push(textBox({
      x: x + 0.22, y: y + 0.16, w: 2.3, h: 0.26,
      padL: 0, padT: 0,
      paragraphs: [{ text: m.badge, size: 10, bold: true, color: m.accent, font: 'Consolas', spc: 150 }],
    }));
    s.push(textBox({
      x: x + 2.4, y: y + 0.16, w: 3.3, h: 0.26,
      padL: 0, padR: 0, padT: 0,
      paragraphs: [{ text: m.metrics, size: 9.5, bold: true, color: C.muted, font: 'Consolas', align: 'r' }],
    }));

    // Title
    s.push(textBox({
      x: x + 0.22, y: y + 0.44, w: 5.46, h: 0.36,
      padL: 0, padT: 0,
      paragraphs: [{ text: m.title, size: 16.5, bold: true, color: C.white, font: 'Segoe UI' }],
    }));

    // Bullets
    s.push(textBox({
      x: x + 0.22, y: y + 0.84, w: 5.46, h: 1.48,
      padL: 0, padT: 0,
      paragraphs: m.bullets.map((b) => ({
        text: `▸  ${b}`,
        size: 11.2,
        color: C.text,
        font: 'Segoe UI',
        lineSpacingPct: 118,
        spaceAfterPt: 5,
      })),
    }));
  });

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 4: Dual Physics Engines & System Architecture
// ===========================================================================
function buildSlide4() {
  const s = [];
  s.push(slideChrome({
    slideNum: 4,
    kicker: 'SYSTEM ARCHITECTURE & SIMULATION CORE',
    title: 'Dual 6-DOF Physics Engines, One Unified FlightRecord Contract',
    subtitle: 'Decoupling high-rate aerodynamic & orbital solvers from 60 FPS floating-origin WebGL rendering.',
  }));

  // Top Layer: App UI & Interactive Controls
  s.push(rectShape({ x: 0.65, y: 1.75, w: 12.03, h: 0.88, fill: C.cardAlt, line: C.borderCyan, radius: 10000 }));
  s.push(textBox({
    x: 0.85, y: 1.83, w: 11.6, h: 0.72,
    padL: 0, padT: 0,
    paragraphs: [
      {
        runs: [
          { text: 'PRESENTATION & HUD LAYER  (src/app + landing.html)   ', size: 10.5, bold: true, color: C.cyan, font: 'Consolas', spc: 140 },
          { text: 'Unified .sfb-root Glass UI · Desktop & 44px Mobile Touch HUD', size: 10.5, color: C.muted, font: 'Consolas' },
        ],
        spaceAfterPt: 4,
      },
      {
        text: 'Mode Switcher  ·  3D Builder Inspector  ·  Flight Telemetry Strip  ·  Flaw & Health Panels  ·  Interactive Timeline Scrubber  ·  1×–100,000× Time Warp',
        size: 12.5, bold: true, color: C.white, font: 'Segoe UI',
      },
    ],
  }));

  // Middle Left: Suborbital / Model Rocket Engine
  s.push(rectShape({ x: 0.65, y: 2.82, w: 3.85, h: 2.65, fill: C.card, line: C.border, radius: 10000 }));
  s.push(rectShape({ x: 0.65, y: 2.82, w: 3.85, h: 0.06, fill: C.green }));
  s.push(textBox({
    x: 0.85, y: 2.98, w: 3.45, h: 2.40,
    padL: 0, padT: 0,
    paragraphs: [
      { text: 'ENGINE A · DESIGN & SOUNDING SIM', size: 10, bold: true, color: C.green, font: 'Consolas', spc: 140, spaceAfterPt: 3 },
      { text: 'Barrowman 6-DOF (src/physics)', size: 15, bold: true, color: C.white, spaceAfterPt: 6 },
      { text: '• Fixed 2 ms RK4 integration with quaternion attitude & dynamic CG/inertia as motors burn.', size: 11.2, color: C.text, spaceAfterPt: 4 },
      { text: '• Per-part normal force (CNα) & CP, body lift, pitch damping, skin/base/pressure + transonic wave drag.', size: 11.2, color: C.text, spaceAfterPt: 4 },
      { text: '• Multi-stage separation, delayed ignition, dual parachute recovery, wind gusts & 11+ flaw rules.', size: 11.2, color: C.text },
    ],
  }));

  // Middle Center: Shared Contract & Frame Adapter
  s.push(rectShape({ x: 4.74, y: 2.82, w: 3.85, h: 2.65, fill: C.cardAlt, line: C.borderPurple, lineWidthPt: 1.3, radius: 10000 }));
  s.push(rectShape({ x: 4.74, y: 2.82, w: 3.85, h: 0.06, fill: C.purple }));
  s.push(textBox({
    x: 4.94, y: 2.98, w: 3.45, h: 2.40,
    padL: 0, padT: 0,
    paragraphs: [
      { text: 'BRIDGE · WEB WORKER & CONTRACT', size: 10, bold: true, color: C.purple, font: 'Consolas', spc: 140, spaceAfterPt: 3 },
      { text: 'FlightRecord + ECI Adapter', size: 15, bold: true, color: C.white, spaceAfterPt: 6 },
      { text: '• Non-blocking Web Worker computes full orbital ascents off-thread and streams FlightRecord samples.', size: 11.2, color: C.text, spaceAfterPt: 4 },
      { text: '• Exact orthogonal frame map: Z-up ECI (body +X nose) → Y-up App (body +Y nose) via (x, z, -y) & qApp = Cq·q·Bq.', size: 11.2, color: C.text, spaceAfterPt: 4 },
      { text: '• Snapshot interpolator drives deterministic forward/backward scrubbing, staging & trajectory draw ranges.', size: 11.2, color: C.text },
    ],
  }));

  // Middle Right: Orbital & Lunar Engine
  s.push(rectShape({ x: 8.83, y: 2.82, w: 3.85, h: 2.65, fill: C.card, line: C.border, radius: 10000 }));
  s.push(rectShape({ x: 8.83, y: 2.82, w: 3.85, h: 0.06, fill: C.amber }));
  s.push(textBox({
    x: 9.03, y: 2.98, w: 3.45, h: 2.40,
    padL: 0, padT: 0,
    paragraphs: [
      { text: 'ENGINE B · ORBITAL & LUNAR SIM', size: 10, bold: true, color: C.amber, font: 'Consolas', spc: 140, spaceAfterPt: 3 },
      { text: 'Orbital 6-DOF (rocket-physics + lunar)', size: 15, bold: true, color: C.white, spaceAfterPt: 6 },
      { text: '• WGS-84 rotating Earth, J2/J3/J4 harmonics, US Standard Atmosphere 1976 to 1000 km & Sutton-Graves heating.', size: 11.2, color: C.text, spaceAfterPt: 4 },
      { text: '• Linear-Tangent closed-loop guidance, oblateness apogee compensation, Lambert transfer & Dormand-Prince RK5(4).', size: 11.2, color: C.text, spaceAfterPt: 4 },
      { text: '• FaultMonitor tracks 12 structural/thermal/propulsion health channels (ullage pressure, cavitation, skin temp).', size: 11.2, color: C.text },
    ],
  }));

  // Bottom Layer: 3D Rendering & Cross-Platform Build
  s.push(rectShape({ x: 0.65, y: 5.66, w: 12.03, h: 1.15, fill: C.card, line: C.border, radius: 10000 }));
  s.push(textBox({
    x: 0.85, y: 5.76, w: 11.6, h: 0.96,
    padL: 0, padT: 0,
    paragraphs: [
      {
        runs: [
          { text: '3D FLOATING-ORIGIN RENDERER  (Three.js r170 · Logarithmic Depth Buffer)   ', size: 10.5, bold: true, color: C.cyan, font: 'Consolas', spc: 140 },
          { text: 'Zero jitter from 1 mm rail buttons to 10⁹ km planetary orbits', size: 10.5, color: C.green, font: 'Consolas' },
        ],
        spaceAfterPt: 5,
      },
      {
        text: '• Procedural Mesh Pipeline: Exact geometry from .ork / VehicleSpec · Cutaway internals · Two-cone vacuum-expanding plumes · Booster & fairing separation kinematics',
        size: 11.5, color: C.text, spaceAfterPt: 3,
      },
      {
        text: '• Single TypeScript + Vite Build: Offline Service Worker PWA (dist/) + Capacitor 8 Android APK (android/) with native file export & 60 FPS WebView performance',
        size: 11.5, color: C.text,
      },
    ],
  }));

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 5: Engineering Rigor, ISRO Benchmarks & Validation
// ===========================================================================
function buildSlide5() {
  const s = [];
  s.push(slideChrome({
    slideNum: 5,
    kicker: 'VALIDATION & BENCHMARKS  ·  1,037 AUTOMATED UNIT TESTS',
    title: 'Verified Against OpenRocket & ISRO LVM3-M4 Flight Data',
    subtitle: 'Every solver, frame transformation, and 3D mesh is pinned against analytical or real-flight benchmarks.',
  }));

  // Top Metric Banner (4 KPI Pill Cards)
  const kpis = [
    { val: '1,037', label: 'UNIT TESTS PASSING', sub: '797 App + 240 Orbital Engine', color: C.green },
    { val: '< 4.5%', label: 'OPENROCKET APOGEE ERR', sub: 'Well inside 10% target band', color: C.cyan },
    { val: '0.3 s', label: 'LVM3 S200 SEP DELTA', sub: '126.7 s sim vs 127.0 s ISRO flight', color: C.purple },
    { val: '67 / 67', label: '3D MESH AUDIT DESIGNS', sub: '62 mock + 5 real .ork files verified', color: C.amber },
  ];

  kpis.forEach((k, i) => {
    const x = 0.65 + i * 3.06;
    s.push(rectShape({ x, y: 1.72, w: 2.88, h: 1.08, fill: C.cardAlt, line: C.border, radius: 12000 }));
    s.push(textBox({
      x: x + 0.12, y: 1.78, w: 2.64, h: 0.96,
      padL: 0, padR: 0, padT: 0,
      paragraphs: [
        { text: k.val, size: 24, bold: true, color: k.color, font: 'Consolas', align: 'ctr', spaceAfterPt: 2 },
        { text: k.label, size: 9.5, bold: true, color: C.white, font: 'Consolas', align: 'ctr', spc: 120, spaceAfterPt: 2 },
        { text: k.sub, size: 9.5, color: C.muted, font: 'Segoe UI', align: 'ctr' },
      ],
    }));
  });

  // Left Table Card: OpenRocket Validation
  s.push(rectShape({ x: 0.65, y: 2.98, w: 5.88, h: 3.82, fill: C.card, line: C.border, radius: 12000 }));
  s.push(rectShape({ x: 0.65, y: 2.98, w: 5.88, h: 0.06, fill: C.cyan }));
  s.push(textBox({
    x: 0.88, y: 3.12, w: 5.42, h: 0.55,
    padL: 0, padT: 0,
    paragraphs: [
      { text: 'BENCHMARK 1 · OPENROCKET 6-DOF VALIDATION', size: 10, bold: true, color: C.cyan, font: 'Consolas', spc: 150, spaceAfterPt: 2 },
      { text: 'Multi-Flight Comparison Against Stored OpenRocket Sims', size: 14.5, bold: true, color: C.white },
    ],
  }));

  const orRows = [
    ['Metric / Reference Design', 'Flights', 'Measured Error Range', 'Target'],
    ['Design 1: Apogee Altitude', '5 sims', '-1.9 %  to  -4.3 %', '< 10 %'],
    ['Design 1: Max Velocity', '5 sims', '-2.2 %  to  -2.9 %', '< 10 %'],
    ['Design 1: Time to Apogee', '5 sims', 'Within  ±1.1 %', '< 10 %'],
    ['Design 1: Rail Exit Speed', '5 sims', '-1.9 %  to  -3.4 %', '< 10 %'],
    ['Design 2 (Dual-Deploy, Mach 1.1): Apogee', '6 sims', '-1.0 %  to  -5.4 %', '< 10 %'],
    ['Design 2 (Dual-Deploy, Mach 1.1): Max Speed', '6 sims', '-0.1 %  to  -2.3 %', '< 10 %'],
    ['Design 2 (Dual-Deploy, Mach 1.1): Rail Exit', '6 sims', '-3.1 %  to  +0.6 %', '< 10 %'],
  ];

  orRows.forEach((r, idx) => {
    const ry = 3.74 + idx * 0.36;
    const isHdr = idx === 0;
    if (isHdr) {
      s.push(rectShape({ x: 0.85, y: ry, w: 5.48, h: 0.32, fill: C.cardAlt }));
    } else if (idx % 2 === 0) {
      s.push(rectShape({ x: 0.85, y: ry, w: 5.48, h: 0.32, fill: C.bgDeep }));
    }
    const colX = [0.92, 3.38, 4.10, 5.62];
    const colW = [2.42, 0.68, 1.48, 0.68];
    r.forEach((cell, cIdx) => {
      s.push(textBox({
        x: colX[cIdx], y: ry + 0.04, w: colW[cIdx], h: 0.26,
        padL: 0, padR: 0, padT: 0,
        paragraphs: [{
          text: cell,
          size: isHdr ? 9.5 : 10,
          bold: isHdr || cIdx === 2,
          color: isHdr ? C.cyan : (cIdx === 2 ? C.green : C.text),
          font: cIdx >= 1 ? 'Consolas' : 'Segoe UI',
          align: cIdx >= 1 ? 'ctr' : 'l',
        }],
      }));
    });
  });

  // Right Table Card: ISRO LVM3-M4 (Chandrayaan-3) Flight & Fault Validation
  s.push(rectShape({ x: 6.80, y: 2.98, w: 5.88, h: 3.82, fill: C.card, line: C.border, radius: 12000 }));
  s.push(rectShape({ x: 6.80, y: 2.98, w: 5.88, h: 0.06, fill: C.purple }));
  s.push(textBox({
    x: 7.02, y: 3.12, w: 5.42, h: 0.55,
    padL: 0, padT: 0,
    paragraphs: [
      { text: 'BENCHMARK 2 · ISRO LVM3-M4 (14 JULY 2023) & FAULT LAB', size: 10, bold: true, color: C.purple, font: 'Consolas', spc: 150, spaceAfterPt: 2 },
      { text: 'Simulated Ascent vs Actual Telemetry & Failure Cases', size: 14.5, bold: true, color: C.white },
    ],
  }));

  const isroRows = [
    ['LVM3-M4 Event / Scenario', 'Astra Sim', 'ISRO Actual / Ref', 'Outcome'],
    ['L110 Core Vikas Ignition', 'T+ 108.0 s', 'T+ 108.1 s', 'Nominal (-0.1 s)'],
    ['S200 Solid Booster Separation', 'T+ 126.7 s', 'T+ 127.0 s', 'Nominal (-0.3 s)'],
    ['L110 Core Stage Separation', 'T+ 307.1 s', 'T+ 305.6 s', 'Nominal (+1.5 s)'],
    ['C25 Cryogenic Stage Ignition', 'T+ 309.5 s', 'T+ 308.0 s', 'Nominal (+1.5 s)'],
    ['C25 Cutoff & GTO Insertion', '170 × 36,501 km', '170 × 36,500 km', 'Target Reached'],
    ['Fault: 1 Vikas Engine Out', 'T+ 1090.2 s', 'Closed-Loop Comp.', 'GTO Reached'],
    ['Fault: Gimbal Lock / Vent Blocked', 'T+ 41.5 s / 32.9 s', 'Structural Breakup', 'Bay of Bengal IIP'],
  ];

  isroRows.forEach((r, idx) => {
    const ry = 3.74 + idx * 0.36;
    const isHdr = idx === 0;
    if (isHdr) {
      s.push(rectShape({ x: 7.00, y: ry, w: 5.48, h: 0.32, fill: C.cardAlt }));
    } else if (idx % 2 === 0) {
      s.push(rectShape({ x: 7.00, y: ry, w: 5.48, h: 0.32, fill: C.bgDeep }));
    }
    const colX = [7.06, 9.36, 10.38, 11.45];
    const colW = [2.26, 0.98, 1.04, 1.00];
    r.forEach((cell, cIdx) => {
      const isBreakup = idx === 7 && cIdx === 3;
      s.push(textBox({
        x: colX[cIdx], y: ry + 0.04, w: colW[cIdx], h: 0.26,
        padL: 0, padR: 0, padT: 0,
        paragraphs: [{
          text: cell,
          size: isHdr ? 9.5 : 9.8,
          bold: isHdr || cIdx === 1,
          color: isHdr ? C.purple : (isBreakup ? C.amber : (cIdx === 3 ? C.green : C.text)),
          font: cIdx >= 1 ? 'Consolas' : 'Segoe UI',
          align: cIdx >= 1 ? 'ctr' : 'l',
        }],
      }));
    });
  });

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 6: Team Members & Contributions (Dedicated Team Slide requested by user)
// ===========================================================================
function buildSlide6() {
  const s = [];
  s.push(slideChrome({
    slideNum: 6,
    kicker: 'THE TEAM BEHIND ASTRA SPACEFLIGHT',
    title: 'Team Members & Engineering Ownership',
    subtitle: 'Four builders uniting 6-DOF flight dynamics, orbital guidance, 3D WebGL graphics, and mobile UX.',
  }));

  const members = [
    {
      initials: 'RP',
      name: 'Ridhima Pandey',
      role: 'Team Lead · Product Architecture & 3D Rocket Builder',
      accent: C.purple,
      tags: 'System Architecture  ·  3D Builder & Snap Engine  ·  .ork CAD Export',
      points: [
        'Led product vision merging Domain 05 (Deep-Space Exploration) and Domain 01 (Indian Space Missions) into one unified 3D platform.',
        'Architected the 40+ preset 3D Rocket Builder, raycast part picking, live property inspector, multi-stage decouplers, and radial boosters.',
        'Built the round-trip OpenRocket (.ork) exporter, engineering challenges system, and unified .sfb-root glass UI token system.',
      ],
    },
    {
      initials: 'VA',
      name: 'Vidit Agarwal',
      role: 'Aerodynamics & 6-DOF Suborbital Physics Lead',
      accent: C.cyan,
      tags: 'Barrowman Aerodynamics  ·  OpenRocket Parser  ·  Flaw Analyzer',
      points: [
        'Engineered the OpenRocket (.ork zip/gzip/XML) parser, RASP (.eng) ThrustCurve motor table, and dynamic per-component mass/CG/inertia solver.',
        'Implemented the 2 ms RK4 6-DOF Barrowman aerodynamics engine with transonic wave drag, multi-stage ignition, and dual parachute recovery.',
        'Created the rule-based pre-flight & post-flight Flaw Analyzer, environmental fault diagnostics, and 19-flight parameter stress sweep.',
      ],
    },
    {
      initials: 'KJ',
      name: 'Kshitij Jha',
      role: 'Orbital Mechanics, GNC & ISRO Mission Mode Lead',
      accent: C.green,
      tags: 'LVM3-M4 GNC Autopilot  ·  12-Channel FaultMonitor  ·  Lunar Descent',
      points: [
        'Built the dependency-free rocket-physics orbital engine: WGS-84 rotating Earth, J2–J4 harmonics, Linear-Tangent guidance, and Lambert solver.',
        'Developed the 12-channel structural/thermal/propulsion FaultMonitor, destructive failure injection lab, and Instantaneous Impact Point (IIP) predictor.',
        'Implemented the 6-DOF Chandrayaan-3 Shiv Shakti lunar powered descent simulator with procedural boulder hazard maps and autopilot/manual controls.',
      ],
    },
    {
      initials: 'MK',
      name: 'Medhansh Khattar',
      role: '3D WebGL Rendering, Solar System & Mobile Lead',
      accent: C.amber,
      tags: 'Floating-Origin Three.js  ·  Mesh Quality Audit  ·  Android Capacitor APK',
      points: [
        'Built the floating-origin 3D rendering pipeline, logarithmic depth buffer solar system, GMST sky alignment, and d3-celestial constellation overlay.',
        'Crafted procedural 3D part geometry with Best/OK/Bad workmanship grading (verified across 67 designs), cutaway internals, and vacuum-expanding plumes.',
        'Delivered the LVM3 3D launch complex, staging kinematics, offline Service Worker PWA, and native Capacitor Android app with 44 px touch ergonomics.',
      ],
    },
  ];

  members.forEach((m, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.65 + col * 6.12;
    const y = 1.75 + row * 2.58;
    const w = 5.90;
    const h = 2.40;

    s.push(rectShape({ x, y, w, h, fill: C.card, line: C.border, radius: 12000 }));
    s.push(rectShape({ x, y, w: 0.08, h, fill: m.accent }));

    // Monogram Avatar Badge
    s.push(textBox({
      x: x + 0.24, y: y + 0.20, w: 0.64, h: 0.64,
      fill: C.cardAlt, line: m.accent, lineWidthPt: 1.5, radius: 22000,
      anchor: 'ctr', padL: 0, padR: 0, padT: 0, padB: 0,
      paragraphs: [{ text: m.initials, size: 16, bold: true, color: m.accent, font: 'Consolas', align: 'ctr' }],
    }));

    // Name & Role
    s.push(textBox({
      x: x + 1.02, y: y + 0.16, w: 4.70, h: 0.72,
      padL: 0, padT: 0,
      paragraphs: [
        { text: m.name, size: 17, bold: true, color: C.white, font: 'Segoe UI', spaceAfterPt: 2 },
        { text: m.role, size: 11.5, bold: true, color: m.accent, font: 'Segoe UI', spaceAfterPt: 3 },
        { text: m.tags, size: 9.2, color: C.muted, font: 'Consolas' },
      ],
    }));

    // Divider line
    s.push(rectShape({ x: x + 0.24, y: y + 0.96, w: 5.44, h: 0.012, fill: C.border }));

    // Contribution bullets
    s.push(textBox({
      x: x + 0.24, y: y + 1.04, w: 5.46, h: 1.30,
      padL: 0, padT: 0,
      paragraphs: m.points.map((pt) => ({
        text: `▸  ${pt}`,
        size: 10.6,
        color: C.text,
        font: 'Segoe UI',
        lineSpacingPct: 116,
        spaceAfterPt: 4,
      })),
    }));
  });

  return wrapSlideXml(s.join('\n'));
}

// ===========================================================================
// SLIDE 7: Impact, Roadmap & Live Demo Flow
// ===========================================================================
function buildSlide7() {
  const s = [];
  s.push(slideChrome({
    slideNum: 7,
    kicker: 'IMPACT, ROADMAP & LIVE DEMO',
    title: 'From Student Launch Pads to Interplanetary Missions',
    subtitle: 'Ready to play today in any browser or Android phone — built to scale across the solar system.',
  }));

  // Left Column: Who It Serves & Immediate Impact
  s.push(rectShape({ x: 0.65, y: 1.75, w: 3.85, h: 5.05, fill: C.card, line: C.border, radius: 12000 }));
  s.push(rectShape({ x: 0.65, y: 1.75, w: 3.85, h: 0.06, fill: C.cyan }));
  s.push(textBox({
    x: 0.88, y: 1.92, w: 3.40, h: 4.70,
    padL: 0, padT: 0,
    paragraphs: [
      { text: '01 · REAL-WORLD IMPACT', size: 10, bold: true, color: C.cyan, font: 'Consolas', spc: 150, spaceAfterPt: 4 },
      { text: 'Who Uses ASTRA Today', size: 16, bold: true, color: C.white, spaceAfterPt: 10 },

      { text: 'Student Rocketry Clubs & IN-SPACe Teams', size: 12.5, bold: true, color: C.cyan, spaceAfterPt: 3 },
      { text: 'Drop any OpenRocket (.ork) design on a phone at the launch field to check stability margin, rail exit speed, fin flutter, and wind sensitivity before lighting the motor.', size: 11, color: C.text, lineSpacingPct: 120, spaceAfterPt: 10 },

      { text: 'Aerospace Educators & STEM Labs', size: 12.5, bold: true, color: C.green, spaceAfterPt: 3 },
      { text: 'Teach Barrowman aerodynamics, 6-DOF attitude control, orbital staging, and lunar descent visually with live force vectors and destructive fault injection.', size: 11, color: C.text, lineSpacingPct: 120, spaceAfterPt: 10 },

      { text: 'ISRO Mission Enthusiasts', size: 12.5, bold: true, color: C.purple, spaceAfterPt: 3 },
      { text: 'Experience Indian spaceflight hands-on — from RH-200 sounding hops at Sriharikota to LVM3-M4 GTO insertion and Chandrayaan-3 touchdown.', size: 11, color: C.text, lineSpacingPct: 120 },
    ],
  }));

  // Center Column: Future Horizon (Mercury to Jupiter Roadmap)
  s.push(rectShape({ x: 4.74, y: 1.75, w: 3.85, h: 5.05, fill: C.card, line: C.border, radius: 12000 }));
  s.push(rectShape({ x: 4.74, y: 1.75, w: 3.85, h: 0.06, fill: C.purple }));
  s.push(textBox({
    x: 4.97, y: 1.92, w: 3.40, h: 4.70,
    padL: 0, padT: 0,
    paragraphs: [
      { text: '02 · ROADMAP TO JUPITER', size: 10, bold: true, color: C.purple, font: 'Consolas', spc: 150, spaceAfterPt: 4 },
      { text: 'Expanding the Mission Fleet', size: 16, bold: true, color: C.white, spaceAfterPt: 10 },

      { text: 'Phase A · Custom Liquid Orbital Builder', size: 12.5, bold: true, color: C.purple, spaceAfterPt: 3 },
      { text: 'Let players assemble custom kerolox, methalox, and hydrolox multi-stage orbital launchers in the 3D builder and fly them straight into the orbital engine.', size: 11, color: C.text, lineSpacingPct: 120, spaceAfterPt: 10 },

      { text: 'Phase B · PSLV, Gaganyaan & Mangalyaan', size: 12.5, bold: true, color: C.cyan, spaceAfterPt: 3 },
      { text: 'Add ISRO PSLV-XL, Gaganyaan crewed abort scenarios, and Mars Orbiter Mission (MOM) trans-Mars Lambert injection windows.', size: 11, color: C.text, lineSpacingPct: 120, spaceAfterPt: 10 },

      { text: 'Phase C · Mercury to Jupiter Transfers', size: 12.5, bold: true, color: C.amber, spaceAfterPt: 3 },
      { text: 'Unlock interactive gravity-assist trajectories across the rendered Solar System from Mercury and Venus aerocapture to Jovian moon tours.', size: 11, color: C.text, lineSpacingPct: 120 },
    ],
  }));

  // Right Column: Live Judge Walkthrough & Technical Summary
  s.push(rectShape({ x: 8.83, y: 1.75, w: 3.85, h: 5.05, fill: C.cardAlt, line: C.borderCyan, lineWidthPt: 1.3, radius: 12000 }));
  s.push(rectShape({ x: 8.83, y: 1.75, w: 3.85, h: 0.06, fill: C.green }));
  s.push(textBox({
    x: 9.06, y: 1.92, w: 3.40, h: 4.70,
    padL: 0, padT: 0,
    paragraphs: [
      { text: '03 · LIVE DEMO WALKTHROUGH', size: 10, bold: true, color: C.green, font: 'Consolas', spc: 150, spaceAfterPt: 4 },
      { text: '90-Second Judge Tour', size: 16, bold: true, color: C.white, spaceAfterPt: 10 },

      { text: 'Step 1 · Snap & Grade in 3D Builder', size: 12, bold: true, color: C.cyan, spaceAfterPt: 2 },
      { text: 'Assemble a 2-stage rocket or drop an .ork file, toggle internal cutaway, and inspect live CG/CP stability.', size: 10.8, color: C.text, spaceAfterPt: 8 },

      { text: 'Step 2 · Launch & Inspect Force Vectors', size: 12, bold: true, color: C.green, spaceAfterPt: 2 },
      { text: 'Fly from Sriharikota, pause at a detected flaw with 3D Thrust/Drag/Lift arrows, and run the 19-flight sweep.', size: 10.8, color: C.text, spaceAfterPt: 8 },

      { text: 'Step 3 · Fly LVM3-M4 & Inject a Fault', size: 12, bold: true, color: C.purple, spaceAfterPt: 2 },
      { text: 'Watch S200 & L110 staging to GTO, then trigger a Gimbal Lock or Vikas Engine-Out to see live health & IIP impact.', size: 10.8, color: C.text, spaceAfterPt: 8 },

      { text: 'Step 4 · Touch Down at Shiv Shakti Point', size: 12, bold: true, color: C.amber, spaceAfterPt: 2 },
      { text: 'Pilot the lunar lander down to 69.37°S, 32.35°E avoiding boulder hazards for a soft landing score.', size: 10.8, color: C.text, spaceAfterPt: 12 },

      { text: 'THANK YOU · QUESTIONS & LIVE FLIGHT', size: 11, bold: true, color: C.white, font: 'Consolas', align: 'ctr', spc: 120 },
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

  // 7. Write slides & slide relationships
  slides.forEach((xml, idx) => {
    const num = idx + 1;
    zip.file(`ppt/slides/slide${num}.xml`, xml);
    const extraRel = num === 1
      ? `\n  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/slide1_space.jpg"/>`
      : '';
    zip.file(`ppt/slides/_rels/slide${num}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${extraRel}
</Relationships>`);
  });

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(PPTX_OUT, buf);
  console.log(`Wrote 7-slide PPTX (${(buf.length / 1024).toFixed(1)} KB) -> ${PPTX_OUT}`);
}

await generatePptx();
