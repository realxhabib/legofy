// iPhone photos are often HEIC, which browsers can't read themselves; they're decoded with libheif.
(function (L) {
  // Decode every image in a HEIC/HEIF file to canvases (a spatial photo holds two; the first is used).
  L.decodeHeic = async function (libheif, bytes) {
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(bytes);
    const canvases = [];
    for (const image of images) {
      const w = image.get_width(), h = image.get_height();
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      const data = g.createImageData(w, h);
      await new Promise((resolve, reject) => image.display(data, (out) => (out ? resolve() : reject(new Error('Could not decode the HEIC image.')))));
      g.putImageData(data, 0, 0);
      canvases.push(c);
    }
    return canvases;
  };
})(window.Legofy = window.Legofy || {});
