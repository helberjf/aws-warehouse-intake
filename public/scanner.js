/** Camera images stay in the browser; only the decoded product code reaches the API. */
let fallbackPromise;
function loadFallback() {
  if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
  fallbackPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/zxing.js';
    script.onload = () =>
      window.ZXingBrowser ? resolve(window.ZXingBrowser) : reject(new Error('Leitor indisponível.'));
    script.onerror = () => {
      fallbackPromise = undefined;
      reject(new Error('Não foi possível carregar o leitor. Use o leitor USB ou digite o código.'));
    };
    document.head.append(script);
  });
  return fallbackPromise;
}

export class CameraScanner {
  constructor(video) {
    this.video = video;
    this.generation = 0;
  }
  async start(onCode) {
    this.stop();
    const generation = this.generation;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'A câmera precisa de HTTPS ou localhost. Você pode usar um leitor USB ou digitar o código.',
      );
    }
    let handled = false;
    const decoded = (value) => {
      const code = String(value ?? '').trim();
      if (!code || handled || generation !== this.generation) return;
      handled = true;
      this.stop();
      onCode(code);
    };
    let detector;
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = [
          'ean_13',
          'ean_8',
          'upc_a',
          'upc_e',
          'code_128',
          'code_39',
          'itf',
          'codabar',
          'data_matrix',
          'qr_code',
        ].filter((format) => supported.includes(format));
        if (formats.length) detector = new window.BarcodeDetector({ formats });
      } catch {
        /* The local software decoder handles browsers without this API. */
      }
    }
    if (generation !== this.generation) return;
    if (detector) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      const scan = async () => {
        if (generation !== this.generation) return;
        try {
          if (this.video.readyState >= 2) {
            const codes = await detector.detect(this.video);
            if (codes[0]) decoded(codes[0].rawValue);
          }
        } catch {
          /* Skip a frame that is not ready; camera lifecycle is handled below. */
        }
        if (generation === this.generation) this.timer = setTimeout(scan, 160);
      };
      await scan();
    } else {
      const library = await loadFallback();
      if (generation !== this.generation) return;
      this.reader = new library.BrowserMultiFormatReader();
      const controls = await this.reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        this.video,
        (result) => {
          if (result) decoded(result.getText());
        },
      );
      if (generation !== this.generation) controls.stop();
      else this.controls = controls;
    }
  }
  stop() {
    this.generation++;
    clearTimeout(this.timer);
    this.controls?.stop();
    this.controls = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.video.srcObject) this.video.srcObject.getTracks().forEach((track) => track.stop());
    this.video.srcObject = null;
  }
}
