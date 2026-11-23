import { describe, expect, it } from 'vitest';
import { parseRockSimXml } from './rocksim';
import { fromRocketModel, toRocketModel } from '../builder/design';

const SAMPLE_RKT = `<?xml version="1.0" encoding="UTF-8"?>
<RockSimDocument>
  <FileVersion>4</FileVersion>
  <DesignInformation>
    <RocketDesign>
      <Name>Alpha RKT</Name>
      <Stage3Parts>
        <NoseCone>
          <Name>Ogive Nose</Name>
          <Len>100</Len>
          <BaseDia>25</BaseDia>
          <WallThickness>2</WallThickness>
          <ShapeCode>1</ShapeCode>
          <Density>1.05</Density>
          <ConstructionType>1</ConstructionType>
        </NoseCone>
        <BodyTube>
          <Name>Main Airframe</Name>
          <Len>300</Len>
          <OD>25</OD>
          <ID>23.6</ID>
          <Density>0.68</Density>
          <AttachedParts>
            <FinSet>
              <Name>Main Fins</Name>
              <FinCount>3</FinCount>
              <RootChord>50</RootChord>
              <TipChord>25</TipChord>
              <SemiSpan>40</SemiSpan>
              <SweepDistance>15</SweepDistance>
              <Thickness>2</Thickness>
              <CantAngle>2</CantAngle>
              <LocationMode>2</LocationMode>
              <Xb>-5</Xb>
              <Density>0.16</Density>
            </FinSet>
            <BodyTube>
              <Name>Motor Mount</Name>
              <Len>70</Len>
              <OD>18.7</OD>
              <ID>18</ID>
              <IsMotorMount>1</IsMotorMount>
              <LocationMode>2</LocationMode>
              <Xb>0</Xb>
              <Density>0.68</Density>
            </BodyTube>
            <Ring>
              <Name>Fore Ring</Name>
              <UsageCode>0</UsageCode>
              <Len>3</Len>
              <OD>23.6</OD>
              <ID>18.7</ID>
              <LocationMode>2</LocationMode>
              <Xb>-65</Xb>
              <Density>0.63</Density>
            </Ring>
            <Parachute>
              <Name>Main Chute</Name>
              <Dia>300</Dia>
              <Cd>0.8</Cd>
              <KnownMass>12</KnownMass>
              <DeployEvent>0</DeployEvent>
              <LocationMode>0</LocationMode>
              <Xb>40</Xb>
            </Parachute>
            <MassObject>
              <Name>Nose Weight</Name>
              <KnownMass>8</KnownMass>
              <Len>15</Len>
              <LocationMode>0</LocationMode>
              <Xb>10</Xb>
            </MassObject>
            <MysteryGadget>
              <Name>Future Sensor</Name>
            </MysteryGadget>
          </AttachedParts>
        </BodyTube>
        <Transition>
          <Name>Tail Cone</Name>
          <Len>30</Len>
          <FrontDia>25</FrontDia>
          <RearDia>20</RearDia>
          <WallThickness>1.5</WallThickness>
          <ShapeCode>0</ShapeCode>
          <Density>1.05</Density>
        </Transition>
      </Stage3Parts>
    </RocketDesign>
  </DesignInformation>
</RockSimDocument>`;

describe('parseRockSimXml', () => {
  it('parses RockSimDocument XML into SI RocketModel and warns on unsupported parts', () => {
    const model = parseRockSimXml(SAMPLE_RKT);

    expect(model.name).toBe('Alpha RKT');
    expect(model.stageCount).toBe(1);
    expect(model.length).toBeCloseTo(0.43, 5); // 100 + 300 + 30 mm
    expect(model.maxRadius).toBeCloseTo(0.0125, 5);

    const nose = model.components.find((c) => c.kind === 'nosecone');
    expect(nose).toBeDefined();
    expect(nose?.length).toBeCloseTo(0.1, 5);
    expect(nose?.density).toBeCloseTo(1050, 2);

    const fins = model.components.find((c) => c.kind === 'finset');
    expect(fins).toBeDefined();
    if (fins?.kind === 'finset') {
      expect(fins.count).toBe(3);
      expect(fins.rootChord).toBeCloseTo(0.05, 5);
      expect(fins.span).toBeCloseTo(0.04, 5);
      expect(fins.cant).toBeCloseTo((2 * Math.PI) / 180, 5);
    }

    const mount = model.components.find((c) => c.kind === 'innertube');
    expect(mount).toBeDefined();
    if (mount?.kind === 'innertube') {
      expect(mount.isMotorMount).toBe(true);
      expect(mount.x).toBeCloseTo(0.1 + 0.3 - 0.07, 5);
    }

    const chute = model.components.find((c) => c.kind === 'parachute');
    expect(chute).toBeDefined();
    if (chute?.kind === 'parachute') {
      expect(chute.diameter).toBeCloseTo(0.3, 5);
      expect(chute.mass).toBeCloseTo(0.012, 5);
    }

    const mass = model.components.find((c) => c.kind === 'mass');
    expect(mass).toBeDefined();
    if (mass?.kind === 'mass') {
      expect(mass.mass).toBeCloseTo(0.008, 5);
    }

    expect(model.warnings.some((w) => w.includes('MysteryGadget'))).toBe(true);

    // Round-trip through editable Design
    const design = fromRocketModel(model);
    expect(design.stack.length).toBe(3);
    const rebuilt = toRocketModel(design);
    expect(rebuilt.components.length).toBeGreaterThanOrEqual(7);
  });

  it('throws friendly errors for empty or non-RockSim XML', () => {
    expect(() => parseRockSimXml('')).toThrow(/empty/i);
    expect(() => parseRockSimXml('<openrocket/>')).toThrow(/RockSimDocument/i);
  });
});

describe('parseRockSimXml limits', () => {
  it('rejects DOCTYPE and ENTITY declarations', () => {
    expect(() => parseRockSimXml(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "v">]>${SAMPLE_RKT}`)).toThrow(/DOCTYPE or ENTITY/);
  });

  it('clamps fin count and dimensions', () => {
    const xml = SAMPLE_RKT.replace('<FinCount>3</FinCount>', '<FinCount>1000000000</FinCount>').replace('<OD>25</OD>', '<OD>9999999</OD>');
    const model = parseRockSimXml(xml);
    for (const c of model.components) {
      if (c.kind === 'finset') expect(c.count).toBeLessThanOrEqual(64);
      if (c.kind === 'bodytube') expect(c.outerRadius).toBeLessThanOrEqual(10);
    }
    expect(model.components.some((c) => c.kind === 'finset' && c.count === 64)).toBe(true);
  });
});
