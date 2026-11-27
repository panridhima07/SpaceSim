// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountHero } from './hero';

describe('mountHero keyboard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.sessionStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const enter = (target: Element): boolean =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  it('leaves Enter to a focused control and starts the sample otherwise', () => {
    const onFly = vi.fn();
    const hero = mountHero(document.body, { onBuild: vi.fn(), onFly, onMoon: vi.fn() });
    vi.advanceTimersByTime(2000);

    const outside = document.createElement('div');
    outside.innerHTML =
      '<button><span>A</span></button><a href="#">x</a><input><select></select><textarea></textarea><div role="button">y</div>';
    document.body.append(outside);
    for (const target of outside.querySelectorAll('button span, a, input, select, textarea, [role="button"]')) {
      expect(enter(target)).toBe(true); // default not prevented
    }
    expect(onFly).not.toHaveBeenCalled();

    expect(enter(document.body)).toBe(false);
    expect(onFly).toHaveBeenCalledTimes(1);
    hero?.dismiss();
  });
});
