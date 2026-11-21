# 3D render accuracy: components and audit

How an OpenRocket (.ork) file becomes the 3D rocket, what each outside part needs to be drawn correctly, and what the mock imports found.

Run the audit: `npx vitest run src/validate/renderAudit.test.ts`
See every part design: `npm run dev`, then open `/parts.html`

## Pipeline

1. `src/ork/parser.ts` reads the file (zip, gzip or plain XML; UTF-8 or UTF-16) into a `RocketModel`.
2. `src/render/parts/grade.ts` grades each component best / ok / bad from its own data.
3. `src/render/rocketMesh.ts` draws each component with the design for its grade (`src/render/parts/aero.ts`, `airframe.ts`, `internals.ts`).
4. `src/validate/renderAudit.ts` measures the finished mesh against the model.

A grade changes workmanship and detail only. Lengths, radii, chords, spans and stations are always the file's own.

## Components visible on the outside

| Component | .ork element | What the render takes from the file | Status |
|---|---|---|---|
| Nose cone | `nosecone` | length, base radius, shape and shape parameter (conical, ogive incl. secant, ellipsoid, power, parabolic, Haack), paint, finish | drawn |
| Tail cone | `nosecone` + `isflipped` | same, wide end forward | drawn; aerodynamics still treat it as a nose |
| Body tube | `bodytube` | length, radius (explicit or automatic), wall thickness, paint, finish | drawn |
| Decoupler / interstage | builder part | band colour, separation hardware | drawn |
| Transition, boat tail | `transition` | both radii, length, curve shape, clipped or not | drawn |
| Fin set | `trapezoidfinset`, `ellipticalfinset`, `freeformfinset` | count, planform, sweep (length or angle), thickness, cross-section, cant, rotation, fillet, position (top / middle / bottom / absolute) | drawn |
| Fin tabs | `tabheight`, `tablength`, `tabposition` | through-the-wall tab | drawn in cutaway |
| Launch lug | `launchlug` | radius, bore, length, angle, instance count and spacing | drawn on the body surface |
| Rail button | `railbutton` | outer and inner diameter, height, angle, instance count and spacing | drawn on the body surface |
| Motor and nozzle | `innertube` + `motormount` + `motor` | motor diameter, mount position, overhang | drawn |
| Motor cluster | `clusterconfiguration` | tube count and layout, scale, rotation | every tube drawn; mass and thrust count one |
| Protruding mount tube | `innertube` past the aft end | length and position | drawn when it sticks out |
| Strap-on pod | builder part (`radialCount`) | radius, length, count, offset | drawn |
| Parallel booster | `parallelstage` | whole side stack | **not supported**: warned, missing from model |
| Pod set | `podset` | whole side stack | **not supported**: warned, missing from model |
| Tube fins | `tubefinset` | ring fins | **not supported**: warned, missing from model |
| Decals | `appearance/decal` | image wrapped on a part | not drawn (paint colour only) |

Inside parts (cutaway view): inner tube, centering ring, bulkhead, tube coupler, engine block, nose and transition shoulders, mass component, shock cord, parachute, streamer.

## How a part gets its grade

Each reason is good, poor or a defect. One defect makes the part bad; otherwise two more good than poor is best, any net poor is bad, the rest are ok. The reasons are shown in the app under "Build quality".

| Part | Good | Poor | Defect |
|---|---|---|---|
| Nose cone | ogive, Haack or parabolic profile; 3–7:1 fineness; smooth or polished finish | conical; under 2 diameters long; over 10; rough finish | under 1 diameter long; no length or radius |
| Body tube | wall 2–12% of radius; smooth finish | no wall given; wall under 0.8% or over 30% | radius step over 2% against the part ahead |
| Transition | taper of 10° or less; curved shape | taper over 18° | taper over 35° |
| Fin set | airfoil section; root fillets; through-the-wall tabs | square edges; thickness under 1% or over 15% of chord; span over 3 diameters; tips trailing far aft | fewer than 3 fins; zero thickness, span or chord |
| Motor mount | motor fits the bore within 1.5 mm; mount covers the motor | no motor; over 4 mm of play; motor longer than mount; half the motor hanging out | motor wider than the bore |
| Lug / button | rail buttons | lug shorter than 2 diameters | no length |
| Recovery | Cd 1.2 or more; altitude deployment | Cd under 0.5 | no canopy size |

