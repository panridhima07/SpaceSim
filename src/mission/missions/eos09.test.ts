import { beforeAll, describe, expect, it } from 'vitest';
import { flyMission } from '../fly';
import type { FlightRecord } from '../record';
import { EOS09_MISSION } from './eos09';
import { pslvXL } from '../../../rocket-physics/src/vehicle/pslv.ts';
import { boosterCount } from '../../../rocket-physics/src/vehicle/types.ts';

const TIMEOUT = 90_000;

let nominal: FlightRecord;
let ps3: FlightRecord;

beforeAll(() => {
  nominal = flyMission(EOS09_MISSION);
  ps3 = flyMission(EOS09_MISSION, { failureCase: 'ps3-pressure-loss' });
}, TIMEOUT);

describe('PSLV-C61 / EOS-09 vehicle', () => {
  it('has a liftoff mass within 3 % of the 320 t ISRO figure', () => {
    const v = pslvXL(1696.24);
    let total = v.payload.mass + (v.fairing?.mass ?? 0);
    for (const s of v.stages) {
      const n = boosterCount(s);
      const prop = s.tanks.reduce((sum, t) => sum + t.propellantMass, 0);
      total += (s.dryMass + prop) * n;
    }
    expect(Math.abs(total - 320e3) / 320e3).toBeLessThanOrEqual(0.03);
  });
});

describe('PSLV-C61 / EOS-09 nominal flight', () => {
  it('reaches the planned sun-synchronous orbit', () => {
    expect(nominal.reachedTarget).toBe(true);
    expect(nominal.outcome?.outcome).toBe('nominal');
    const orbit = nominal.orbit!;
    expect(Math.abs(orbit.periapsis! - 529e3)).toBeLessThanOrEqual(25e3);
    expect(Math.abs(orbit.apoapsis! - 529e3)).toBeLessThanOrEqual(25e3);
    expect(Math.abs(orbit.inclinationDeg! - 97.6)).toBeLessThanOrEqual(0.3);
  }, TIMEOUT);

  it('separates every stage except the top one, in flight order', () => {
    const seps = nominal.stageSeparation!;
    expect(seps).toHaveLength(6);
    // Index order: 0 PS1, 1 strap-ons lit on the pad, 2 strap-ons lit in the air, 3 PS2, 4 PS3, 5 PS4.
    for (const i of [0, 1, 2, 3, 4]) expect(seps[i], `stage ${i} separation`).not.toBeNull();
    expect(seps[5]).toBeNull();
    // Flight order: the pad-lit strap-ons, then the air-lit pair, then PS1, PS2, PS3.
    const flightOrder = [1, 2, 0, 3, 4].map((i) => seps[i]!);
    for (let k = 1; k < flightOrder.length; k++) {
      expect(flightOrder[k]).toBeGreaterThan(flightOrder[k - 1]);
    }
    expect(nominal.fairingSeparation).not.toBeNull();
  }, TIMEOUT);

  it('matches the planned events it has sources for within 5 s', () => {
    const find = (text: string) => {
      const m = nominal.markers.find((x) => x.label.includes(text));
      expect(m, `missing marker ${text}`).toBeDefined();
      return m!;
    };
    for (const text of ['PS1 (S139) separation', 'PS2 (Vikas) ignition', 'PS2 (Vikas) separation']) {
      const m = find(text);
      expect(m.reference, `reference for ${text}`).toBeDefined();
      expect(Math.abs(m.t - m.reference!)).toBeLessThanOrEqual(5);
    }
  }, TIMEOUT);

  it('releases the EOS-09 satellite after orbit insertion', () => {
    expect(nominal.payloadSeparation).toBeTypeOf('number');
    expect(Number.isFinite(nominal.payloadSeparation!)).toBe(true);
    expect(nominal.markers.some((m) => m.label.includes('EOS-09 separation'))).toBe(true);
  }, TIMEOUT);
});

describe('PSLV-C61 / EOS-09 ps3-pressure-loss case', () => {
  it('does not reach orbit and comes down on a suborbital path', () => {
    expect(ps3.failureCase).toBe('ps3-pressure-loss');
    expect(ps3.reachedTarget).toBe(false);
    expect(ps3.outcome?.outcome).not.toBe('nominal');
    expect(['suborbital', 'impact']).toContain(ps3.outcome?.outcome);
    expect(ps3.orbit!.periapsis!).toBeLessThan(100e3);
  }, TIMEOUT);

  it('shows the PS3 leak event and no satellite release', () => {
    expect(ps3.markers.some((m) => m.label.includes('PS3 (S7) HTPB leak'))).toBe(true);
    expect(ps3.payloadSeparation ?? null).toBeNull();
  }, TIMEOUT);
});
