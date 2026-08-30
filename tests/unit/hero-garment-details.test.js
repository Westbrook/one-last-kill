import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { humanoidDimensions, createHumanoidRig, resetHumanoidPose, updateHumanoidPose } from '../../src/render/humanoid-rig.js';
import { heroGarmentDetails } from '../../src/render/hero-garment-details.js';

const archetypes = [
  { role: 'brawler', height: 1.78, build: 1 }, { role: 'thug', height: 1.82, build: 1.05 },
  { role: 'gunman', height: 1.76, build: 0.98 }, { role: 'hitman', height: 1.78, build: 1 },
  { role: 'bruiser', height: 1.94, build: 1.32 }, { role: 'enforcer', height: 1.92, build: 1.28 },
];
const palette = Object.fromEntries(['shirt', 'pants', 'trim', 'equipment', 'belt', 'boot', 'sole']
  .map((name, i) => [name, new THREE.Color().setHSL(0.17, 0.10, 0.17 + i * 0.025)]));
const validBones = new Set(['chest', 'spine', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR']);

function fixture(config) {
  const dimensions = humanoidDimensions(config), h = dimensions.height;
  // A deliberately curved, tapering garment surface catches panels that only
  // sample their corners and then cut straight chords through the torso.
  const frontAt = (x, y) => {
    const chest = Math.exp(-(((y / h - 0.74) / 0.13) ** 2));
    const rx = (0.102 + chest * 0.024) * h * dimensions.width;
    return Math.sqrt(Math.max(0, 1 - (x / rx) ** 2)) * (0.061 + chest * 0.014) * h * dimensions.width;
  };
  return { dimensions, role: config.role, palette, frontAt };
}

function inspectTriangles(mesh, callback) {
  const position = mesh.attributes.position, index = mesh.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const normal = new THREE.Vector3(), edge = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i)); b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    normal.subVectors(b, a).cross(edge.subVectors(c, a)); callback(a, b, c, normal);
  }
}

test('each garment construction stays below 800 triangles and supplies only mergeable geometry', () => {
  for (const config of archetypes) {
    const parts = heroGarmentDetails(fixture(config));
    const triangles = parts.reduce((sum, part) => sum + part.geometry.index.count / 3, 0);
    assert.ok(triangles > 250 && triangles <= 800, `${config.role}: ${triangles} triangles`);
    assert.equal(parts.userData.triangles, triangles); assert.equal(parts.userData.role, config.role);
    assert.equal(new Set(parts.map(part => part.name)).size, parts.length);
    for (const part of parts) {
      assert.equal(part.isObject3D, undefined); assert.equal(part.material, undefined);
      assert.ok(part.geometry.isBufferGeometry); assert.equal(part.geometry.name, part.name);
      assert.equal(part.geometry.userData.garmentPart, part.name);
    }
    const names = new Set(parts.map(part => part.name));
    assert.ok(names.has('sleeve-hem.L') && names.has('sleeve-hem.R') && names.has('neck-fold'));
    if (config.role === 'brawler') assert.ok(names.has('shirt-bottom-hem'));
    else if (config.role === 'thug') assert.ok(names.has('jacket-zip-placket') && names.has('jacket-pocket-welt.L'));
    else if (['bruiser', 'enforcer'].includes(config.role)) {
      for (const name of ['vest-front-panel', 'vest-back-panel', 'vest-shoulder-strap.L', 'vest-pouch-flap.R']) assert.ok(names.has(name));
    } else assert.ok(names.has('shirt-button-placket') && names.has('shirt-patch-pocket') && names.has('folded-collar.L'));
  }
});

test('folds, seams and panels are closed surfaces with outward winding and valid skin weights', () => {
  for (const config of archetypes) for (const { name, geometry, weightFor, colorFor } of heroGarmentDetails(fixture(config))) {
    let signedVolume = 0;
    inspectTriangles(geometry, (a, b, c, normal) => {
      assert.ok(normal.lengthSq() > 1e-14, `${config.role}/${name}: degenerate triangle`);
      signedVolume += a.dot(normal) / 6;
    });
    assert.ok(signedVolume > 0, `${config.role}/${name}: inward winding`);
    const edges = new Map(), index = geometry.index;
    for (let i = 0; i < index.count; i += 3) for (let j = 0; j < 3; j++) {
      const a = index.getX(i + j), b = index.getX(i + (j + 1) % 3), key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const edge = edges.get(key) || { count: 0, direction: 0 };
      edge.count++; edge.direction += a < b ? 1 : -1; edges.set(key, edge);
    }
    for (const edge of edges.values()) { assert.equal(edge.count, 2, `${name}: open seam`); assert.equal(edge.direction, 0); }
    const { position, normal } = geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      for (const value of [x, y, z]) assert.ok(Number.isFinite(value));
      assert.ok(Math.abs(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) - 1) < 1e-5);
      const weights = Object.entries(weightFor(x, y, z));
      assert.ok(weights.length > 0 && weights.length <= 4);
      for (const [bone, weight] of weights) { assert.ok(validBones.has(bone)); assert.ok(Number.isFinite(weight) && weight >= 0 && weight <= 1); }
      assert.ok(Math.abs(weights.reduce((sum, [, weight]) => sum + weight, 0) - 1) < 1e-8);
      const color = colorFor(x, y, z);
      assert.ok(color.isColor && Number.isFinite(color.r + color.g + color.b));
    }
  }
});

