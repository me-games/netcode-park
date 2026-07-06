// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TS port of the ecctrl controller (pure math helpers: value remapping,
// antipodal-safe vector slerp, and the weighted-Hermite curve LUT used by the
// tire slip curves, engine torque curve, steer-angle curve, and the character's
// platform mass-ratio falloff).

import * as THREE from "three";

/**
 * Linearly remap `value` from the range [inMin, inMax] to [outMin, outMax].
 *
 * Deliberately does NOT clamp — out-of-range input extrapolates linearly.
 * The tire static-friction blend relies on this pass-through behavior.
 */
export const remap = (
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
) => {
  return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
};

/**
 * Build a tunable falloff curve `x => a * exp(-((x + c) / d) ** t) + b`.
 *
 * Tuning hints: `a` sets the peak height, `b` the floor the curve settles to,
 * `c` shifts the curve left/right, `d` stretches it wider, and `t` controls
 * how sharply it drops (higher = steeper cliff).
 */
export const dynamicCurve = (
  a: number,
  b: number,
  c: number,
  d: number,
  t: number
) => {
  return (x: number) => a * Math.exp(-Math.pow((x + c) / d, t)) + b;
};

/**
 * Create a spherical-lerp function for unit direction vectors that stays
 * stable even when `start` and `end` are nearly opposite (the antipodal case
 * picks a perpendicular rotation axis instead of collapsing to zero).
 *
 * Used for smooth gravity-direction changes on characters and vehicles.
 *
 * IMPORTANT: the returned function reuses ONE preallocated result vector —
 * every call returns the same mutated `THREE.Vector3` instance. Callers must
 * `.copy()` the result immediately. Create one factory instance per consumer
 * (e.g. one class field per controller); do not share across controllers.
 */
export const createSlerpVec3 = () => {
  const startClone = new THREE.Vector3();
  const relativeVec = new THREE.Vector3();
  const resultVec3 = new THREE.Vector3();

  return (
    start: THREE.Vector3,
    end: THREE.Vector3,
    percent: number,
    refAxis?: THREE.Vector3
  ) => {
    const dot = THREE.MathUtils.clamp(start.dot(end), -1, 1);

    // When vectors are nearly opposite, find a stable perpendicular vector
    if (Math.abs(dot + 1) < 0.001) {
      // Choose a stable perpendicular axis
      if (refAxis && Math.abs(refAxis.dot(start)) < 0.99) {
        relativeVec.copy(refAxis).normalize();
      } else {
        if (Math.abs(start.y) > 0.99) {
          relativeVec.set(1, 0, 0);
        } else if (Math.abs(start.x) > 0.99) {
          relativeVec.set(0, 1, 0);
        } else {
          relativeVec.set(0, 0, 1);
        }
      }
      // Compute orthogonal vector
      relativeVec.cross(start).normalize();
      const theta = Math.PI * percent;
      resultVec3
        .copy(start)
        .multiplyScalar(Math.cos(theta))
        .addScaledVector(relativeVec, Math.sin(theta));
    } else {
      const theta = Math.acos(dot) * percent;
      relativeVec
        .copy(end)
        .sub(startClone.copy(start).multiplyScalar(dot))
        .normalize();
      resultVec3
        .copy(start)
        .multiplyScalar(Math.cos(theta))
        .addScaledVector(relativeVec, Math.sin(theta));
    }

    return resultVec3.normalize();
  };
};

/**
 * One control point of a weighted-Hermite curve.
 *
 * `r_in`/`r_out` are tangent ANGLES in radians (converted to slopes via
 * `Math.tan`), not slopes. `w_in`/`w_out` blend each user tangent toward the
 * segment's straight-line slope: weight 0 = straight line, weight 1 = full
 * user tangent (default 1). Omitted tangents default to flat (slope 0).
 */
export type CurvePoint = {
  x: number;
  y: number;
  r_in?: number;
  r_out?: number;
  w_in?: number;
  w_out?: number;
};

