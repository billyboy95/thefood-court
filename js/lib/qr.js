import { renderSVG } from '../vendor/uqr.js';

export function qrSvg(text) {
  return renderSVG(String(text || 'FC'), {
    pixelSize: 8,
    whiteColor: '#ffffff',
    blackColor: '#0b1f3a',
  });
}
