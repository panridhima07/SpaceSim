// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showFatal } from './fatal';

describe('showFatal', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('shows a WebGL explanation with the raw message in an alert overlay', () => {
    showFatal(new Error('Error creating WebGL context.'));
    const overlay = document.getElementById('astra-fatal');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('role')).toBe('alert');
    expect(overlay?.textContent).toContain('does not support WebGL');
    expect(overlay?.textContent).toContain('Error creating WebGL context.');
  });

  it('shows the generic reload hint for other errors', () => {
    showFatal(new Error('boom'));
    expect(document.getElementById('astra-fatal')?.textContent).toContain('Reloading usually fixes it');
  });

  it('leaves exactly one overlay when called twice', () => {
    showFatal(new Error('boom'));
    showFatal(new Error('again'));
    expect(document.querySelectorAll('#astra-fatal')).toHaveLength(1);
  });

  it('sets the raw message as text, never as markup', () => {
    showFatal(new Error('<img src=x onerror=alert(1)>'));
    const overlay = document.getElementById('astra-fatal');
    expect(overlay?.querySelector('img')).toBeNull();
    expect(overlay?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
