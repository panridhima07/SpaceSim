// Hand-built reference rocket and motor used by physics tests and as a
// known-good example. Values are model-rocket scale (about 37 cm, C6 motor).

import type { Motor, RocketModel } from '../types';

const CURVE: [number, number][] = [
  [0, 0],
  [0.2, 14],
  [0.3, 5],
  [1.8, 4.5],
  [1.86, 0],
];

/** Trapezoid integral of a thrust curve, N s. */
function trapezoidImpulse(curve: [number, number][]): number {
  let I = 0;
  for (let i = 1; i < curve.length; i++) {
    const [t0, F0] = curve[i - 1];
    const [t1, F1] = curve[i];
    I += ((F0 + F1) / 2) * (t1 - t0);
  }
  return I;
}

export const FIXTURE_MOTOR: Motor = {
  manufacturer: 'Estes',
  designation: 'C6',
  diameter: 0.018,
  length: 0.07,
  totalMass: 0.024,
  propellantMass: 0.0125,
  curve: CURVE,
  burnTime: 1.86,
  totalImpulse: trapezoidImpulse(CURVE),
  approximate: true,
};

export const FIXTURE_ROCKET: RocketModel = {
  name: 'Fixture 37 cm sport rocket',
  length: 0.37,
  maxRadius: 0.0125,
  stageCount: 1,
  warnings: [],
  components: [
    {
      kind: 'nosecone',
      id: 'nose',
      name: 'Ogive nose cone',
      x: 0,
      length: 0.07,
      density: 1250,
      shape: 'ogive',
      shapeParam: 0,
      baseRadius: 0.0125,
      thickness: 0.001,
    },
    {
      kind: 'bodytube',
      id: 'body',
      name: 'Body tube',
      x: 0.07,
      length: 0.3,
      density: 680,
      outerRadius: 0.0125,
      thickness: 0.0005,
    },
    {
      kind: 'innertube',
      id: 'mount',
      name: 'Motor mount',
      x: 0.3,
      length: 0.07,
      density: 680,
      outerRadius: 0.0095,
      thickness: 0.0005,
      isMotorMount: true,
      overhang: 0,
      motor: {
        manufacturer: 'Estes',
        designation: 'C6',
        diameter: 0.018,
        length: 0.07,
        delay: 5,
      },
    },
    {
      kind: 'finset',
      id: 'fins',
      name: 'Balsa fins',
      x: 0.32,
      length: 0.05,
      density: 130,
      count: 3,
      rootChord: 0.05,
      tipChord: 0.025,
      span: 0.04,
      sweepLength: 0.025,
      thickness: 0.003,
      cant: 0,
      bodyRadius: 0.0125,
      finShape: 'trapezoid',
    },
    {
      kind: 'parachute',
      id: 'chute',
      name: 'Parachute',
      x: 0.12,
      length: 0.05,
      density: 0,
      diameter: 0.3,
      cd: 0.8,
      deployEvent: 'ejection',
      deployAltitude: 0,
      deployDelay: 0,
      mass: 0.006,
    },
    {
      kind: 'mass',
      id: 'ballast',
      name: 'Nose weight',
      x: 0.03,
      length: 0,
      density: 0,
      mass: 0.005,
    },
  ],
};