test('sleeve hems follow the A-pose arm endpoint and keep blended wrist influences', () => {
  for (const config of archetypes) {
    const setup = fixture(config), d = setup.dimensions, armLength = d.upperArmLength + d.forearmLength;
    for (const part of heroGarmentDetails(setup).filter(part => part.name.startsWith('sleeve-hem'))) {
      const side = part.name.endsWith('L') ? 'L' : 'R', sign = side === 'L' ? -1 : 1, position = part.geometry.attributes.position;
      let first = Infinity, last = -Infinity, wristBlend = false;
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
        const t = ((x - sign * d.shoulderSpacing) * sign * Math.sin(0.45) - (y - d.shoulderY) * Math.cos(0.45)) / armLength;
        first = Math.min(first, t); last = Math.max(last, t);
        const weights = part.weightFor(x, y, z);
        if (weights[`elbow${side}`] > 0.01 && weights[`wrist${side}`] > 0.01) wristBlend = true;
      }
      assert.ok(Math.abs(first - (config.role === 'brawler' ? 0.320 : 0.940)) < 1e-6);
      assert.ok(Math.abs(last - (config.role === 'brawler' ? 0.381 : 0.983)) < 1e-6);
      assert.equal(wristBlend, config.role !== 'brawler');
    }
  }
});

test('front and back armor faces conform to a curved body without cutting through it', () => {
  for (const config of archetypes.filter(config => ['bruiser', 'enforcer'].includes(config.role))) {
    const setup = fixture(config), center = new THREE.Vector3();
    const parts = heroGarmentDetails(setup);
    for (const part of parts.filter(part => ['vest-front-panel', 'vest-back-panel'].includes(part.name))) {
      const side = part.name.includes('back') ? -1 : 1;
      inspectTriangles(part.geometry, (a, b, c, normal) => {
        if (normal.z * side / normal.length() < 0.60) return;
        center.copy(a).add(b).add(c).divideScalar(3);
        const gap = center.z * side - setup.frontAt(center.x, center.y);
        assert.ok(gap >= -0.0002, `${config.role}/${part.name}: panel cuts ${-gap}m into the shirt`);
      });
    }
    const shifted = heroGarmentDetails({ ...setup, frontAt: (x, y) => setup.frontAt(x, y) + 0.003 });
    const before = parts.find(part => part.name === 'vest-front-panel').geometry.attributes.position;
    const after = shifted.find(part => part.name === 'vest-front-panel').geometry.attributes.position;
    for (let i = 0; i < before.count; i++) assert.ok(Math.abs(after.getZ(i) - before.getZ(i) - 0.003) < 1e-7);
  }
});

