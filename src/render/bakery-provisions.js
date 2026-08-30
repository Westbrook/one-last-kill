import * as THREE from 'three';
import { furnitureBox } from './furniture-geometry.js';
import { getBakeryProvisionMaterials, BAKERY_PROVISION_ATLAS } from './bakery-provision-materials.js';

const cache = new Map();
const keyOf = values => values.map(value => typeof value === 'number' ? value.toFixed(6) : value).join(':');

function cached(key, create) {
  if (!cache.has(key)) {
    const geometry = create();
    geometry.computeBoundingBox(); geometry.computeBoundingSphere(); cache.set(key, geometry);
  }
  return cache.get(key);
}

function dimensions(...values) {
  if (values.some(value => !Number.isFinite(value) || value <= 0)) throw new RangeError('Bakery provision dimensions must be positive');
}

function atlasUV(cell, u, v) {
  return [THREE.MathUtils.lerp(cell.uMin, cell.uMax, u), THREE.MathUtils.lerp(cell.vMin, cell.vMax, v)];
}

function smoothWrapNormals(geometry, rings, radial, offset = 1) {
  const normal = geometry.attributes.normal, first = new THREE.Vector3(), last = new THREE.Vector3();
  for (let ring = 0; ring < rings; ring++) {
    const start = offset + ring * (radial + 1), end = start + radial;
    first.fromBufferAttribute(normal, start); last.fromBufferAttribute(normal, end);
    first.add(last).normalize(); normal.setXYZ(start, first.x, first.y, first.z); normal.setXYZ(end, first.x, first.y, first.z);
  }
}

/**
 * A flattened loaf with a real bearing patch and raised, opened score lips.
 * Retail outlines use the original ten-sided sphere footprint exactly; prep
 * loaves stay within their original 30×20 cm board allocation.
 */
export function bakeryBreadGeometry(width, height, depth, variant = 0, retail = false) {
  dimensions(width, height, depth);
  return cached(keyOf(['bread', width, height, depth, variant, retail]), () => {
    const radial = 20, row = radial + 1, bodyHeight = height - Math.min(0.005, height * 0.05);
    const positions = [0, bodyHeight, 0], uv = [], indices = [];
    const crust = BAKERY_PROVISION_ATLAS.bread.cells[variant % 2], crumb = BAKERY_PROVISION_ATLAS.bread.crumb;
    uv.push(...atlasUV(crust, 0.5, 0.5));
    const rings = [[0.28, 0.97], [0.55, 0.84], [0.78, 0.63], [1, 0.18], [0.83, 0]];
    for (const [radius, elevation] of rings) {
      for (let i = 0; i <= radial; i++) {
        const angle = -i / radial * Math.PI * 2;
        let x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
        if (retail) {
          const sector = Math.PI * 2 / 10;
          const mid = Math.floor((angle + Math.PI * 2) / sector) * sector + sector / 2;
          const limit = Math.cos(sector / 2) / Math.cos(angle + Math.PI * 2 - mid);
          if (radius > limit) { x *= limit / radius; z *= limit / radius; }
        }
        positions.push(x * width / 2, elevation * bodyHeight, z * depth / 2);
        uv.push(...atlasUV(crust, x * 0.5 + 0.5, z * 0.5 + 0.5));
      }
    }
    for (let i = 0; i < radial; i++) indices.push(0, 1 + i, 2 + i);
    for (let ring = 0; ring < rings.length - 1; ring++) for (let i = 0; i < radial; i++) {
      const a = 1 + ring * row + i, b = a + row;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const bottom = positions.length / 3; positions.push(0, 0, 0); uv.push(...atlasUV(crust, 0.5, 0.5));
    const base = 1 + (rings.length - 1) * row;
    for (let i = 0; i < radial; i++) indices.push(bottom, base + i + 1, base + i);
    const bodyIndices = indices.length;

    // Fit scored crust to the actual triangulated dome, not an analytic oval
    // that would leave strips hovering over a coarse mesh between its rings.
    function surfaceY(x, z) {
      let height = 0;
      for (let i = 0; i < bodyIndices; i += 3) {
        const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
        const denominator = (positions[b + 2] - positions[c + 2]) * (positions[a] - positions[c])
          + (positions[c] - positions[b]) * (positions[a + 2] - positions[c + 2]);
        if (Math.abs(denominator) < 1e-10) continue;
        const u = ((positions[b + 2] - positions[c + 2]) * (x - positions[c])
          + (positions[c] - positions[b]) * (z - positions[c + 2])) / denominator;
        const v = ((positions[c + 2] - positions[a + 2]) * (x - positions[c])
          + (positions[a] - positions[c]) * (z - positions[c + 2])) / denominator;
        if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8) {
          height = Math.max(height, u * positions[a + 1] + v * positions[b + 1] + (1 - u - v) * positions[c + 1]);
        }
      }
      return height;
    }
    const scoreCount = retail ? 4 : 3, segments = 8, across = 4;
    for (let cut = 0; cut < scoreCount; cut++) {
      const start = positions.length / 3, cx = (cut - (scoreCount - 1) / 2) * width * 0.19;
      for (let i = 0; i <= segments; i++) {
        const t = i / segments, z = (t - 0.5) * depth * 0.65, center = cx + z * 0.25;
        const opening = Math.max(0.015, Math.sin(t * Math.PI)) * Math.min(0.012, width * 0.045);
        for (let edge = 0; edge < across; edge++) {
          const x = center + [-1, -0.32, 0.32, 1][edge] * opening;
          const lip = [0.0005, 0.0038, 0.001, 0.0005][edge] * Math.sin(t * Math.PI);
          positions.push(x, surfaceY(x, z) + lip + 0.00015, z);
          uv.push(...atlasUV(crumb, 0.20 + edge * 0.16, 0.12 + t * 0.76));
        }
      }
      for (let i = 0; i < segments; i++) for (let edge = 0; edge < across - 1; edge++) {
        const a = start + i * across + edge, b = a + across;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices); geometry.computeVertexNormals(); smoothWrapNormals(geometry, rings.length, radial);
    geometry.userData.bakeryProvision = { kind: 'bread', width, height, depth, variant, retail, bodyIndices, scores: scoreCount };
    return geometry;
  });
}

function mapPackage(geometry, variant) {
  // Keep each triangle wholly inside one atlas island. Per-vertex normal
  // classification would interpolate paper and label cells across bevels.
  if (geometry.index) geometry = geometry.toNonIndexed();
  const { position, normal, uv } = geometry.attributes;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox, size = bounds.getSize(new THREE.Vector3());
  const atlas = BAKERY_PROVISION_ATLAS.packages;
  for (let face = 0; face < uv.count; face += 3) {
    const front = (normal.getZ(face) + normal.getZ(face + 1) + normal.getZ(face + 2)) / 3 < -0.65;
    const cell = front ? atlas[variant % 2 ? 'kraft' : 'flour'] : atlas.plain;
    for (let i = face; i < face + 3; i++) {
      const u = front ? (bounds.max.x - position.getX(i)) / size.x : uv.getX(i);
      const v = front ? (position.getY(i) - bounds.min.y) / size.y : uv.getY(i);
      uv.setXY(i, ...atlasUV(cell, Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v))));
    }
  }
  return geometry;
}

