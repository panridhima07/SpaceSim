// ISRO Rohini RH-200 two-stage sounding rocket sample.
// Published specs (ISRO / VSSC): 200 mm (0.20 m) diameter, ~3.6 m length,
// ~108 kg liftoff mass, ~70 km apogee with 10 kg payload.
// Component thicknesses, fin geometry, and motor thrust curves are estimated.

import type { Motor } from '../types';

export const RH200_ORK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<openrocket version="1.9" creator="Astra">
  <rocket>
    <name>ISRO RH-200</name>
    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <subcomponents>
          <nosecone>
            <name>Ogive nose (estimated)</name>
            <material type="bulk" density="2700.0">Aluminum</material>
            <length>0.60</length>
            <thickness>0.003</thickness>
            <shape>ogive</shape>
            <shapeparameter>1.0</shapeparameter>
            <aftradius>auto</aftradius>
          </nosecone>
          <bodytube>
            <name>Sustainer body</name>
            <material type="bulk" density="2700.0">Aluminum</material>
            <length>1.40</length>
            <thickness>0.003</thickness>
            <radius>0.10</radius>
            <subcomponents>
              <trapezoidfinset>
                <name>Sustainer fins (estimated)</name>
                <material type="bulk" density="2700.0">Aluminum</material>
                <fincount>4</fincount>
                <rootchord>0.30</rootchord>
                <tipchord>0.15</tipchord>
                <sweeplength>0.15</sweeplength>
                <height>0.18</height>
                <thickness>0.004</thickness>
                <crosssection>rounded</crosssection>
                <position type="bottom">0.0</position>
              </trapezoidfinset>
              <innertube>
                <name>Sustainer motor mount</name>
                <material type="bulk" density="2700.0">Aluminum</material>
                <length>1.00</length>
                <thickness>0.002</thickness>
                <outerradius>0.09</outerradius>
                <position type="bottom">0.0</position>
                <motormount>
                  <overhang>0.02</overhang>
                </motormount>
              </innertube>
            </subcomponents>
          </bodytube>
        </subcomponents>
      </stage>
      <stage>
        <name>Booster</name>
        <subcomponents>
          <bodytube>
            <name>Booster body</name>
            <material type="bulk" density="2700.0">Aluminum</material>
            <length>1.60</length>
            <thickness>0.003</thickness>
            <radius>0.10</radius>
            <subcomponents>
              <trapezoidfinset>
                <name>Booster fins (estimated)</name>
                <material type="bulk" density="2700.0">Aluminum</material>
                <fincount>4</fincount>
                <rootchord>0.35</rootchord>
                <tipchord>0.18</tipchord>
                <sweeplength>0.17</sweeplength>
                <height>0.22</height>
                <thickness>0.005</thickness>
                <crosssection>rounded</crosssection>
                <position type="bottom">0.0</position>
              </trapezoidfinset>
              <innertube>
                <name>Booster motor mount</name>
                <material type="bulk" density="2700.0">Aluminum</material>
                <length>1.40</length>
                <thickness>0.002</thickness>
                <outerradius>0.09</outerradius>
                <position type="bottom">0.0</position>
                <motormount>
                  <overhang>0.02</overhang>
                </motormount>
              </innertube>
            </subcomponents>
          </bodytube>
        </subcomponents>
      </stage>
    </subcomponents>
  </rocket>
</openrocket>`;

/** Approximate solid motor curves for RH-200 booster and sustainer (estimated). */
export const RH200_STAGE_MOTORS: { motor: Motor; ignitionDelay?: number }[] = [
  {
    motor: {
      manufacturer: 'ISRO (approx)',
      designation: 'RH200-Booster',
      diameter: 0.18,
      length: 1.4,
      totalMass: 45,
      propellantMass: 35,
      burnTime: 3.5,
      totalImpulse: 69100,
      approximate: true,
      curve: [
        [0, 0],
        [0.1, 22000],
        [3.2, 20000],
        [3.5, 0],
      ],
    },
  },
  {
    motor: {
      manufacturer: 'ISRO (approx)',
      designation: 'RH200-Sustainer',
      diameter: 0.18,
      length: 1.0,
      totalMass: 30,
      propellantMass: 22,
      burnTime: 4.0,
      totalImpulse: 46500,
      approximate: true,
      curve: [
        [0, 0],
        [0.1, 13000],
        [3.7, 11500],
        [4.0, 0],
      ],
    },
    ignitionDelay: 2.0,
  },
];
