import { it } from 'vitest';
import { flyMission } from './fly';
import { getMission } from './vehicles';

it('measures one flight', () => {
  const def = getMission('lvm3-m4')!;
  const t0 = performance.now();
  const rec = flyMission(def);
  const cold = performance.now() - t0;
  const t1 = performance.now();
  flyMission(def);
  const warm = performance.now() - t1;
  console.log('COLD_MS', cold.toFixed(0), 'WARM_MS', warm.toFixed(0), 'SAMPLES', rec.samples.length, 'LAST_T', rec.samples[rec.samples.length - 1].t.toFixed(1));
}, 120_000);