/** A baked curve: uniformly sampled lookup table over [xMin, xMax]. */
export type CurveLUT = {
  lut: Float32Array;
  xMin: number;
  xMax: number;
  samples: number;
};

/** Serializable curve definition: control points plus optional sample count. */
export type CurveData = {
  points: CurvePoint[];
  samples?: number;
};

/**
 * Weighted cubic Hermite curve functions.
 * Weight blends each user tangent toward the segment linear slope:
 * weight 0 = straight line, weight 1 = user tangent.
 */
function evalHermiteSegment(p0: CurvePoint, p1: CurvePoint, x: number) {
  const x0 = p0.x;
  const x1 = p1.x;
  const dx = x1 - x0;
  if (dx <= 0) return p0.y; // fallback if points overlap

  const t = (x - x0) / dx;
  const t2 = t * t;
  const t3 = t2 * t;

  // Cubic Hermite basis functions
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  // Convert angle (rad) -> slope (dy/dx)
  const m0 = p0.r_out !== undefined ? Math.tan(p0.r_out) : 0;
  const m1 = p1.r_in !== undefined ? Math.tan(p1.r_in) : 0;
  const w_out = p0.w_out ?? 1;
  const w_in = p1.w_in ?? 1;
  const linearSlope = (p1.y - p0.y) / dx;
  const weightedM0 = linearSlope + (m0 - linearSlope) * w_out;
  const weightedM1 = linearSlope + (m1 - linearSlope) * w_in;

  return h00 * p0.y + h10 * weightedM0 * dx + h01 * p1.y + h11 * weightedM1 * dx;
}

function findSegmentByX(x: number, points: CurvePoint[]) {
  let low = 0;
  let high = points.length - 2;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (x < points[mid].x) high = mid - 1;
    else if (x > points[mid + 1].x) low = mid + 1;
    else return mid;
  }
  return x < points[0].x ? 0 : points.length - 2;
}

function evalMultiPointCurveAtX(x: number, points: CurvePoint[]) {
  const i = findSegmentByX(x, points);
  const p0 = points[i];
  const p1 = points[i + 1];
  return evalHermiteSegment(p0, p1, x);
}

/**
 * Bake a weighted-Hermite curve into a uniformly-sampled lookup table.
 *
 * The input `points` array is copied and sorted by `x` — the caller's array is
 * never mutated. Throws if fewer than 2 points are given.
 *
 * Tuning hint: 50 samples (the default) is plenty for the smooth slip/torque
 * curves the controllers ship with; raise it only if you add a curve with
 * very sharp kinks and see faceting in behavior.
 */
export function bakeCurveLUT(points: CurvePoint[], samples: number = 50): CurveLUT {
  if (points.length < 2) throw new Error("Curve needs at least 2 points");
  const sortedPoints = [...points].sort((a, b) => a.x - b.x);
  const xMin = sortedPoints[0].x;
  const xMax = sortedPoints[sortedPoints.length - 1].x;
  const lut = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    const x = xMin + u * (xMax - xMin);
    lut[i] = evalMultiPointCurveAtX(x, sortedPoints);
  }
  return { lut, xMin, xMax, samples };
}

/**
 * Sample a baked curve at `x` with linear interpolation between LUT entries.
 *
 * Input outside [xMin, xMax] clamps to the end values (constant
 * extrapolation) — load-bearing for tire slip ratios that exceed 1.
 */
export function evaluateCurveLUT(x: number, curve: CurveLUT) {
  const { lut, xMin, xMax, samples } = curve;
  const u = (x - xMin) / (xMax - xMin);
  if (u <= 0) return lut[0];
  if (u >= 1) return lut[samples - 1];
  const f = u * (samples - 1);
  const i = f | 0;
  const t = f - i;
  const y0 = lut[i];
  const y1 = lut[i + 1];
  return y0 * (1 - t) + y1 * t;
}
