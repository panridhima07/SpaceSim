import { describe, expect, it } from 'vitest';
import { Simulation, SITES, twoStageKerolox } from './engine';

describe('rocket physics engine integration', () => {
  it('builds a two-stage kerolox simulation at Sriharikota', () => {
    const sim = new Simulation(twoStageKerolox(12000), { site: SITES.sriharikota });
    expect(Math.abs(sim.diag.altitude - SITES.sriharikota.altitude)).toBeLessThan(100);
    expect(sim.diag.mass).toBeGreaterThan(0);
  });
});
