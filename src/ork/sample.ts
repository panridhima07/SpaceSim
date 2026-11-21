// A small, realistic OpenRocket design used for demos and tests.
// "Astra Sample": 0.37 m single-stage model rocket with an ogive nose,
// balsa trapezoid fins, an Estes C6 motor mount and a 0.30 m chute.

export const SAMPLE_ORK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<openrocket version="1.9" creator="OpenRocket 23.09">
  <rocket>
    <name>Astra Sample</name>
    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <subcomponents>
          <nosecone>
            <name>Ogive nose</name>
            <material type="bulk" density="1250.0">Polystyrene</material>
            <length>0.07</length>
            <thickness>0.001</thickness>
            <shape>ogive</shape>
            <shapeparameter>1.0</shapeparameter>
            <aftradius>auto</aftradius>
          </nosecone>
          <bodytube>
            <name>Body tube</name>
            <material type="bulk" density="680.0">Cardboard</material>
            <length>0.30</length>
            <thickness>0.0005</thickness>
            <radius>0.0125</radius>
            <subcomponents>
              <trapezoidfinset>
                <name>Balsa fins</name>
                <fincount>3</fincount>
                <rootchord>0.05</rootchord>
                <tipchord>0.025</tipchord>
                <sweeplength>0.025</sweeplength>
                <height>0.04</height>
                <thickness>0.003</thickness>
                <cant>0.0</cant>
                <material type="bulk" density="150.0">Balsa</material>
                <position type="bottom">0.0</position>
              </trapezoidfinset>
              <innertube>
                <name>Motor mount</name>
                <material type="bulk" density="680.0">Cardboard</material>
                <length>0.07</length>
                <outerradius>0.0095</outerradius>
                <thickness>0.0005</thickness>
                <position type="bottom">0.0</position>
                <motormount>
                  <overhang>0.005</overhang>
                  <motor configid="1">
                    <manufacturer>Estes</manufacturer>
                    <designation>C6</designation>
                    <diameter>0.018</diameter>
                    <length>0.070</length>
                    <delay>5.0</delay>
                  </motor>
                </motormount>
              </innertube>
              <parachute>
                <name>Main chute</name>
                <material type="surface" density="0.067">Ripstop nylon</material>
                <diameter>0.30</diameter>
                <cd>auto</cd>
                <deployevent>ejection</deployevent>
                <deploydelay>0.0</deploydelay>
                <packedlength>0.02</packedlength>
                <position type="top">0.10</position>
              </parachute>
              <masscomponent>
                <name>Avionics</name>
                <mass>0.005</mass>
                <packedlength>0.01</packedlength>
                <position type="top">0.20</position>
              </masscomponent>
            </subcomponents>
          </bodytube>
        </subcomponents>
      </stage>
    </subcomponents>
  </rocket>
</openrocket>
`;
