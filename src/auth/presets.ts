// The real flights shown on the landing page (Chandrayaan-3, the Starship booster catch,
// Starlink, and PSLV-C61 / EOS-09). Each one also names the launch site the 3D Earth turns
// to when the card is hovered or opened.

import type { JourneySite } from './journey';

export interface MissionPreset {
  id: string;
  agency: string;
  vehicle: string;
  name: string;
  line: string;
  date: string;
  site: JourneySite;
  facts: Array<{ label: string; value: string }>;
  timeline: Array<{ t: string; label: string }>;
  timelineNote?: string;
  status: 'flyable' | 'brief';
  statusText: string;
}

export const PRESETS: MissionPreset[] = [
  {
    id: 'chandrayaan-3',
    agency: 'ISRO',
    vehicle: 'LVM3-M4',
    name: 'Chandrayaan-3',
    line: "From Sriharikota to a soft landing near the Moon's south pole.",
    date: '14 Jul 2023',
    site: { id: 'chandrayaan-3', label: 'SRIHARIKOTA', latDeg: 13.72, lonDeg: 80.23, kind: 'orbit' },
    facts: [
      { label: 'Vehicle', value: 'LVM3-M4, three stages, 640 t at liftoff' },
      { label: 'Launch site', value: 'Satish Dhawan Space Centre, Sriharikota' },
      { label: 'Liftoff', value: '14 July 2023, 14:35 IST' },
      { label: 'Parking orbit', value: '170 × 36,500 km' },
      { label: 'Landing', value: '23 August 2023, 69.37° S 32.35° E' },
    ],
    timeline: [
      { t: 'T+0:00', label: 'Liftoff on two S200 boosters' },
      { t: 'T+1:48', label: 'L110 core ignition' },
      { t: 'T+2:07', label: 'S200 separation' },
      { t: 'T+3:15', label: 'Fairing separation' },
      { t: 'T+5:06', label: 'L110 separation' },
      { t: 'T+5:08', label: 'C25 cryogenic stage ignition' },
      { t: 'T+15:54', label: 'C25 cutoff, in orbit' },
      { t: 'Day 23', label: 'Lunar orbit insertion' },
      { t: 'Day 41', label: 'Powered descent and touchdown' },
    ],
    status: 'flyable',
    statusText: 'In the simulator: the LVM3 ascent, the flight to the Moon and the powered landing.',
  },
  {
    id: 'starship-catch',
    agency: 'SpaceX',
    vehicle: 'Starship',
    name: 'Booster catch',
    line: 'Super Heavy flies back to the pad and the launch tower catches it in mid-air.',
    date: '13 Oct 2024',
    site: { id: 'starship-catch', label: 'STARBASE', latDeg: 25.997, lonDeg: -97.157, kind: 'return' },
    facts: [
      { label: 'Flight', value: 'Starship Flight 5, Booster 12 and Ship 30' },
      { label: 'Vehicle', value: '121 m tall, 33 Raptor engines on the booster' },
      { label: 'Launch site', value: 'Starbase, Boca Chica, Texas' },
      { label: 'Liftoff', value: '13 October 2024, 07:25 CDT' },
      { label: 'Result', value: 'First catch of a returning booster by the tower arms' },
    ],
    timeline: [
      { t: 'T+0:00', label: 'Liftoff' },
      { t: 'T+1:02', label: 'Maximum aerodynamic pressure' },
      { t: 'T+2:40', label: 'Hot staging, ship ignites and separates' },
      { t: 'T+2:48', label: 'Booster boostback burn begins' },
      { t: 'T+6:33', label: 'Landing burn begins' },
      { t: 'T+6:56', label: 'Caught by the tower arms' },
      { t: 'T+65:00', label: 'Ship splashes down in the Indian Ocean' },
    ],
    timelineNote: 'Times are approximate.',
    status: 'brief',
    statusText: 'Mission brief only. Not yet flyable in the simulator.',
  },
  {
    id: 'starlink',
    agency: 'SpaceX',
    vehicle: 'Falcon 9',
    name: 'Starlink delivery',
    line: 'A Falcon 9 carries a stack of Starlink satellites to low Earth orbit and lands its booster at sea.',
    date: 'Flying since 2019',
    site: { id: 'starlink', label: 'CAPE CANAVERAL', latDeg: 28.562, lonDeg: -80.577, kind: 'orbit' },
    facts: [
      { label: 'Vehicle', value: 'Falcon 9 Block 5, 70 m, nine Merlin engines' },
      { label: 'Launch site', value: 'SLC-40, Cape Canaveral, Florida' },
      { label: 'Payload', value: 'A stack of 20 to 29 Starlink satellites' },
      { label: 'Orbit', value: 'Low Earth orbit, 43° or 53° inclination' },
      { label: 'Booster', value: 'Lands on a drone ship in the Atlantic' },
    ],
    timeline: [
      { t: 'T+0:00', label: 'Liftoff' },
      { t: 'T+1:12', label: 'Maximum aerodynamic pressure' },
      { t: 'T+2:27', label: 'Main engine cutoff and stage separation' },
      { t: 'T+3:00', label: 'Fairing separation' },
      { t: 'T+6:10', label: 'Booster entry burn' },
      { t: 'T+8:10', label: 'Booster lands on the drone ship' },
      { t: 'T+8:40', label: 'Second stage cutoff, in orbit' },
      { t: 'T+65:00', label: 'Satellites released' },
    ],
    timelineNote: 'A typical flight. Times vary by mission.',
    status: 'flyable',
    statusText: 'In the simulator: the Falcon 9 ascent to orbit and the release of the satellites.',
  },
  {
    id: 'eos-09',
    agency: 'ISRO',
    vehicle: 'PSLV-C61',
    name: 'EOS-09',
    line: 'A PSLV carries the EOS-09 radar satellite from Sriharikota. The third stage fails and the satellite is lost.',
    date: '18 May 2025',
    site: { id: 'eos-09', label: 'SRIHARIKOTA', latDeg: 13.72, lonDeg: 80.23, kind: 'orbit' },
    facts: [
      { label: 'Vehicle', value: 'PSLV-XL, four stages and six strap-on boosters, 44.4 m, about 320 t at liftoff' },
      { label: 'Launch site', value: 'First Launch Pad, Satish Dhawan Space Centre, Sriharikota' },
      { label: 'Liftoff', value: '18 May 2025, 05:59 IST' },
      { label: 'Payload', value: 'EOS-09, a radar imaging satellite of about 1,700 kg' },
      { label: 'Planned orbit', value: 'Sun-synchronous polar orbit' },
      { label: 'Result', value: 'Failed. The third stage lost chamber pressure, and the satellite was lost' },
    ],
    timeline: [
      { t: '05:59 IST', label: 'Liftoff from the First Launch Pad' },
      { t: 'Ascent', label: 'Planned climb through the four stages' },
      { t: 'Third stage', label: 'Chamber pressure is lost. The mission fails' },
    ],
    timelineNote: 'Exact times after liftoff are not shown here.',
    status: 'flyable',
    statusText: 'In the simulator: the planned flight and the third-stage failure that ended the real one.',
  },
];
