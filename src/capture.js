// Guided walk-around capture: the camera asks for the front, back and left side of the object in turn
// and takes one photo of each with a tap. Those photos go to the AI together, so the back and sides come
// out as they really are.
(function (L) {
  // The AI takes the front, back and left side together (the multi-view model needs all three).
  const STEPS = [
    { view: 'front', name: 'Front', tip: 'Face the front of the object and fit all of it in the frame.' },
    { view: 'back', name: 'Back', tip: 'Walk round to the back and take the same shot from behind.' },
    { view: 'left', name: 'Left side', tip: 'Now go to its left side and face it square on.' },
  ];

  // Opens the capture screen. Resolves with { front, back?, left? } (canvases), or null if
  // it's cancelled.
  L.walkAround = function () {
    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.className = 'capture-screen';
      root.innerHTML = `
        <video playsinline muted autoplay></video>
        <div class="cap-frame" aria-hidden="true"></div>
        <div class="cap-top">
          <p class="cap-step"></p>
          <p class="cap-tip"></p>
        </div>
        <div class="cap-bottom">
          <div class="cap-thumbs">${STEPS.map((s, i) => `<button type="button" class="cap-thumb" data-i="${i}"><span>${s.name}</span></button>`).join('')}</div>
          <div class="cap-buttons">
            <button type="button" class="cap-cancel">Cancel</button>
            <button type="button" class="cap-shutter" aria-label="Take photo"></button>
            <button type="button" class="cap-skip">Skip</button>
          </div>
          <button type="button" class="cap-done" disabled>Use these photos</button>
        </div>
        <p class="cap-error" hidden></p>`;
      document.body.appendChild(root);
      document.body.classList.add('capturing');
      const $ = (s) => root.querySelector(s);
      const video = $('video');
      const shots = {};
      let step = 0, stream = null;

      const show = () => {
        const s = STEPS[step];
        $('.cap-step').textContent = `${step + 1} of ${STEPS.length} · ${s.name}`;
        $('.cap-tip').textContent = s.tip;
        $('.cap-skip').disabled = step === 0 && !shots.front;
        $('.cap-skip').textContent = step === STEPS.length - 1 ? 'Finish' : 'Skip';
        $('.cap-done').disabled = !shots.front;
        root.querySelectorAll('.cap-thumb').forEach((t, i) => {
          const shot = shots[STEPS[i].view];
          t.classList.toggle('current', i === step);
          t.classList.toggle('done', !!shot);
          t.style.backgroundImage = shot ? `url(${shot.thumb})` : '';
        });
      };
      const close = (result) => {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        root.remove();
        document.body.classList.remove('capturing');
        resolve(result);
      };
      const next = () => {
        // Go on to the next side still missing; after the last, finish if there's a front.
        for (let i = step + 1; i < STEPS.length; i++) if (!shots[STEPS[i].view]) { step = i; return show(); }
        if (shots.front) return close(shots);
        step = 0;
        show();
      };

      $('.cap-shutter').addEventListener('click', () => {
        if (!video.videoWidth) return;
        const c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0);
        const t = document.createElement('canvas');
        const k = 160 / Math.max(c.width, c.height);
        t.width = Math.round(c.width * k); t.height = Math.round(c.height * k);
        t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
        c.thumb = t.toDataURL('image/jpeg', 0.8);
        shots[STEPS[step].view] = c;
        root.classList.add('flash');
        setTimeout(() => root.classList.remove('flash'), 150);
        next();
      });
      $('.cap-skip').addEventListener('click', () => (step === STEPS.length - 1 && shots.front ? close(shots) : next()));
      $('.cap-cancel').addEventListener('click', () => close(null));
      $('.cap-done').addEventListener('click', () => shots.front && close(shots));
      root.querySelectorAll('.cap-thumb').forEach((t) => t.addEventListener('click', () => { step = +t.dataset.i; show(); }));

      show();
      (async () => {
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser can\'t use the camera here.');
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false,
          });
          video.srcObject = stream;
          await video.play().catch(() => {});
        } catch (err) {
          const e = $('.cap-error');
          e.hidden = false;
          e.textContent = err.name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.'
            : (err.message || 'Couldn\'t start the camera.');
        }
      })();
    });
  };
})(window.Legofy = window.Legofy || {});
