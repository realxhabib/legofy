// LEGO plate colors (approximate sRGB values of real, currently produced colors).
(function (L) {
  const COLORS = [
    ['White', '#F4F4F4'],
    ['Light Bluish Gray', '#A0A5A9'],
    ['Dark Bluish Gray', '#6C6E68'],
    ['Black', '#1B2A34'],
    ['Red', '#C91A09'],
    ['Dark Red', '#720E0F'],
    ['Coral', '#FF698F'],
    ['Bright Pink', '#E4ADC8'],
    ['Dark Pink', '#C870A0'],
    ['Magenta', '#923978'],
    ['Orange', '#FE8A18'],
    ['Dark Orange', '#A95500'],
    ['Bright Light Orange', '#F8BB3D'],
    ['Yellow', '#F2CD37'],
    ['Bright Light Yellow', '#FFF03A'],
    ['Lime', '#BBE90B'],
    ['Bright Green', '#4B9F4A'],
    ['Green', '#237841'],
    ['Dark Green', '#184632'],
    ['Olive Green', '#9B9A5A'],
    ['Sand Green', '#A0BCAC'],
    ['Light Aqua', '#ADC3C0'],
    ['Dark Turquoise', '#008F9B'],
    ['Medium Azure', '#36AEBF'],
    ['Dark Azure', '#078BC9'],
    ['Bright Light Blue', '#9FC3E9'],
    ['Medium Blue', '#5A93DB'],
    ['Blue', '#0055BF'],
    ['Dark Blue', '#0A3463'],
    ['Sand Blue', '#6074A1'],
    ['Medium Lavender', '#AC78BA'],
    ['Dark Purple', '#3F3691'],
    ['Light Nougat', '#F6D7B3'],
    ['Nougat', '#D09168'],
    ['Medium Nougat', '#AA7D55'],
    ['Tan', '#E4CD9E'],
    ['Dark Tan', '#958A73'],
    ['Reddish Brown', '#582A12'],
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

  L.PALETTE = COLORS.map(([name, fallbackHex], id) => {
    // Official colour values and ids from Rebrickable when available (src/parts-data.js).
    const data = (L.COLOR_DATA || {})[name];
    const hex = data ? data.rgb.toUpperCase() : fallbackHex;
    const rgb = hexToRgb(hex);
    return {
      id, name, hex, rgb,
      rebrickableId: data ? data.id : null,
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
