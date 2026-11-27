// Full-screen message shown when the builder cannot start (most often: no WebGL). Built with
// DOM APIs only (textContent, never innerHTML), so error text is never parsed as markup.
export function showFatal(err: unknown): void {
  console.error(err);
  if (document.getElementById('astra-fatal')) return;

  const message = err instanceof Error ? err.message : String(err);
  const overlay = document.createElement('div');
  overlay.id = 'astra-fatal';
  overlay.setAttribute('role', 'alert');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '99999',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a0a0b',
    color: '#e8e8ea',
    font: '16px/1.5 system-ui, sans-serif',
    padding: '24px',
    textAlign: 'center',
  });

  const box = document.createElement('div');
  box.style.maxWidth = '480px';

  const title = document.createElement('h2');
  title.textContent = 'ASTRA could not start';

  const explanation = document.createElement('p');
  explanation.textContent = /webgl/i.test(message)
    ? 'This device or browser does not support WebGL, which the 3D view needs. Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration on.'
    : 'Something went wrong while loading. Reloading usually fixes it.';

  const detail = document.createElement('p');
  detail.textContent = message;
  Object.assign(detail.style, { opacity: '.6', fontSize: '13px' });

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  Object.assign(reload.style, {
    padding: '10px 20px',
    marginTop: '12px',
    borderRadius: '6px',
    border: '1px solid #555',
    background: '#1c1c20',
    color: 'inherit',
    cursor: 'pointer',
  });
  reload.addEventListener('click', () => window.location.reload());

  box.append(title, explanation, detail, reload);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