export function bakeryPackageGeometry(width, height, depth, variant = 0) {
  dimensions(width, height, depth);
  return cached(keyOf(['package', width, height, depth, variant]), () => {
    let geometry;
    const bag = variant % 3 === 0;
    if (!bag) {
      geometry = furnitureBox(width, height, depth, 0.006, 1).clone(); geometry.translate(0, height / 2, 0);
    } else {
      const cross = [[-0.72, -1], [0, -0.94], [0.72, -1], [1, -0.60], [1, 0.60],
        [0.72, 1], [0, 0.94], [-0.72, 1], [-1, 0.60], [-1, -0.60]];
      const levels = [[0, 0.84, 0.84], [0.15, 1, 1], [0.72, 0.95, 0.87], [0.91, 0.83, 0.38], [1, 0.9, 0.26]];
      const positions = [], uv = [], indices = [], row = cross.length + 1;
      for (const [y, sx, sz] of levels) for (let i = 0; i <= cross.length; i++) {
        const [x, z] = cross[i % cross.length];
        positions.push(x * width / 2 * sx, y * height, z * depth / 2 * sz); uv.push(i / cross.length, y);
      }
      for (let ring = 0; ring < levels.length - 1; ring++) for (let i = 0; i < cross.length; i++) {
        const a = ring * row + i, b = a + row;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
      for (const [ring, up] of [[0, false], [levels.length - 1, true]]) {
        const center = positions.length / 3; positions.push(0, levels[ring][0] * height, 0); uv.push(0.5, 0.5);
        for (let i = 0; i < cross.length; i++) {
          const a = ring * row + i;
          if (up) indices.push(center, a + 1, a); else indices.push(center, a, a + 1);
        }
      }
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
      smoothWrapNormals(geometry, levels.length, cross.length, 0);
    }
    geometry = mapPackage(geometry, variant);
    geometry.userData.bakeryProvision = { kind: bag ? 'flour-sack' : 'paper-box', width, height, depth, variant };
    return geometry;
  });
}

export function addBakeryBread(pushDecor, { x, topY, z, width, height, depth, yaw = 0, variant = 0, retail = false }) {
  pushDecor(bakeryBreadGeometry(width, height, depth, variant, retail), getBakeryProvisionMaterials().bread, x, topY, z, 1, 1, 1, yaw);
}

export function addBakeryPackage(pushDecor, { x, topY, z, variant = 0, minX = -Infinity, maxX = Infinity }) {
  const bag = variant % 3 === 0;
  // End slots in the original shelving ran into their side stiles. Fit the
  // paper stock inside both the old slot footprint and the usable shelf bay.
  const low = Math.max(x - 0.195, minX), high = Math.min(x + 0.195, maxX);
  const width = Math.min(bag ? 0.28 : variant % 2 ? 0.39 : 0.34, high - low);
  const height = bag ? 0.23 : variant % 2 ? 0.19 : 0.215, depth = bag ? 0.17 : 0.18;
  const center = THREE.MathUtils.clamp(x, low + width / 2, high - width / 2);
  pushDecor(bakeryPackageGeometry(width, height, depth, variant % 6), getBakeryProvisionMaterials().packages, center, topY, z, 1, 1, 1);
}

export function bakeryProvisionGeometryBudget() {
  let triangles = 0, bytes = 0;
  for (const geometry of cache.values()) {
    triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    bytes += Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
    bytes += geometry.index?.array.byteLength ?? 0;
  }
  return { geometries: cache.size, triangles, bytes };
}
