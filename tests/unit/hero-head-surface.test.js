import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHumanoidRig } from '../../src/render/humanoid-rig.js';

const ARCHETYPES = [
  { role: 'thug', kind: 'thug', height: 1.82, build: 1.05 },
  { role: 'brawler', kind: 'brawler', height: 1.78, build: 1 },
  { role: 'gunman', kind: 'gunman', height: 1.76, build: 0.98 },
  { role: 'bruiser', kind: 'bruiser', height: 1.94, build: 1.32 },
  { role: 'hitman', kind: 'hitman', height: 1.78, build: 1 },
  { role: 'enforcer', kind: 'bruiser', height: 1.92, build: 1.28 },
];
const fixtures = new Map();

function triangles(geometry, start = 0, count = (geometry.index?.count ?? geometry.attributes.position.count) / 3) {
  const position = geometry.attributes.position;
  return Array.from({ length: count }, (_, triangle) => [0, 1, 2].map(corner => {
    const index = (start + triangle) * 3 + corner;
    return new THREE.Vector3().fromBufferAttribute(position, geometry.index ? geometry.index.getX(index) : index);
  }));
}

function fixture(config) {
  if (fixtures.has(config.role)) return fixtures.get(config.role);
  const root = createHumanoidRig(config), rig = root.userData.rig;
  const head = rig.visualMeshes.find(mesh => mesh.name === 'hero-head');
  const details = rig.visualMeshes.find(mesh => mesh.name === 'hero-face-hair');
  const result = { head, details, skull: triangles(head.geometry) };
  fixtures.set(config.role, result); return result;
}

function firstHit(faces, ray) {
  const point = new THREE.Vector3(); let result = null;
  for (const [a, b, c] of faces) {
    // Match the rendered FrontSide material: an inverted cap must not pass.
    if (!ray.intersectTriangle(a, b, c, true, point)) continue;
    const distance = point.distanceTo(ray.origin);
    if (!result || distance < result.distance) result = {
      distance, point: point.clone(), normal: THREE.Triangle.getNormal(a, b, c, new THREE.Vector3()),
    };
  }
  return result;
}

function crownCenter(geometry) {
  const position = geometry.attributes.position, bounds = new THREE.Box3();
  const top = geometry.boundingBox.max.y;
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) >= top - 1e-6) bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, i));
  }
  return bounds.getCenter(new THREE.Vector3());
}

function hairSurface(details) {
  const surface = details.geometry.userData.surfaces?.hair;
  assert.ok(surface, 'The combined detail draw must identify its actual hair triangles');
  const total = (details.geometry.index?.count ?? details.geometry.attributes.position.count) / 3;
  assert.ok(Number.isInteger(surface.triangleStart) && surface.triangleStart >= 0);
  assert.ok(Number.isInteger(surface.triangleCount) && surface.triangleCount > 0);
  assert.ok(surface.triangleStart + surface.triangleCount <= total);
  return triangles(details.geometry, surface.triangleStart, surface.triangleCount);
}

function radialRay(center, point) {
  const direction = new THREE.Vector3(point.x - center.x, 0, point.z - center.z).normalize();
  const origin = new THREE.Vector3(center.x, point.y, center.z).addScaledVector(direction, 2);
  return new THREE.Ray(origin, direction.negate());
}

function metresPerUnit(ray, head) {
  return ray.direction.clone().multiply(head.scale).length();
}

function eyeSurfaces(details) {
  const eyes = details.geometry.userData.surfaces?.eyes;
  assert.ok(Array.isArray(eyes) && eyes.length === 2, 'Both rendered eyes must expose their actual surface ranges');
  const total = (details.geometry.index?.count ?? details.geometry.attributes.position.count) / 3;
  return [...eyes].sort((a, b) => a.center[0] - b.center[0]).map(eye => {
    assert.equal(eye.center.length, 2);
    const result = { center: eye.center };
    for (const name of ['sclera', 'iris', 'pupil', 'upperLid', 'lowerLid']) {
      const range = eye[name];
      assert.ok(range && Number.isInteger(range.triangleStart) && range.triangleStart >= 0);
      assert.ok(Number.isInteger(range.triangleCount) && range.triangleCount > 0);
      assert.ok(range.triangleStart + range.triangleCount <= total);
      result[name] = triangles(details.geometry, range.triangleStart, range.triangleCount);
    }
    return result;
  });
}

