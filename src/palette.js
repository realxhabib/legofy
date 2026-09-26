// LEGO colours: name, fallback sRGB, and BrickLink colour id (for ordering the parts on BrickLink).
(function (L) {
  const COLORS = [
    ['White', '#F4F4F4', 1],
    ['Light Bluish Gray', '#A0A5A9', 86],
    ['Dark Bluish Gray', '#6C6E68', 85],
    ['Black', '#1B2A34', 11],
    ['Red', '#C91A09', 5],
    ['Dark Red', '#720E0F', 59],
    ['Coral', '#FF698F', 220],
    ['Bright Pink', '#E4ADC8', 104],
    ['Dark Pink', '#C870A0', 47],
    ['Magenta', '#923978', 71],
    ['Orange', '#FE8A18', 4],
    ['Dark Orange', '#A95500', 68],
    ['Bright Light Orange', '#F8BB3D', 110],
    ['Yellow', '#F2CD37', 3],
    ['Bright Light Yellow', '#FFF03A', 103],
    ['Lime', '#BBE90B', 34],
    ['Bright Green', '#4B9F4A', 36],
    ['Green', '#237841', 6],
    ['Dark Green', '#184632', 80],
    ['Olive Green', '#9B9A5A', 155],
    ['Sand Green', '#A0BCAC', 48],
    ['Light Aqua', '#ADC3C0', 152],
    ['Dark Turquoise', '#008F9B', 39],
    ['Medium Azure', '#36AEBF', 156],
    ['Dark Azure', '#078BC9', 153],
    ['Bright Light Blue', '#9FC3E9', 105],
    ['Medium Blue', '#5A93DB', 42],
    ['Blue', '#0055BF', 7],
    ['Dark Blue', '#0A3463', 63],
    ['Sand Blue', '#6074A1', 55],
    ['Medium Lavender', '#AC78BA', 157],
    ['Dark Purple', '#3F3691', 89],
    ['Light Nougat', '#F6D7B3', 90],
    ['Nougat', '#D09168', 28],
    ['Medium Nougat', '#AA7D55', 150],
    ['Tan', '#E4CD9E', 2],
    ['Dark Tan', '#958A73', 69],
    ['Reddish Brown', '#582A12', 88],
  ];

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  // sRGB (0-255) -> CIE L*a*b* (D65), used for perceptual color matching.
  function rgbToLab(r, g, b) {
    const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  function shade([r, g, b], amt) {
    // amt > 0 lightens toward white, amt < 0 darkens toward black
    const t = amt < 0 ? 0 : 255;
    const p = Math.abs(amt);
    const m = (c) => Math.round(c + (t - c) * p);
    return `rgb(${m(r)},${m(g)},${m(b)})`;
  }

  L.PALETTE = COLORS.map(([name, fallbackHex, bricklinkId], id) => {
    // Official colour values and ids from Rebrickable when available (src/parts-data.js).
    const data = (L.COLOR_DATA || {})[name];
    const hex = data ? data.rgb.toUpperCase() : fallbackHex;
    const rgb = hexToRgb(hex);
    return {
      id, name, hex, rgb,
      rebrickableId: data ? data.id : null,
      bricklinkId,
      // Footprints ("1x4", "2x2"…) really produced in this colour, for bricks and for plates.
      made: data ? { brick: new Set(data.brick), plate: new Set(data.plate) } : null,
      lab: rgbToLab(...rgb),
      css: hex,
      light: shade(rgb, 0.35),
      dark: shade(rgb, -0.3),
      darker: shade(rgb, -0.45),
    };
  });

  L.rgbToLab = rgbToLab;
})(window.Legofy = window.Legofy || {});
