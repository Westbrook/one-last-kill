import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BUILDING, BALCONY, APARTMENT_DOORS } from '../../src/world/layout.js';
import {
  buildWorldSurfaceFixture, collectAxisAlignedBoxFaces, findCoplanarBoxOverlaps,
} from './helpers/world-surface-fixture.js';

// The fixture runs the actual room and gallery builders and keeps each piece
// of rendered decoration separate, so shared trim cannot hide an overlap.
const fixture = buildWorldSurfaceFixture();
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6,
  `${label}: ${actual} differs from ${expected}`);
const entry = id => {
  const found = fixture.entries.find(value => value.id === id);
  assert.ok(found, `Missing rendered assembly ${id}`);
  return found;
};
const bounds = value => new THREE.Box3().setFromObject(value.mesh);
const focused = entries => ({ World: fixture.World, entries });

test('the kitchen cabinet ends exactly at the worktop underside with no overlapping side faces', () => {
  const base = entry('apartment-kitchen-base'), top = entry('apartment-kitchen-top');
  const baseBounds = bounds(base), topBounds = bounds(top);
  near(baseBounds.min.y, BUILDING.apartmentY, 'cabinet rests on the unchanged apartment floor');
  near(baseBounds.max.y, topBounds.min.y, 'cabinet meets, but does not penetrate, the metal worktop');
  near(topBounds.min.y, BUILDING.apartmentY + 0.895, 'worktop underside height stays authored');
  near(topBounds.max.y, BUILDING.apartmentY + 0.945, 'worktop surface height stays authored');
  for (const value of [baseBounds, topBounds]) {
    near(value.min.x, -14.9, 'west extent'); near(value.max.x, -13.9, 'east extent');
    near(value.min.z, -3.7, 'north extent'); near(value.max.z, -1.3, 'south extent');
  }
  assert.equal(top.mesh.userData.collider, null, 'decorative worktop does not add a new obstacle');
  near(base.mesh.userData.collider.max.y, baseBounds.max.y, 'cabinet collision matches its visible top');
  const surfaces = focused([base, top]);
  const faces = collectAxisAlignedBoxFaces(surfaces);
  assert.equal(faces.filter(face => face.axis === 'x' || face.axis === 'z').length, 8,
    'Both assemblies retain their real side triangles');
  const overlaps = findCoplanarBoxOverlaps(surfaces, { minArea: 1e-6, differentMaterialsOnly: false });
  assert.deepEqual(overlaps, [], 'Wood and metal share only an edge on their vertical faces');
});

test('the terrace address plate clears the header and trim bottom faces while retaining its support', () => {
  const door = APARTMENT_DOORS.neighborTerrace;
  const plate = entry(`${door.id}-number-backing`), header = entry(`${door.id}-header`);
  const plateBounds = bounds(plate), headerBounds = bounds(header);
  const headerTop = door.floorY + door.height + door.frameWidth;
  near(plateBounds.min.y, headerTop - 0.01, 'metal backing mounts on the upper centimetre of the frame');
  near(headerBounds.max.y, headerTop, 'door header itself is unchanged');
  assert.ok(plateBounds.min.y > headerBounds.min.y + 0.04,
    'The backing clears the lower wood and trim faces without aligning to the masonry underside');
  assert.ok(plateBounds.clone().expandByScalar(1e-6).intersectsBox(headerBounds),
    'The plate still has a physical mounting contact');
  assert.equal(plate.mesh.userData.collider, null, 'raised address plate does not obstruct the passage');
  const neighbors = fixture.entries.filter(value => value.mesh === plate.mesh
    || bounds(value).expandByScalar(1e-5).intersectsBox(plateBounds));
  assert.ok(neighbors.some(value => value.mesh === header.mesh), 'Actual header is included in the face audit');
  assert.ok(neighbors.some(value => value.materialKey === 'wood' && value.options?.batched),
    'Actual exterior frame trim is included in the face audit');
  const overlaps = findCoplanarBoxOverlaps(focused(neighbors), { minArea: 1e-6, differentMaterialsOnly: false })
    .filter(overlap => overlap.a.entry.mesh === plate.mesh || overlap.b.entry.mesh === plate.mesh)
    .map(overlap => ({ other: overlap.a.entry.mesh === plate.mesh ? overlap.b.id : overlap.a.id,
      axis: overlap.axis, sign: overlap.sign, area: overlap.area }));
  assert.deepEqual(overlaps, [], 'No same-facing plate triangles compete with the frame or wall');
});

test('the raised terrace number remains on its backing without changing the clear opening', () => {
  const door = APARTMENT_DOORS.neighborTerrace;
  const plate = entry(`${door.id}-number-backing`), number = entry(`${door.id}-exterior-number`);
  const plateBounds = bounds(plate), numberBounds = bounds(number);
  near(number.mesh.position.y, plate.mesh.position.y, 'lettering follows its raised backing');
  near(number.mesh.position.z, door.z, 'number remains centered above its doorway');
  assert.ok(numberBounds.min.y > plateBounds.min.y && numberBounds.max.y < plateBounds.max.y);
  assert.ok(numberBounds.min.z > plateBounds.min.z && numberBounds.max.z < plateBounds.max.z);
  near(numberBounds.min.x - plateBounds.max.x, 0.003, 'lettering remains just in front of the metal plate');
  const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(number.mesh.quaternion);
  assert.ok(direction.x > 0.999, 'The sign still faces the exterior terrace');
  near(bounds(entry(`${door.id}-header`)).min.y, door.floorY + door.height, 'clear head height is preserved');
  near(bounds(entry(`${door.id}-threshold`)).max.y, door.floorY, 'untouched threshold remains flush');
});