## Mock imports

`src/validate/mockOrk.ts` holds 59 hand-written designs, each with the result a correct import must give. The test also runs the five real OpenRocket sample files. Every design is parsed, built at all three grades plus the automatic one, with and without cutaway, and measured: no bad vertices, every outside part drawn, axial extent and radius of each part, fin tip radius and root contact, fittings outside the body, motor end, overall length.

### Faults found and fixed

| Fault | Seen in | Fix |
|---|---|---|
| Launch lugs and rail buttons were never drawn outside; in cutaway they sat on the rocket axis | all 5 sample files | parser records mount radius, angle and instances; drawn on the surface |
| Motors and nozzles were never drawn | all 5 sample files | motor drawn in the mount |
| Motor overhang and protruding mount tubes left the drawn rocket short (12.7 mm on the dual-deploy sample) | Dual parachute deployment | drawn to their true aft end |
| Paint colours in the file were ignored | every painted file | `appearance/paint` read into the part colour |
| Tail cones (`isflipped`) were drawn as a second nose pointing forward | mock | flipped profile; automatic radii resolved from the correct end |
| Curved and clipped transitions were drawn as straight cones | mock | OpenRocket's transition curve |
| Ogive shape parameter was ignored, so secant ogives were drawn as tangent ogives | mock | OpenRocket's arc |
| Fins on a taper were mounted at the taper's aft radius: floating or buried by up to 12 mm | mock | mounted at the radius under the leading edge; the root is carried down to the surface where the body narrows |
| Fin set rotation was ignored | mock | `angleoffset` / `rotation` applied |
| Sweep given as an angle was read as zero sweep | mock | `sweepangle` converted |
| Motor clusters were drawn as one tube | mock | all tubes placed |
| A fin with zero thickness in the file vanished | mock | drawn as a thin sheet |
| Decimal commas (`0,3`) parsed as 0, giving a zero-length rocket with no warning | mock | accepted |
| Negative lengths drew geometry ahead of the nose tip | mock | clamped to 0 with a warning |
| Unresolvable automatic radii became 0 | mock | OpenRocket's 25 mm default, with a warning |
| A byte-order mark or blank line before the XML made the file unreadable | mock | stripped |
| Namespaced or upper-case element names were rejected as "not an OpenRocket file" | mock | matched by local name |
| Gzip-compressed .ork files (OpenRocket 1.0–1.1) and UTF-16 files were read as garbage | mock | unpacked and decoded |
| A zip with no design inside failed with "No `<rocket>` element"; a corrupt zip threw a raw library error | mock | clear messages |
| Self-crossing or collapsed freeform fin outlines vanished silently | mock | warned |

### Known gaps

- **Parallel boosters, pod sets and tube fins** are skipped with a warning. They change the outside shape, so a file that uses them renders incomplete. Supporting them needs side-mounted bodies in `RocketModel` and in the aerodynamics.
- **`RocketModel.length`** is the airframe length. Swept fin tips and motor overhang extend past it in the mesh, but the exhaust plume and the builder ruler still start from the airframe end.
- **Tail cone aerodynamics** use the nose-cone formulas.
- **Clusters** fly as one motor.
- **Decals and textures** are not drawn.
- **Fin and fitting angles** follow one consistent convention, but its handedness against OpenRocket's own view has not been compared with a screenshot.
- **Exported .ork files** (`src/builder/orkExport.ts`) do not yet write the newly read fields (paint, fin rotation, fillets, tabs, fitting angles, clusters).