function surfaceBounds(faces) {
  const bounds = new THREE.Box3();
  for (const triangle of faces) for (const point of triangle) bounds.expandByPoint(point);
  return bounds;
}

function boundaryEdges(faces) {
  const edges = new Map();
  const key = point => point.toArray().map(value => Math.round(value * 1e7)).join(',');
  for (const triangle of faces) for (let i = 0; i < 3; i++) {
    const a = triangle[i], b = triangle[(i + 1) % 3], ak = key(a), bk = key(b);
    const id = ak < bk ? `${ak}:${bk}` : `${bk}:${ak}`;
    const edge = edges.get(id) || { a, b, count: 0 }; edge.count++; edges.set(id, edge);
  }
  return [...edges.values()].filter(edge => edge.count === 1);
}

function verticalOpening(edges, x) {
  const points = [];
  for (const { a, b } of edges) {
    if (Math.abs(b.x - a.x) < 1e-9) continue;
    const t = (x - a.x) / (b.x - a.x);
    if (t >= -1e-7 && t <= 1 + 1e-7) points.push(a.clone().lerp(b, Math.max(0, Math.min(1, t))));
  }
  assert.ok(points.length >= 2, 'The actual sclera boundary must enclose the sampled eye opening');
  points.sort((a, b) => a.y - b.y);
  return { lower: points[0], upper: points.at(-1) };
}

function triangleSamples([a, b, c]) {
  return [a, b, c, a.clone().add(b).multiplyScalar(0.5), b.clone().add(c).multiplyScalar(0.5),
    c.clone().add(a).multiplyScalar(0.5), a.clone().add(b).add(c).multiplyScalar(1 / 3)];
}

test('the rendered skull is one closed oriented surface after positional welding', () => {
  for (const config of ARCHETYPES) {
    const { head, skull } = fixture(config), position = head.geometry.attributes.position;
    const welded = new Map(), ids = [], edges = new Map(), used = new Set();
    for (let i = 0; i < position.count; i++) {
      const key = [position.getX(i), position.getY(i), position.getZ(i)].map(value => Math.round(value * 1e6)).join(',');
      if (!welded.has(key)) welded.set(key, welded.size);
      ids.push(welded.get(key));
    }
    const parents = Array.from({ length: welded.size }, (_, i) => i);
    const find = i => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
    const index = head.geometry.index, cross = new THREE.Vector3(); let signedVolume = 0;
    for (let i = 0; i < skull.length; i++) {
      const face = [0, 1, 2].map(corner => ids[index.getX(i * 3 + corner)]);
      assert.equal(new Set(face).size, 3, `${config.role}: coincident cap corners create a degenerate triangle`);
      const [a, b, c] = skull[i];
      assert.ok(cross.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).lengthSq() > 1e-20,
        `${config.role}: every drawn skull triangle needs nonzero area`);
      signedVolume += a.dot(cross.crossVectors(b, c)) / 6;
      for (let j = 0; j < 3; j++) {
        const a = face[j], b = face[(j + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const edge = edges.get(key) || { count: 0, direction: 0 };
        edge.count++; edge.direction += a < b ? 1 : -1; edges.set(key, edge);
        used.add(a); used.add(b); parents[find(a)] = find(b);
      }
    }
    for (const [key, edge] of edges) {
      assert.equal(edge.count, 2, `${config.role}: exposed/non-manifold skull edge ${key}`);
      assert.equal(edge.direction, 0, `${config.role}: inconsistent winding at skull edge ${key}`);
    }
    assert.equal(new Set([...used].map(find)).size, 1, 'The skull must not hide disconnected cap pieces');
    assert.equal(used.size - edges.size + skull.length, 2, 'The closed skull must not retain a crown or neck opening');
    assert.ok(signedVolume > 0, 'The closed skull must face outward');
    const cranium = new THREE.Box3(), point = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) >= 0.65 && position.getY(i) <= 0.82) cranium.expandByPoint(point.fromBufferAttribute(position, i));
    }
    const fullWidth = head.geometry.boundingBox.max.x - head.geometry.boundingBox.min.x;
    assert.ok(fullWidth <= (cranium.max.x - cranium.min.x) * 1.25, 'Ear cartilage must stay within the compact head silhouette');
  }
});

