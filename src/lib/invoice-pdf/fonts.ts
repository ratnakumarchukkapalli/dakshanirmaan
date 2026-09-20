import 'server-only';
import path from 'node:path';
import { Font } from '@react-pdf/renderer';

// Noto Sans (SIL Open Font License, see src/assets/fonts/OFL-LICENSE.txt). The Latin file has the
// letters and digits; the Latin-Extended file is the one that carries the Rupee sign, and a font
// cannot borrow glyphs from another, so the sign is set in its own family.
const dir = path.join(process.cwd(), 'src', 'assets', 'fonts');
let registered = false;

export const BODY_FONT = 'NotoSans';
export const RUPEE_FONT = 'NotoSansRupee';

export function registerFonts() {
  if (registered) return;
  registered = true;
  Font.register({
    family: BODY_FONT,
    fonts: [
      { src: path.join(dir, 'noto-sans-latin-400-normal.woff'), fontWeight: 400 },
      { src: path.join(dir, 'noto-sans-latin-700-normal.woff'), fontWeight: 700 },
    ],
  });
  Font.register({
    family: RUPEE_FONT,
    fonts: [
      { src: path.join(dir, 'noto-sans-latin-ext-400-normal.woff'), fontWeight: 400 },
      { src: path.join(dir, 'noto-sans-latin-ext-700-normal.woff'), fontWeight: 700 },
    ],
  });
  // Words are never hyphenated across lines on a tax invoice.
  Font.registerHyphenationCallback((word) => [word]);
}