test('the gallery end band fits both slab ends without extending their collision or floor bounds', () => {
  const band = entry('balcony-wrap-end-band'), bandBounds = bounds(band);
  near(bandBounds.min.x, BALCONY.wrap.x2, 'band contacts the existing slab ends');
  near(bandBounds.max.x, BALCONY.wrap.x2 + 0.02, 'end band has a physical two-centimetre thickness');
  near(bandBounds.min.y, BALCONY.floorY - 0.4, 'band covers the lower beam');
  near(bandBounds.max.y, BALCONY.floorY, 'band never rises above the walkable floor');
  near(bandBounds.min.z, BALCONY.wrap.z1, 'band starts at the gallery wall');
  near(bandBounds.max.z, BALCONY.wrap.z2, 'band finishes at the existing deck edge');
  assert.equal(band.mesh.userData.collider, null, 'the fitted finish creates no new invisible obstacle');
  const record = fixture.records.get(band.id);
  assert.equal(record.supportKind, 'anchored');
  assert.deepEqual([...record.supports].sort(), ['balcony-wrap-beam', 'balcony-wrap-deck']);
  for (const [id, bottom, top] of [['balcony-wrap-beam', 0.4, 0.2], ['balcony-wrap-deck', 0.2, 0]]) {
    const slab = entry(id), slabBounds = bounds(slab);
    near(slabBounds.min.x, BALCONY.wrap.x1, `${id} west bound is unchanged`);
    near(slabBounds.max.x, BALCONY.wrap.x2, `${id} east bound is unchanged`);
    near(slabBounds.min.y, BALCONY.floorY - bottom, `${id} bottom is unchanged`);
    near(slabBounds.max.y, BALCONY.floorY - top, `${id} top is unchanged`);
    near(slab.mesh.userData.collider.max.x, slabBounds.max.x, `${id} collision remains at its authored edge`);
    assert.ok(bandBounds.clone().expandByScalar(1e-6).intersectsBox(slabBounds), `${id} physically supports the band`);
  }
  const neighbors = fixture.entries.filter(value => value.mesh === band.mesh
    || bounds(value).expandByScalar(1e-5).intersectsBox(bandBounds));
  const overlaps = findCoplanarBoxOverlaps(focused(neighbors), { minArea: 1e-6, differentMaterialsOnly: false })
    .filter(overlap => overlap.a.entry.mesh === band.mesh || overlap.b.entry.mesh === band.mesh)
    .map(overlap => ({ a: overlap.a.id, b: overlap.b.id, axis: overlap.axis, sign: overlap.sign, area: overlap.area }));
  assert.deepEqual(overlaps, [], 'The band adds no competing same-facing triangles');
});

test('real street and scaffold rays see the end band before the coincident concrete and brick ends', () => {
  const band = entry('balcony-wrap-end-band');
  const structural = [entry('balcony-wrap-beam').mesh, entry('balcony-wrap-deck').mesh, entry('main-ground-south').mesh];
  for (const height of [BALCONY.floorY - 0.3, BALCONY.floorY - 0.1]) {
    for (const z of [0.025, 0.075]) {
      const target = new THREE.Vector3(BALCONY.wrap.x2, height, z);
      const flatOrigin = target.clone().add(new THREE.Vector3(0.6, 0, 0));
      const flatRay = new THREE.Raycaster(flatOrigin, new THREE.Vector3(-1, 0, 0), 0, 0.8);
      const underlying = flatRay.intersectObjects(structural);
      const owners = new Set(underlying.filter(hit => Math.abs(hit.point.x - BALCONY.wrap.x2) < 1e-6)
        .map(hit => hit.object.userData.architectureId));
      assert.ok(owners.has('main-ground-south') && owners.has(height < BALCONY.floorY - 0.2
        ? 'balcony-wrap-beam' : 'balcony-wrap-deck'), 'The fixture includes the original concrete/brick conflict');
      // The existing annex belt course hides the lower patch from above and
      // the upper patch from below. Test the actual unobstructed views: street
      // looking up at the beam, and scaffold looking down at the deck edge.
      const observerY = height < BALCONY.floorY - 0.2 ? 2 : 4.6;
      for (const origin of [flatOrigin, new THREE.Vector3(BALCONY.wrap.x2 + 0.6, observerY, 0.4)]) {
        const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize(), 0, 4);
        const hits = ray.intersectObject(fixture.World, true);
        assert.ok(hits.length > 0, 'The actual world has a visible end surface');
        assert.ok(hits[0].object === band.mesh,
          `First visible owner is ${hits[0].object.name || hits[0].object.userData.architectureId || 'unnamed mesh'} from ${origin.toArray()}`);
        near(hits[0].point.x, BALCONY.wrap.x2 + 0.02, 'Visible face is physically outside both structural faces');
      }
    }
  }
});