test('integrated panels and pockets remain outside the actual extracted body triangles', () => {
  let checked = 0;
  for (const config of archetypes) {
    const rig = createHumanoidRig(config).userData.rig;
    const garment = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments').geometry;
    const body = new THREE.BufferGeometry();
    body.setAttribute('position', garment.attributes.position);
    body.setIndex(Array.from(garment.index.array.slice(0, rig.hero.continuousSurfaceTriangles * 3)));
    body.computeBoundingBox(); body.computeBoundingSphere();
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), mesh = new THREE.Mesh(body, material);
    mesh.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(), origin = new THREE.Vector3(), direction = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const center = new THREE.Vector3(), normal = new THREE.Vector3(), edge = new THREE.Vector3();
    let offset = rig.hero.continuousSurfaceTriangles * 3;
    try {
      for (const part of rig.hero.garmentDetails.parts) {
        const count = part.triangles * 3, side = part.name === 'vest-back-panel' ? -1 : 1;
        if (/panel|pouch|placket|patch-pocket|pocket-flap|webbing/.test(part.name)) {
          for (let i = offset; i < offset + count; i += 3) {
            a.fromBufferAttribute(garment.attributes.position, garment.index.getX(i));
            b.fromBufferAttribute(garment.attributes.position, garment.index.getX(i + 1));
            c.fromBufferAttribute(garment.attributes.position, garment.index.getX(i + 2));
            normal.subVectors(b, a).cross(edge.subVectors(c, a)).normalize();
            if (normal.z * side < 0.60) continue;
            center.copy(a).add(b).add(c).divideScalar(3);
            ray.set(origin.set(center.x, center.y, side * 2), direction.set(0, 0, -side));
            const hit = ray.intersectObject(mesh, false)[0];
            assert.ok(hit, `${config.role}/${part.name}: sewn detail has no underlying shirt`);
            const gap = (center.z - hit.point.z) * side;
            assert.ok(gap >= 0, `${config.role}/${part.name}: cloth intersects the extracted body by ${-gap}m`);
            assert.ok(gap <= 0.023, `${config.role}/${part.name}: detail floats ${gap}m beyond the shirt`);
            checked++;
          }
        }
        offset += count;
      }
    } finally {
      body.dispose(); material.dispose();
    }
  }
  assert.ok(checked > 600, 'The check must inspect real sewn surfaces across the full enemy roster');
});

test('the extracted body closes its shoulder and ankle boundaries across the full roster', () => {
  for (const config of archetypes) {
    const rig = createHumanoidRig(config).userData.rig;
    const garment = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments').geometry;
    const body = new THREE.BufferGeometry();
    body.setAttribute('position', garment.attributes.position);
    body.setIndex(Array.from(garment.index.array.slice(0, rig.hero.continuousSurfaceTriangles * 3)));
    const index = body.index, edges = new Map(), vertices = new Set();
    let volume = 0;
    inspectTriangles(body, (a, b, c, normal) => {
      assert.ok(Number.isFinite(normal.lengthSq()) && normal.lengthSq() > 0, `${config.role}: degenerate extracted triangle`);
      volume += a.dot(normal) / 6;
    });
    assert.ok(volume > 0, `${config.role}: extracted body must face outward`);
    for (let i = 0; i < index.count; i += 3) for (let j = 0; j < 3; j++) {
      const a = index.getX(i + j), b = index.getX(i + (j + 1) % 3), key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const edge = edges.get(key) || { count: 0, direction: 0 };
      edge.count++; edge.direction += a < b ? 1 : -1; edges.set(key, edge); vertices.add(a);
    }
    for (const edge of edges.values()) {
      assert.equal(edge.count, 2, `${config.role}: extracted shoulder or ankle boundary remains open`);
      assert.equal(edge.direction, 0, `${config.role}: adjoining body faces disagree on winding`);
    }
    const bounds = new THREE.Box3(), vertex = new THREE.Vector3();
    for (const i of vertices) bounds.expandByPoint(vertex.fromBufferAttribute(body.attributes.position, i));
    assert.ok(Math.abs(bounds.min.y / config.height - 0.056) < 1e-6, `${config.role}: trousers must include their lower caps`);
    assert.ok(bounds.max.y > config.height * 0.838, `${config.role}: the upper shoulder is still clipped`);
    assert.ok(bounds.min.y > config.height * 0.04 && bounds.max.y < config.height * 0.875,
      'All extracted surfaces must stay inside the usable field bounds');

    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), mesh = new THREE.Mesh(body, material);
    mesh.updateMatrixWorld(true);
    try {
      const ray = new THREE.Raycaster();
      for (const sign of [-1, 1]) {
        ray.set(new THREE.Vector3(sign * 0.13 * config.height * rig.dimensions.width, config.height, config.height * 0.010),
          new THREE.Vector3(0, -1, 0));
        const cap = ray.intersectObject(mesh, false)[0];
        // The tailored tee intentionally lowers its outer shoulder cap;
        // keep the original height control for every unchanged archetype.
        const capFloor = config.role === 'brawler' ? 0.820 : 0.835;
        assert.ok(cap && cap.point.y > config.height * capFloor,
          `${config.role}: a top-down shoulder ray must hit the restored cap, not the lower inside of the sleeve`);
      }
    } finally {
      body.dispose(); material.dispose();
    }
  }
});