test('upward views below the chin hit the physical jaw underside', () => {
  for (const config of ARCHETYPES) {
    const { skull } = fixture(config);
    for (const x of [-0.06, 0, 0.06]) for (const z of [0.08, 0.15, 0.22]) {
      const hit = firstHit(skull, new THREE.Ray(new THREE.Vector3(x, -0.25, z), new THREE.Vector3(0, 1, 0)));
      assert.ok(hit, `${config.role}: the view below (${x}, ${z}) passes through an open chin`);
      assert.ok(hit.point.y >= -1e-6 && hit.point.y < 0.20, `${config.role}: the first visible surface must be the lower jaw`);
      assert.ok(hit.normal.y < -0.10, `${config.role}: the jaw underside must face the viewer below it`);
    }
  }
});

test('hair occludes the actual scalp around the crown and temples without extending above the authored height', () => {
  for (const config of ARCHETYPES) {
    const { head, details, skull } = fixture(config), hair = hairSurface(details), center = crownCenter(head.geometry);
    const hairBounds = new THREE.Box3();
    for (const triangle of hair) for (const point of triangle) hairBounds.expandByPoint(point);
    assert.ok(Math.max(hairBounds.max.y, head.geometry.boundingBox.max.y) <= 1 + 1e-6, 'Closed caps must preserve the authored crown height');
    assert.ok(hairBounds.max.y >= 0.99, 'The hair cap must still cover the crown');
    const checkOcclusion = (ray, label, allowAboveSkull = false) => {
      const cap = firstHit(hair, ray), skin = firstHit(skull, ray);
      assert.ok(cap, `${config.role}: hair is missing at ${label}`);
      if (!skin && allowAboveSkull && ray.origin.y > head.geometry.boundingBox.max.y) return;
      assert.ok(skin, `${config.role}: the skull is open at ${label}`);
      const clearance = (skin.distance - cap.distance) * metresPerUnit(ray, head);
      assert.ok(clearance > 1e-5, `${config.role}: hair/scalp clearance is ${clearance} m at ${label}`);
    };
    for (const y of [0.86, 0.90, 0.94, 0.97, 0.99]) for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      const point = new THREE.Vector3(center.x + Math.sin(angle), y, center.z + Math.cos(angle));
      checkOcclusion(radialRay(center, point), `height ${y}, azimuth ${i * 45}`, true);
    }
    // The small off-axis sample also covers the old tiny crown opening while
    // avoiding exact fan edges. Strict ordering rejects coplanar cap surfaces.
    for (const x of [-0.04, 0.00017, 0.04]) for (const z of [-0.05, 0.00023, 0.05]) {
      checkOcclusion(new THREE.Ray(new THREE.Vector3(center.x + x, 1.25, center.z + z), new THREE.Vector3(0, -1, 0)),
        `crown offset (${x}, ${z})`);
    }
    const temples = hair.filter(triangle => {
      const midpoint = triangle[0].clone().add(triangle[1]).add(triangle[2]).multiplyScalar(1 / 3);
      return midpoint.y >= 0.58 && midpoint.y <= 0.84 && Math.abs(midpoint.x - center.x) > 0.20;
    });
    assert.ok(temples.length >= 8, 'Coverage checks must include actual temple triangles');
    const stride = Math.max(1, Math.ceil(temples.length / 24));
    for (let i = 0; i < temples.length; i += stride) {
      const triangle = temples[i], midpoint = triangle[0].clone().add(triangle[1]).add(triangle[2]).multiplyScalar(1 / 3);
      checkOcclusion(radialRay(center, midpoint), `temple triangle ${i}`);
      for (const vertex of triangle) {
        const ray = radialRay(center, vertex), skin = firstHit(skull, ray);
        assert.ok(skin, `${config.role}: temple vertex has no underlying skull`);
        const separation = (skin.distance - vertex.distanceTo(ray.origin)) * metresPerUnit(ray, head);
        // A boundary vertex can meet skin at the hairline; it must not sink
        // into the scalp. Interior triangle and crown checks are stricter.
        assert.ok(separation >= -1e-4, `${config.role}: a temple hair vertex penetrates scalp by ${-separation} m`);
      }
    }
  }
});

test('actual eye openings are restrained, pupils are round in metres, and coloured eye surfaces stay inside the opening', () => {
  for (const config of ARCHETYPES) {
    const { details } = fixture(config), scale = details.scale;
    for (const [side, eye] of eyeSurfaces(details).entries()) {
      assert.ok(Math.abs(eye.center[0] - (side ? 0.175 : -0.175)) < 1e-6);
      assert.ok(Math.abs(eye.center[1] - 0.554) < 1e-6, 'Eye polishing must preserve the established gaze center');
      const opening = surfaceBounds(eye.sclera), size = opening.getSize(new THREE.Vector3()).multiply(scale);
      assert.ok(size.x >= 0.023 && size.x <= 0.031, `${config.role}: rendered eye width is ${size.x} m`);
      assert.ok(size.y >= 0.008 && size.y <= 0.012, `${config.role}: rendered eye opening is too tall or too narrow at ${size.y} m`);
      assert.ok(size.y / size.x >= 0.30 && size.y / size.x <= 0.45, 'The exposed sclera must not return to a tall white disk');

      const pupilBounds = surfaceBounds(eye.pupil), pupilCenter = pupilBounds.getCenter(new THREE.Vector3());
      assert.ok(Math.abs(pupilCenter.x - eye.center[0]) * scale.x < 1e-5);
      assert.ok(Math.abs(pupilCenter.y - eye.center[1]) * scale.y < 1e-5);
      const radii = boundaryEdges(eye.pupil).flatMap(edge => [edge.a, edge.b]).map(point =>
        Math.hypot((point.x - eye.center[0]) * scale.x, (point.y - eye.center[1]) * scale.y));
      assert.ok(radii.length >= 16 && Math.min(...radii) > 0);
      assert.ok(Math.min(...radii) / Math.max(...radii) >= 0.95,
        `${config.role}: visible pupil boundary must remain round after actual head scaling`);

      // Check the rendered triangle union, not the equation used to clip it.
      // Metric XY makes the tolerance independent of head size and aspect.
      const metric = point => new THREE.Vector3(point.x * scale.x, point.y * scale.y, 0);
      const white = eye.sclera.map(triangle => new THREE.Triangle(...triangle.map(metric))).filter(triangle => triangle.getArea() > 1e-14);
      const closest = new THREE.Vector3();
      assert.ok(white.length > 0);
      for (const name of ['iris', 'pupil']) for (const triangle of eye[name]) for (const point of triangleSamples(triangle)) {
        const sample = metric(point); let distance = Infinity;
        for (const surface of white) distance = Math.min(distance, surface.closestPointToPoint(sample, closest).distanceTo(sample));
        assert.ok(distance <= 0.00005, `${config.role}: ${name} spills ${distance} m beyond the actual opening at (${point.x}, ${point.y})`);
      }
    }
  }
});

test('opposing eyelids cover the actual upper and lower rims while preserving the visible centered gaze', () => {
  for (const config of ARCHETYPES) {
    const { details, skull } = fixture(config);
    for (const eye of eyeSurfaces(details)) {
      const bounds = surfaceBounds(eye.sclera), edges = boundaryEdges(eye.sclera);
      for (const fraction of [0.10, 0.20, 0.35, 0.50, 0.65, 0.80, 0.90]) {
        const x = bounds.min.x + (bounds.max.x - bounds.min.x) * fraction;
        const rim = verticalOpening(edges, x);
        for (const upper of [true, false]) {
          const point = rim[upper ? 'upper' : 'lower'];
          // Nudge 0.01 mm into the opening to avoid exact triangle-edge ties.
          const y = point.y + (upper ? -1 : 1) * 0.00001 / details.scale.y;
          const ray = new THREE.Ray(new THREE.Vector3(x, y, 2), new THREE.Vector3(0, 0, -1));
          const lid = firstHit(eye[upper ? 'upperLid' : 'lowerLid'], ray);
          assert.ok(lid, `${config.role}: ${upper ? 'upper' : 'lower'} lid leaves the rim exposed at (${x}, ${point.y})`);
          assert.ok(lid.point.z > point.z + 1e-5, `${config.role}: the lid must lie ahead of the sclera rim`);
        }
      }
      const ray = new THREE.Ray(new THREE.Vector3(eye.center[0], eye.center[1], 2), new THREE.Vector3(0, 0, -1));
      const pupil = firstHit(eye.pupil, ray), iris = firstHit(eye.iris, ray), white = firstHit(eye.sclera, ray);
      const skin = firstHit(skull, ray), lid = firstHit([...eye.upperLid, ...eye.lowerLid], ray);
      assert.ok(pupil && iris && white && skin, `${config.role}: the centered gaze must have real visible eye layers`);
      assert.ok(pupil.distance < iris.distance && iris.distance < white.distance && pupil.distance < skin.distance);
      assert.ok(!lid || lid.distance > pupil.distance, 'A lid must not cross and cover the centered pupil');
    }
  }
});