test('actual short-sleeve surfaces cover the upper cuff seam in oblique resting and fist views', () => {
  const root = createHumanoidRig({ role: 'brawler', kind: 'brawler', height: 1.78, build: 1 });
  const rig = root.userData.rig, d = rig.dimensions, h = d.height, armLength = d.upperArmLength + d.forearmLength;
  const garments = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments');
  const skin = rig.visualMeshes.find(mesh => mesh.name === 'hero-skin');
  const material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
  const vertex = new THREE.Vector3(), center = new THREE.Vector3(), radial = new THREE.Vector3();
  const axis = new THREE.Vector3(), outward = new THREE.Vector3(), target = new THREE.Vector3();
  const origin = new THREE.Vector3(), direction = new THREE.Vector3(), transform = new THREE.Matrix4();
  const ray = new THREE.Raycaster();
  const poseGeometry = source => {
    const geometry = new THREE.BufferGeometry(), positions = new Float32Array(source.geometry.attributes.position.count * 3);
    for (let i = 0; i < source.geometry.attributes.position.count; i++) {
      source.getVertexPosition(i, vertex).applyMatrix4(source.matrixWorld); vertex.toArray(positions, i * 3);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(Array.from(source.geometry.index.array)); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material); mesh.updateMatrixWorld(true); return mesh;
  };
  const poses = [
    ['bind', null], ['rest', null], ['idle', { mode: 'idle' }], ['guard', { mode: 'fist', alert: 1 }],
    ['windup', { mode: 'fist', alert: 1, swingProgress: 0.18, swingSide: 'L' }],
    ['contact', { mode: 'fist', alert: 1, swingProgress: 0.50, swingSide: 'L' }],
    ['recovery', { mode: 'fist', alert: 1, swingProgress: 0.78, swingSide: 'L' }],
  ];
  let checked = 0;
  try {
    for (const [name, state] of poses) {
      resetHumanoidPose(root);
      if (name === 'bind') { rig.joints.shoulderL.rotation.z = -0.45; rig.joints.shoulderR.rotation.z = 0.45; }
      else if (state) for (let frame = 0; frame < 30; frame++) updateHumanoidPose(root, state, 1 / 60);
      root.updateMatrixWorld(true);
      const cloth = poseGeometry(garments), armSkin = poseGeometry(skin);
      try {
        for (const [side, sign] of [['L', -1], ['R', 1]]) {
          const shoulder = rig.joints[`shoulder${side}`], bone = rig.hero.skeleton.bones.indexOf(shoulder);
          transform.multiplyMatrices(shoulder.matrixWorld, rig.hero.skeleton.boneInverses[bone]);
          axis.set(sign * Math.sin(0.45), -Math.cos(0.45), 0).transformDirection(transform);
          // Off-axis samples avoid a ray lying exactly on a triangle edge.
          for (const angle of [35, 65, 95, 125, 155]) for (const t of [0.354, 0.358, 0.362, 0.366, 0.370, 0.374, 0.378]) {
            const around = angle * Math.PI / 180;
            center.set(sign * d.shoulderSpacing + sign * Math.sin(0.45) * t * armLength,
              d.shoulderY - Math.cos(0.45) * t * armLength, 0).applyMatrix4(transform);
            radial.set(sign * Math.sin(around) * Math.cos(0.45), Math.sin(around) * Math.sin(0.45), Math.cos(around))
              .transformDirection(transform);
            ray.set(origin.copy(center).addScaledVector(radial, h * 0.09), direction.copy(radial).negate()); ray.far = h * 0.09;
            const underlying = ray.intersectObject(armSkin, false)[0];
            assert.ok(underlying && underlying.point.distanceTo(center) < h * 0.045, 'The coverage target must be actual upper-arm skin');
            target.copy(underlying.point);
            // Look from above and radially through the upper seam. Views up
            // the open lower cuff are intentionally allowed to show the arm.
            for (const tilt of [-45, -30, -15, 0]) {
              const elevation = tilt * Math.PI / 180;
              outward.copy(radial).multiplyScalar(Math.cos(elevation)).addScaledVector(axis, Math.sin(elevation));
              ray.set(origin.copy(target).addScaledVector(outward, h * 0.6), direction.copy(outward).negate()); ray.far = h * 0.61;
              const visibleSkin = ray.intersectObject(armSkin, false)[0];
              if (!visibleSkin || visibleSkin.point.distanceTo(target) >= h * 0.02) continue;
              const visibleCloth = ray.intersectObject(cloth, false)[0];
              assert.ok(visibleCloth && visibleCloth.distance <= visibleSkin.distance + 1e-5,
                `${name}/${side}: skin is exposed above the cuff at angle ${angle}, tilt ${tilt}, arm t=${t}`);
              checked++;
            }
          }
        }
      } finally { cloth.geometry.dispose(); armSkin.geometry.dispose(); }
    }
  } finally { material.dispose(); }
  assert.ok(checked > 1500, 'The test must compare actual visible surfaces across both arms and all poses');
});
